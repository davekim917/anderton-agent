import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// callHaiku resolves credentials through structuredCredentials(), which
// merges in `.env`-file values via
// readEnvFileMatching() whenever passed process.env directly. Stub it out so
// tests never touch the real on-disk `.env` (which, on a live install, holds
// real OAuth tokens) — credential slots for these tests come exclusively
// from process.env, set explicitly per test below.
vi.mock('./env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.js')>()),
  readEnvFileMatching: vi.fn(() => ({})),
}));

import { DEFAULT_HAIKU_MODEL } from './flag-parser.js';
import { _setClaudeCliForTesting, callHaiku, CallHaikuHttpError, claudeCliAvailable } from './llm.js';
import { installFakeClaudeCli, type FakeClaudeCall } from './test-fixtures/fake-claude-cli.js';
import { allowSubprocess } from './test-hermeticity.js';

function flag(call: FakeClaudeCall, name: string): string | undefined {
  const i = call.argv.indexOf(name);
  return i === -1 ? undefined : call.argv[i + 1];
}

describe('callHaiku', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_2', 'HTTPS_PROXY', 'GH_TOKEN'];
  let cli: ReturnType<typeof installFakeClaudeCli>;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_2;
    cli = installFakeClaudeCli();
  });

  afterEach(() => {
    cli.uninstall();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('asks the CLI for Haiku at low effort with no tools, settings or session, prompt on stdin', async () => {
    cli.script({ 'test-key': { result: '  Snowflake auto-suspend  ' } });

    expect(await callHaiku('label this')).toBe('Snowflake auto-suspend');

    const [call] = cli.calls();
    expect(flag(call, '--model')).toBe(DEFAULT_HAIKU_MODEL);
    expect(flag(call, '--effort')).toBe('low');
    expect(flag(call, '--tools')).toBe('');
    expect(flag(call, '--setting-sources')).toBe('');
    expect(call.argv).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence']));
    expect(flag(call, '--output-format')).toBe('json');
    expect(call.stdin).toBe('label this');
  });

  it.each(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'])(
    'sends no effort to %s, which takes none',
    async (model) => {
      cli.script({ 'test-key': { result: 'ok' } });

      await callHaiku('hello', { model });

      const [call] = cli.calls();
      expect(flag(call, '--model')).toBe(model);
      expect(call.argv).not.toContain('--effort');
    },
  );

  it('keeps low effort for a model the effort table does not list', async () => {
    cli.script({ 'test-key': { result: 'ok' } });

    await callHaiku('hello', { model: 'claude-haiku-9-9' });

    expect(flag(cli.calls()[0], '--effort')).toBe('low');
  });

  it("passes the slot's credential and an isolated config, and nothing else from the host env", async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    process.env.GH_TOKEN = 'unrelated-secret';
    cli.script({ 'test-key': { result: 'ok' } });

    await callHaiku('hello');

    const { env } = cli.calls()[0];
    expect(env.ANTHROPIC_API_KEY).toBe('test-key');
    expect(env.CLAUDE_CONFIG_DIR).toBe(cli.configDir);
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('0');
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it('sends the optional system prompt and model', async () => {
    cli.script({ 'test-key': { result: 'ok' } });

    await callHaiku('user text', { system: 'be brief', model: 'claude-test-model' });

    const [call] = cli.calls();
    expect(flag(call, '--system-prompt')).toBe('be brief');
    expect(flag(call, '--model')).toBe('claude-test-model');
  });

  it('carries the API status and message of a failed call into the thrown error', async () => {
    cli.script({
      'test-key': { isError: true, apiErrorStatus: 429, result: 'This request would exceed your rate limit' },
    });

    const err = await callHaiku('hello').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CallHaikuHttpError);
    expect((err as CallHaikuHttpError).status).toBe(429);
    expect((err as Error).message).toBe('callHaiku: Anthropic returned 429: This request would exceed your rate limit');
    expect(cli.calls()).toHaveLength(1);
  });

  it.each([
    ['output that is not JSON', { raw: 'Not logged in', exitCode: 1 }, 10_000, /exited 1 without a result/],
    ['an error with no API status', { isError: true, result: 'boom' }, 10_000, /claude CLI failed: boom/],
    [
      'an error subtype that carries errors instead of a result',
      { raw: JSON.stringify({ is_error: true, subtype: 'error_during_execution', errors: ['tool loop failed'] }) },
      10_000,
      /claude CLI failed: tool loop failed/,
    ],
    ['no answer within the timeout', { result: 'late', delayMs: 2_000 }, 300, /did not answer within 300 ms/],
  ])('rejects on %s', async (_label, reply, timeoutMs, message) => {
    cli.script({ 'test-key': reply });

    await expect(callHaiku('hello', { timeoutMs })).rejects.toThrow(message);
  });

  it('names the install script when no claude CLI is on PATH', async () => {
    allowSubprocess(['missing-claude']);
    _setClaudeCliForTesting({ executable: '/nonexistent/missing-claude', configDir: cli.configDir });

    await expect(callHaiku('hello')).rejects.toThrow(/no claude CLI on PATH; install it with setup\/install-claude.sh/);
  });

  it('claudeCliAvailable() reads PATH', () => {
    _setClaudeCliForTesting(null);
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = cli.configDir;
      expect(claudeCliAvailable()).toBe(false);
      fs.writeFileSync(path.join(cli.configDir, 'claude'), '');
      expect(claudeCliAvailable()).toBe(true);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  describe('trying each key in turn', () => {
    beforeEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-slot-1-token';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_2 = 'oauth-slot-2-token';
    });

    it.each([
      ['a 429', { isError: true, apiErrorStatus: 429, result: 'limit' }],
      ['a 401', { isError: true, apiErrorStatus: 401, result: 'auth' }],
      ['a 529', { isError: true, apiErrorStatus: 529, result: 'overloaded' }],
      ['a CLI failure', { raw: 'crashed', exitCode: 1 }],
    ])('moves to the next key on %s', async (_label, failure) => {
      cli.script({ 'oauth-slot-1-token': failure, 'oauth-slot-2-token': { result: 'from slot 2' } });

      expect(await callHaiku('hello')).toBe('from slot 2');
      expect(cli.calls().map((c) => c.env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([
        'oauth-slot-1-token',
        'oauth-slot-2-token',
      ]);
    });

    it('rethrows a 429 over a later key’s different failure', async () => {
      cli.script({
        'oauth-slot-1-token': { isError: true, apiErrorStatus: 429, result: 'limit' },
        'oauth-slot-2-token': { isError: true, apiErrorStatus: 401, result: 'auth' },
      });

      await expect(callHaiku('hello')).rejects.toMatchObject({ status: 429 });
    });

    it('throws the last error after one call per key', async () => {
      const limit = { isError: true, apiErrorStatus: 429, result: 'limit' };
      cli.script({ 'oauth-slot-1-token': limit, 'oauth-slot-2-token': limit });

      await expect(callHaiku('hello')).rejects.toMatchObject({ status: 429 });
      expect(cli.calls()).toHaveLength(2);
    });

    it('starts from the first key on every call', async () => {
      cli.script({ 'oauth-slot-1-token': { result: 'first' } });

      expect(await callHaiku('hello')).toBe('first');
      expect(await callHaiku('hello again')).toBe('first');
      expect(cli.calls().map((c) => c.env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([
        'oauth-slot-1-token',
        'oauth-slot-1-token',
      ]);
    });
  });
});
