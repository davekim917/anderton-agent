/**
 * `engage_senders` against the real router, central DB and permissions gates: a mention-mode wiring on a gated
 * channel (request_approval + sender_scope=known) engages on a listed sender's posts, and nothing else about
 * engagement or admission moves.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from './channels/adapter.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  initMigratedTestDb,
} from './db/index.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-engage-senders') }));
vi.mock('./config.js', async () => ({ ...(await vi.importActual('./config.js')), DATA_DIR: TEST_DIR }));

const CHANNEL = 'es-slack';
const ALERT_BOT = 'alert-bot';
const OTHER_BOT = 'other-bot';
const HUMAN = 'human-1';
const now = () => new Date().toISOString();

const threadedAdapter = () => ({
  name: CHANNEL,
  channelType: CHANNEL,
  supportsThreads: true,
  async setup() {},
  async teardown() {},
  isConnected: () => true,
  async deliver() {
    return undefined;
  },
});

function post(
  id: string,
  sender: string,
  opts: { threadId: string; text: string; isMention?: boolean; isBot?: boolean },
): InboundEvent {
  return {
    channelType: CHANNEL,
    platformId: 'es:C1',
    threadId: opts.threadId,
    message: {
      id,
      kind: 'chat',
      content: JSON.stringify({
        text: opts.text,
        sender: sender,
        senderId: sender,
        author: { userId: sender, isBot: opts.isBot ?? true },
      }),
      timestamp: now(),
      isMention: opts.isMention,
      isGroup: true,
    },
  };
}

async function member(platformUserId: string): Promise<void> {
  const { createUser } = await import('./modules/permissions/db/users.js');
  const { addMember } = await import('./modules/permissions/db/agent-group-members.js');
  const userId = `${CHANNEL}:${platformUserId}`;
  await createUser({ id: userId, kind: CHANNEL, display_name: null, created_at: now() });
  await addMember({ user_id: userId, agent_group_id: 'ag-es', added_by: null, added_at: now() });
}

/** Trigger flags of the stored copies of one platform message, across every session of the agent. */
async function storedTriggers(messageId: string): Promise<number[]> {
  const { getSessionsByAgentGroup } = await import('./db/sessions.js');
  const triggers: number[] = [];
  for (const session of await getSessionsByAgentGroup('ag-es')) {
    const path = inboundDbPath('ag-es', session.id);
    if (!fs.existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    const row = db.prepare('SELECT trigger FROM messages_in WHERE id = ?').get(`${messageId}:ag-es`) as
      | { trigger: number }
      | undefined;
    db.close();
    if (row) triggers.push(row.trigger);
  }
  return triggers;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  await import('./modules/permissions/index.js');

  await createAgentGroup({
    id: 'ag-es',
    name: 'Ops Agent',
    folder: 'ops-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-es',
    channel_type: CHANNEL,
    platform_id: 'es:C1',
    name: 'ops',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-es',
    messaging_group_id: 'mg-es',
    agent_group_id: 'ag-es',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'known',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: now(),
  });
  await getDb().run(
    'UPDATE messaging_group_agents SET engage_senders = ? WHERE id = ?',
    JSON.stringify([`${CHANNEL}:${ALERT_BOT}`]),
    'mga-es',
  );

  const { registerChannelAdapter, initChannelAdapters } = await import('./channels/channel-registry.js');
  registerChannelAdapter(CHANNEL, { factory: threadedAdapter });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));

  const { wakeContainer } = await import('./container-runner.js');
  vi.mocked(wakeContainer).mockClear();
});

afterEach(async () => {
  const { teardownChannelAdapters } = await import('./channels/channel-registry.js');
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('engage_senders on a mention-mode wiring', () => {
  it('a listed bot root post engages with no mention', async () => {
    await member(ALERT_BOT);
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(post('alert-1', ALERT_BOT, { threadId: 'es:C1:100.1', text: 'nightly ended in failed state.' }));

    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(await storedTriggers('alert-1')).toEqual([1]);
  });

  it('a listed bot reply inside an existing thread engages too', async () => {
    await member(ALERT_BOT);
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(post('alert-2', ALERT_BOT, { threadId: 'es:C1:90.0', text: 'nightly recovered.' }));

    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(await storedTriggers('alert-2')).toEqual([1]);
  });

  it('an unlisted bot is only accumulated, even as a member', async () => {
    await member(OTHER_BOT);
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(post('other-1', OTHER_BOT, { threadId: 'es:C1:101.1', text: 'nightly ended in failed state.' }));

    expect(wakeContainer).not.toHaveBeenCalled();
    expect(await storedTriggers('other-1')).toEqual([0]);
  });

  it('leaves mention engagement as it was', async () => {
    await member(HUMAN);
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(post('human-plain', HUMAN, { threadId: 'es:C1:102.1', text: 'morning all', isBot: false }));
    expect(wakeContainer).not.toHaveBeenCalled();

    await routeInbound(
      post('human-mention', HUMAN, { threadId: 'es:C1:103.1', text: '@Ops Agent look', isMention: true, isBot: false }),
    );
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(await storedTriggers('human-mention')).toEqual([1]);
  });

  // Each case leaves exactly one gate able to refuse a listed non-member, so bypassing either gate alone fails here.
  it.each([
    ['the access gate', 'strict', 'all'],
    ['the sender-scope gate', 'public', 'known'],
  ])(
    'admits nobody: %s still refuses a listed non-member, which is neither engaged nor stored',
    async (_gate, policy, scope) => {
      await getDb().run('UPDATE messaging_groups SET unknown_sender_policy = ? WHERE id = ?', policy, 'mg-es');
      await getDb().run('UPDATE messaging_group_agents SET sender_scope = ? WHERE id = ?', scope, 'mga-es');
      const { routeInbound } = await import('./router.js');
      const { wakeContainer } = await import('./container-runner.js');

      await routeInbound(
        post('alert-stranger', ALERT_BOT, { threadId: 'es:C1:104.1', text: 'nightly ended in failed state.' }),
      );

      expect(wakeContainer).not.toHaveBeenCalled();
      // Accumulate stores every message engagement merely skipped, so no copy at all means a gate refused it.
      expect(await storedTriggers('alert-stranger')).toEqual([]);
    },
  );
});
