import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (content: Record<string, unknown>, session: Session) => Promise<void>>(),
  provider: 'claude',
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  notices: [] as string[],
  requester: { kind: 'one', userId: 'slack:U0OWNER' } as
    | { kind: 'one'; userId: string }
    | { kind: 'unclear'; reason: 'nobody' | 'several' },
  approvals: [] as string[],
  approvalHandlers: new Map<
    string,
    (ctx: { payload: Record<string, unknown>; session: Session; userId: string }) => Promise<void>
  >(),
}));

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (
    name: string,
    handler: (content: Record<string, unknown>, session: Session) => Promise<void>,
  ) => fixture.handlers.set(name, handler),
}));
vi.mock('../../db/central-lease.js', () => ({ withCentralSync: async (fn: () => unknown) => fn() }));
vi.mock('../../caller-identity.js', () => ({
  REQUESTER_WINDOW_MS: 900_000,
  resolveRequester: async () => fixture.requester,
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => ({ id, name: 'agent', agent_provider: fixture.provider }),
}));
vi.mock('../../db/container-configs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/container-configs.js')>()),
  getContainerConfig: async () => ({ provider: fixture.provider }),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroupAgentByPair: async () => ({ id: 'wiring-1' }),
  getMessagingGroupByPlatform: async () => null,
  updateMessagingGroupAgent: async (id: string, patch: Record<string, unknown>) => {
    fixture.updates.push({ id, patch });
  },
}));
vi.mock('../../session-manager.js', () => ({ withExistingMailboxSession: async () => undefined }));
vi.mock('../approvals/primitive.js', () => ({
  notifyAgent: async (_session: Session, text: string) => {
    fixture.notices.push(text);
  },
  registerApprovalHandler: (action: string, handler: never) => fixture.approvalHandlers.set(action, handler),
  pickApprover: async () => [],
}));
vi.mock('../approvals/index.js', () => ({
  notifyAgent: async (_session: Session, text: string) => {
    fixture.notices.push(text);
  },
  requestApproval: async (opts: { action: string }) => {
    fixture.approvals.push(opts.action);
    return true;
  },
}));
vi.mock('../permissions/db/user-roles.js', () => ({
  isOwner: () => true,
  isGlobalAdmin: () => false,
  isAdminOfAgentGroup: () => false,
}));

await import('./index.js');

const session = { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1', agent_provider: null } as Session;

function run(action: string, content: Record<string, unknown>): Promise<void> {
  return fixture.handlers.get(action)!(content, session);
}

beforeEach(() => {
  fixture.provider = 'claude';
  fixture.updates.length = 0;
  fixture.notices.length = 0;
  fixture.requester = { kind: 'one', userId: 'slack:U0OWNER' };
  fixture.approvals.length = 0;
});

describe('set_channel_model / set_channel_effort', () => {
  it.each([
    ['set_channel_model', { model: 'claude-future-model-9' }, { default_model: 'claude-future-model-9' }],
    ['set_channel_effort', { effort: 'high' }, { default_effort: 'high' }],
  ])('%s waits for an approver when several people wrote, then runs as them', async (action, content, patch) => {
    fixture.requester = { kind: 'unclear', reason: 'several' };
    await run(action, content);
    expect(fixture.updates).toEqual([]);
    expect(fixture.approvals).toEqual([action]);

    await fixture.approvalHandlers.get(action)!({ payload: content, session, userId: 'slack:U0OWNER' });
    expect(fixture.updates).toEqual([{ id: 'wiring-1', patch }]);
  });

  it.each([
    ['claude', 'claude-future-model-9'],
    ['opencode', 'openrouter/future-model:free'],
  ])('pins a %s model id the flag vocabulary does not know, verbatim', async (provider, model) => {
    fixture.provider = provider;
    await run('set_channel_model', { model });
    expect(fixture.updates).toEqual([{ id: 'wiring-1', patch: { default_model: model } }]);
  });

  it.each([
    ['codex', 'ultra', true],
    ['claude', 'ultra', false],
    ['opencode', 'ultra', false],
    ['claude', 'xhigh', true],
    ['opencode', 'xhigh', false],
    ['opencode', 'high', true],
  ])('on a %s wiring, effort %s is accepted: %s', async (provider, effort, accepted) => {
    fixture.provider = provider;
    await run('set_channel_effort', { effort });
    expect(fixture.updates).toEqual(accepted ? [{ id: 'wiring-1', patch: { default_effort: effort } }] : []);
  });
});
