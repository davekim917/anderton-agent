import { randomBytes } from 'crypto';

import { PREVIEW_ORIGIN_SUFFIX } from '../../config.js';
import { centralTransaction } from '../../db/central-lease.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

export const PREVIEW_TTL_MS = 8 * 60 * 60_000;
const MAX_LABEL_CHARS = 80;
/** 128 random bits as lowercase hex: a valid DNS label, and the only credential a preview has. */
export const PREVIEW_ID_RE = /^[0-9a-f]{32}$/;

interface Preview {
  id: string;
  sessionId: string;
  agentGroupId: string;
  containerName: string;
  port: number;
  label: string | null;
  expiresAt: number;
  timer: NodeJS.Timeout;
  revoked: AbortController;
}

export interface PreviewInfo {
  url: string;
  port: number;
  label: string | null;
  expiresAt: string;
}

type EndReason = 'closed' | 'replaced' | 'expired' | 'container exited';

/**
 * A preview that ended without its agent asking: `expired` while its container still runs, or `container exited`
 * when the container serving it exited or was not adopted by a restarted host.
 */
export interface LostPreview {
  previewId: string;
  sessionId: string;
  port: number;
  label: string | null;
  reason: Extract<EndReason, 'expired' | 'container exited'>;
}

interface PreviewRow {
  id: string;
  session_id: string;
  agent_group_id: string;
  container_name: string;
  port: number;
  label: string | null;
  expires_at: string;
}

const bySession = new Map<string, Preview>();
const byId = new Map<string, Preview>();
let onLost: ((lost: LostPreview) => void) | null = null;

const previewUrl = (id: string) => `https://${id}.${PREVIEW_ORIGIN_SUFFIX}`;

function info(p: Preview): PreviewInfo {
  return { url: previewUrl(p.id), port: p.port, label: p.label, expiresAt: new Date(p.expiresAt).toISOString() };
}

function reportLost(p: Pick<Preview, 'id' | 'sessionId' | 'port' | 'label'>, reason: LostPreview['reason']): void {
  onLost?.({ previewId: p.id, sessionId: p.sessionId, port: p.port, label: p.label, reason });
}

/**
 * Not awaited, because expiry and container exit end previews from synchronous paths. A row a failed delete leaves is
 * past its expiry or names a container no restarted host adopts, so boot drops it. Close and replace leave the
 * container running, so they go through `storeSessionPreview` instead.
 */
function forget(id: string): void {
  getDb()
    .run('DELETE FROM previews WHERE id = ?', id)
    .catch((err: unknown) => log.warn('Could not delete a preview row', { previewId: id, err }));
}

