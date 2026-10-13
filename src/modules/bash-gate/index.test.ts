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
import { getPendingApprovalByRequestId } from '../../db/sessions.js';
import './index.js';

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
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: mocks.wakeContainer,
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
