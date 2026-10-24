/**
 * The DM pointer a thread-delivered card sends to the human who has to answer
 * it. Real central DB and a real session inbound.db; the delivery adapter and
 * the channel registry are fakes, so each case reads what would have been DMed.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, createSession, updatePendingApprovalStatus } from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { sendCardPointer } from './card-pointer.js';
import { registerChoiceHandler } from './choices.js';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-card-pointer') }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

const CHANNEL = 'slack-example';
const WORK_PLATFORM = 'slack:C0WORK';
const THREAD = 'slack:C0WORK:1786621514.008659';
const CARD_TS = '1786621599.000100';
const CARD_LINK = `https://example-labs.slack.com/archives/C0WORK/p1786621599000100?thread_ts=1786621514.008659&cid=C0WORK`;

vi.mock('../../channels/channel-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channels/channel-registry.js')>();
  const { slackMessagePermalink, registerSlackBot } = await import('../../channels/slack-mentions.js');
  registerSlackBot('slack-example', {
    userId: 'U0BOT',
    username: 'bot',
    teamId: 'T0EXAMPLE',
    workspaceUrl: 'https://example-labs.slack.com/',
  });
  const adapter = {
    messagePermalink: (platformId: string, threadId: string | null, messageId: string) =>
      slackMessagePermalink('slack-example', platformId, threadId, messageId),
  };
  return {
    ...actual,
    getChannelAdapter: (key: string) => (key.startsWith('slack-example') ? adapter : undefined),
  };
});

const CHOICE_ACTION = 'test_choice';
const GATE_ACTION = 'test_gate';
registerChoiceHandler(CHOICE_ACTION, async () => null);

const REQUESTER = `${CHANNEL}:U0REQ`;
const ADMIN = `${CHANNEL}:U0ADMIN`;

interface Delivered {
  channelType: string;
  platformId: string;
  threadId: string | null;
  text: string;
}
let delivered: Delivered[];
let session: Session;

function now(): string {
  return new Date().toISOString();
}

function insertInbound(content: Record<string, unknown>, opts: { kind?: string; timestamp?: string } = {}): void {
  const db = new Database(inboundDbPath('ag-1', 'sess-1'));
  try {
    db.prepare(`INSERT INTO messages_in (id, kind, timestamp, channel_type, content) VALUES (?, ?, ?, ?, ?)`).run(
      `in-${Math.random().toString(36).slice(2, 8)}`,
      opts.kind ?? 'chat-sdk',
      opts.timestamp ?? now(),
      CHANNEL,
      JSON.stringify(content),
    );
  } finally {
    db.close();
  }
}

function humanSays(userId: string, timestamp?: string): void {
  insertInbound({ text: 'please do the thing', author: { userId, fullName: 'Someone', isBot: false } }, { timestamp });
}

async function card(
  overrides: { action?: string; payload?: Record<string, unknown>; platformId?: string; threadId?: string | null } = {},
): Promise<string> {
  const approvalId = `appr-${Math.random().toString(36).slice(2, 8)}`;
  await createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    agent_group_id: 'ag-1',
    request_id: approvalId,
    action: overrides.action ?? GATE_ACTION,
    payload: JSON.stringify(overrides.payload ?? {}),
    created_at: now(),
    title: 'Run the migration?',
    question: 'It drops a column.',
    options_json: '[]',
    channel_type: CHANNEL,
    platform_id: overrides.platformId ?? WORK_PLATFORM,
    thread_id: overrides.threadId === undefined ? THREAD : overrides.threadId,
    platform_message_id: CARD_TS,
  });
  return approvalId;
}

async function dmRow(id: string, platformId: string, userId: string, isGroup = 0): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: CHANNEL,
    platform_id: platformId,
    name: id,
    is_group: isGroup,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({ user_id: userId, channel_type: CHANNEL, messaging_group_id: id, resolved_at: now() });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-work',
    channel_type: CHANNEL,
    platform_id: WORK_PLATFORM,
    name: 'work',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-work',
    thread_id: THREAD,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  initSessionFolder('ag-1', 'sess-1');

  await upsertUser({ id: REQUESTER, kind: CHANNEL, display_name: 'Riley Requester', created_at: now() });
  await upsertUser({ id: ADMIN, kind: CHANNEL, display_name: 'Avery Admin', created_at: now() });
  await grantRole({ user_id: ADMIN, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  await dmRow('mg-dm-req', 'slack:D0REQ', REQUESTER);
  await dmRow('mg-dm-admin', 'slack:D0ADMIN', ADMIN);

  delivered = [];
  const adapter: ChannelDeliveryAdapter = {
    async deliver(channelType, platformId, threadId, _kind, content) {
      delivered.push({ channelType, platformId, threadId, text: (JSON.parse(content) as { text: string }).text });
      return 'pm-dm';
    },
  };
  setDeliveryAdapter(adapter);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('sendCardPointer', () => {
  it('DMs the requester a link to the card when they can answer it', async () => {
    humanSays('U0REQ');
    const approvalId = await card();

    expect(await sendCardPointer(approvalId, session)).toBe('sent-requester');

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ channelType: CHANNEL, platformId: 'slack:D0REQ', threadId: null });
    expect(delivered[0].text).toBe(`Your call is needed: Run the migration? — ${CARD_LINK}`);
  });

  it('names the latest human, not a bot that spoke after them', async () => {
    humanSays('U0REQ', '2026-01-01T00:00:00.000Z');
    insertInbound(
      { text: 'on it', author: { userId: 'sibling-bot', isBot: true } },
      { timestamp: '2026-01-01T00:00:01.000Z' },
    );
    insertInbound(
      { text: 'gate failed', sender: 'system', senderId: 'system' },
      { kind: 'chat', timestamp: '2026-01-01T00:00:02.000Z' },
    );

    expect(await sendCardPointer(await card(), session)).toBe('sent-requester');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0REQ']);
  });

  it('sends nothing when no human asked: only bots and host notes are in the session', async () => {
    insertInbound({ text: 'scheduled run', author: { userId: 'sibling-bot', isBot: true } });
    insertInbound({ text: 'note', sender: 'system', senderId: 'system' }, { kind: 'chat' });

    expect(await sendCardPointer(await card(), session)).toBe('skipped-no-requester');
    expect(delivered).toHaveLength(0);
  });

  it('DMs an approver instead when the requester cannot answer a choice card', async () => {
    humanSays('U0REQ');
    const approvalId = await card({ action: CHOICE_ACTION });

    expect(await sendCardPointer(approvalId, session)).toBe('sent-approver');

    expect(delivered).toHaveLength(1);
    expect(delivered[0].platformId).toBe('slack:D0ADMIN');
    expect(delivered[0].text).toBe(
      `Your call is needed: Run the migration? — ${CARD_LINK}\nRiley Requester asked, and can't answer this card.`,
    );
  });

  it('DMs the requester of a choice card when they hold admin privilege on the group', async () => {
    humanSays('U0ADMIN');

    expect(await sendCardPointer(await card({ action: CHOICE_ACTION }), session)).toBe('sent-requester');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0ADMIN']);
  });

  it('DMs a named approver when the card narrows its answerers past the requester', async () => {
    humanSays('U0ADMIN');
    const other = `${CHANNEL}:U0OTHER`;
    await upsertUser({ id: other, kind: CHANNEL, display_name: 'Other Admin', created_at: now() });
    await grantRole({ user_id: other, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    await dmRow('mg-dm-other', 'slack:D0OTHER', other);

    const approvalId = await card({ action: CHOICE_ACTION, payload: { approvers: [other] } });

    expect(await sendCardPointer(approvalId, session)).toBe('sent-approver');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0OTHER']);
  });

  it('sends nothing when nobody who can answer the card is reachable', async () => {
    humanSays('U0REQ');
    const approvalId = await card({ action: CHOICE_ACTION, payload: { approvers: [`${CHANNEL}:U0GONE`] } });

    expect(await sendCardPointer(approvalId, session)).toBe('skipped-no-recipient');
    expect(delivered).toHaveLength(0);
  });

  it('sends nothing for a card already posted into a DM', async () => {
    humanSays('U0REQ');
    await createMessagingGroup({
      id: 'mg-dm-thread',
      channel_type: CHANNEL,
      platform_id: 'slack:D0CARD',
      name: 'dm',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });

    expect(await sendCardPointer(await card({ platformId: 'slack:D0CARD', threadId: null }), session)).toBe(
      'skipped-card-in-dm',
    );
    expect(delivered).toHaveLength(0);
  });

  it('sends nothing for a card that was answered before the pointer ran', async () => {
    humanSays('U0REQ');
    const approvalId = await card();
    await updatePendingApprovalStatus(approvalId, 'approved');

    expect(await sendCardPointer(approvalId, session)).toBe('skipped-not-pending');
    expect(delivered).toHaveLength(0);
  });

  it('still points at the card in words when no link can be built', async () => {
    humanSays('U0REQ');
    const approvalId = await card({ threadId: 'slack:C0WORK:not-a-ts' });

    expect(await sendCardPointer(approvalId, session)).toBe('sent-requester');
    expect(delivered[0].text).toBe('Your call is needed: Run the migration? — the card is in work.');
  });

  it('never throws when the DM delivery fails', async () => {
    humanSays('U0REQ');
    setDeliveryAdapter({
      async deliver() {
        throw new Error('platform down');
      },
    });

    expect(await sendCardPointer(await card(), session)).toBe('failed');
  });
});