async function storeSessionPreview(sessionId: string, row: PreviewRow | null): Promise<void> {
  await centralTransaction(async () => {
    await getDb().run('DELETE FROM previews WHERE session_id = ?', sessionId);
    if (!row) return;
    await getDb().run(
      `INSERT INTO previews (id, session_id, agent_group_id, container_name, port, label, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.session_id,
      row.agent_group_id,
      row.container_name,
      row.port,
      row.label,
      row.expires_at,
    );
  }, 'storeSessionPreview');
}

function end(p: Preview, reason: EndReason): void {
  if (byId.get(p.id) !== p) return;
  clearTimeout(p.timer);
  p.revoked.abort();
  byId.delete(p.id);
  if (bySession.get(p.sessionId) === p) bySession.delete(p.sessionId);
  forget(p.id);
  log.info('Preview ended', {
    reason,
    sessionId: p.sessionId,
    agentGroupId: p.agentGroupId,
    containerName: p.containerName,
    port: p.port,
  });
  if (reason === 'expired' || reason === 'container exited') reportLost(p, reason);
}

function register(fields: Omit<Preview, 'timer' | 'revoked'>): Preview {
  const preview: Preview = {
    ...fields,
    timer: setTimeout(() => end(preview, 'expired'), Math.max(0, fields.expiresAt - Date.now())),
    revoked: new AbortController(),
  };
  preview.timer.unref();
  const previous = bySession.get(fields.sessionId);
  if (previous) end(previous, 'replaced');
  bySession.set(fields.sessionId, preview);
  byId.set(fields.id, preview);
  return preview;
}

export interface OpenPreviewInput {
  sessionId: string;
  agentGroupId: string;
  port: number;
  label?: string;
  /** The session's container right now: read to open the link, and again once the link is stored. */
  containerFor: (sessionId: string) => string | null | undefined;
}

/** A new preview from the same session replaces the old one, whose address stops working at once. */
export async function openPreview(input: OpenPreviewInput): Promise<PreviewInfo> {
  if (!PREVIEW_ORIGIN_SUFFIX)
    throw new Error('Live preview is not configured on this host (PREVIEW_ORIGIN_SUFFIX is unset).');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error('--port must be a TCP port number (1-65535).');
  }
  const containerName = input.containerFor(input.sessionId);
  if (!containerName) throw new Error('This session has no running container.');
  const label = (input.label ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS) || null;
  const id = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  await storeSessionPreview(input.sessionId, {
    id,
    session_id: input.sessionId,
    agent_group_id: input.agentGroupId,
    container_name: containerName,
    port: input.port,
    label,
    expires_at: new Date(expiresAt).toISOString(),
  });
  // Either write can wait on another transaction, and the container's exit hook may run in that wait, before there
  // is a preview for it to end.
  if (input.containerFor(input.sessionId) !== containerName) {
    forget(id);
    throw new Error("This session's container stopped while the link was being opened. Open it again.");
  }
  const preview = register({
    id,
    sessionId: input.sessionId,
    agentGroupId: input.agentGroupId,
    containerName,
    port: input.port,
    label,
    expiresAt,
  });
  log.info('Preview opened', {
    sessionId: input.sessionId,
    agentGroupId: input.agentGroupId,
    containerName,
    port: input.port,
    label,
  });
  return info(preview);
}

/**
 * Boot: reopens each stored preview whose container is still the session's, so its link keeps working, and drops the
 * rest. `containerFor` must count a survivor whose adoption is still pending: the bridge reaches it all the same.
 * A pending survivor later proven gone ends its preview through `endPreviewForContainer`.
 * From here on every preview that ends without its agent asking, these included, goes to `onLostPreview`, which runs
 * inside container-exit and timer paths and so must not throw.
 */
export async function restorePreviews(
  containerFor: (sessionId: string) => string | null,
  onLostPreview: (lost: LostPreview) => void,
): Promise<{ restored: number; dropped: number }> {
  onLost = onLostPreview;
  const rows = await getDb().all<PreviewRow>('SELECT * FROM previews ORDER BY expires_at ASC');
  const counts = { restored: 0, dropped: 0 };
  for (const row of rows) {
    const expiresAt = Date.parse(row.expires_at);
    const serving = Boolean(PREVIEW_ORIGIN_SUFFIX) && containerFor(row.session_id) === row.container_name;
    if (!serving || !(expiresAt > Date.now())) {
      counts.dropped += 1;
      forget(row.id);
      reportLost(
        { id: row.id, sessionId: row.session_id, port: row.port, label: row.label },
        serving ? 'expired' : 'container exited',
      );
      continue;
    }
    counts.restored += 1;
    register({
      id: row.id,
      sessionId: row.session_id,
      agentGroupId: row.agent_group_id,
      containerName: row.container_name,
      port: row.port,
      label: row.label,
      expiresAt,
    });
  }
  if (rows.length > 0) log.info('Restored live previews', counts);
  return counts;
}

export async function closePreview(sessionId: string): Promise<{ closed: boolean }> {
  await storeSessionPreview(sessionId, null);
  const preview = bySession.get(sessionId);
  if (preview) end(preview, 'closed');
  return { closed: preview !== undefined };
}

/** When the session's open preview expires, or null with none open. */
export function previewHeldUntilMs(sessionId: string): number | null {
  return bySession.get(sessionId)?.expiresAt ?? null;
}

export function previewStatus(sessionId: string): PreviewInfo | null {
  const preview = bySession.get(sessionId);
  return preview ? info(preview) : null;
}

/** Compare-and-delete on the container name: a replacement container's newer preview stays open. */
export function endPreviewForContainer(sessionId: string, containerName: string): void {
  const preview = bySession.get(sessionId);
  if (preview?.containerName === containerName) end(preview, 'container exited');
}

/** `revoked` fires when the preview ends, so connections already open through it end too. */
export function resolvePreview(id: string): { containerName: string; port: number; revoked: AbortSignal } | null {
  const preview = byId.get(id);
  if (!preview) return null;
  if (preview.expiresAt <= Date.now()) {
    end(preview, 'expired');
    return null;
  }
  return { containerName: preview.containerName, port: preview.port, revoked: preview.revoked.signal };
}
