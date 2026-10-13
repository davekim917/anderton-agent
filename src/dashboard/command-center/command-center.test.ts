import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuthedRequestContext } from '../router.js';
import { _resetCommandCenterCacheForTesting, buildCommandCenter, commandCenterHandler } from './handler.js';
import type { CommandCenterDeps } from './handler.js';
import { readPrs, type GithubGet } from './prs.js';
import { readHerdrTitles, readHostSessions, sessionProcessLive } from './sessions.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-center-'));
  _resetCommandCenterCacheForTesting();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const HOME = '/home/op';
const ALIVE = new Set([101, 102, 103, 104, 105]);
const isAlive = (pid: number) => ALIVE.has(pid);
const AT = Date.parse('2026-10-12T15:00:00.000Z');

function writeSession(dir: string, file: string, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(body));
}

function sessionFile(pid: number, sessionId: string, status: string, name: string): Record<string, unknown> {
  return {
    pid,
    sessionId,
    cwd: `${HOME}/nanoclaw-v2`,
    status,
    name,
    statusUpdatedAt: AT,
    updatedAt: AT + 1,
    messagingSocketPath: '/tmp/secret.sock',
    bridgeSessionId: 'bridge-1',
    peerFeatures: ['x'],
  };
}

describe('readHostSessions', () => {
  it('maps every file status, keeps only contract fields, and drops dead pids and .key files', () => {
    const dir = path.join(tmp, 'sessions');
    fs.mkdirSync(dir);
    writeSession(dir, '101.json', sessionFile(101, 's-wait', 'waiting', 'alpha'));
    writeSession(dir, '102.json', sessionFile(102, 's-busy', 'busy', 'beta'));
    writeSession(dir, '103.json', sessionFile(103, 's-idle', 'idle', 'gamma'));
    writeSession(dir, '104.json', sessionFile(104, 's-shell', 'shell', 'delta'));
    writeSession(dir, '105.json', sessionFile(105, 's-odd', 'compacting', 'epsilon'));
    writeSession(dir, '999.json', sessionFile(999, 's-dead', 'busy', 'dead'));
    fs.writeFileSync(path.join(dir, '103-null.json'), 'null');
    fs.writeFileSync(
      path.join(dir, '102-bad.json'),
      JSON.stringify(sessionFile(102, 's-bad-time', 'busy', 'bad')).replace(String(AT), '1e999'),
    );
    // A key file shaped like a session would surface if the reader opened it.
    writeSession(dir, '101.abc.key', sessionFile(101, 's-key', 'busy', 'keyfile'));

    const sessions = readHostSessions(dir, new Map([['s-busy', 'Herdr title']]), isAlive, HOME);

    const base = { cwd: '~/nanoclaw-v2', since: '2026-10-12T15:00:00.000Z' };
    expect(sessions.sort((a, b) => a.session_id.localeCompare(b.session_id))).toEqual([
      { ...base, session_id: 's-busy', title: 'Herdr title', status: 'working' },
      { ...base, session_id: 's-idle', title: 'gamma', status: 'idle' },
      { ...base, session_id: 's-odd', title: 'epsilon', status: 'unknown' },
      { ...base, session_id: 's-shell', title: 'delta', status: 'shell' },
      { ...base, session_id: 's-wait', title: 'alpha', status: 'needs_you' },
    ]);
  });
});

describe('sessionProcessLive', () => {
  const ownStart = () => {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    return stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(' ')[19];
  };

  it('accepts a pid whose start time matches procStart', () => {
    expect(sessionProcessLive(process.pid, ownStart())).toBe(true);
  });

  it('rejects a live pid that a different process now holds', () => {
    expect(sessionProcessLive(process.pid, String(Number(ownStart()) + 1))).toBe(false);
  });

  it.each([undefined, '', 'yesterday'])('rejects a live pid whose record carries no usable procStart (%s)', (start) => {
    expect(sessionProcessLive(process.pid, start)).toBe(false);
  });

  it('counts fields after a command name holding spaces and parentheses', () => {
    const procRoot = path.join(tmp, 'proc');
    fs.mkdirSync(path.join(procRoot, '42'), { recursive: true });
    const after = ['S', ...Array.from({ length: 18 }, (_, i) => String(i)), '777', '0'].join(' ');
    fs.writeFileSync(path.join(procRoot, '42', 'stat'), `42 (a (b) c) ${after}`);
    expect(sessionProcessLive(42, '777', procRoot)).toBe(true);
    expect(sessionProcessLive(42, '17', procRoot)).toBe(false);
  });
});

