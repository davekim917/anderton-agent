/**
 * Who a container-emitted privileged action (grant.ts, channel-config) is acting for, read only from inbound rows the
 * host wrote itself, never from the agent's claim or the container's own bookkeeping.
 */
import { getMessagingGroup } from './db/messaging-groups.js';
import type { InboundChatSenderRow } from './modules/mailbox/ops/lookups.js';
import { withExistingMailboxSession } from './session-manager.js';
import { isHumanChatSdkContent } from './task-list-host.js';
import type { Session } from './types.js';

/** Sibling bots in a shared room can post many turns after the human, so the human scan looks further back. */
const HUMAN_SCAN_DEPTH = 100;
/** Longer than an agent turn normally takes to reach its action; an older request reads as nobody asking. */
export const REQUESTER_WINDOW_MS = 15 * 60_000;

export type Requester =
  | { kind: 'one'; userId: string }
  | { kind: 'unclear'; reason: 'nobody' | 'several' | 'busy' | 'unidentified' };

export async function resolveRequester(session: Session, nowMs = Date.now()): Promise<Requester> {
  const since = nowMs - REQUESTER_WINDOW_MS;
  const people = new Set<string>();
  const rows = await recentChatSenders(session, HUMAN_SCAN_DEPTH);
  let reachedWindowStart = false;
  let unidentified = false;
  for (const row of rows) {
    if (row.timestamp && Date.parse(row.timestamp) < since) {
      reachedWindowStart = true;
      break;
    }
    if (!row.content) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    const userId = await namespacedSender(session, row, parsed);
    if (userId) people.add(userId);
    else if (parsed.senderId !== 'system' && parsed.sender !== 'system') unidentified = true;
  }
  if (people.size > 1) return { kind: 'unclear', reason: 'several' };
  if (!reachedWindowStart && rows.length >= HUMAN_SCAN_DEPTH) return { kind: 'unclear', reason: 'busy' };
  if (unidentified) return { kind: 'unclear', reason: 'unidentified' };
  if (people.size === 1) return { kind: 'one', userId: [...people][0] };
  return { kind: 'unclear', reason: 'nobody' };
}

/**
 * The latest platform-flagged human (`chat-sdk`, `author.isBot === false`) in the session, or null. Stricter than
 * `resolveRequester`, which also counts a legacy adapter's rows and the host's own voice-call rows.
 */
export async function deriveHumanRequesterId(session: Session): Promise<string | null> {
  return (await deriveHumanRequest(session))?.userId ?? null;
}

export interface HumanRequest {
  userId: string;
  /** Where that message came from: the conversation a reply to it belongs in. */
  route: { channelType: string; platformId: string; threadId: string | null };
}

export async function deriveHumanRequest(session: Session): Promise<HumanRequest | null> {
  const found = await firstSender(session, await recentChatSenders(session, HUMAN_SCAN_DEPTH), (row) =>
    isHumanChatSdkContent(row.kind, row.content ?? ''),
  );
  if (!found) return null;
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const channelType = found.row.channel_type ?? mg?.channel_type;
  const platformId = found.row.platform_id ?? mg?.platform_id;
  if (!channelType || !platformId) return null;
  const threadId = found.row.platform_id ? (found.row.thread_id ?? null) : session.thread_id;
  return { userId: found.userId, route: { channelType, platformId, threadId } };
}

async function recentChatSenders(session: Session, depth: number): Promise<InboundChatSenderRow[]> {
  return (
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.getRecentInboundChatSenders(depth),
    )) ?? []
  );
}

async function firstSender(
  session: Session,
  rows: InboundChatSenderRow[],
  accept: (row: InboundChatSenderRow) => boolean,
): Promise<{ userId: string; row: InboundChatSenderRow } | null> {
  for (const row of rows) {
    if (!row.content || !accept(row)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    const userId = await namespacedSender(session, row, parsed);
    if (userId) return { userId, row };
  }
  return null;
}

async function namespacedSender(
  session: Session,
  row: InboundChatSenderRow,
  parsed: Record<string, unknown>,
): Promise<string | null> {
  const direct = parsed.senderId;
  const author = parsed.author as { userId?: unknown } | undefined;
  const rawId =
    typeof direct === 'string' && direct.length > 0
      ? direct
      : typeof author?.userId === 'string' && author.userId.length > 0
        ? author.userId
        : null;
  if (!rawId || rawId === 'system') return null;
  if (rawId.includes(':')) return rawId;
  const mgFallback = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const channelType = row.channel_type ?? mgFallback?.channel_type ?? null;
  return channelType ? `${channelType}:${rawId}` : null;
}
