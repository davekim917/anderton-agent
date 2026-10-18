/**
 * Live path `provider-claude`: the real ClaudeProvider drives the real Claude Agent SDK, which spawns the Claude Code
 * CLI it bundles, against a local fake of the Anthropic Messages API. Nothing between the provider and the socket is
 * mocked, so a bump of either package that changes what reaches the API, or how a streamed reply becomes a turn,
 * fails here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { allowNetwork, allowSubprocess, allowWritesTo } from '../test-hermeticity.js';
import { ClaudeProvider, IMAGE_CLAUDE_CODE_EXECUTABLE, _setClaudeCodeExecutableForTesting } from './claude.js';
import type { ProviderEvent } from './types.js';

type MessagesRequest = {
  model?: string;
  stream?: boolean;
  thinking?: { type?: string };
  output_config?: { effort?: string };
  system?: Array<{ type: string; text: string }> | string;
  tools?: Array<{ name: string }>;
  messages?: Array<{ role: string; content: unknown }>;
};

type Reply = { text: string } | { toolUse: { id: string; name: string; input: Record<string, unknown> } };

function sse(model: string, reply: Reply): string {
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const block =
    'text' in reply
      ? { start: { type: 'text', text: '' }, delta: { type: 'text_delta', text: reply.text } }
      : {
          start: { type: 'tool_use', id: reply.toolUse.id, name: reply.toolUse.name, input: {} },
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.toolUse.input) },
        };
  return [
    ev('message_start', {
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    }),
    ev('content_block_start', { index: 0, content_block: block.start }),
    ev('content_block_delta', { index: 0, delta: block.delta }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', {
      delta: { stop_reason: 'text' in reply ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: 7 },
    }),
    ev('message_stop', {}),
  ].join('');
}

/** The streamed main-loop requests, in order; side requests (titles, classifiers) are answered but not recorded. */
const turns: MessagesRequest[] = [];
let script: Reply[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;

beforeAll(() => {
  allowNetwork();
  allowSubprocess(['claude']);
  initTestSessionDb();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') return Response.json({}, { status: 404 });
      const body = (await req.json()) as MessagesRequest;
      const model = body.model ?? 'unknown';
      if (!body.stream) {
        return Response.json({
          id: 'msg_side',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      turns.push(body);
      const reply = script.shift() ?? { text: 'unscripted' };
      return new Response(sse(model, reply), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  _setClaudeCodeExecutableForTesting(undefined);
});

afterAll(() => {
  server.stop(true);
  closeSessionDb();
  _setClaudeCodeExecutableForTesting(IMAGE_CLAUDE_CODE_EXECUTABLE);
});

afterEach(() => {
  turns.length = 0;
  script = [];
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

async function runTurn(
  input: Omit<Parameters<ClaudeProvider['query']>[0], 'cwd'>,
): Promise<Extract<ProviderEvent, { type: 'result' }>> {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-live-path-'));
  allowWritesTo(home);
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd);
  const p = new ClaudeProvider({
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ANTHROPIC_API_KEY: 'sk-ant-live-path-fake',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
  p.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = p.query({ ...input, cwd });
  try {
    for await (const event of q.events) {
      if (event.type === 'result') return event;
    }
    throw new Error('the query ended without a result');
  } finally {
    q.end();
    q.abort();
  }
}

function systemText(req: MessagesRequest): string {
  return typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text).join('\n');
}

describe('provider-claude live path', () => {
  it('runs the Claude Code release the image pins', () => {
    // The image runs its own install of that pin (/pnpm/claude); this test can only run the SDK's bundled build.
    const pin = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(
      fs.readFileSync(path.join(import.meta.dir, '../../../Dockerfile'), 'utf8'),
    )?.[1];
    const platformPackage = require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const version = Bun.spawnSync([path.join(path.dirname(platformPackage), 'claude'), '--version']);
    expect(pin).toBeDefined();
    expect(version.stdout.toString().trim().split(' ')[0]).toBe(pin!);
  });

  it('sends the resolved model, effort and adaptive thinking, and returns the streamed reply as the turn', async () => {
    script = [{ text: 'pong from the fake' }];
    const result = await runTurn({
      prompt: 'ping',
      model: 'claude-sonnet-5-5',
      effort: 'low',
      systemContext: { instructions: 'LIVE-PATH-INSTRUCTIONS-MARKER' },
    });

    expect(result.isError ?? false).toBe(false);
    expect(result.text).toContain('pong from the fake');
    expect(turns).toHaveLength(1);
    expect(turns[0].model).toBe('claude-sonnet-5-5');
    expect(turns[0].output_config?.effort).toBe('low');
    expect(turns[0].thinking?.type).toBe('adaptive');
    expect(systemText(turns[0])).toContain('LIVE-PATH-INSTRUCTIONS-MARKER');
    expect(JSON.stringify(turns[0].messages)).toContain('ping');
  }, 60_000);

  it('runs a tool the model calls and sends its output back in the next request', async () => {
    script = [
      {
        toolUse: {
          id: 'toolu_live_1',
          name: 'Bash',
          input: { command: 'echo live-path-tool-output', description: 'echo' },
        },
      },
      { text: 'tool done' },
    ];
    const result = await runTurn({ prompt: 'run the echo', model: 'claude-sonnet-5-5' });

    expect(result.text).toContain('tool done');
    expect(turns).toHaveLength(2);
    expect(turns[0].tools?.map((t) => t.name)).toContain('Bash');
    const followUp = JSON.stringify(turns[1].messages);
    expect(followUp).toContain('toolu_live_1');
    expect(followUp).toContain('live-path-tool-output');
  }, 60_000);
});
