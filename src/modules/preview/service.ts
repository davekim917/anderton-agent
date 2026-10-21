import { randomBytes } from 'crypto';

import { PREVIEW_ORIGIN_SUFFIX } from '../../config.js';
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

const bySession = new Map<string, Preview>();
const byId = new Map<string, Preview>();

const previewUrl = (id: string) => `https://${id}.${PREVIEW_ORIGIN_SUFFIX}`;

function info(p: Preview): PreviewInfo {
  return { url: previewUrl(p.id), port: p.port, label: p.label, expiresAt: new Date(p.expiresAt).toISOString() };
}

function end(p: Preview, reason: 'closed' | 'replaced' | 'expired' | 'container exited'): void {
  if (byId.get(p.id) !== p) return;
  clearTimeout(p.timer);
  p.revoked.abort();
  byId.delete(p.id);
  if (bySession.get(p.sessionId) === p) bySession.delete(p.sessionId);
  log.info('Preview ended', {
    reason,
    sessionId: p.sessionId,
    agentGroupId: p.agentGroupId,
    containerName: p.containerName,
    port: p.port,
  });
}

export interface OpenPreviewInput {
  sessionId: string;
  agentGroupId: string;
  containerName: string;
  port: number;
  label?: string;
}

/** A new preview from the same session replaces the old one, whose address stops working at once. */
export function openPreview(input: OpenPreviewInput): PreviewInfo {
  if (!PREVIEW_ORIGIN_SUFFIX)
    throw new Error('Live preview is not configured on this host (PREVIEW_ORIGIN_SUFFIX is unset).');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error('--port must be a TCP port number (1-65535).');
  }
  const previous = bySession.get(input.sessionId);
  if (previous) end(previous, 'replaced');
  const label = (input.label ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS) || null;
  const id = randomBytes(16).toString('hex');
  const preview: Preview = {
    id,
    sessionId: input.sessionId,
    agentGroupId: input.agentGroupId,
    containerName: input.containerName,
    port: input.port,
    label,
    expiresAt: Date.now() + PREVIEW_TTL_MS,
    timer: setTimeout(() => end(preview, 'expired'), PREVIEW_TTL_MS),
    revoked: new AbortController(),
  };
  preview.timer.unref();
  bySession.set(input.sessionId, preview);
  byId.set(id, preview);
  log.info('Preview opened', {
    sessionId: input.sessionId,
    agentGroupId: input.agentGroupId,
    containerName: input.containerName,
    port: input.port,
    label,
  });
  return info(preview);
}

export function closePreview(sessionId: string): { closed: boolean } {
  const preview = bySession.get(sessionId);
  if (preview) end(preview, 'closed');
  return { closed: preview !== undefined };
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
