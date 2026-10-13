/**
 * Admin-approval gates for in-container Bash: `request_bash_gate` (soft
 * sensitive, e.g. email send) and `request_destructive_gate`. Distinct action
 * names so cards, logs and policy can differ; shared ack mechanics.
 *
 * The container hook writes the request (requestId === messages_out.id) and
 * polls inbound.db's `delivered` table for requestId; approve, reject or
 * timeout writes the decision there. Without a registered handler the
 * container-side hook blocks until its own timeout on every send.
 */

import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import {
  deletePendingApproval,
  getPendingApprovalByRequestId,
  getPendingApprovalsBySession,
  getSession,
} from '../../db/sessions.js';

import {
  editApprovalCard,
  registerApprovalHandler,
  requestApproval,
  notifyAgent,
  type ApprovalHandlerContext,
} from '../approvals/primitive.js';

// Approvers are often in a meeting when the card lands.
const BASH_GATE_TIMEOUT_MS = 60 * 60 * 1000;
const GATE_CARD_TITLE_MAX_CHARS = 140;
// The card body (summary, command preview, footer) is budgeted in UTF-16 units so
// that both the posted card and its approve/reject edit (title, body and resolution
// line as one message) fit the platform's text limit; past it the footer, the
// command's tail or the resolution line would be dropped silently. The limits are
// the adapters' configured maxTextLength (Slack 2800, Discord 1900), copied because
// adapters are skill-installed and may be absent; 1900 also covers any other platform.
const SLACK_MESSAGE_MAX_UNITS = 2800;
const OTHER_MESSAGE_MAX_UNITS = 1900;
const RESOLUTION_LINE_RESERVE_UNITS = 160;
const GATE_COMMAND_PREVIEW_MIN_UNITS = 600;

const pendingTimeouts = new Map<string, NodeJS.Timeout>();

/**
 * Lets the router skip the cancel query in the common case. Not persisted: on
 * host restart every container gate is already stale.
 */
const sessionsWithActiveGates = new Set<string>();

export function sessionHasActiveGates(sessionId: string): boolean {
  return sessionsWithActiveGates.has(sessionId);
}

interface BashGatePayload {
  requestId: string;
  label: string;
  summary: string;
  command: string;
  sessionId: string;
}

/**
 * Runs long after the dispatching drain, in its own short session. Existing-only:
 * a session whose mailbox is gone has no container polling for the decision.
 */
async function writeGateAck(
  session: Session,
  requestId: string,
  outcome: 'approved' | 'rejected' | 'timeout',
  errorText?: string,
): Promise<void> {
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    if (outcome === 'approved') {
      mailbox.markDelivered(requestId, null);
    } else {
      mailbox.markDeliveryFailed(requestId, errorText ?? outcome);
    }
  });
}

function clearPending(requestId: string): void {
  const handle = pendingTimeouts.get(requestId);
  if (handle) {
    clearTimeout(handle);
    pendingTimeouts.delete(requestId);
  }
}

interface GateCategory {
  deliveryAction: string;
  approvalAction: string;
  defaultLabel: string;
  defaultSummary: string;
  logPrefix: string;
  titleEmoji: string;
  kindNoun: string;
}

function headUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  let end = Math.max(0, units);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

function tailUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  let start = text.length - Math.max(0, units);
  if (start < text.length && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  return text.slice(start);
}

// Head+tail preview: a long command's final arguments are often the most
// consequential part.
function commandPreview(command: string, units: number): string {
  if (command.length <= units) return command;
  const marker = '\n…[middle omitted; full command retained in the approval record]…\n';
  const headLength = Math.floor((units - marker.length) / 2);
  return headUnits(command, headLength) + marker + tailUnits(command, units - marker.length - headLength);
}

function cardBodyBudget(platformId: string | undefined, title: string): number {
  const limit = platformId?.startsWith('slack:') ? SLACK_MESSAGE_MAX_UNITS : OTHER_MESSAGE_MAX_UNITS;
  // The edit is `title\n\nbody\n\nresolution`; Discord's post wraps the title as `**title**\n\n`, which is shorter.
  return limit - title.length - '\n\n\n\n'.length - RESOLUTION_LINE_RESERVE_UNITS;
}

