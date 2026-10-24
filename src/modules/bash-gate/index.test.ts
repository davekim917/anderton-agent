import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { getRawDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { initSessionFolder } from '../../session-manager.js';
import type Database from 'better-sqlite3';

import { openInboundDb as openInboundDbAt } from '../../modules/mailbox/openers.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { getDeliveryAction } from '../../delivery.js';
import { editApprovalCardResolution } from '../approvals/primitive.js';
import {
  createPendingApproval,
  getApprovalByRequestId,
  getPendingApprovalByRequestId,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import {
  _dropGateTimersForTesting,
  cancelPendingGatesForSession,
  expireOverdueGates,
  openGateDeadlineMs,
  sessionHasActiveGates,
} from './index.js';
import { resolveApprovalFromHost } from '../approvals/response-handler.js';

// `session-manager`'s ids-addressed inbound opener went away with the mailbox
// seam's raw wrappers (PR 7). Production code opens sessions through the seam;
// this fixture still wants a plain handle on a named session's file, which is
// the module's own path-addressed funnel plus the layout helper.
function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openInboundDbAt(inboundDbPath(agentGroupId, sessionId));
}

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  wakeContainer: vi.fn(),
  failedMailboxWrites: 0,
  containerName: null as string | null,
  pendingAdoption: false,
}));

vi.mock('../../session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...actual,
    withExistingMailboxSession: ((...args: Parameters<typeof actual.withExistingMailboxSession>) => {
      if (mocks.failedMailboxWrites > 0) {
        mocks.failedMailboxWrites--;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return actual.withExistingMailboxSession(...args);
    }) as typeof actual.withExistingMailboxSession,
  };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

// Its own mailbox read would take a failure `failedMailboxWrites` injects for the gate; card-pointer.test.ts covers it.
vi.mock('../approvals/card-pointer.js', () => ({ sendCardPointer: vi.fn().mockResolvedValue('skipped-no-requester') }));

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: mocks.wakeContainer,
  getContainerIdentity: () => mocks.containerName,
  hasPendingAdoption: () => mocks.pendingAdoption,
}));

