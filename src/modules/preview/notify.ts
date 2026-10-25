import { getSession } from '../../db/sessions.js';
import { withStoppedContainerSession } from '../../host-sweep.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { notifyAgent } from '../approvals/primitive.js';
import type { LostPreview } from './service.js';

/**
 * Says that a link stopped working. An expired link's container still runs, so its agent is told and can reopen it.
 * A link whose container is gone has no agent to tell, so the note goes straight to the thread, where the people
 * using it are.
 */
export async function announcePreviewLost(lost: LostPreview): Promise<void> {
  const session = await getSession(lost.sessionId);
  if (!session) return;
  const name = lost.label ? ` (${lost.label})` : '';
  if (lost.reason === 'expired') {
    await notifyAgent(
      session,
      `Your live preview${name} reached its 8-hour limit and closed, so its link no longer works. If people still ` +
        `need the app, run \`ncl preview open --port ${lost.port}\` again and post the new link.`,
      { id: `preview-expired-${lost.previewId}` },
    );
    return;
  }
  await withStoppedContainerSession(
    (action) => withExistingMailboxSession(session.agent_group_id, session.id, action),
    session,
    // A respawn already running owns outbound.db; its agent is a fresh conversation the note would not help.
    (m) => {
      const routing = m.readSessionRouting();
      if (!routing) return;
      m.writeOutboundDirect({
        id: `preview-lost-${lost.previewId}`,
        kind: 'chat',
        platformId: routing.platform_id,
        channelType: routing.channel_type,
        threadId: routing.thread_id,
        content: JSON.stringify({
          text: `The live preview link${name} stopped working because the session serving it ended. Ask me here to reopen it.`,
          _system: { kind: 'preview_lost' },
        }),
      });
    },
  );
}

export function reportPreviewLost(lost: LostPreview): void {
  announcePreviewLost(lost).catch((err: unknown) =>
    log.warn('Could not announce a lost live preview', { previewId: lost.previewId, sessionId: lost.sessionId, err }),
  );
}
