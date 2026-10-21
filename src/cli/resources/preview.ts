// `open` needs no approval: the address is a random capability posted only where the agent chooses, it reaches only
// the agent's own container, and it ends with that container.
import { TIMEZONE } from '../../config.js';
import { containerIdentityFor } from '../../container-runner.js';
import { closePreview, openPreview, previewStatus, type PreviewInfo } from '../../modules/preview/service.js';
import { formatLocalTime } from '../../timezone.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

function agentSession(ctx: CallerContext): { sessionId: string; agentGroupId: string } {
  if (ctx.caller !== 'agent') throw new Error('Only an agent session can open a live preview of its own app.');
  return { sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId };
}

const describePreview = (p: PreviewInfo) =>
  `${p.url}${p.label ? ` (${p.label})` : ''}, port ${p.port}, open until ${formatLocalTime(p.expiresAt, TIMEZONE)}`;

registerResource({
  name: 'preview',
  plural: 'preview',
  table: 'sessions',
  description:
    'Share a live link to a web app running in your container, so people open the real app in their browser.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    open: {
      access: 'open',
      description:
        'Open a live link to the dev server listening on --port inside your container, and print the URL to post in this conversation. Anyone with the URL can use the app, so post it only where you would share the app itself.\n\n' +
        "The server must listen on 127.0.0.1 (not `localhost`, which can resolve to IPv6 only) and serve `/`. It must accept the preview Host (Vite: `server.allowedHosts` includes the preview suffix); HMR connects back on the page's own origin. Run the app from your checkout under /workspace/worktrees: the preview serves `/@fs/` paths only from there. Anyone with the URL can fetch any file the dev server will serve, so keep Vite's `server.fs.allow` to the app and the packages it builds from. The link lasts 8 hours, until `ncl preview close`, or until this container exits. While it is open a chat session's container is not reaped as idle (a scheduled-task session's still is), so run `ncl preview close` as soon as nobody needs the app. A new `open` from this session replaces the previous link.",
      args: [
        {
          name: 'port',
          type: 'number',
          description: 'The port the app listens on inside your container.',
          required: true,
        },
        { name: 'label', type: 'string', description: 'A short name for the app, shown in `ncl preview status`.' },
      ],
      examples: ['ncl preview open --port 5173 --label "checkout redesign"'],
      handler: async (args, ctx) => {
        const session = agentSession(ctx);
        const containerName = containerIdentityFor(session.sessionId)?.containerName;
        if (!containerName) throw new Error('This session has no running container.');
        return openPreview({
          ...session,
          containerName,
          port: Number(args.port),
          label: args.label === undefined ? undefined : String(args.label),
        });
      },
      formatHuman: (data) => `Live preview: ${describePreview(data as PreviewInfo)}. Post the URL here to share it.`,
    },
    close: {
      access: 'open',
      description: "End this session's live preview. Its URL stops working at once.",
      args: [],
      examples: ['ncl preview close'],
      handler: async (_args, ctx) => closePreview(agentSession(ctx).sessionId),
      formatHuman: (data) =>
        (data as { closed: boolean }).closed ? 'Live preview closed.' : 'No live preview was open for this session.',
    },
    status: {
      access: 'open',
      description: "Show this session's live preview, if one is open.",
      args: [],
      examples: ['ncl preview status'],
      handler: async (_args, ctx) => ({ preview: previewStatus(agentSession(ctx).sessionId) }),
      formatHuman: (data) => {
        const { preview } = data as { preview: PreviewInfo | null };
        return preview ? `Live preview: ${describePreview(preview)}.` : 'No live preview is open for this session.';
      },
    },
  },
});
