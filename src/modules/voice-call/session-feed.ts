import { onOutboundDelivered, type DeliveredOutbound } from '../../delivery-events.js';
import type { CallRoute } from './registry.js';

export type FeedEvent = { type: 'reply'; text: string; inReplyTo: string | null } | { type: 'turn-end' };

/** What delivery posted is what the caller hears; delivery has already scrubbed, rewritten and placed it. */
function deliveredEvent(event: DeliveredOutbound, sessionId: string, route: CallRoute): FeedEvent | null {
  if (event.sessionId !== sessionId) return null;
  if (event.action !== undefined) return event.action === 'turn_end' ? { type: 'turn-end' } : null;
  const text = event.post?.text.trim();
  if (!text) return null;
  const { channelType, platformId, threadId } = event.post!;
  if (channelType !== route.channelType || platformId !== route.platformId || threadId !== route.threadId) return null;
  return { type: 'reply', text, inReplyTo: event.inReplyTo };
}

export interface SessionFeed {
  close(): void;
}

/** The agent's replies to the call's thread and its turn ends, as delivery posts them, in delivery's order. */
export function followSessionFeed(
  sessionId: string,
  route: CallRoute,
  onEvent: (event: FeedEvent) => void,
): SessionFeed {
  let closed = false;
  const stop = onOutboundDelivered((delivered) => {
    if (closed) return;
    const event = deliveredEvent(delivered, sessionId, route);
    if (event) onEvent(event);
  });
  return {
    close() {
      closed = true;
      stop();
    },
  };
}
