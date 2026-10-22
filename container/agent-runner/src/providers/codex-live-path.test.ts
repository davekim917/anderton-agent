import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { allowNetwork, allowSubprocess, allowWritesTo } from '../test-hermeticity.js';
import {
  killCodexAppServer,
  startCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  type AppServer,
  type JsonRpcNotification,
} from './codex-app-server.js';

let app: AppServer | undefined;
let api: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.CODEX_HOME;
});

async function stopApp(): Promise<void> {
  if (app) {
    const child = app.process;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killCodexAppServer(app);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }
    app = undefined;
  }
}

afterEach(async () => {
  await stopApp();
  api?.stop(true);
  api = undefined;
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function responseStream(text: string): string {
  const message = {
    id: 'msg_live_path',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id: 'resp_live_path',
    object: 'response',
    status: 'completed',
    output: [message],
    usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
  };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

describe('provider-codex live path', () => {
  it('sends a turn through the real CLI and resumes its saved conversation', async () => {
    allowNetwork();
    allowSubprocess(['codex']);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-path-'));
    allowWritesTo(scratch);
    process.env.CODEX_HOME = scratch;
    const requests: Record<string, unknown>[] = [];
    api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/responses') {
          return Response.json({}, { status: 404 });
        }
        requests.push((await request.json()) as Record<string, unknown>);
        return new Response(responseStream(`local reply ${requests.length}`), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const notifications: JsonRpcNotification[] = [];
    const overrides = [
      'model_provider="live_path"',
      'model_providers.live_path.name="Local fixture"',
      `model_providers.live_path.base_url="http://127.0.0.1:${api.port}"`,
      'model_providers.live_path.wire_api="responses"',
      'model_providers.live_path.requires_openai_auth=false',
      'features.hooks=false',
    ];
    const start = () =>
      startCodexAppServer(
        overrides,
        (server) => {
          app = server;
          server.notificationHandlers.push((notification) => notifications.push(notification));
        },
        () => {
          throw new Error('CLI initialization unexpectedly needed a retry');
        },
      );
    const params = { model: 'example-model', cwd: scratch, sandbox: 'read-only', approvalPolicy: 'never' };
    const turn = async (threadId: string, prompt: string) => {
      const before = notifications.length;
      const turnId = await startCodexTurn(app!, { threadId, inputText: prompt });
      expect(turnId).toBeString();
      for (let attempt = 0; attempt < 200; attempt++) {
        const completed = notifications
          .slice(before)
          .find(
            (notification) => notification.method === 'turn/completed' && notification.params.threadId === threadId,
          );
        if (completed) {
          expect((completed.params.turn as { status: string }).status).toBe('completed');
          return notifications.slice(before);
        }
        await Bun.sleep(50);
      }
      throw new Error(`Turn did not complete: ${JSON.stringify(notifications.slice(before))}`);
    };

    await start();
    const threadId = await startOrResumeCodexThread(app!, undefined, params);
    const first = await turn(threadId, 'first local prompt');
    expect(JSON.stringify(first)).toContain('local reply 1');
    expect(requests[0].model).toBe('example-model');
    expect(requests[0].stream).toBe(true);
    expect(JSON.stringify(requests[0].input)).toContain('first local prompt');

    await stopApp();
    await start();
    expect(await startOrResumeCodexThread(app!, threadId, params)).toBe(threadId);
    const second = await turn(threadId, 'second local prompt');
    expect(JSON.stringify(second)).toContain('local reply 2');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].input)).toContain('first local prompt');
    expect(JSON.stringify(requests[1].input)).toContain('second local prompt');
  }, 30_000);
});
