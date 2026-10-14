import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { allowSubprocess, allowWritesTo } from '../../../../src/test-hermeticity.js';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-nanoclaw.sh');
const OWN = 'aaaa1111';
const LIVE = 'bbbb2222';

allowSubprocess(['bash', 'sleep']);

let root: string;
let run: string;
let liveLog: string;
let live: string;
const LIVE_TAGS = `nanoclaw-agent-v2-${LIVE}:latest\nnanoclaw-agent-v2-${LIVE}:pre-deploy\n`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-guard-'));
  allowWritesTo(root);
  run = path.join(root, 'run');
  live = path.join(root, 'live');
  fs.mkdirSync(run);
  fs.mkdirSync(path.join(live, 'logs'), { recursive: true });
  liveLog = path.join(live, 'logs', 'nanoclaw.log');
  fs.writeFileSync(liveLog, 'before the run\n');
  fs.writeFileSync(
    path.join(run, 'state'),
    [
      `SLUG=${OWN}`,
      `LIVE_SLUG=${LIVE}`,
      `LIVE_CHECKOUT=${live}`,
      `LIVE_LOG_OFFSET=${'before the run\n'.length}`,
      'EVENTS_STOPPED=1',
      `IMAGE=nanoclaw-agent-v2-${OWN}:latest`,
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(run, 'host.log'), 'INFO Reconciled sessions at startup adopted=0 stopped=0\n');
  fs.writeFileSync(path.join(run, 'images-before.txt'), LIVE_TAGS);
  fs.writeFileSync(path.join(run, 'images-after.txt'), LIVE_TAGS);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function events(...lines: string[]): void {
  fs.writeFileSync(path.join(run, 'docker-events.log'), lines.map((l) => `1 container ${l}\n`).join(''));
}

function imageEvent(line: string): void {
  fs.appendFileSync(path.join(run, 'docker-events.log'), `1 image ${line}\n`);
}

function guard(): { status: number | null; out: string } {
  const r = spawnSync('bash', [HELPER, 'guard', run], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe('verify-nanoclaw guard', () => {
  it('passes when the only non-own stops carry the live host’s own stop record', () => {
    events(`stop nanoclaw-v2-own-1 install=${OWN}`, `kill nanoclaw-v2-live-1 install=${LIVE}`);
    fs.appendFileSync(liveLog, 'INFO Killing container sessionId=s1 reason=idle containerName="nanoclaw-v2-live-1"\n');
    const r = guard();
    expect(r.status).toBe(0);
    expect(r.out).toContain('own stop record: 1; unattributed: 0');
  });

  it('fails a live stop whose name appears only in an exit line', () => {
    events(`stop nanoclaw-v2-live-1 install=${LIVE}`);
    fs.appendFileSync(liveLog, 'INFO Container exited sessionId=s1 code=143 containerName="nanoclaw-v2-live-1"\n');
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.out).toContain('UNATTRIBUTED: live container nanoclaw-v2-live-1');
  });

  it('fails when a large verify host log names a non-own container', () => {
    events(`stop nanoclaw-v2-live-1 install=${LIVE}`);
    fs.appendFileSync(liveLog, 'INFO Killing container containerName="nanoclaw-v2-live-1"\n');
    // The name comes early and 200 KB follow it: a `cat | grep -q` pipeline under pipefail reads that as no match.
    fs.appendFileSync(path.join(run, 'host.log'), 'WARN stopping nanoclaw-v2-live-1\n' + 'x'.repeat(200_000) + '\n');
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.out).toContain('VIOLATION: the verify host log names non-own container nanoclaw-v2-live-1');
  });

  it('fails when shared infrastructure stops during the run', () => {
    events('stop onecli install=');
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.out).toContain('LIVE IMPACT: shared container onecli');
  });

  it('treats the live install\u2019s configured gateway container as shared', () => {
    fs.appendFileSync(path.join(run, 'state'), 'SHARED_CONTAINERS=acme-gateway onecli-postgres\n');
    events('kill acme-gateway install=');
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.out).toContain('LIVE IMPACT: shared container acme-gateway');
  });

  it('fails when the event recorder died before cleanup stopped it', () => {
    events(`stop nanoclaw-v2-own-1 install=${OWN}`);
    const state = path.join(run, 'state');
    fs.writeFileSync(
      state,
      fs.readFileSync(state, 'utf8').replace('EVENTS_STOPPED=1\n', 'EVENTS_PID=999999999\nEVENTS_START=1\n'),
    );
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.out).toContain('the event recorder is not running');
  });

  it('fails when the event recorder logged an error instead of events', () => {
    events(`stop nanoclaw-v2-own-1 install=${OWN}`);
    fs.appendFileSync(path.join(run, 'docker-events.log'), 'Error response from daemon: connection reset\n');
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.out).toContain('the event recorder logged something other than an event');
  });

  it('passes when the only image change is this run untagging its own image', () => {
    events(`stop nanoclaw-v2-own-1 install=${OWN}`);
    imageEvent(`untag nanoclaw-agent-v2-${OWN}:latest install=`);
    expect(guard().status).toBe(0);
  });

  it('fails when a live image tag is untagged during the run', () => {
    events(`stop nanoclaw-v2-own-1 install=${OWN}`);
    imageEvent(`untag nanoclaw-agent-v2-${LIVE}:pre-deploy install=`);
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.out).toContain(`image nanoclaw-agent-v2-${LIVE}:pre-deploy got untag`);
  });

  it('fails when a tag present at launch is gone, even with no event naming it', () => {
    events(`stop nanoclaw-v2-own-1 install=${OWN}`);
    fs.writeFileSync(path.join(run, 'images-after.txt'), `nanoclaw-agent-v2-${LIVE}:latest\n`);
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.out).toContain(`image tag nanoclaw-agent-v2-${LIVE}:pre-deploy present at launch is gone`);
  });

  it('fails when no image inventory was recorded at launch', () => {
    events(`stop nanoclaw-v2-own-1 install=${OWN}`);
    fs.rmSync(path.join(run, 'images-before.txt'));
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.out).toContain('no image inventory was recorded');
  });

  it('fails when the verify host stopped a container at boot', () => {
    events(`stop nanoclaw-v2-own-1 install=${OWN}`);
    fs.appendFileSync(path.join(run, 'host.log'), 'INFO Stopped an unadoptable container at startup\n');
    expect(guard().status).toBe(3);
  });
});

