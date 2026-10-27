/**
 * Tests for chat-invokable access grants. Exercises:
 *   - _resolveTargetUserId: namespaced id, <@mention>, bare handle, Slack
 *     alias pipe, Discord role-mention rejection
 *   - resolveRequester: who an action acts for, from the session's recent
 *     inbound rows; several people or nobody is unclear
 *   - an unclear requester holds the action for an approver, whose click then
 *     runs it as them
 *   - handleGrantAccess: authority tiers (owner, global_admin,
 *     scoped_admin, stranger), role gating (admin vs member), idempotency,
 *     missing agent group, bad args
 *   - handleRevokeAccess: authority + escalation blocks
 *   - handleListAccess: readable by anyone
 *
 * notifyAgent is mocked — its real implementation writes to a session
 * directory and wakes a container, neither of which are available in a
 * unit-test harness. We capture the messages it would have sent so the
 * tests can assert on the user-visible outcome.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// The requester is read from the session's real mailbox, so these tests run
// against a real temp session mailbox rather than an in-memory stand-in.
const { TEST_DIR, GROUPS_DIR } = vi.hoisted(() => {
  // path.join isn't usable here: vitest's import-hoisting transform turns
  // `path` into a lazily-initialized binding, and vi.hoisted() runs before
  // that initialization, so referencing it throws a TDZ ReferenceError.
  const DATA_DIR = uniqueTmpRoot('test-permissions-grant');
  return { TEST_DIR: DATA_DIR, GROUPS_DIR: `${DATA_DIR}/groups` };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR,
  };
});

const notifyCalls: Array<{ sessionId: string; text: string }> = [];
const approvalCalls: Array<{
  action: string;
  payload: Record<string, unknown>;
  question: string;
  approvers?: string[];
  onlyRecipientAnswers?: boolean;
}> = [];
// Lets a case run arbitrary work immediately BEFORE the handler's apply block
// (`grant_access apply` / `revoke_access apply`) takes the lease — the last
// point at which a concurrent grant or revoke can still land, since the
// re-check and the write inside the block are one synchronous turn
// (#460 round 2). Inert unless a case arms it.
const beforeApply = vi.hoisted(() => ({
  label: null as string | null,
  run: null as null | (() => Promise<void>),
}));
vi.mock('../../db/central-lease.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/central-lease.js')>();
  return {
    ...real,
    withCentralSync: (async (fn: () => unknown, label?: string) => {
      if (beforeApply.run && label === beforeApply.label) {
        const run = beforeApply.run;
        beforeApply.run = null;
        await run();
      }
      return (real.withCentralSync as (fn: () => unknown, label?: string) => Promise<unknown>)(fn, label);
    }) as typeof real.withCentralSync,
  };
});

vi.mock('../approvals/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../approvals/index.js')>()),
  notifyAgent: (session: { id: string }, text: string) => {
    notifyCalls.push({ sessionId: session.id, text });
  },
  requestApproval: async (opts: {
    action: string;
    payload: Record<string, unknown>;
    question: string;
    approvers?: string[];
    onlyRecipientAnswers?: boolean;
  }) => {
    approvalCalls.push({
      action: opts.action,
      payload: opts.payload,
      question: opts.question,
      approvers: opts.approvers,
      onlyRecipientAnswers: opts.onlyRecipientAnswers,
    });
    return true;
  },
}));

import { closeDb, createAgentGroup, createMessagingGroup, initMigratedTestDb } from '../../db/index.js';
import { withCentralSync } from '../../db/central-lease.js';
import { initSessionFolder } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { REQUESTER_WINDOW_MS, resolveRequester } from '../../caller-identity.js';
import { getApprovalHandler } from '../approvals/primitive.js';
import type { PendingApproval } from '../../types.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { addMember, hasMembershipRow, isMember } from './db/agent-group-members.js';
import { createUser } from './db/users.js';
import { grantRole, isAdminOfAgentGroup, isOwner, revokeRole } from './db/user-roles.js';
import { _resolveTargetUserId, handleGrantAccess, handleListAccess, handleRevokeAccess } from './grant.js';

function now(): string {
  return new Date().toISOString();
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-helper',
    messaging_group_id: 'mg-test',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
    ...overrides,
  };
}

function makeMg(id: string, channelType: string, platformId: string): MessagingGroup {
  return {
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  };
}

function makeAg(id: string, folder: string, name: string): AgentGroup {
  return { id, folder, name, agent_provider: null, created_at: now() };
}

/** Write straight into the session's real inbound.db, the way the host would. */
function insertChatInbound(
  content: Record<string, unknown>,
  opts: { channelType?: string; timestamp?: string; kind?: string } = {},
): void {
  const db = new Database(inboundDbPath('ag-helper', 'sess-test'));
  try {
    db.prepare(`INSERT INTO messages_in (id, kind, timestamp, channel_type, content) VALUES (?, ?, ?, ?, ?)`).run(
      `in-${Math.random().toString(36).slice(2, 8)}`,
      opts.kind ?? 'chat',
      opts.timestamp ?? now(),
      opts.channelType ?? 'slack-example-labs',
      JSON.stringify(content),
    );
  } finally {
    db.close();
  }
}

