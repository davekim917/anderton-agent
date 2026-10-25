import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ container: 'nanoclaw-v2-example-1' as string | null }));

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  PREVIEW_ORIGIN_SUFFIX: 'preview.example.test',
}));
vi.mock('../../container-runner.js', () => ({
  containerIdentityFor: () => (h.container ? { containerName: h.container, claimIncarnation: 1 } : null),
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, getDb, initMigratedTestDb } from '../../db/index.js';
import { previewStatus, resolvePreview } from '../../modules/preview/service.js';
import type { CallerContext } from '../frame.js';
import { GROUP_SCOPE_RESOURCES, lookup } from '../registry.js';
import './preview.js';

const agent: CallerContext = {
  caller: 'agent',
  sessionId: 'sess-example',
  agentGroupId: 'ag-example',
  messagingGroupId: 'mg-example',
};

async function run(verb: string, args: Record<string, unknown> = {}, ctx: CallerContext = agent) {
  const cmd = lookup(`preview-${verb}`)!;
  const data = await cmd.handler(cmd.parseArgs(args), ctx);
  return { data, human: cmd.formatHuman?.(data) ?? '' };
}

beforeEach(async () => {
  await initMigratedTestDb();
});

afterEach(async () => {
  h.container = 'nanoclaw-v2-example-1';
  await run('close');
  await closeDb();
});

describe('ncl preview', () => {
  it('is open to a group-scoped agent without approval', () => {
    expect(GROUP_SCOPE_RESOURCES.has('preview')).toBe(true);
    for (const verb of ['open', 'close', 'status']) {
      expect(lookup(`preview-${verb}`)).toMatchObject({
        resource: 'preview',
        access: 'open',
        action: `preview.${verb}`,
      });
    }
  });

  it("open points the URL at the calling session's own container and prints it with the expiry", async () => {
    const { data, human } = await run('open', { port: '5173', label: 'shop' });
    const { url } = data as { url: string };
    expect(resolvePreview(new URL(url).hostname.split('.')[0])).toMatchObject({
      containerName: 'nanoclaw-v2-example-1',
      port: 5173,
    });
    expect(human).toContain(url);
    expect(human).toMatch(/open until/);
  });

  it('status shows the open preview, close ends it', async () => {
    const { data } = await run('open', { port: 5173 });
    expect((await run('status')).human).toContain((data as { url: string }).url);
    expect((await run('close')).human).toBe('Live preview closed.');
    expect((await run('status')).human).toBe('No live preview is open for this session.');
  });

  it.each([
    ['exits', null],
    ['is replaced', 'nanoclaw-v2-example-2'],
  ])('fails, leaving nothing open, when the container %s while the link is being stored', async (_label, next) => {
    const driver = getDb();
    const run_ = driver.run.bind(driver);
    // The container's exit hook ran while the INSERT waited for the database, before the preview existed to end.
    vi.spyOn(driver, 'run').mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (/^\s*INSERT INTO previews/.test(sql)) h.container = next;
      return run_(sql, ...(params as never[]));
    });
    await expect(run('open', { port: 5173 })).rejects.toThrow(/container stopped while the link was being opened/);
    vi.mocked(driver.run).mockRestore();
    expect(previewStatus('sess-example')).toBeNull();
    expect(await getDb().all('SELECT id FROM previews')).toEqual([]);
  });

  it('refuses a session with no running container, a host caller, and a missing port', async () => {
    h.container = null;
    await expect(run('open', { port: 5173 })).rejects.toThrow(/no running container/);
    await expect(run('open', { port: 5173 }, { caller: 'host' })).rejects.toThrow(/agent session/);
    await expect(run('open', {})).rejects.toThrow(/port/);
  });
});
