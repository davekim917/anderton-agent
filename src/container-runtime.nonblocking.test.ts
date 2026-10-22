import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// A complete stub: the real log.ts installs process-wide exit handlers at module scope.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import {
  _setRuntimeTimeoutsForTesting,
  CONTAINER_RUNTIME_BIN,
  RuntimeCallTimeoutError,
  runtimeShowsRunning,
  stopContainer,
} from './container-runtime.js';
import { allowSubprocess } from './test-hermeticity.js';

// A stand-in runtime binary first on PATH: each verb sleeps or fails as the case sets, and every call is logged.
const STUB = `#!/bin/sh
echo "$*" >> "$STUB_RUNTIME_LOG"
case "$1" in
  stop) [ -n "$STUB_STOP_EXIT" ] && exit "$STUB_STOP_EXIT"; exec sleep "\${STUB_STOP_SLEEP:-0}" ;;
  kill) exit "\${STUB_KILL_EXIT:-0}" ;;
  ps) [ -n "$STUB_PS_SLEEP" ] && exec sleep "$STUB_PS_SLEEP"; echo "\${STUB_PS_OUT:-}" ;;
esac
`;

const STUB_ENV = [
  'STUB_RUNTIME_LOG',
  'STUB_STOP_EXIT',
  'STUB_STOP_SLEEP',
  'STUB_KILL_EXIT',
  'STUB_PS_SLEEP',
  'STUB_PS_OUT',
];

let dir: string;
let logFile: string;
const originalPath = process.env.PATH;

beforeAll(() => {
  allowSubprocess([CONTAINER_RUNTIME_BIN, 'sh', 'sleep']);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runtime-stub-'));
  fs.writeFileSync(path.join(dir, CONTAINER_RUNTIME_BIN), STUB, { mode: 0o755 });
  logFile = path.join(dir, 'calls.log');
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  _setRuntimeTimeoutsForTesting();
  for (const key of STUB_ENV) delete process.env[key];
  fs.rmSync(logFile, { force: true });
});

function stubCalls(): string[] {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/** Counts timer turns while `work` runs: a call that blocks the event loop counts none. */
async function timerTurnsDuring<T>(
  work: () => Promise<T>,
): Promise<{ turns: number; result: PromiseSettledResult<T> }> {
  let turns = 0;
  const timer = setInterval(() => (turns += 1), 20);
  try {
    const [result] = await Promise.allSettled([work()]);
    return { turns, result };
  } finally {
    clearInterval(timer);
  }
}

describe('runtime calls run off the event loop', () => {
  it('a slow docker stop leaves timers firing while it runs', async () => {
    process.env.STUB_RUNTIME_LOG = logFile;
    process.env.STUB_STOP_SLEEP = '0.6';

    const { turns, result } = await timerTurnsDuring(() => stopContainer('nanoclaw-stub-slow-1'));

    expect(result.status).toBe('fulfilled');
    expect(turns).toBeGreaterThanOrEqual(5);
    expect(stubCalls()).toEqual(['stop -t 1 nanoclaw-stub-slow-1']);
  });

  it('a stop past its bound is killed and escalates to docker kill', async () => {
    process.env.STUB_RUNTIME_LOG = logFile;
    process.env.STUB_STOP_SLEEP = '30';
    _setRuntimeTimeoutsForTesting({ stopMs: 300 });

    const started = Date.now();
    const { turns, result } = await timerTurnsDuring(() => stopContainer('nanoclaw-stub-hung-1'));

    expect(result.status).toBe('fulfilled');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(turns).toBeGreaterThan(0);
    expect(stubCalls()).toEqual(['stop -t 1 nanoclaw-stub-hung-1', 'kill nanoclaw-stub-hung-1']);
  });

  it('a timed-out stop whose escalation also fails rejects as a timeout', async () => {
    process.env.STUB_RUNTIME_LOG = logFile;
    process.env.STUB_STOP_SLEEP = '30';
    process.env.STUB_KILL_EXIT = '1';
    _setRuntimeTimeoutsForTesting({ stopMs: 300 });

    await expect(stopContainer('nanoclaw-stub-hung-2')).rejects.toBeInstanceOf(RuntimeCallTimeoutError);
    expect(stubCalls()).toEqual(['stop -t 1 nanoclaw-stub-hung-2', 'kill nanoclaw-stub-hung-2']);
  });

  it('a stop that fails outright is not escalated', async () => {
    process.env.STUB_RUNTIME_LOG = logFile;
    process.env.STUB_STOP_EXIT = '1';

    await expect(stopContainer('nanoclaw-stub-gone-1')).rejects.toThrow();
    expect(stubCalls()).toEqual(['stop -t 1 nanoclaw-stub-gone-1']);
  });

  it('a hung listing times out as "could not ask", never as absent', async () => {
    process.env.STUB_RUNTIME_LOG = logFile;
    process.env.STUB_PS_SLEEP = '30';
    _setRuntimeTimeoutsForTesting({ queryMs: 300 });

    const { turns, result } = await timerTurnsDuring(() => runtimeShowsRunning('nanoclaw-stub-ps-1'));

    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(RuntimeCallTimeoutError);
    expect(turns).toBeGreaterThan(0);
  });
});
