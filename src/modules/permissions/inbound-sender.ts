import type { InboundEvent } from '../../channels/adapter.js';

/**
 * The sender of an inbound message, as a namespaced user id, and the display name it carries. chat-sdk-bridge puts
 * the sender at `author.userId`; older adapters put `senderId` or `sender` at the top level.
 */
export function inboundSender(event: InboundEvent): { userId: string; name: string | undefined } | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const rawHandle =
    (typeof content.senderId === 'string' ? content.senderId : undefined) ??
    (typeof content.sender === 'string' ? content.sender : undefined) ??
    (typeof author?.userId === 'string' ? author.userId : undefined);
  if (!rawHandle) return null;
  const name =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? author.fullName : undefined) ??
    (typeof author?.userName === 'string' ? author.userName : undefined);
  return { userId: rawHandle.includes(':') ? rawHandle : `${event.channelType}:${rawHandle}`, name };
}