function buildCardBody(category: GateCategory, summary: string, command: string, budget: number): string {
  const timeoutMinutes = BASH_GATE_TIMEOUT_MS / 60_000;
  const footer = `_Reject, or no answer within ${timeoutMinutes} min, cancels the ${category.kindNoun.toLowerCase()}._`;
  const separator = '\n\n';
  const fence = (body: string) => '```\n' + body + '\n```';
  const fixed = footer.length + separator.length + (command ? fence('').length + separator.length : 0);
  const summaryUnits = budget - fixed - Math.min(GATE_COMMAND_PREVIEW_MIN_UNITS, command.length);
  const shownSummary = summary.length <= summaryUnits ? summary : headUnits(summary, summaryUnits - 1) + '…';
  const parts: string[] = [shownSummary];
  if (command) {
    // The full command is persisted in the approval payload; the card preview
    // keeps head and tail so the approver never infers omitted final arguments.
    parts.push(fence(commandPreview(command, budget - fixed - shownSummary.length)));
  }
  parts.push(footer);
  return parts.join(separator);
}

function buildCardTitle(category: GateCategory, label: string): string {
  const title = `${category.titleEmoji} ${label}`;
  const codePoints = Array.from(title);
  if (codePoints.length <= GATE_CARD_TITLE_MAX_CHARS) return title;
  return (
    codePoints
      .slice(0, GATE_CARD_TITLE_MAX_CHARS - 1)
      .join('')
      .trimEnd() + '…'
  );
}

function createGateHandler(category: GateCategory) {
  return async function handleGateRequest(
    content: Record<string, unknown>,
    session: Session,
  ): Promise<{ deferAck: true }> {
    const label = typeof content.label === 'string' ? content.label : category.defaultLabel;
    const summary = typeof content.summary === 'string' ? content.summary : category.defaultSummary;
    // Keep the full command: truncating would drop consequential trailing flags.
    const command = typeof content.command === 'string' ? content.command : '';
    const requestId = typeof content.requestId === 'string' ? (content.requestId as string) : '';
    if (!requestId) {
      log.warn(`${category.deliveryAction} missing requestId`, { content });
      // Still defer: the container polls for a decision on its own requestId,
      // and auto-acking would falsely unblock it.
      return { deferAck: true };
    }

    sessionsWithActiveGates.add(session.id);

    // Schedule the timeout before dispatching, so a throw below still
    // auto-resolves the container side.
    const timer = setTimeout(() => {
      void (async () => {
        pendingTimeouts.delete(requestId);
        sessionsWithActiveGates.delete(session.id);
        log.warn(`${category.logPrefix} gate timed out`, { requestId, agentGroupId: session.agent_group_id });
        await writeGateAck(
          session,
          requestId,
          'timeout',
          `${category.logPrefix} gate timed out after ${BASH_GATE_TIMEOUT_MS / 60_000} minutes.`,
        );
        const pending = await getPendingApprovalByRequestId(requestId);
        if (pending) {
          await editApprovalCard(
            pending,
            `🕒 *${pending.title}* — timed out\n\nNo approval received within ${BASH_GATE_TIMEOUT_MS / 60_000} minutes. The ${category.kindNoun} was not run.`,
          );
          await deletePendingApproval(pending.approval_id);
        }
      })().catch((err) => {
        log.error(`${category.logPrefix} gate timeout handler failed`, { requestId, err });
      });
    }, BASH_GATE_TIMEOUT_MS);
    timer.unref(); // don't block process shutdown on a pending gate
    pendingTimeouts.set(requestId, timer);

    const payload: BashGatePayload = {
      requestId,
      label,
      summary,
      command,
      sessionId: session.id,
    };

    const title = buildCardTitle(category, label);
    const platformId = session.messaging_group_id
      ? (await getMessagingGroup(session.messaging_group_id))?.platform_id
      : undefined;
    const approvalDelivered = await requestApproval({
      session,
      agentName: session.agent_group_id,
      action: category.approvalAction,
      requestId,
      payload: payload as unknown as Record<string, unknown>,
      title,
      question: buildCardBody(category, summary, command, cardBodyBudget(platformId, title)),
      // In-thread: thread access IS the authority for work-level gates
      // (response-handler.ts doesn't check clicker identity). Self-mod and
      // credential approvals stay admin-DM.
      deliveryTarget: 'thread',
    });
    if (!approvalDelivered) {
      clearPending(requestId);
      sessionsWithActiveGates.delete(session.id);
      await writeGateAck(
        session,
        requestId,
        'rejected',
        `${category.approvalAction} delivery failed: approval request could not be posted.`,
      );
      return { deferAck: true };
    }

    // Mark 'pending' so the delivery loop's dedup skips it; otherwise every
    // poll re-dispatches the gate and posts another card.
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.markPending(requestId));

    return { deferAck: true };
  };
}

