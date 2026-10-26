import { log } from './log.js';

/** One outbound row delivery has finished with, in the order delivery processed them (the runner's write timestamps). */
export interface DeliveredOutbound {
  sessionId: string;
  outboundId: string;
  inReplyTo: string | null;
  action?: string;
  /**
   * A chat row: the text delivery recorded as delivered, scrubbed and humanized, and where it landed. A long post the
   * platform accepted only in part still counts as delivered in full, as it does in the chat archive.
   */
  post?: { text: string; channelType: string; platformId: string; threadId: string | null };
}

type Listener = (event: DeliveredOutbound) => void;

const listeners = new Set<Listener>();

export function onOutboundDelivered(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyOutboundDelivered(event: DeliveredOutbound): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn('Outbound delivery listener failed', { sessionId: event.sessionId, err });
    }
  }
}