vi.mock('../../delivery.js', async () => {
  const actual = await vi.importActual<typeof import('../../delivery.js')>('../../delivery.js');
  return {
    ...actual,
    getDeliveryAdapter: () => ({
      deliver: mocks.deliver,
    }),
  };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-bash-gate') }));

function now(): string {
  return new Date().toISOString();
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function seedSession(): Promise<void> {
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack-example-labs',
    platform_id: 'slack:C123',
    instance: 'slack-example-labs',
    name: '#support',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'slack:C123:1781317853.356239',
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
  initSessionFolder('ag-1', 'sess-1');
}

async function runDestructiveGate(label: string, requestId: string, command?: string, summary?: string): Promise<void> {
  const handler = getDeliveryAction('request_destructive_gate');
  const session = await getSession('sess-1');
  expect(handler).toBeDefined();
  expect(session).toBeDefined();
  // Two arguments: the handler opens its own mailbox session now, and the
  // delivery loop holds none while it runs (plan §4.5b).
  await handler!(
    {
      requestId,
      label,
      summary: summary ?? 'The agent wants to run a destructive command.',
      command:
        command ??
        'CREATE OR REPLACE PROCEDURE HOOLI_PLATFORM.MASTER._LONG_TEST_SP() RETURNS STRING LANGUAGE SQL AS $$ SELECT 1; $$',
    },
    session!,
  );
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  await seedSession();
  mocks.deliver.mockReset();
  mocks.wakeContainer.mockReset();
  mocks.failedMailboxWrites = 0;
  mocks.containerName = 'nanoclaw-v2-agent-1';
  mocks.pendingAdoption = false;
  mocks.wakeContainer.mockResolvedValue(undefined);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('bash destructive gate delivery', () => {
  it('caps long destructive gate titles before Slack Block Kit delivery', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-1');

    await runDestructiveGate(
      'Destructive Snowflake SQL detected (CREATE OR REPLACE) — CREATE OR REPLACE PROCEDURE HOOLI_PLATFORM.MASTER._VERY_LONG_PROCEDURE_NAME_FOR_APPROVAL_CARD_LIMIT_REGRESSION() RETURNS STRING LANGUAGE SQL AS $$',
      'gate-long-title',
    );

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const content = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { title: string };
    expect(Array.from(content.title).length).toBeLessThanOrEqual(140);
    expect(content.title).toMatch(/…$/);

    const pending = getRawDb()
      .prepare('SELECT title, platform_message_id FROM pending_approvals WHERE request_id = ?')
      .get('gate-long-title') as { title: string; platform_message_id: string } | undefined;
    expect(pending?.title).toBe(content.title);
    expect(pending?.platform_message_id).toBe('slack-msg-1');
  });

  it('caps destructive gate titles without splitting emoji code points', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-emoji');

    await runDestructiveGate(`${'A'.repeat(135)}🚨 tail`, 'gate-emoji-title');

    const content = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { title: string };
    const codePoints = Array.from(content.title);
    expect(codePoints.length).toBeLessThanOrEqual(140);
    expect(codePoints.at(-2)).toBe('🚨');
    expect(codePoints.at(-1)).toBe('…');
    expect(hasLoneSurrogate(content.title)).toBe(false);
  });

  it('retains the full command for audit while showing both ends of a long command on the card', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-command');
    const command = `terraform apply -var='opening=${'a'.repeat(4000)}' -auto-approve --target=module.production`;

    await runDestructiveGate('Terraform apply', 'gate-long-command', command);

    const content = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
    expect(content.question).toContain("terraform apply -var='opening=");
    expect(content.question).toContain('--target=module.production');
    expect(content.question).toContain('…[middle omitted; full command retained in the approval record]…');

    const pending = getRawDb()
      .prepare('SELECT payload FROM pending_approvals WHERE request_id = ?')
      .get('gate-long-command') as { payload: string } | undefined;
    expect(JSON.parse(pending!.payload).command).toBe(command);
  });

  it("keeps the card body inside Slack's 3000-unit section limit, footer and command tail included", async () => {
    mocks.deliver.mockResolvedValue('slack-msg-budget');
    const summary = `Rebuild 🧪 model\n\n> ${'🚨'.repeat(600)}`;
    const command = `psql -c "select '${'🔥'.repeat(900)}'" --set ON_ERROR_STOP=1 --dbname production`;

    await runDestructiveGate('Emoji-heavy gate', 'gate-budget', command, summary);

    const { question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
    expect(question.length).toBeLessThanOrEqual(3000);
    expect(question).toContain('--dbname production');
    expect(question).toMatch(/cancels the destructive command\._$/);
    expect(hasLoneSurrogate(question)).toBe(false);
  });

  it("fits a Discord card, title included, in the Discord adapter's 1900-unit message", async () => {
    getRawDb()
      .prepare("UPDATE messaging_groups SET channel_type = 'discord', platform_id = 'discord:G1:C1' WHERE id = 'mg-1'")
      .run();
    mocks.deliver.mockResolvedValue('discord-msg-budget');
    const command = `psql -c "delete from t where id in (${'1,'.repeat(1050)}1)" --dbname production`;

    await runDestructiveGate('Delete rows', 'gate-discord-budget', command);

    const { title, question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as {
      title: string;
      question: string;
    };
    expect(`**${title}**\n\n${question}`.length).toBeLessThanOrEqual(1900);
    expect(question).toContain('--dbname production');
    expect(question).toMatch(/cancels the destructive command\._$/);
  });

  it('keeps the command tail and the resolution line when the card is edited after a decision', async () => {
    const command = `terraform apply -var='opening=${'a'.repeat(4000)}' -auto-approve --target=module.production`;
    for (const [platform, limit] of [
      ['slack:C123', 2800],
      ['discord:G1:C1', 1900],
    ] as const) {
      getRawDb().prepare('UPDATE messaging_groups SET platform_id = ? WHERE id = ?').run(platform, 'mg-1');
      mocks.deliver.mockReset();
      mocks.deliver.mockResolvedValue(`msg-${platform}`);
      const requestId = `gate-edit-${platform}`;

      await runDestructiveGate('Terraform apply', requestId, command);
      const pending = await getPendingApprovalByRequestId(requestId);
      await editApprovalCardResolution(pending!, 'approve', '');

      const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
      expect(edit.operation).toBe('edit');
      expect(edit.text.length).toBeLessThanOrEqual(limit);
      expect(edit.text).toContain('--target=module.production');
      expect(edit.text).toMatch(/cancels the destructive command\._\n\n\S/);
    }
  });

  it('keeps the approver line, clipped, when a long display name approves a full-budget card', async () => {
    const command = `terraform apply -var='opening=${'a'.repeat(4000)}' -auto-approve --target=module.production`;
    const longName = '𝐀𝐥𝐞𝐱𝐚𝐧𝐝𝐫𝐚 '.repeat(30);
    await upsertUser({ id: 'slack:U-LONG', kind: 'slack', display_name: longName, created_at: now() });
    for (const [platform, limit] of [
      ['slack:C123', 2800],
      ['discord:G1:C1', 1900],
    ] as const) {
      getRawDb().prepare('UPDATE messaging_groups SET platform_id = ? WHERE id = ?').run(platform, 'mg-1');
      mocks.deliver.mockReset();
      mocks.deliver.mockResolvedValue(`msg-long-${platform}`);
      const requestId = `gate-long-name-${platform}`;

      await runDestructiveGate('Terraform apply', requestId, command);
      const pending = await getPendingApprovalByRequestId(requestId);
      await editApprovalCardResolution(pending!, 'approve', 'slack:U-LONG');

      const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { text: string };
      expect(edit.text.length).toBeLessThanOrEqual(limit);
      expect(edit.text).toContain('--target=module.production');
      expect(edit.text).toMatch(/cancels the destructive command\._\n\n.+ — 𝐀𝐥𝐞𝐱𝐚𝐧𝐝𝐫𝐚 .*…$/u);
      expect(hasLoneSurrogate(edit.text)).toBe(false);
    }
  });

  it('does not split an emoji where the command tail is cut', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-tail');
    const command = `echo ${'🔥'.repeat(1500)} --tail-marker`;

    for (const summary of ['s', 'ss']) {
      mocks.deliver.mockClear();
      await runDestructiveGate('Emoji tail', `gate-tail-${summary}`, command, summary);
      const { question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
      expect(question).toContain('--tail-marker');
      expect(hasLoneSurrogate(question)).toBe(false);
    }
  });

  it('gives a long summary the room a short command leaves', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-short');

    await runDestructiveGate('Short command', 'gate-short', 'rm -rf /tmp/x', 'y'.repeat(2400));

    const { question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
    expect(question).toContain('y'.repeat(2400));
  });

  it('cuts an oversized summary before the command preview', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-summary');
    const command = `terraform destroy ${'-target=module.x '.repeat(40)}-target=module.production`;

    await runDestructiveGate('Long summary', 'gate-summary', command, 'x'.repeat(5000));

    const { question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
    expect(question.length).toBeLessThanOrEqual(3000);
    expect(question).toContain('-target=module.production');
    expect(question).toMatch(/cancels the destructive command\._$/);
  });

  it('fails the gate ack immediately when approval-card delivery throws', async () => {
    mocks.deliver.mockRejectedValue(new Error('An API error occurred: invalid_blocks'));

    await runDestructiveGate(
      'Destructive Snowflake SQL detected (CREATE OR REPLACE) — CREATE OR REPLACE PROCEDURE HOOLI_PLATFORM.MASTER._VERY_LONG_PROCEDURE_NAME_FOR_APPROVAL_CARD_LIMIT_REGRESSION() RETURNS STRING LANGUAGE SQL AS $$',
      'gate-delivery-fail',
    );

    const pendingCount = (
      getRawDb()
        .prepare('SELECT COUNT(*) AS count FROM pending_approvals WHERE request_id = ?')
        .get('gate-delivery-fail') as { count: number }
    ).count;
    expect(pendingCount).toBe(0);

    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      const ack = inDb
        .prepare('SELECT status, error FROM delivered WHERE message_out_id = ?')
        .get('gate-delivery-fail') as { status: string; error: string } | undefined;
      expect(ack).toEqual({
        status: 'failed',
        error: 'destructive-gate delivery failed: approval request could not be posted.',
      });
    } finally {
      inDb.close();
    }
  });
});

describe('rejecting a gate', () => {
  function gateAck(requestId: string): unknown {
    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      return inDb.prepare('SELECT status, error FROM delivered WHERE message_out_id = ?').get(requestId);
    } finally {
      inDb.close();
    }
  }

  async function rejectGate(requestId: string): Promise<void> {
    const approval = await getPendingApprovalByRequestId(requestId);
    expect(approval).toBeDefined();
    expect(await resolveApprovalFromHost(approval!.approval_id, 'reject', 'slack:admin-1')).toEqual({ resolved: true });
  }

  it('keeps the session marked while a sibling gate is still open', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    await runDestructiveGate('Drop table', 'gate-a');
    await runDestructiveGate('Drop schema', 'gate-b');

    await rejectGate('gate-a');
    expect(gateAck('gate-a')).toEqual({ status: 'failed', error: 'Rejected by an approver.' });
    expect(sessionHasActiveGates('sess-1')).toBe(true);

    await rejectGate('gate-b');
    expect(sessionHasActiveGates('sess-1')).toBe(false);
  });

  it('leaves the timeout armed when the reject cannot be written, so the gate still fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      await runDestructiveGate('Drop table', 'gate-c');

      mocks.failedMailboxWrites = 1;
      await rejectGate('gate-c');
      expect(gateAck('gate-c')).toEqual({ status: 'pending', error: null });

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(gateAck('gate-c')).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a gate whose container restarted', () => {
  const MINUTE = 60 * 1000;
  const at = (minutesAgo: number): number => Date.now() - minutesAgo * MINUTE;
  const container = (startedMinutesAgo: number): string => `nanoclaw-v2-agent-${at(startedMinutesAgo)}`;
  const request = (askedMinutesAgo: number, tag: string): string => `gate-${at(askedMinutesAgo)}-${tag}`;

  function gateAck(requestId: string): unknown {
    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      return inDb.prepare('SELECT status, error FROM delivered WHERE message_out_id = ?').get(requestId);
    } finally {
      inDb.close();
    }
  }

  it('closes the dead container’s card when its replacement asks again, and counts only the live gate', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(40);
    const oldId = request(35, 'aa');
    await runDestructiveGate('Drop database', oldId);
    expect(await getPendingApprovalByRequestId(oldId)).toBeDefined();

    mocks.containerName = container(3);
    expect(await openGateDeadlineMs('sess-1')).toBeNull();
    const newId = request(1, 'bb');
    await runDestructiveGate('Drop database', newId);

    expect(await getPendingApprovalByRequestId(oldId)).toBeUndefined();
    expect(await getPendingApprovalByRequestId(newId)).toBeDefined();
    expect(await openGateDeadlineMs('sess-1')).toBe(Number(newId.split('-')[1]) + 62 * MINUTE);
  });

  it('an answer to the dead container’s card after its replacement asked again neither acks it nor tells the agent', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(40);
    const staleId = request(35, 'dd');
    await runDestructiveGate('Drop database', staleId);
    const stale = await getPendingApprovalByRequestId(staleId);
    mocks.containerName = container(3);
    await runDestructiveGate('Drop database', request(1, 'ee'));

    expect(await resolveApprovalFromHost(stale!.approval_id, 'approve', 'slack:admin-1')).toEqual({
      resolved: false,
      error: `No pending approval ${stale!.approval_id}`,
    });
    expect(gateAck(staleId)).toEqual({
      status: 'failed',
      error: 'Superseded: the agent restarted and asked again.',
    });
    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      expect(inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE content LIKE '%gate approved%'").get()).toEqual({
        n: 0,
      });
    } finally {
      inDb.close();
    }
  });

  it('refuses a request its container wrote before being replaced, without posting a card', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(3);
    const id = request(5, 'cc');
    await runDestructiveGate('Drop database', id);

    expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(gateAck(id)).toEqual({
      status: 'failed',
      error: 'The agent stopped before this approval request was posted.',
    });
    expect(await openGateDeadlineMs('sess-1')).toBeNull();
  });

  it('refuses a request drained after its container exited and before any replacement owns the session', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = null;
    const id = request(5, 'hh');
    await runDestructiveGate('Drop database', id);

    expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(gateAck(id)).toEqual({
      status: 'failed',
      error: 'The agent stopped before this approval request was posted.',
    });
  });

  it('times out a late-posted request when its own hour ends, not an hour after posting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      mocks.containerName = container(90);
      const id = request(50, 'tt');
      await runDestructiveGate('Drop database', id);

      await vi.advanceTimersByTimeAsync(9 * MINUTE);
      expect(gateAck(id)).toEqual({ status: 'pending', error: null });
      await vi.advanceTimersByTimeAsync(MINUTE + 1000);
      expect(gateAck(id)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never dates a gate’s deadline later than an hour past when the host posted it', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(3);
    const forged = `gate-${Date.now() + 365 * 24 * 60 * MINUTE}-ff`;
    await runDestructiveGate('Drop database', forged);
    const card = await getPendingApprovalByRequestId(forged);
    expect(await openGateDeadlineMs('sess-1')).toBe(Date.parse(card!.created_at) + 62 * MINUTE);
  });

  for (const [when, afterFiling] of [
    ['no container owns the session, or its replacement is still spawning', () => (mocks.containerName = null)],
    ['a replacement started but has not asked yet', () => (mocks.containerName = container(1))],
  ] as const) {
    it(`an approve clicked after the filing container stopped runs nothing and says so (${when})`, async () => {
      mocks.deliver.mockResolvedValue('pm-1');
      mocks.containerName = container(40);
      const id = request(35, 'kk');
      await runDestructiveGate('Rename schemas', id);
      const card = await getPendingApprovalByRequestId(id);
      afterFiling();

      expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({
        resolved: true,
        declined:
          '⏭️ The agent stopped before this was answered, so nothing ran. It will ask again if it still needs this.',
      });

      expect(gateAck(id)).toEqual({ status: 'failed', error: 'The agent stopped before this approval was answered.' });
      expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
      expect(sessionHasActiveGates('sess-1')).toBe(false);
      const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
      expect(edit.operation).toBe('edit');
      expect(edit.text).toContain('nothing ran');
      const inDb = openInboundDb('ag-1', 'sess-1');
      try {
        expect(inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE content LIKE '%approved%'").get()).toEqual({
          n: 0,
        });
      } finally {
        inDb.close();
      }
    });
  }

  it('still declines, and says nothing ran, when the stopped gate’s ack cannot be written', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(40);
    const id = request(35, 'mm');
    await runDestructiveGate('Rename schemas', id);
    const card = await getPendingApprovalByRequestId(id);
    mocks.containerName = null;
    mocks.failedMailboxWrites = 1;

    expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({
      resolved: true,
      declined:
        '⏭️ The agent stopped before this was answered, so nothing ran. It will ask again if it still needs this.',
    });

    expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
    const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
    expect(edit.text).toContain('nothing ran');
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });
  });

  it('an approve while the filing container still waits is applied', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(40);
    const id = request(35, 'll');
    await runDestructiveGate('Rename schemas', id);
    const card = await getPendingApprovalByRequestId(id);

    expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({ resolved: true });
    expect(gateAck(id)).toEqual({ status: 'delivered', error: null });
  });

  it('posts and applies a gate from an adopted survivor whose name the runtime could not report', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = null;
    mocks.pendingAdoption = true;
    const id = request(5, 'nn');
    await runDestructiveGate('Rename schemas', id);
    const card = await getPendingApprovalByRequestId(id);
    expect(card).toBeDefined();

    expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({ resolved: true });
    expect(gateAck(id)).toEqual({ status: 'delivered', error: null });
  });

  it('expires a gate whose timer a host restart dropped, once its hour from the ask has passed', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const orphaned = request(59, 'pp');
    await runDestructiveGate('Drop database', orphaned);
    _dropGateTimersForTesting();
    const armed = request(59, 'qq');
    await runDestructiveGate('Drop database', armed);

    expect(await expireOverdueGates()).toBe(0);
    expect(await expireOverdueGates(Date.now() + 2 * MINUTE)).toBe(1);

    expect(gateAck(orphaned)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
    expect(await getPendingApprovalByRequestId(orphaned)).toBeUndefined();
    const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
    expect(edit.operation).toBe('edit');
    expect(edit.text).toContain('timed out');
    expect(await getPendingApprovalByRequestId(armed)).toBeDefined();
    expect(sessionHasActiveGates('sess-1')).toBe(true);
    _dropGateTimersForTesting();
  });

  it('an approve that lands while the gate is being timed out runs nothing', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const id = request(59, 'rr');
    await runDestructiveGate('Drop database', id);
    const card = await getPendingApprovalByRequestId(id);
    expect(await transitionPendingApprovalStatus(card!.approval_id, 'pending', 'expired')).toBe(true);

    expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({
      resolved: false,
      error: `Approval ${card!.approval_id} was already answered by someone else.`,
    });
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });
    _dropGateTimersForTesting();
  });

  it('a timer that fires after an approve claimed the gate writes no timeout over it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      const id = request(59, 'ss');
      await runDestructiveGate('Drop database', id);
      const card = await getPendingApprovalByRequestId(id);
      expect(await transitionPendingApprovalStatus(card!.approval_id, 'pending', 'approved')).toBe(true);

      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(gateAck(id)).toEqual({ status: 'pending', error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes an expiry whose ack write failed after the gate was claimed', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const id = request(59, 'uu');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await runDestructiveGate('Drop database', id);
      mocks.failedMailboxWrites = 1;
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
    } finally {
      vi.useRealTimers();
    }
    expect((await getApprovalByRequestId(id, 'sess-1', 'destructive-gate'))?.status).toBe('expired');
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });

    expect(await expireOverdueGates()).toBe(1);
    expect(gateAck(id)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
    expect(await getApprovalByRequestId(id, 'sess-1', 'destructive-gate')).toBeUndefined();
  });

  it('times out only its own gate when another approval reuses its request id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      const id = request(59, 'vv');
      await createPendingApproval({
        approval_id: 'appr-other-kind',
        session_id: 'sess-1',
        request_id: id,
        action: 'some-other-action',
        payload: '{}',
        created_at: new Date().toISOString(),
        title: 'Other',
        options_json: '[]',
      });
      await runDestructiveGate('Drop database', id);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);

      expect(gateAck(id)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
      expect(await getApprovalByRequestId(id, 'sess-1', 'destructive-gate')).toBeUndefined();
      expect((await getApprovalByRequestId(id, 'sess-1', 'some-other-action'))?.status).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the expiry sweep writes no timeout over a gate approved while it was working', async () => {
    const b = request(59, 'wb');
    mocks.deliver.mockResolvedValue('pm-1');
    await runDestructiveGate('Drop database', request(59, 'wa'));
    await runDestructiveGate('Drop database', b);
    _dropGateTimersForTesting();
    const cardB = await getPendingApprovalByRequestId(b);
    let approvedB = false;
    mocks.deliver.mockImplementation(async () => {
      if (!approvedB) {
        approvedB = true;
        await resolveApprovalFromHost(cardB!.approval_id, 'approve', 'slack:admin-1');
      }
      return 'pm-1';
    });

    expect(await expireOverdueGates(Date.now() + 2 * MINUTE)).toBe(1);

    expect(gateAck(b)).toEqual({ status: 'delivered', error: null });
  });

  it('a follow-up cancel and an approve landing during it decide the gate once', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const id = request(5, 'xc');
    await runDestructiveGate('Drop database', id);
    const card = await getPendingApprovalByRequestId(id);
    let approveResult: unknown;
    let clicked = false;
    mocks.deliver.mockImplementation(async () => {
      if (!clicked) {
        clicked = true;
        approveResult = await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1');
      }
      return 'pm-1';
    });

    await cancelPendingGatesForSession('sess-1', 'User sent a follow-up.');

    expect(gateAck(id)).toEqual({ status: 'failed', error: 'User sent a follow-up.' });
    expect(approveResult).toEqual({
      resolved: false,
      error: `Approval ${card!.approval_id} was already answered by someone else.`,
    });
  });

  it('a follow-up cancel whose ack cannot be written leaves the gate to its timeout', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const id = request(59, 'yc');
    await runDestructiveGate('Drop database', id);
    _dropGateTimersForTesting();
    mocks.failedMailboxWrites = 1;

    await cancelPendingGatesForSession('sess-1', 'User sent a follow-up.');
    expect((await getPendingApprovalByRequestId(id))?.status).toBe('pending');
    expect(sessionHasActiveGates('sess-1')).toBe(true);

    expect(await expireOverdueGates(Date.now() + 2 * MINUTE)).toBe(1);
    expect(gateAck(id)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
  });

  it('closes a gate whose answer a dead host claimed but never finished, once the hook has stopped waiting', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const id = request(59, 'za');
    await runDestructiveGate('Drop database', id);
    _dropGateTimersForTesting();
    const card = await getPendingApprovalByRequestId(id);
    expect(await transitionPendingApprovalStatus(card!.approval_id, 'pending', 'approved')).toBe(true);

    expect(await expireOverdueGates(Date.now() + 2 * MINUTE)).toBe(0);
    expect(await expireOverdueGates(Date.now() + 4 * MINUTE)).toBe(1);

    expect(await getApprovalByRequestId(id, 'sess-1', 'destructive-gate')).toBeUndefined();
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });
    const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
    expect(edit.text).toContain('Check the agent');
  });

  it('a gate whose reject was claimed but never finished still fails at its timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      const id = request(59, 'zr');
      await runDestructiveGate('Drop database', id);
      const card = await getPendingApprovalByRequestId(id);
      expect(await transitionPendingApprovalStatus(card!.approval_id, 'pending', 'rejected')).toBe(true);

      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(gateAck(id)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
      expect((await getApprovalByRequestId(id, 'sess-1', 'destructive-gate'))?.status).toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a request whose hour ran out before the host posted it, and dates a late card from the request', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(90);
    const expired = request(61, 'ff');
    await runDestructiveGate('Drop database', expired);
    expect(await getPendingApprovalByRequestId(expired)).toBeUndefined();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(gateAck(expired)).toEqual({
      status: 'failed',
      error: 'The approval window ran out before this request was posted.',
    });

    const late = request(50, 'gg');
    await runDestructiveGate('Drop database', late);
    expect(await getPendingApprovalByRequestId(late)).toBeDefined();
    expect(await openGateDeadlineMs('sess-1')).toBe(Number(late.split('-')[1]) + 62 * MINUTE);
  });
});
