/**
 * Which posted cards ask for a pointer DM, and that the pointer can never hold or fail the card. What the pointer
 * sends is card-pointer.test.ts. Setup mirrors primitive.test.ts.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { sendCardPointer } from './card-pointer.js';
import { editApprovalCard, requestApprovalOutcome } from './primitive.js';

vi.mock('./card-pointer.js', () => ({ sendCardPointer: vi.fn().mockResolvedValue('sent-requester') }));

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('../../delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../delivery.js')>()),
  settleSessionStatusAfterPublicDelivery: vi.fn().mockResolvedValue(undefined),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-card-pointer-wiring') }));
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';

function now(): string {
  return new Date().toISOString();
}

let session: Session;

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);

  // Authorized approver + a cached DM so ensureUserDm resolves without a
  // platform openDM call.
  await upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  await grantRole({
    user_id: 'slack:admin-1',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('card pointer wiring', () => {
  const okAdapter: ChannelDeliveryAdapter = {
    async deliver() {
      return 'pm-1';
    },
  };

  async function threadSession(): Promise<Session> {
    await createMessagingGroup({
      id: 'mg-work',
      channel_type: DM_CHANNEL,
      platform_id: 'C-work',
      name: 'work',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    const threaded = { ...session, id: 'sess-thread', messaging_group_id: 'mg-work', thread_id: 'C-work:1.2' };
    await createSession(threaded);
    return threaded;
  }

  const base = {
    agentName: 'Agent',
    action: 'test_action',
    payload: {},
    title: 'Test Approval',
    question: 'Approve the thing?',
  };

  it('points once at a card posted into a thread, keyed on its row', async () => {
    setDeliveryAdapter(okAdapter);
    const threaded = await threadSession();

    expect(await requestApprovalOutcome({ ...base, session: threaded, deliveryTarget: 'thread' })).toBe('posted');

    await vi.waitFor(() => expect(sendCardPointer).toHaveBeenCalledTimes(1));
    const [row] = await getPendingApprovalsByAction('test_action');
    expect(sendCardPointer).toHaveBeenCalledWith(row.approval_id, threaded);

    await editApprovalCard(row, 'edited');
    expect(sendCardPointer).toHaveBeenCalledTimes(1);
  });

  it('sends no pointer for a card already delivered to an admin DM', async () => {
    setDeliveryAdapter(okAdapter);

    expect(await requestApprovalOutcome({ ...base, session })).toBe('posted');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendCardPointer).not.toHaveBeenCalled();
  });

  it('keeps the card posted when the pointer fails', async () => {
    setDeliveryAdapter(okAdapter);
    vi.mocked(sendCardPointer).mockRejectedValueOnce(new Error('dm down'));
    const threaded = await threadSession();

    expect(await requestApprovalOutcome({ ...base, session: threaded, deliveryTarget: 'thread' })).toBe('posted');

    await vi.waitFor(() => expect(sendCardPointer).toHaveBeenCalledTimes(1));
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(1);
  });
});