describe('readHerdrTitles', () => {
  it('reads titles keyed by agent session id', async () => {
    const out = JSON.stringify({
      result: {
        agents: [
          { agent_session: { value: 's-1' }, terminal_title_stripped: 'Archive migration' },
          { agent_session: { value: 's-2' }, terminal_title_stripped: '' },
        ],
      },
    });
    expect([...(await readHerdrTitles(['printf', '%s', out]))]).toEqual([['s-1', 'Archive migration']]);
  });

  it.each([
    ['missing binary', ['/nonexistent/herdr'] as [string]],
    ['non-zero exit', ['false'] as [string]],
    ['unparseable output', ['printf', 'not json'] as [string, string]],
  ])('%s yields no titles', async (_label, command) => {
    expect((await readHerdrTitles(command)).size).toBe(0);
  });

  it('gives up on a slow herdr at the timeout', async () => {
    const started = Date.now();
    expect((await readHerdrTitles(['sleep', '5'], 100)).size).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a failed herdr falls back to the session file name', async () => {
    const dir = path.join(tmp, 'sessions');
    fs.mkdirSync(dir);
    writeSession(dir, '101.json', sessionFile(101, 's-wait', 'waiting', 'alpha'));
    const cc = await buildCommandCenter({
      sessionsDir: dir,
      repoRoot: tmp,
      liveSha: () => null,
      titles: () => readHerdrTitles(['/nonexistent/herdr']),
      github: async () => null,
      isAlive,
    });
    expect(cc.sessions.map((s) => s.title)).toEqual(['alpha']);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function commit(repo: string, msg: string): string {
  git(repo, 'commit', '--allow-empty', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

const NOW = new Date('2026-10-12T16:00:00.000Z');
const RECENT = '2026-10-11T12:00:00Z';

function pull(n: number, extra: Record<string, unknown>) {
  return {
    number: n,
    title: `PR ${n}`,
    html_url: `https://github.com/acme/widgets/pull/${n}`,
    state: 'closed',
    merged_at: null,
    merge_commit_sha: null,
    updated_at: RECENT,
    ...extra,
  };
}

describe('readPrs', () => {
  let repo: string;
  let live: string;
  let unshipped: string;
  let pulls: unknown[];
  const calls: string[] = [];

  beforeEach(() => {
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    const shipped = commit(repo, 'shipped');
    live = commit(repo, 'live');
    git(repo, 'checkout', '-q', '-b', 'side', shipped);
    unshipped = commit(repo, 'merged after the deploy');
    calls.length = 0;
    pulls = [
      pull(10, { merged_at: RECENT, merge_commit_sha: shipped }),
      pull(11, { merged_at: RECENT, merge_commit_sha: unshipped }),
      pull(12, { state: 'open' }),
      pull(13, {}),
      pull(14, { merged_at: RECENT, merge_commit_sha: 'f'.repeat(40) }),
      pull(9, { state: 'open', updated_at: '2026-10-04T12:00:00Z' }),
    ];
  });

  const issues = [
    { body: 'Bypassed.\n<!-- gate-bypass pr=10 -->\n<!-- gate-bypass pr=12 -->' },
    { body: '<!-- gate-bypass pr=11 -->', pull_request: { url: 'x' } },
    { body: null },
    { body: 'An old PR outside the window.\n<!-- gate-bypass pr=3 -->' },
  ];

  const get: GithubGet = async (p) => {
    calls.push(p);
    if (p.startsWith('/repos/acme/widgets/pulls?')) return pulls;
    if (p.startsWith('/repos/acme/widgets/issues?')) return issues;
    throw new Error(`unexpected ${p}`);
  };

  const stages = (prs: { number: number; stage: string; unreviewed: boolean }[]) =>
    prs.map((p) => [p.number, p.stage, p.unreviewed]);

  it('derives each stage from ancestry of the live build, and unreviewed from bypass markers on real issues only', async () => {
    const out = await readPrs(repo, get, NOW, live);
    expect(out.live_sha).toBe(live);
    expect(out.gate_bypass_prs).toEqual([3, 10, 12]);
    expect(stages(out.prs)).toEqual([
      [10, 'deployed', true],
      [11, 'merged', false],
      [12, 'open', true],
      [14, 'merged', false],
    ]);
    expect(out.prs[0]).toEqual({
      number: 10,
      title: 'PR 10',
      url: 'https://github.com/acme/widgets/pull/10',
      stage: 'deployed',
      unreviewed: true,
      updated_at: RECENT,
    });
    expect(calls.every((c) => c.startsWith('/repos/acme/widgets/'))).toBe(true);
  });

  it.each([
    'https://git.example.com/acme/widgets.git',
    'https://notgithub.com/acme/widgets.git',
    'https://git.example.com/github.com/acme/widgets.git',
  ])('origin %s is not GitHub: a failed read, not an empty one', async (url) => {
    git(repo, 'remote', 'set-url', 'origin', url);
    await expect(readPrs(repo, get, NOW, live)).rejects.toThrow(/not a GitHub remote/);
  });

  it.each(['https://github.com/acme/widgets', 'ssh://git@github.com/acme/widgets.git'])(
    'origin %s reads acme/widgets',
    async (url) => {
      git(repo, 'remote', 'set-url', 'origin', url);
      await readPrs(repo, get, NOW, live);
      expect(calls.every((c) => c.startsWith('/repos/acme/widgets/'))).toBe(true);
    },
  );

  it('stamps fetched rows with when the refresh finished, not when it started', async () => {
    let clock = NOW.getTime();
    const slow: GithubGet = async (p) => {
      clock += 3 * 60_000;
      return get(p);
    };
    const cc = await buildCommandCenter({
      sessionsDir: path.join(tmp, 'none'),
      repoRoot: repo,
      liveSha: () => live,
      titles: async () => new Map(),
      github: async () => slow,
      now: () => new Date(clock),
    });
    expect(cc.prs_as_of).toBe(new Date(clock).toISOString());
  });

  it('no running build sha means nothing is deployed', async () => {
    const out = await readPrs(repo, get, NOW, null);
    expect(out.live_sha).toBeNull();
    expect(out.prs.find((p) => p.number === 10)?.stage).toBe('merged');
  });

  it('a listing still full at the page cap fails rather than passing as complete', async () => {
    const full = Array.from({ length: 100 }, () => ({ body: '' }));
    const capped: GithubGet = async (p) => (p.includes('/issues?') ? full : get(p));
    await expect(readPrs(repo, capped, NOW, live)).rejects.toThrow(/more than 500 rows/);
  });

  it('concurrent polls past the TTL share one GitHub refresh', async () => {
    const deps: CommandCenterDeps = {
      sessionsDir: path.join(tmp, 'none'),
      repoRoot: repo,
      liveSha: () => live,
      titles: async () => new Map(),
      github: async () => get,
      now: () => NOW,
    };
    const [a, b] = await Promise.all([buildCommandCenter(deps), buildCommandCenter(deps)]);
    expect(b.prs).toEqual(a.prs);
    expect(calls.filter((c) => c.includes('/pulls?'))).toHaveLength(1);
  });

  it('a GitHub failure keeps serving the last good PRs, stamped with when they were fetched', async () => {
    const dir = path.join(tmp, 'sessions');
    fs.mkdirSync(dir);
    let fail = false;
    let clock = NOW.getTime();
    const deps: CommandCenterDeps = {
      sessionsDir: dir,
      repoRoot: repo,
      liveSha: () => live,
      titles: async () => new Map(),
      github: async () => (fail ? async () => Promise.reject(new Error('github 502')) : get),
      now: () => new Date(clock),
    };
    fail = true;
    const never = await buildCommandCenter(deps);
    expect(never.prs).toEqual([]);
    expect(never.prs_as_of).toBeNull();
    fail = false;
    clock += 5 * 60_000;
    const fetchedAt = new Date(clock).toISOString();
    expect((await buildCommandCenter(deps)).prs).toHaveLength(4);
    fail = true;
    clock += 5 * 60_000;
    const after = await buildCommandCenter(deps);
    expect(after.prs.map((p) => p.number)).toEqual([10, 11, 12, 14]);
    expect(after.live_sha).toBe(live);
    expect(after.prs_as_of).toBe(fetchedAt);
  });
});

describe('commandCenterHandler', () => {
  it.each(['global_admin', 'admin_of_group', 'member'] as const)('is a 404 for %s', async (role) => {
    const ctx: AuthedRequestContext = {
      rawNodeReq: {} as never,
      user: { id: 'u1', kind: 'dashboard', display_name: null, created_at: '' },
      scopes: { role, allowed_group_ids: [], no_filter: role === 'global_admin' },
    };
    const res = await commandCenterHandler(new Request('http://localhost/dashboard/api/command-center'), {}, ctx);
    expect(res?.status).toBe(404);
  });
});
