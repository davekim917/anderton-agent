import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ suffix: 'preview.example.test' }));

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  get PREVIEW_ORIGIN_SUFFIX() {
    return h.suffix;
  },
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../../log.js';
import {
  closePreview,
  endPreviewForContainer,
  openPreview,
  PREVIEW_TTL_MS,
  previewStatus,
  resolvePreview,
} from './service.js';

const SESSION = 'sess-example';
const base = { sessionId: SESSION, agentGroupId: 'ag-example', containerName: 'nanoclaw-v2-example-1', port: 5173 };
const idOf = (url: string) => new URL(url).hostname.split('.')[0];
const ended = () =>
  vi
    .mocked(log.info)
    .mock.calls.filter((c) => c[0] === 'Preview ended')
    .map((c) => (c[1] as { reason: string }).reason);

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(log.info).mockClear();
  h.suffix = 'preview.example.test';
});

afterEach(() => {
  closePreview(SESSION);
  vi.useRealTimers();
});

describe('preview lifecycle', () => {
  it('opens a random-id URL under the suffix that resolves to the container port for 8 hours', () => {
    const now = Date.now();
    const p = openPreview({ ...base, label: '  checkout\n redesign ' });
    expect(p.url).toMatch(/^https:\/\/[0-9a-f]{32}\.preview\.example\.test$/);
    expect(p).toMatchObject({ port: 5173, label: 'checkout redesign' });
    expect(Date.parse(p.expiresAt)).toBe(now + PREVIEW_TTL_MS);
    expect(resolvePreview(idOf(p.url))).toMatchObject({ containerName: base.containerName, port: 5173 });
    expect(previewStatus(SESSION)).toEqual(p);
    expect(vi.mocked(log.info).mock.calls.some((c) => c[0] === 'Preview opened')).toBe(true);
  });

  it('a new open from the same session replaces the old one, whose address stops working', () => {
    const first = openPreview(base);
    const { signal } = { signal: resolvePreview(idOf(first.url))!.revoked };
    const second = openPreview({ ...base, port: 3000 });
    expect(idOf(second.url)).not.toBe(idOf(first.url));
    expect(resolvePreview(idOf(first.url))).toBeNull();
    expect(resolvePreview(idOf(second.url))).toMatchObject({ containerName: base.containerName, port: 3000 });
    expect(ended()).toEqual(['replaced']);
    expect(signal.aborted).toBe(true);
  });

  it('close ends it at once; a second close reports nothing open', () => {
    const p = openPreview(base);
    const { revoked } = resolvePreview(idOf(p.url))!;
    expect(closePreview(SESSION)).toEqual({ closed: true });
    expect(revoked.aborted).toBe(true);
    expect(resolvePreview(idOf(p.url))).toBeNull();
    expect(previewStatus(SESSION)).toBeNull();
    expect(closePreview(SESSION)).toEqual({ closed: false });
    expect(ended()).toEqual(['closed']);
  });

  it('expires 8 hours after open', () => {
    const p = openPreview(base);
    vi.advanceTimersByTime(PREVIEW_TTL_MS - 1);
    const { revoked } = resolvePreview(idOf(p.url))!;
    expect(revoked.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(revoked.aborted).toBe(true);
    expect(resolvePreview(idOf(p.url))).toBeNull();
    expect(previewStatus(SESSION)).toBeNull();
    expect(ended()).toEqual(['expired']);
  });

  it('ends when its container exits, but not when a different container of the session does', () => {
    const p = openPreview(base);
    endPreviewForContainer(SESSION, 'nanoclaw-v2-example-0');
    expect(resolvePreview(idOf(p.url))).not.toBeNull();
    const { revoked } = resolvePreview(idOf(p.url))!;
    endPreviewForContainer(SESSION, base.containerName);
    expect(revoked.aborted).toBe(true);
    expect(resolvePreview(idOf(p.url))).toBeNull();
    expect(ended()).toEqual(['container exited']);
  });

  it('keeps sessions apart', () => {
    const mine = openPreview(base);
    const theirs = openPreview({ ...base, sessionId: 'sess-other', containerName: 'nanoclaw-v2-other-1' });
    closePreview(SESSION);
    expect(resolvePreview(idOf(theirs.url))).not.toBeNull();
    expect(resolvePreview(idOf(mine.url))).toBeNull();
    closePreview('sess-other');
  });

  it('refuses when the feature is off or the port is not a TCP port', () => {
    expect(() => openPreview({ ...base, port: 0 })).toThrow(/--port/);
    expect(() => openPreview({ ...base, port: 70000 })).toThrow(/--port/);
    h.suffix = '';
    expect(() => openPreview(base)).toThrow(/PREVIEW_ORIGIN_SUFFIX/);
  });
});