function createApprovalHandler(logPrefix: string) {
  return async function handleGateApproval(ctx: ApprovalHandlerContext): Promise<void> {
    const { payload, userId } = ctx;
    const p = payload as unknown as BashGatePayload;
    if (!p.requestId || !p.sessionId) {
      log.warn(`${logPrefix} gate approval with malformed payload`, { payload });
      return;
    }
    clearPending(p.requestId);
    sessionsWithActiveGates.delete(p.sessionId);

    const session = await getSession(p.sessionId);
    if (!session) {
      log.warn(`${logPrefix} gate approval for unknown session`, { sessionId: p.sessionId, requestId: p.requestId });
      return;
    }

    // Only invoked on Approve; Reject is handled in response-handler.ts.
    await writeGateAck(session, p.requestId, 'approved');
    log.info(`${logPrefix} gate approved`, { requestId: p.requestId, userId });
    // Best-effort, never awaited: an awaited rejection whose fallback notify
    // also fails leaves the approval row clickable, replaying the ack.
    void Promise.resolve(notifyAgent(session, `${logPrefix} gate approved: ${p.label}`)).catch((err) =>
      log.warn(`${logPrefix} gate approval notification failed`, { requestId: p.requestId, err }),
    );
  };
}

const BASH_GATE: GateCategory = {
  deliveryAction: 'request_bash_gate',
  approvalAction: 'bash-gate',
  defaultLabel: 'Bash command',
  defaultSummary: 'The agent wants to run a sensitive command.',
  logPrefix: 'Bash',
  titleEmoji: '⚠️',
  kindNoun: 'command',
};
const DESTRUCTIVE_GATE: GateCategory = {
  deliveryAction: 'request_destructive_gate',
  approvalAction: 'destructive-gate',
  defaultLabel: 'Destructive command',
  defaultSummary: 'The agent wants to run a destructive command.',
  logPrefix: 'Destructive',
  titleEmoji: '🛑',
  kindNoun: 'destructive command',
};

registerDeliveryAction(
  BASH_GATE.deliveryAction,
  createGateHandler(BASH_GATE),
  unguarded('request path only; execution waits for the registered bash-gate approval handler'),
);
registerApprovalHandler(BASH_GATE.approvalAction, createApprovalHandler(BASH_GATE.logPrefix));
registerDeliveryAction(
  DESTRUCTIVE_GATE.deliveryAction,
  createGateHandler(DESTRUCTIVE_GATE),
  unguarded('request path only; execution waits for the registered destructive-gate approval handler'),
);
registerApprovalHandler(DESTRUCTIVE_GATE.approvalAction, createApprovalHandler(DESTRUCTIVE_GATE.logPrefix));

/**
 * A follow-up message implicitly rejects the session's open gates so the
 * agent can answer it instead of staying blocked. Card edit is best-effort;
 * the pending_approvals row is deleted so a late click can't approve a
 * cancelled gate.
 */
export async function cancelPendingGatesForSession(sessionId: string, reason: string): Promise<void> {
  const pending: PendingApproval[] = (await getPendingApprovalsBySession(sessionId)).filter(
    (p) => p.action === BASH_GATE.approvalAction || p.action === DESTRUCTIVE_GATE.approvalAction,
  );
  if (pending.length === 0) return;

  const session = await getSession(sessionId);
  if (!session) {
    log.warn('cancelPendingGatesForSession called for unknown session', { sessionId });
    return;
  }

  log.info('Auto-cancelling in-flight gates', {
    sessionId,
    count: pending.length,
    approvalIds: pending.map((p) => p.approval_id),
  });

  for (const p of pending) {
    // request_id is the gate's own outbound message id, which the container polls on.
    clearPending(p.request_id);
    try {
      await editApprovalCard(p, `❌ *${p.title}* — cancelled\n\n${reason}`);
    } catch (err) {
      log.warn('Failed to edit cancelled approval card', { approvalId: p.approval_id, err });
    }
    await writeGateAck(session, p.request_id, 'rejected', reason);
    await deletePendingApproval(p.approval_id);
  }
  sessionsWithActiveGates.delete(sessionId);
}
