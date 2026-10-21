import { log } from '../../log.js';
import { openGateDeadlineMs } from '../bash-gate/index.js';
import { previewHeldUntilMs } from '../preview/service.js';

/**
 * Every reason a running session counts as active while its turn is quiet, as the instant the last of them lapses
 * (null with none). Both the chat idle reap and the stuck ceiling read this, so a new reason is added here once.
 *
 * - an approval gate the current container filed and is waiting on, with its heartbeat quiet;
 * - an open live preview, whose visitors use the app the container serves.
 */
export async function heldAwakeUntilMs(sessionId: string): Promise<number | null> {
  const gate = await openGateDeadlineMs(sessionId).catch((err: unknown) => {
    log.warn('Gate deadline lookup failed; the session is not held awake by it this tick', { sessionId, err });
    return null;
  });
  const reasons = [gate, previewHeldUntilMs(sessionId)].filter((at): at is number => at !== null);
  return reasons.length > 0 ? Math.max(...reasons) : null;
}
