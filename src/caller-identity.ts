/**
 * The human caller behind a container-emitted privileged action (grant.ts, channel-config): never the agent's own
 * claim, but the sender of the session's latest inbound chat row. One implementation for both callers.
 */
import { getMessagingGroup } from './db/messaging-groups.js';
import type { InboundChatSenderRow } from './modules/mailbox/ops/lookups.js';
import { withExistingMailboxSession } from './session-manager.js';
import { isHumanChatSdkContent } from './task-list-host.js';
import type { Session } from './types.js';

/** `notifyAgent` writes `kind='chat'` notices as `senderId: 'system'` after the user's message; scan past them. */
const SCAN_DEPTH = 20;
/** Sibling bots in a shared room can post many turns after the human, so the human scan looks further back. */
const HUMAN_SCAN_DEPTH = 100;

/** Namespaced senderId, or null when the session has no mailbox. Opens its own short mailbox session. */
export async function deriveCallerId(session: Session): Promise<string | null> {
  return firstSenderId(session, await recentChatSenders(session, SCAN_DEPTH), () => true);
}

/**
 * The latest platform-flagged human (`chat-sdk`, `author.isBot === false`) in the session, or null. Stricter than
 * `deriveCallerId`, which also takes a bot's row or a legacy adapter's.
 */
export async function deriveHumanRequesterId(session: Session): Promise<string | null> {
  return firstSenderId(session, await recentChatSenders(session, HUMAN_SCAN_DEPTH), (row) =>
    isHumanChatSdkContent(row.kind, row.content ?? ''),
  );
}

async function recentChatSenders(session: Session, depth: number): Promise<InboundChatSenderRow[]> {
  return (
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.getRecentInboundChatSenders(depth),
    )) ?? []
  );
}

async function firstSenderId(
  session: Session,
  rows: InboundChatSenderRow[],
  accept: (row: InboundChatSenderRow) => boolean,
): Promise<string | null> {
  for (const row of rows) {
    if (!row.content || !accept(row)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rawId = (() => {
      const direct = parsed.senderId;
      if (typeof direct === 'string' && direct.length > 0) return direct;
      const author = parsed.author as { userId?: unknown } | undefined;
      if (typeof author?.userId === 'string' && author.userId.length > 0) return author.userId;
      return null;
    })();
    if (!rawId || rawId === 'system') continue;
    if (rawId.includes(':')) return rawId;
    const mgFallback = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    const channelType = row.channel_type ?? mgFallback?.channel_type ?? null;
    if (!channelType) continue;
    return `${channelType}:${rawId}`;
  }
  return null;
}
