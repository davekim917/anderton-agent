import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const h = vi.hoisted(() => ({
  session: undefined as unknown,
  ownsOutbound: false,
  routing: { channel_type: 'slack', platform_id: 'C-EXAMPLE', thread_id: 'T-EXAMPLE' } as unknown,
  written: [] as unknown[],
  notified: [] as unknown[],
}));

vi.mock('../../db/sessions.js', () => ({ getSession: async () => h.session }));
vi.mock('../../container-runner.js', async (orig) => ({
  ...(await orig<typeof import('../../container-runner.js')>()),
  containerOwnsOutbound: () => h.ownsOutbound,
}));
vi.mock('../../session-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../session-manager.js')>()),
  withExistingMailboxSession: async (_agentGroupId: string, _sessionId: string, action: (m: unknown) => unknown) =>
    action({ readSessionRouting: () => h.routing, writeOutboundDirect: (row: unknown) => h.written.push(row) }),
}));
vi.mock('../approvals/primitive.js', () => ({
  notifyAgent: async (session: Session, text: string, opts: unknown) => h.notified.push({ session, text, opts }),
}));

import { announcePreviewLost } from './notify.js';

const SESSION = { id: 'sess-example', agent_group_id: 'ag-example' } as Session;
const lost = (reason: 'expired' | 'container exited', label: string | null = 'checkout') => ({
  previewId: 'ab'.repeat(16),
  sessionId: SESSION.id,
  port: 5173,
  label,
  reason,
});

beforeEach(() => {
  h.session = SESSION;
  h.ownsOutbound = false;
  h.routing = { channel_type: 'slack', platform_id: 'C-EXAMPLE', thread_id: 'T-EXAMPLE' };
  h.written = [];
  h.notified = [];
});
afterEach(() => vi.restoreAllMocks());

describe('announcePreviewLost', () => {
  it('tells the agent of an expired link how to reopen it, and writes nothing to the thread', async () => {
    await announcePreviewLost(lost('expired'));
    expect(h.notified).toEqual([
      {
        session: SESSION,
        text: expect.stringContaining('ncl preview open --port 5173'),
        opts: { id: `preview-expired-${'ab'.repeat(16)}` },
      },
    ]);
    expect((h.notified[0] as { text: string }).text).toContain('(checkout)');
    expect(h.written).toEqual([]);
  });

  it("posts to the session's own thread when the container serving the link is gone", async () => {
    await announcePreviewLost(lost('container exited', null));
    expect(h.notified).toEqual([]);
    expect(h.written).toEqual([
      expect.objectContaining({
        id: `preview-lost-${'ab'.repeat(16)}`,
        kind: 'chat',
        platformId: 'C-EXAMPLE',
        channelType: 'slack',
        threadId: 'T-EXAMPLE',
      }),
    ]);
    const content = JSON.parse((h.written[0] as { content: string }).content);
    expect(content).toMatchObject({ _system: { kind: 'preview_lost' } });
    expect(content.text).toMatch(/^The live preview link stopped working/);
  });

  it('writes nothing while a new container owns the outbound mailbox, or the session never woke', async () => {
    h.ownsOutbound = true;
    await announcePreviewLost(lost('container exited'));
    h.ownsOutbound = false;
    h.routing = null;
    await announcePreviewLost(lost('container exited'));
    expect(h.written).toEqual([]);
  });

  it('does nothing for a session that no longer exists', async () => {
    h.session = undefined;
    await announcePreviewLost(lost('expired'));
    await announcePreviewLost(lost('container exited'));
    expect([h.notified, h.written]).toEqual([[], []]);
  });
});
