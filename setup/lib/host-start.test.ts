import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { markLogs, probeHostReady, waitForHostStart } from './host-start.js';

function logs(): { out: string; err: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-start-'));
  return { out: path.join(dir, 'nanoclaw.log'), err: path.join(dir, 'nanoclaw.error.log') };
}

/** A fake clock: each pause advances time, and `onTick` lets the "host" act between polls. */
function clock(onTick: (tick: number) => void = () => {}) {
  let t = 0;
  let tick = 0;
  return {
    now: () => t,
    pause: async (ms: number) => {
      t += ms;
      onTick(++tick);
    },
  };
}

const never = async () => false;

describe('waitForHostStart', () => {
  it('counts a start once the host answers as ready', async () => {
    const { out, err } = logs();
    let ready = false;
    const c = clock((tick) => {
      if (tick === 3) ready = true;
    });
    expect(
      await waitForHostStart(
        markLogs([out, err]),
        () => true,
        async () => ready,
        { ...c, pollMs: 100 },
      ),
    ).toBe('running');
  });

  it('does not report a crash-looping host whose unit stays active as running', async () => {
    const { out, err } = logs();
    const marks = markLogs([out, err]);
    const c = clock((tick) => {
      if (tick === 1) fs.appendFileSync(err, '[ts] \x1b[41mFATAL\x1b[0m \x1b[36mStartup failed\x1b[39m err=runtime\n');
    });
    expect(await waitForHostStart(marks, () => true, never, { ...c, pollMs: 100 })).toBe('failed');
  });

  it('ignores a startup failure an earlier boot left in the log', async () => {
    const { out, err } = logs();
    fs.writeFileSync(err, '[old] FATAL Startup failed\n');
    const marks = markLogs([out, err]);
    expect(await waitForHostStart(marks, () => true, never, { ...clock(), timeoutMs: 1000, pollMs: 100 })).toBe(
      'timeout',
    );
  });

  it('reads the whole file again when it was truncated since the mark', async () => {
    const { out, err } = logs();
    fs.writeFileSync(err, 'x'.repeat(4096));
    const marks = markLogs([out, err]);
    fs.writeFileSync(err, '[ts] FATAL Startup failed\n');
    expect(await waitForHostStart(marks, () => true, never, { ...clock(), pollMs: 100 })).toBe('failed');
  });

  it('waits past the deadline for a host the crash circuit breaker is holding back', async () => {
    const { out, err } = logs();
    const marks = markLogs([out, err]);
    let ready = false;
    const c = clock((tick) => {
      if (tick === 1) {
        fs.appendFileSync(
          err,
          `[ts] \x1b[33mWARN\x1b[39m \x1b[36mCircuit breaker: delaying startup due to repeated crashes\x1b[39m attempt=5 delaySec=120 resumeAt="${new Date(120_000).toISOString()}"\n`,
        );
      }
      if (tick === 1200) ready = true;
    });
    expect(
      await waitForHostStart(
        marks,
        () => true,
        async () => ready,
        { ...c, timeoutMs: 1000, pollMs: 100 },
      ),
    ).toBe('running');
  });

  it('waits for a process the service manager has not started yet', async () => {
    const { out, err } = logs();
    let alive = false;
    let ready = false;
    const c = clock((tick) => {
      if (tick === 2) alive = true;
      if (tick === 4) ready = true;
    });
    expect(
      await waitForHostStart(
        markLogs([out, err]),
        () => alive,
        async () => ready,
        { ...c, pollMs: 100 },
      ),
    ).toBe('running');
  });

  it('stops waiting when a process it saw start goes away before it is ready', async () => {
    const { out, err } = logs();
    let alive = true;
    const c = clock((tick) => {
      if (tick === 2) alive = false;
    });
    expect(await waitForHostStart(markLogs([out, err]), () => alive, never, { ...c, pollMs: 100 })).toBe('exited');
  });

  it('treats a process that is gone at the first look as exited when the caller saw it start', async () => {
    const { out, err } = logs();
    expect(await waitForHostStart(markLogs([out, err]), () => false, never, { ...clock(), started: true })).toBe(
      'exited',
    );
  });
});

describe('probeHostReady', () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  function host(answer: object): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-probe-'));
    const socketPath = path.join(dir, 'ncl.sock');
    const server = net.createServer((conn) => {
      conn.once('data', () => conn.end(JSON.stringify(answer) + '\n'));
    });
    servers.push(server);
    return new Promise((resolve) => server.listen(socketPath, () => resolve(socketPath)));
  }

  it('is not ready while the host answers not-ready', async () => {
    const socketPath = await host({ id: 'x', ok: false, error: { code: 'not-ready', message: 'starting' } });
    expect(await probeHostReady(socketPath)).toBe(false);
  });

  it('is ready once the host dispatches the probe', async () => {
    const socketPath = await host({ id: 'x', ok: false, error: { code: 'unknown-command', message: 'no such' } });
    expect(await probeHostReady(socketPath)).toBe(true);
  });

  it('is not ready when nothing listens on the socket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-probe-'));
    expect(await probeHostReady(path.join(dir, 'ncl.sock'))).toBe(false);
  });
});
