import fs from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { SocketTransport } from '../../src/cli/socket-client.js';

/** Where the host's logs ended before a start, so only lines written by that start are judged. */
export interface LogMark {
  path: string;
  offset: number;
}

export type HostStart = 'running' | 'failed' | 'exited' | 'timeout';

const FAILED = /\bStartup failed\b/;
const BACKOFF = /Circuit breaker: delaying startup[^\n]*?resumeAt="?([0-9T:.+-]+Z)/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export function hostLogPaths(projectRoot: string): string[] {
  return [path.join(projectRoot, 'logs', 'nanoclaw.log'), path.join(projectRoot, 'logs', 'nanoclaw.error.log')];
}

export function hostSocketPath(projectRoot: string): string {
  return path.join(projectRoot, 'data', 'ncl.sock');
}

export function markLogs(paths: string[]): LogMark[] {
  return paths.map((p) => ({ path: p, offset: fileSize(p) }));
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function readSince(mark: LogMark): string {
  const size = fileSize(mark.path);
  const start = size < mark.offset ? 0 : mark.offset;
  if (size <= start) return '';
  const fd = fs.openSync(mark.path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8').replace(ANSI, '');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The host binds its ncl socket early and answers `not-ready` until startup completes, so any other answer means
 * the host is up. The probe names no real command, so a ready host only reports it unknown.
 */
export async function probeHostReady(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const frame = await Promise.race([
      new SocketTransport(socketPath).sendFrame({ id: 'setup-probe', command: 'setup-readiness-probe', args: {} }),
      timeout,
    ]);
    if (!frame) return false;
    return frame.ok || (frame.error.code !== 'not-ready' && frame.error.code !== 'transport-error');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A host being replaced keeps serving its socket until its asynchronous shutdown reaches the listener, so a ready
 * answer only counts for the new host once the old process is gone.
 */
export function readyAfterExit(oldPid: number | null, probe: () => Promise<boolean>): () => Promise<boolean> {
  return async () => (oldPid === null || !pidAlive(oldPid)) && probe();
}

/**
 * A service manager reports a crash-looping host as active between restarts, so a start counts only once the host
 * itself answers as ready. A logged startup failure, or the process going away after it was seen, ends the wait
 * early; a process the manager has not started yet is waited for, and so is a host the crash circuit breaker holds
 * back, until its logged resume time plus the usual allowance.
 */
export async function waitForHostStart(
  marks: LogMark[],
  isAlive: () => boolean,
  isReady: () => Promise<boolean>,
  opts: {
    /** The caller already saw the process start, so its absence means it exited rather than not yet started. */
    started?: boolean;
    timeoutMs?: number;
    pollMs?: number;
    pause?: (ms: number) => Promise<unknown>;
    now?: () => number;
  } = {},
): Promise<HostStart> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 500;
  const pause = opts.pause ?? sleep;
  const now = opts.now ?? Date.now;
  let seenAlive = opts.started ?? false;
  let deadline = now() + timeoutMs;
  for (;;) {
    const written = marks.map(readSince).join('\n');
    if (FAILED.test(written)) return 'failed';
    const resumeAt = Date.parse(BACKOFF.exec(written)?.[1] ?? '');
    if (Number.isFinite(resumeAt)) deadline = Math.max(deadline, resumeAt + timeoutMs);
    if (await isReady()) return 'running';
    if (isAlive()) seenAlive = true;
    else if (seenAlive) return 'exited';
    if (now() >= deadline) return 'timeout';
    await pause(pollMs);
  }
}
