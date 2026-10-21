import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { resolvePreview } from '../../modules/preview/service.js';
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

afterEach(async () => {
  h.container = 'nanoclaw-v2-example-1';
  await run('close');
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

  it('refuses a session with no running container, a host caller, and a missing port', async () => {
    h.container = null;
    await expect(run('open', { port: 5173 })).rejects.toThrow(/no running container/);
    await expect(run('open', { port: 5173 }, { caller: 'host' })).rejects.toThrow(/agent session/);
    await expect(run('open', {})).rejects.toThrow(/port/);
  });
});