function insertRawInbound(id: string, content: string): void {
  const db = new Database(inboundDbPath('ag-helper', 'sess-test'));
  try {
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, channel_type, content) VALUES (?, 'chat', ?, 'slack-example-labs', ?)`,
    ).run(id, now(), content);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  notifyCalls.length = 0;
  approvalCalls.length = 0;
  beforeApply.label = null;
  beforeApply.run = null;
  initSessionFolder('ag-helper', 'sess-test');

  await createMessagingGroup(makeMg('mg-test', 'slack-example-labs', 'slack:C1'));
  await createAgentGroup(makeAg('ag-helper', 'example-labs-v2', 'helper'));
  await createAgentGroup(makeAg('ag-other', 'other', 'other'));

  await createUser({
    id: 'slack-example-labs:OWNER',
    kind: 'slack-example-labs',
    display_name: 'Owner',
    created_at: now(),
  });
  await createUser({
    id: 'slack-example-labs:GADMIN',
    kind: 'slack-example-labs',
    display_name: 'GlobalAdmin',
    created_at: now(),
  });
  await createUser({
    id: 'slack-example-labs:SADMIN',
    kind: 'slack-example-labs',
    display_name: 'ScopedAdmin',
    created_at: now(),
  });
  await createUser({
    id: 'slack-example-labs:STRANGER',
    kind: 'slack-example-labs',
    display_name: 'Stranger',
    created_at: now(),
  });
  // Target users that test-local addMember/grantRole calls reference before
  // the handler's own ensureUserExists has a chance to create them.
  await createUser({
    id: 'slack-example-labs:BOB',
    kind: 'slack-example-labs',
    display_name: 'Bob',
    created_at: now(),
  });
  await createUser({
    id: 'slack-example-labs:CAROL',
    kind: 'slack-example-labs',
    display_name: 'Carol',
    created_at: now(),
  });

  await grantRole({
    user_id: 'slack-example-labs:OWNER',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await grantRole({
    user_id: 'slack-example-labs:GADMIN',
    role: 'admin',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await grantRole({
    user_id: 'slack-example-labs:SADMIN',
    role: 'admin',
    agent_group_id: 'ag-helper',
    granted_by: null,
    granted_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('_resolveTargetUserId', () => {
  it('returns a namespaced id as-is', async () => {
    expect(await _resolveTargetUserId('slack-example-labs:U1', makeSession())).toBe('slack-example-labs:U1');
  });

  it('unwraps <@Uxxx> mentions and prepends channel_type', async () => {
    expect(await _resolveTargetUserId('<@U12345>', makeSession())).toBe('slack-example-labs:U12345');
  });

  it('strips a Slack display-alias pipe in the mention', async () => {
    expect(await _resolveTargetUserId('<@U12345|operator>', makeSession())).toBe('slack-example-labs:U12345');
  });

  it('rejects Discord role mentions (<@&snowflake>)', async () => {
    expect(await _resolveTargetUserId('<@&12345>', makeSession())).toBeNull();
  });

  it('accepts bare handles and prepends channel_type', async () => {
    expect(await _resolveTargetUserId('U12345', makeSession())).toBe('slack-example-labs:U12345');
  });

  it('returns null when the session has no messaging group', async () => {
    expect(await _resolveTargetUserId('U12345', makeSession({ messaging_group_id: null }))).toBeNull();
  });
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const OWNER_ONLY = { kind: 'one', userId: 'slack-example-labs:OWNER' };

describe('resolveRequester', () => {
  it('reads senderId from a recent chat inbound', async () => {
    insertChatInbound({ senderId: 'slack-example-labs:OWNER', text: 'hi' });
    expect(await resolveRequester(makeSession())).toEqual(OWNER_ONLY);
  });

  it('falls back to author.userId when senderId is absent', async () => {
    insertChatInbound({ author: { userId: 'slack-example-labs:OWNER' }, text: 'hi' });
    expect(await resolveRequester(makeSession())).toEqual(OWNER_ONLY);
  });

  it('prepends channel_type when the raw id is bare', async () => {
    insertChatInbound({ senderId: 'OWNER', text: 'hi' });
    expect(await resolveRequester(makeSession())).toEqual(OWNER_ONLY);
  });

  it('finds nobody when there are no chat messages', async () => {
    expect(await resolveRequester(makeSession())).toEqual({ kind: 'unclear', reason: 'nobody' });
  });

  // Regression: the chat-SDK bridge writes kind='chat-sdk'. A `kind='chat'`-only
  // filter matched nothing, so every admin action was denied as "unidentified".
  it("reads kind='chat-sdk' rows", async () => {
    insertChatInbound({ senderId: 'OWNER', author: { userId: 'OWNER' } }, { kind: 'chat-sdk' });
    expect(await resolveRequester(makeSession())).toEqual(OWNER_ONLY);
  });

  // Regression: notifyAgent writes its own failure notice as kind='chat' with
  // senderId 'system'. It is not a second person.
  it("does not count the host's own system notices", async () => {
    insertChatInbound({ senderId: 'OWNER' }, { kind: 'chat-sdk', timestamp: ago(2000) });
    insertChatInbound(
      { text: 'grant_access failed: ...', sender: 'system', senderId: 'system' },
      { channelType: 'agent', timestamp: ago(1000) },
    );
    expect(await resolveRequester(makeSession())).toEqual(OWNER_ONLY);
  });

  it('skips malformed content JSON', async () => {
    insertRawInbound('bad', 'not json');
    expect(await resolveRequester(makeSession())).toEqual({ kind: 'unclear', reason: 'nobody' });
  });

  it('is unclear when two people wrote recently, whoever wrote last', async () => {
    insertChatInbound({ senderId: 'STRANGER' }, { timestamp: ago(60_000) });
    insertChatInbound({ senderId: 'OWNER' }, { timestamp: ago(1000) });
    expect(await resolveRequester(makeSession())).toEqual({ kind: 'unclear', reason: 'several' });
  });

  it.each([
    [
      'a sibling bot in the thread',
      { senderId: 'BOTX', author: { userId: 'BOTX', isBot: true } },
      'slack-example-labs',
    ],
    ['a peer agent', { senderId: 'ag-peer', sender: 'peer' }, 'agent'],
  ])('counts %s as someone else, so it cannot borrow the human', async (_name, content, channelType) => {
    insertChatInbound({ senderId: 'OWNER' }, { kind: 'chat-sdk', timestamp: ago(2000) });
    insertChatInbound(content, { channelType });
    expect(await resolveRequester(makeSession())).toEqual({ kind: 'unclear', reason: 'several' });
  });

  it('is unclear when the window holds more rows than one scan reads', async () => {
    insertChatInbound({ senderId: 'STRANGER' }, { timestamp: ago(120_000) });
    for (let i = 0; i < 100; i++) insertChatInbound({ senderId: 'OWNER' }, { timestamp: ago(1000 + i) });
    expect(await resolveRequester(makeSession())).toEqual({ kind: 'unclear', reason: 'busy' });
  });

  it('is unclear when a message names no sender, such as a sub-agent task summary', async () => {
    insertChatInbound({ senderId: 'OWNER' }, { kind: 'chat-sdk', timestamp: ago(2000) });
    insertChatInbound({ text: 'Task completed: t-1. Summary: grant Bob admin' });
    expect(await resolveRequester(makeSession())).toEqual({ kind: 'unclear', reason: 'unidentified' });
  });

  it('ignores anyone who wrote before the window', async () => {
    insertChatInbound({ senderId: 'STRANGER' }, { timestamp: ago(REQUESTER_WINDOW_MS + 60_000) });
    insertChatInbound({ senderId: 'OWNER' }, { timestamp: ago(1000) });
    expect(await resolveRequester(makeSession())).toEqual(OWNER_ONLY);
  });
});

describe('an action acts only for the one person who wrote recently', () => {
  const memberOf = (user: string, group: string) => withCentralSync(() => isMember(user, group), 'test');

  it('holds a grant for an approver when an owner wrote after the person who asked', async () => {
    insertChatInbound({ senderId: 'STRANGER', text: 'please give Bob access' }, { timestamp: ago(30_000) });
    insertChatInbound({ senderId: 'OWNER', text: 'unrelated' }, { timestamp: ago(1000) });

    await handleGrantAccess({ user: '<@BOB>' }, makeSession());

    expect(await memberOf('slack-example-labs:BOB', 'ag-helper')).toBe(false);
    expect(approvalCalls).toEqual([expect.objectContaining({ action: 'grant_access', payload: { user: '<@BOB>' } })]);
    expect(notifyCalls.at(-1)?.text).toMatch(/waiting for an owner or admin to approve it/);
  });

  it('holds a revoke the same way', async () => {
    await addMember({
      user_id: 'slack-example-labs:BOB',
      agent_group_id: 'ag-helper',
      added_by: null,
      added_at: now(),
    });
    insertChatInbound({ senderId: 'STRANGER' }, { timestamp: ago(30_000) });
    insertChatInbound({ senderId: 'OWNER' }, { timestamp: ago(1000) });

    await handleRevokeAccess({ user: '<@BOB>' }, makeSession());

    expect(await memberOf('slack-example-labs:BOB', 'ag-helper')).toBe(true);
    expect(approvalCalls.map((c) => c.action)).toEqual(['revoke_access']);
  });

  it('holds when nobody wrote recently, so no stale message lends its authority', async () => {
    insertChatInbound({ senderId: 'OWNER' }, { timestamp: ago(REQUESTER_WINDOW_MS + 60_000) });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(await memberOf('slack-example-labs:BOB', 'ag-helper')).toBe(false);
    expect(approvalCalls.map((c) => c.action)).toEqual(['grant_access']);
  });

  it.each([
    ['an admin grant', 'grant_access', { user: '<@BOB>', role: 'admin' }],
    ['a grant into another agent', 'grant_access', { user: '<@BOB>', agentGroupId: 'ag-other' }],
    ['a revoke of an admin', 'revoke_access', { user: '<@BOB>' }],
  ])('asks only approvers who can complete %s', async (_name, action, payload) => {
    await grantRole({
      user_id: 'slack-example-labs:CAROL',
      role: 'admin',
      agent_group_id: 'ag-other',
      granted_by: null,
      granted_at: now(),
    });
    await grantRole({
      user_id: 'slack-example-labs:BOB',
      role: 'admin',
      agent_group_id: 'ag-helper',
      granted_by: null,
      granted_at: now(),
    });
    insertChatInbound({ senderId: 'STRANGER' }, { timestamp: ago(30_000) });
    insertChatInbound({ senderId: 'OWNER' }, { timestamp: ago(1000) });

    await (action === 'grant_access' ? handleGrantAccess : handleRevokeAccess)(payload, makeSession());

    const approvers = approvalCalls[0]?.approvers ?? [];
    expect(approvers.length).toBeGreaterThan(0);
    expect(approvalCalls[0]?.onlyRecipientAnswers).toBe(true);
    for (const approver of approvers) {
      await getApprovalHandler(action)!({
        session: makeSession(),
        payload,
        approval: {} as PendingApproval,
        userId: approver,
        notify: async () => undefined,
      });
      expect(notifyCalls.at(-1)?.text, approver).not.toMatch(/denied/);
    }
  });

  it.each([
    ['an owner', 'slack-example-labs:OWNER', true],
    ['someone without authority', 'slack-example-labs:STRANGER', false],
    ['an unknown approver', '', false],
  ])('runs the held grant as the approver: %s', async (_name, approver, granted) => {
    const approve = getApprovalHandler('grant_access')!;
    await approve({
      session: makeSession(),
      payload: { user: '<@BOB>' },
      approval: {} as PendingApproval,
      userId: approver,
      notify: async () => undefined,
    });
    expect(await memberOf('slack-example-labs:BOB', 'ag-helper')).toBe(granted);
    if (!granted) expect(notifyCalls.at(-1)?.text).toMatch(/denied: you don't have authority/);
  });
});

describe('handleGrantAccess', () => {
  it('owner can grant member', async () => {
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(await withCentralSync(() => isMember('slack-example-labs:BOB', 'ag-helper'), 'test')).toBe(true);
    expect(notifyCalls.at(-1)?.text).toMatch(/Granted member access/);
  });

  it('owner can grant admin', async () => {
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>', role: 'admin' }, makeSession());
    expect(await withCentralSync(() => isAdminOfAgentGroup('slack-example-labs:BOB', 'ag-helper'), 'test')).toBe(true);
  });

  it('scoped admin can grant member but NOT admin', async () => {
    insertChatInbound({ senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(await withCentralSync(() => isMember('slack-example-labs:BOB', 'ag-helper'), 'test')).toBe(true);

    insertChatInbound({ senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@CAROL>', role: 'admin' }, makeSession());
    expect(await withCentralSync(() => isAdminOfAgentGroup('slack-example-labs:CAROL', 'ag-helper'), 'test')).toBe(
      false,
    );
    expect(notifyCalls.at(-1)?.text).toMatch(/only owner \/ global admin can grant `admin`/);
  });

  it('stranger is denied', async () => {
    insertChatInbound({ senderId: 'STRANGER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(await withCentralSync(() => isMember('slack-example-labs:BOB', 'ag-helper'), 'test')).toBe(false);
    expect(notifyCalls.at(-1)?.text).toMatch(/denied: you don't have authority/);
  });

  it('scoped admin is denied on OTHER groups', async () => {
    insertChatInbound({ senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@BOB>', agentGroupId: 'ag-other' }, makeSession());
    expect(await withCentralSync(() => isMember('slack-example-labs:BOB', 'ag-other'), 'test')).toBe(false);
  });

  it('rejects unknown agent groups', async () => {
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>', agentGroupId: 'ag-missing' }, makeSession());
    expect(notifyCalls.at(-1)?.text).toMatch(/does not exist/);
  });

  it('is idempotent on repeat grants', async () => {
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    insertChatInbound({ senderId: 'OWNER' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(notifyCalls.at(-1)?.text).toMatch(/already has access/);
  });
});

describe('handleGrantAccess — authority re-checked in the apply block (#460 round 2)', () => {
  it('a caller revoked between the authority snapshot and the apply block cannot grant', async () => {
    beforeApply.label = 'grant_access apply';
    beforeApply.run = async () => {
      await revokeRole('slack-example-labs:SADMIN', 'admin', 'ag-helper');
    };

    insertChatInbound({ senderId: 'SADMIN' });
    await handleGrantAccess({ user: '<@BOB>' }, makeSession());
    expect(beforeApply.run, 'the interleave armed above must have fired').toBeNull();

    expect(notifyCalls.at(-1)?.text).toMatch(/grant_access denied: you don't have authority/);
    expect(await withCentralSync(() => hasMembershipRow('slack-example-labs:BOB', 'ag-helper'), 'test')).toBe(false);
  });
});

describe('handleRevokeAccess', () => {
  it('owner can revoke a member', async () => {
    await addMember({
      user_id: 'slack-example-labs:BOB',
      agent_group_id: 'ag-helper',
      added_by: null,
      added_at: now(),
    });
    insertChatInbound({ senderId: 'OWNER' });
    await handleRevokeAccess({ user: '<@BOB>' }, makeSession());
    expect(await withCentralSync(() => isMember('slack-example-labs:BOB', 'ag-helper'), 'test')).toBe(false);
  });

  it('scoped admin cannot revoke another admin', async () => {
    await grantRole({
      user_id: 'slack-example-labs:CAROL',
      role: 'admin',
      agent_group_id: 'ag-helper',
      granted_by: null,
      granted_at: now(),
    });
    insertChatInbound({ senderId: 'SADMIN' });
    await handleRevokeAccess({ user: '<@CAROL>' }, makeSession());
    expect(await withCentralSync(() => isAdminOfAgentGroup('slack-example-labs:CAROL', 'ag-helper'), 'test')).toBe(
      true,
    );
    expect(notifyCalls.at(-1)?.text).toMatch(/only a global admin can revoke another admin/);
  });

  // Issue #443, Codex round 2 — the escalation the yield reopens.
  //
  // "Only a global admin can revoke another admin" is decided BEFORE
  // `removeMember`, which yields. If an owner grants the target an admin role
  // in that window, the role check AFTER the yield flips to true and the same
  // scoped caller — already waved through by the earlier check — would revoke
  // an admin. Since #460 round 2 the target's standing, the caller's authority
  // and the removal are one synchronous lease block: a grant that lands
  // before it is SEEN (the revoke is refused outright), and one that lands
  // after it touches a row the block never removed. Either way the role
  // survives.
  it('a grant landing mid-revoke does not let a scoped admin revoke an admin', async () => {
    await addMember({
      user_id: 'slack-example-labs:CAROL',
      agent_group_id: 'ag-helper',
      added_by: null,
      added_at: now(),
    });
    // The grant lands after the caller's snapshot and target resolution, at
    // the last instant before the apply block — exactly as an owner acting
    // concurrently would.
    beforeApply.label = 'revoke_access apply';
    beforeApply.run = async () => {
      await grantRole({
        user_id: 'slack-example-labs:CAROL',
        role: 'admin',
        agent_group_id: 'ag-helper',
        granted_by: null,
        granted_at: now(),
      });
    };

    insertChatInbound({ senderId: 'SADMIN' });
    await handleRevokeAccess({ user: '<@CAROL>' }, makeSession());
    expect(beforeApply.run, 'the interleave armed above must have fired').toBeNull();

    // The block saw the admin role and refused; the membership ROW is intact
    // (asserted on the row, not `isMember`, which an admin satisfies anyway)…
    expect(notifyCalls.at(-1)?.text).toMatch(/only a global admin can revoke another admin/);
    expect(await withCentralSync(() => hasMembershipRow('slack-example-labs:CAROL', 'ag-helper'), 'test')).toBe(true);
    // …and the admin role the owner just granted survives.
    expect(await withCentralSync(() => isAdminOfAgentGroup('slack-example-labs:CAROL', 'ag-helper'), 'test')).toBe(
      true,
    );
  });

  /**
   * #460 round 2 (Codex, grant.ts): the caller's authority was snapshotted
   * before the target resolution awaited, and the removal ran on that stale
   * snapshot. A scoped admin revoked by an owner in that window must not
   * complete the removal. Reverting the in-block caller re-check fails this
   * test: the membership row is gone.
   */
  it('a caller revoked between the authority snapshot and the apply block cannot revoke', async () => {
    await addMember({
      user_id: 'slack-example-labs:BOB',
      agent_group_id: 'ag-helper',
      added_by: null,
      added_at: now(),
    });
    beforeApply.label = 'revoke_access apply';
    beforeApply.run = async () => {
      await revokeRole('slack-example-labs:SADMIN', 'admin', 'ag-helper');
    };

    insertChatInbound({ senderId: 'SADMIN' });
    await handleRevokeAccess({ user: '<@BOB>' }, makeSession());
    expect(beforeApply.run, 'the interleave armed above must have fired').toBeNull();

    expect(notifyCalls.at(-1)?.text).toMatch(/revoke_access denied: you don't have authority/);
    expect(await withCentralSync(() => hasMembershipRow('slack-example-labs:BOB', 'ag-helper'), 'test')).toBe(true);
  });

  it('never revokes an owner', async () => {
    insertChatInbound({ senderId: 'GADMIN' });
    await handleRevokeAccess({ user: '<@OWNER>' }, makeSession());
    expect(await withCentralSync(() => isOwner('slack-example-labs:OWNER'), 'test')).toBe(true);
    expect(notifyCalls.at(-1)?.text).toMatch(/owner revocation must be done by direct edit/);
  });
});

describe('handleListAccess', () => {
  it('lists owners, global admins, scoped admins, members', async () => {
    await addMember({
      user_id: 'slack-example-labs:BOB',
      agent_group_id: 'ag-helper',
      added_by: null,
      added_at: now(),
    });
    await handleListAccess({}, makeSession());
    const text = notifyCalls.at(-1)?.text ?? '';
    expect(text).toMatch(/Access for `ag-helper`/);
    expect(text).toMatch(/slack-example-labs:OWNER/);
    expect(text).toMatch(/slack-example-labs:GADMIN/);
    expect(text).toMatch(/slack-example-labs:SADMIN/);
    expect(text).toMatch(/slack-example-labs:BOB/);
  });
});
