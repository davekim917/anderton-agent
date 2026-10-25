/**
 * A "host restart" here is `vi.resetModules()` plus a re-import of `service.ts` against the SAME central DB file:
 * fresh module memory, same rows. An in-memory DB would prove nothing, so this suite runs on a file.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migration089 } from '../../db/migrations/089-previews.js';
import type { LostPreview } from './service.js';

const { TEST_DIR, h, logSpy } = vi.hoisted(() => ({
  TEST_DIR: uniqueTmpRoot('test-preview-service'),
  h: { suffix: 'preview.example.test' },
  logSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
const DB_PATH = `${TEST_DIR}/v2.db`;

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  get PREVIEW_ORIGIN_SUFFIX() {
    return h.suffix;
  },
}));
// Not spread: log.ts installs process-wide exit handlers at module scope.
vi.mock('../../log.js', () => ({ log: logSpy, setLogScrubber: vi.fn(), isSurvivableIoError: vi.fn(() => false) }));

interface Host {
  svc: typeof import('./service.js');
  db: typeof import('../../db/connection.js');
}

let host: Host;
let lost: LostPreview[];
const record = (p: LostPreview) => lost.push(p);

async function bootHost(): Promise<Host> {
  vi.resetModules();
  const migrator = new Database(DB_PATH);
  try {
    migration089.up(migrator);
  } finally {
    migrator.close();
  }
  const db = await import('../../db/connection.js');
  await db.initDb(DB_PATH, { role: 'test' });
  const svc = await import('./service.js');
  host = { svc, db };
  return host;
}

async function restartHost(): Promise<Host> {
  // The old process is gone, and its timers with it; the wall clock carries on.
  const now = Date.now();
  vi.clearAllTimers();
  await host.db.closeDb();
  const next = await bootHost();
  vi.setSystemTime(now);
  return next;
}

const rows = () => {
  const reader = new Database(DB_PATH, { readonly: true });
  try {
    return reader.prepare('SELECT id FROM previews').all();
  } finally {
    reader.close();
  }
};
/** Row deletes are not awaited by their synchronous callers. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const SESSION = 'sess-example';
const base = { sessionId: SESSION, agentGroupId: 'ag-example', containerName: 'nanoclaw-v2-example-1', port: 5173 };
const opening = ({ containerName, ...input }: typeof base & { label?: string }) => ({
  ...input,
  containerFor: () => containerName,
});
const idOf = (url: string) => new URL(url).hostname.split('.')[0];
const ended = () =>
  logSpy.info.mock.calls.filter((c) => c[0] === 'Preview ended').map((c) => (c[1] as { reason: string }).reason);

beforeEach(async () => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  logSpy.info.mockClear();
  h.suffix = 'preview.example.test';
  lost = [];
  await bootHost();
  // The first boot of an empty install: nothing to restore, and from here on lost previews are reported.
  await host.svc.restorePreviews(() => null, record);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  await host.db.closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('preview lifecycle', () => {
  it('opens a random-id URL under the suffix that resolves to the container port for 8 hours', async () => {
    const { svc } = host;
    const now = Date.now();
    const p = await svc.openPreview(opening({ ...base, label: '  checkout\n redesign ' }));
    expect(p.url).toMatch(/^https:\/\/[0-9a-f]{32}\.preview\.example\.test$/);
    expect(p).toMatchObject({ port: 5173, label: 'checkout redesign' });
    expect(Date.parse(p.expiresAt)).toBe(now + svc.PREVIEW_TTL_MS);
    expect(svc.resolvePreview(idOf(p.url))).toMatchObject({ containerName: base.containerName, port: 5173 });
    expect(svc.previewStatus(SESSION)).toEqual(p);
    expect(logSpy.info.mock.calls.some((c) => c[0] === 'Preview opened')).toBe(true);
  });

  it('a new open from the same session replaces the old one, whose address stops working', async () => {
    const { svc } = host;
    const first = await svc.openPreview(opening(base));
    const { signal } = { signal: svc.resolvePreview(idOf(first.url))!.revoked };
    const second = await svc.openPreview(opening({ ...base, port: 3000 }));
    expect(idOf(second.url)).not.toBe(idOf(first.url));
    expect(svc.resolvePreview(idOf(first.url))).toBeNull();
    expect(svc.resolvePreview(idOf(second.url))).toMatchObject({ containerName: base.containerName, port: 3000 });
    expect(ended()).toEqual(['replaced']);
    expect(signal.aborted).toBe(true);
    expect(lost).toEqual([]);
  });

  it('close ends it at once; a second close reports nothing open', async () => {
    const { svc } = host;
    const p = await svc.openPreview(opening(base));
    const { revoked } = svc.resolvePreview(idOf(p.url))!;
    expect(await svc.closePreview(SESSION)).toEqual({ closed: true });
    expect(revoked.aborted).toBe(true);
    expect(svc.resolvePreview(idOf(p.url))).toBeNull();
    expect(svc.previewStatus(SESSION)).toBeNull();
    expect(await svc.closePreview(SESSION)).toEqual({ closed: false });
    expect(ended()).toEqual(['closed']);
    expect(lost).toEqual([]);
  });

  it('expires 8 hours after open and reports the link lost to an agent that still runs', async () => {
    const { svc } = host;
    const p = await svc.openPreview(opening({ ...base, label: 'checkout' }));
    vi.advanceTimersByTime(svc.PREVIEW_TTL_MS - 1);
    const { revoked } = svc.resolvePreview(idOf(p.url))!;
    expect(revoked.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(revoked.aborted).toBe(true);
    expect(svc.resolvePreview(idOf(p.url))).toBeNull();
    expect(svc.previewStatus(SESSION)).toBeNull();
    expect(ended()).toEqual(['expired']);
    expect(lost).toEqual([
      { previewId: idOf(p.url), sessionId: SESSION, port: 5173, label: 'checkout', reason: 'expired' },
    ]);
  });

  it('ends when its container exits, but not when a different container of the session does', async () => {
    const { svc } = host;
    const p = await svc.openPreview(opening(base));
    svc.endPreviewForContainer(SESSION, 'nanoclaw-v2-example-0');
    expect(svc.resolvePreview(idOf(p.url))).not.toBeNull();
    const { revoked } = svc.resolvePreview(idOf(p.url))!;
    svc.endPreviewForContainer(SESSION, base.containerName);
    expect(revoked.aborted).toBe(true);
    expect(svc.resolvePreview(idOf(p.url))).toBeNull();
    expect(ended()).toEqual(['container exited']);
    expect(lost.map((l) => [l.previewId, l.reason])).toEqual([[idOf(p.url), 'container exited']]);
  });

  it('keeps sessions apart', async () => {
    const { svc } = host;
    const mine = await svc.openPreview(opening(base));
    const theirs = await svc.openPreview(
      opening({ ...base, sessionId: 'sess-other', containerName: 'nanoclaw-v2-other-1' }),
    );
    await svc.closePreview(SESSION);
    expect(svc.resolvePreview(idOf(theirs.url))).not.toBeNull();
    expect(svc.resolvePreview(idOf(mine.url))).toBeNull();
  });

  it('refuses when the feature is off or the port is not a TCP port', async () => {
    const { svc } = host;
    await expect(svc.openPreview(opening({ ...base, port: 0 }))).rejects.toThrow(/--port/);
    await expect(svc.openPreview(opening({ ...base, port: 70000 }))).rejects.toThrow(/--port/);
    h.suffix = '';
    await expect(svc.openPreview(opening(base))).rejects.toThrow(/PREVIEW_ORIGIN_SUFFIX/);
    expect(rows()).toEqual([]);
  });
});

describe('a live preview across a host restart', () => {
  const adopted = (containers: Record<string, string>) => (sessionId: string) => containers[sessionId] ?? null;

  it('keeps working when the new host adopted its container, and still ends at its original expiry', async () => {
    const opened = await host.svc.openPreview(opening({ ...base, label: 'checkout' }));
    const openedAt = Date.now();
    vi.advanceTimersByTime(60 * 60_000);

    const { svc } = await restartHost();
    expect(await svc.restorePreviews(adopted({ [SESSION]: base.containerName }), record)).toEqual({
      restored: 1,
      dropped: 0,
    });

    expect(svc.resolvePreview(idOf(opened.url))).toMatchObject({ containerName: base.containerName, port: 5173 });
    expect(svc.previewStatus(SESSION)).toEqual(opened);
    expect(svc.previewHeldUntilMs(SESSION)).toBe(openedAt + svc.PREVIEW_TTL_MS);
    vi.advanceTimersByTime(svc.PREVIEW_TTL_MS - 60 * 60_000 - 1);
    expect(svc.resolvePreview(idOf(opened.url))).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(svc.previewStatus(SESSION)).toBeNull();
    expect(lost.map((l) => l.reason)).toEqual(['expired']);
    await settle();
    expect(rows()).toEqual([]);
  });

  it('is dropped and reported when its container did not survive, and a later boot finds nothing', async () => {
    const opened = await host.svc.openPreview(opening(base));

    const { svc } = await restartHost();
    expect(await svc.restorePreviews(adopted({ [SESSION]: 'nanoclaw-v2-example-2' }), record)).toEqual({
      restored: 0,
      dropped: 1,
    });
    expect(svc.resolvePreview(idOf(opened.url))).toBeNull();
    expect(svc.previewHeldUntilMs(SESSION)).toBeNull();
    expect(lost).toEqual([
      { previewId: idOf(opened.url), sessionId: SESSION, port: 5173, label: null, reason: 'container exited' },
    ]);
    await settle();
    expect(rows()).toEqual([]);

    const next = await restartHost();
    expect(await next.svc.restorePreviews(adopted({ [SESSION]: base.containerName }), record)).toEqual({
      restored: 0,
      dropped: 0,
    });
  });

  it('reports a link that expired while the host was down as expired when its container still runs', async () => {
    const opened = await host.svc.openPreview(opening(base));
    const { svc } = await restartHost();
    vi.setSystemTime(Date.now() + svc.PREVIEW_TTL_MS);
    expect(await svc.restorePreviews(adopted({ [SESSION]: base.containerName }), record)).toEqual({
      restored: 0,
      dropped: 1,
    });
    expect(svc.resolvePreview(idOf(opened.url))).toBeNull();
    expect(lost.map((l) => [l.previewId, l.reason])).toEqual([[idOf(opened.url), 'expired']]);
  });

  it('does not bring back a link its agent closed or replaced', async () => {
    const closed = await host.svc.openPreview(opening(base));
    await host.svc.closePreview(SESSION);
    const other = { ...base, sessionId: 'sess-other', containerName: 'nanoclaw-v2-other-1' };
    const first = await host.svc.openPreview(opening(other));
    const second = await host.svc.openPreview(opening(other));
    await settle();

    const { svc } = await restartHost();
    expect(
      await svc.restorePreviews(
        adopted({ [SESSION]: base.containerName, [other.sessionId]: other.containerName }),
        record,
      ),
    ).toEqual({
      restored: 1,
      dropped: 0,
    });
    expect(svc.resolvePreview(idOf(closed.url))).toBeNull();
    expect(svc.resolvePreview(idOf(first.url))).toBeNull();
    expect(svc.resolvePreview(idOf(second.url))).not.toBeNull();
    expect(lost).toEqual([]);
  });

  function failNext(statement: 'INSERT' | 'DELETE', { persistent = false } = {}): void {
    const driver = host.db.getDb();
    const run = driver.run.bind(driver);
    vi.spyOn(driver, 'run').mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (sql.trimStart().startsWith(statement)) {
        if (!persistent) vi.mocked(driver.run).mockRestore();
        throw new Error('disk I/O error');
      }
      return run(sql, ...(params as never[]));
    });
  }

  it('a close the host cannot record fails, and the link stays open rather than coming back after a restart', async () => {
    const opened = await host.svc.openPreview(opening(base));
    failNext('DELETE');
    await expect(host.svc.closePreview(SESSION)).rejects.toThrow(/disk I\/O error/);
    expect(host.svc.resolvePreview(idOf(opened.url))).not.toBeNull();
    expect(await host.svc.closePreview(SESSION)).toEqual({ closed: true });

    const { svc } = await restartHost();
    expect(await svc.restorePreviews(adopted({ [SESSION]: base.containerName }), record)).toEqual({
      restored: 0,
      dropped: 0,
    });
    expect(svc.resolvePreview(idOf(opened.url))).toBeNull();
  });

  it('a replacement the host cannot record fails, and the old link is not handed back after a restart', async () => {
    const first = await host.svc.openPreview(opening(base));
    failNext('DELETE');
    await expect(host.svc.openPreview(opening({ ...base, port: 3000 }))).rejects.toThrow(/disk I\/O error/);
    expect(host.svc.resolvePreview(idOf(first.url))).toMatchObject({ port: 5173 });
    const second = await host.svc.openPreview(opening({ ...base, port: 3000 }));

    const { svc } = await restartHost();
    expect(await svc.restorePreviews(adopted({ [SESSION]: base.containerName }), record)).toEqual({
      restored: 1,
      dropped: 0,
    });
    expect(svc.resolvePreview(idOf(first.url))).toBeNull();
    expect(svc.resolvePreview(idOf(second.url))).toMatchObject({ port: 3000 });
  });

  it('a replacement whose new row cannot be stored fails, and the old link still comes back after a restart', async () => {
    const first = await host.svc.openPreview(opening(base));
    failNext('INSERT');
    await expect(host.svc.openPreview(opening({ ...base, port: 3000 }))).rejects.toThrow(/disk I\/O error/);
    expect(host.svc.resolvePreview(idOf(first.url))).toMatchObject({ port: 5173 });

    const { svc } = await restartHost();
    expect(await svc.restorePreviews(adopted({ [SESSION]: base.containerName }), record)).toEqual({
      restored: 1,
      dropped: 0,
    });
    expect(svc.resolvePreview(idOf(first.url))).toMatchObject({ port: 5173 });
  });

  it('a replacement that fails under a lasting storage fault leaves the old link the one a restart brings back', async () => {
    const first = await host.svc.openPreview(opening(base));
    failNext('DELETE', { persistent: true });
    await expect(host.svc.openPreview(opening({ ...base, port: 3000 }))).rejects.toThrow(/disk I\/O error/);

    const { svc } = await restartHost();
    expect(await svc.restorePreviews(adopted({ [SESSION]: base.containerName }), record)).toEqual({
      restored: 1,
      dropped: 0,
    });
    expect(svc.resolvePreview(idOf(first.url))).toMatchObject({ port: 5173 });
  });

  it('restores nothing when the feature has been turned off', async () => {
    const opened = await host.svc.openPreview(opening(base));
    h.suffix = '';
    const { svc } = await restartHost();
    expect(await svc.restorePreviews(adopted({ [SESSION]: base.containerName }), record)).toEqual({
      restored: 0,
      dropped: 1,
    });
    expect(svc.resolvePreview(idOf(opened.url))).toBeNull();
  });
});