describe('verify-nanoclaw cleanup', () => {
  let calls: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    calls = path.join(root, 'calls.log');
    fs.writeFileSync(path.join(root, 'images.txt'), LIVE_TAGS);
    fs.writeFileSync(
      path.join(bin, 'docker'),
      '#!/usr/bin/env bash\necho "docker $*" >>"$CALLS"\ncase "$1" in\n  ps) [ "$2" = -q ] && echo c0ffee01 ;;\n  images) cat "$IMAGES" ;;\nesac\nexit 0\n',
      { mode: 0o755 },
    );
    for (const tool of ['onecli', 'systemctl']) {
      fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\necho "${tool} $*" >>"$CALLS"\n`, { mode: 0o755 });
    }
    fs.mkdirSync(path.join(root, 'home'));
    events();
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: path.join(root, 'home'),
      CALLS: calls,
      IMAGES: path.join(root, 'images.txt'),
    };
  });

  function cleanup(): { status: number | null; out: string; calls: string } {
    const r = spawnSync('bash', [HELPER, 'cleanup', run], { encoding: 'utf8', env });
    return {
      status: r.status,
      out: r.stdout + r.stderr,
      calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    };
  }

  function setState(key: string, value: string): void {
    fs.appendFileSync(path.join(run, 'state'), `${key}=${value}\n`);
  }

  it('stops this install\u2019s containers by its own label', () => {
    const r = cleanup();
    expect(r.calls).toContain(`docker ps -q --filter label=nanoclaw-install=${OWN}`);
    expect(r.calls).toContain('docker stop -t 5 c0ffee01');
    expect(r.status).toBe(0);
  });

  it('stops nothing when the recorded slug is the live install\u2019s', () => {
    setState('SLUG', LIVE);
    const r = cleanup();
    expect(r.calls).not.toContain('docker stop');
    expect(r.out).toContain(`slug ${LIVE} is the live install's; stopped nothing`);
    expect(fs.readFileSync(path.join(run, 'cleanup.txt'), 'utf8')).toContain('FAILED');
    expect(r.status).not.toBe(0);
  });

  it('stops nothing when the slug matches the live checkout\u2019s path even if LIVE_SLUG disagrees', () => {
    setState('SLUG', crypto.createHash('sha1').update(live).digest('hex').slice(0, 8));
    const r = cleanup();
    expect(r.calls).not.toContain('docker stop');
    expect(r.status).not.toBe(0);
  });

  it('signals a recorded host PID only while its start time still matches', () => {
    // Started through a shell that exits, so the sleep is reaped by init rather than left a zombie of this process.
    const pid = Number(spawnSync('bash', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout);
    const start = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21];
    try {
      setState('HOST_PID', String(pid));
      setState('HOST_START', `${Number(start) + 1}`);
      cleanup();
      expect(fs.existsSync(`/proc/${pid}`)).toBe(true);

      setState('HOST_START', start);
      cleanup();
      expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
    } finally {
      if (fs.existsSync(`/proc/${pid}`)) process.kill(pid, 'SIGKILL');
    }
  });
});
