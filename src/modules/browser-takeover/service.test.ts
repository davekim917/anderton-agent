import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  origin: 'https://browser.example.test',
  lockdown: false,
  dataDir: '',
  chromiumVersion: 'Chromium 155.0.8059.79 built on Debian GNU/Linux 12 (bookworm)\n',
  dashboardStdout: 'Dashboard started\nhttps://browser.example.test/#dashboard-access-token=dash-token-1\n',
  stateJson: JSON.stringify({
    cookies: [
      { name: 'app', value: 'a', domain: 'app.example.com' },
      { name: 'parent', value: 'p', domain: '.example.com' },
      { name: 'idp', value: 'i', domain: 'login.idp.example' },
      { name: 'sibling', value: 's', domain: 'other.example.com' },
      { name: 'parentHostOnly', value: 'h', domain: 'example.com' },
    ],
    origins: [
      { origin: 'https://app.example.com', localStorage: [{ name: 'token', value: 't' }] },
      { origin: 'https://login.idp.example', localStorage: [{ name: 'idp', value: 'i' }] },
      { origin: 'https://app.example.com:8443', localStorage: [{ name: 'otherPort', value: 'o' }] },
    ],
  }),
  holdDm: null as Promise<void> | null,
  reached: true,
  dms: [] as string[],
  docker: [] as string[][],
}));

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  get BROWSER_TAKEOVER_ORIGIN() {
    return h.origin;
  },
  get DATA_DIR() {
    return h.dataDir;
  },
  get EGRESS_LOCKDOWN() {
    return h.lockdown;
  },
}));
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFile: (_bin: string, args: string[], _opts: unknown, cb: (e: null, r: { stdout: string }) => void) => {
    h.docker.push(args);
    const has = (...words: string[]) => words.every((w) => args.includes(w));
    let stdout = '';
    if (args[0] === 'inspect') stdout = 'sha256:example-agent-image\n';
    else if (has('chromium', '--version')) stdout = h.chromiumVersion;
    else if (has('dashboard', 'start')) stdout = h.dashboardStdout;
    else if (args[0] === 'exec' && args.includes('cat')) stdout = h.stateJson;
    cb(null, { stdout });
  },
}));
vi.mock('../../container-runner.js', () => ({
  containerIdentityFor: () => ({ containerName: 'nanoclaw-v2-example-agent', claimIncarnation: 1 }),
}));
vi.mock('../../operator-alert.js', () => ({
  notifyOperators: async (text: string) => {
    h.dms.push(text);
    const reached = h.reached;
    if (h.holdDm) await h.holdDm;
    return reached;
  },
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async () => ({ name: 'example-agent', workgroup_id: 'example-wg', folder: 'example-agent' }),
}));

import {
  BINDING_TTL_MS,
  consumeTakeoverLink,
  finishBrowserTakeover,
  LINK_TTL_MS,
  resolveTakeoverBinding,
  startBrowserTakeover,
} from './service.js';

const REQUEST = {
  sessionId: 'sess-1',
  agentGroupId: 'ag-1',
  url: 'https://app.example.com/login',
  site: 'example',
};

function linkFromLastDm(): string {
  const match = /https:\/\/browser\.example\.test\/t\/([A-Za-z0-9_-]+)/.exec(h.dms.at(-1) ?? '');
  if (!match) throw new Error(`no link in DM: ${h.dms.at(-1)}`);
  return match[1];
}

const sidecarRuns = () => h.docker.filter((a) => a[0] === 'run' && a.includes('-d'));
const sidecarName = (run: string[]) => run[run.indexOf('--name') + 1];
const removed = () => h.docker.filter((a) => a[0] === 'rm').map((a) => a.at(-1));

beforeEach(() => {
  h.origin = 'https://browser.example.test';
  h.lockdown = false;
  h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
  h.dashboardStdout = 'https://browser.example.test/#dashboard-access-token=dash-token-1\n';
  h.chromiumVersion = 'Chromium 155.0.8059.79 built on Debian GNU/Linux 12 (bookworm)\n';
  h.reached = true;
  h.holdDm = null;
  h.dms = [];
  h.docker = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await finishBrowserTakeover(REQUEST.sessionId).catch(() => {});
  fs.rmSync(h.dataDir, { recursive: true, force: true });
});

describe('startBrowserTakeover', () => {
  it("reads Chromium's version from the agent's image, so the user agent names the browser that actually runs", async () => {
    h.chromiumVersion = 'Chromium 161.0.1.2 built on Debian\n';
    await startBrowserTakeover(REQUEST);
    expect(h.docker).toContainEqual([
      'run',
      '--rm',
      '--entrypoint',
      'chromium',
      'sha256:example-agent-image',
      '--version',
    ]);
    expect(sidecarRuns()[0]).toContain(
      'AGENT_BROWSER_USER_AGENT=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/161.0.0.0 Safari/537.36',
    );
  });

  it('still hides the automation flag when the Chromium version cannot be read, without inventing a user agent', async () => {
    h.chromiumVersion = '';
    await startBrowserTakeover(REQUEST);
    const run = sidecarRuns()[0];
    expect(run).toContain('AGENT_BROWSER_ARGS=--disable-blink-features=AutomationControlled');
    expect(run.some((a) => a.startsWith('AGENT_BROWSER_USER_AGENT='))).toBe(false);
  });

  it("opens the URL in a bare sidecar from the agent's image, never in the agent's own container", async () => {
    await startBrowserTakeover(REQUEST);
    const [run] = sidecarRuns();
    const name = sidecarName(run);
    expect(run).toContain('sha256:example-agent-image');
    expect(run.some((a) => a === '-v' || a.startsWith('--mount') || a === '--volume')).toBe(false);
    expect(run.filter((_, i) => run[i - 1] === '-e')).toEqual([
      'AGENT_BROWSER_ARGS=--disable-blink-features=AutomationControlled',
      'AGENT_BROWSER_USER_AGENT=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    ]);
    expect(h.docker).toContainEqual(['exec', name, 'agent-browser', 'open', 'https://app.example.com/login']);
    expect(h.docker).toContainEqual(['exec', name, 'agent-browser', 'set', 'viewport', '430', '900']);
    expect(h.docker).toContainEqual([
      'exec',
      name,
      'agent-browser',
      'dashboard',
      'start',
      '--port',
      '4848',
      '--allowed-origins',
      'https://browser.example.test',
    ]);
    expect(h.docker.some((a) => a[0] === 'exec' && a[1] === 'nanoclaw-v2-example-agent')).toBe(false);

    expect(h.dms.at(-1)).toContain('example-agent needs you to sign in to app.example.com');
    const link = linkFromLastDm();
    const spent = consumeTakeoverLink(link);
    expect(resolveTakeoverBinding(spent!.bindingId)).toEqual({ containerName: name, dashboardToken: 'dash-token-1' });
    expect(consumeTakeoverLink(link)).toBeNull();
  });

  it.each([
    ['no takeover origin', { origin: '' }, {}, /BROWSER_TAKEOVER_ORIGIN/],
    ['egress lockdown, which the sidecar would escape', { lockdown: true }, {}, /egress lockdown/],
    ['a site name that is a path', {}, { site: '../x' }, /--site/],
    ['a non-http URL', {}, { url: 'file:///etc/passwd' }, /--url/],
  ])('refuses %s before starting anything', async (_label, env, input, error) => {
    Object.assign(h, env);
    await expect(startBrowserTakeover({ ...REQUEST, ...input })).rejects.toThrow(error);
    expect(h.docker).toEqual([]);
  });

  it('removes the sidecar and sends nothing when the dashboard prints no access URL', async () => {
    h.dashboardStdout = 'something else';
    await expect(startBrowserTakeover(REQUEST)).rejects.toThrow(/no access URL/);
    expect(removed()).toEqual([sidecarName(sidecarRuns()[0])]);
    expect(h.dms).toEqual([]);
  });

  it('removes the sidecar and kills the link when no owner could be reached', async () => {
    h.reached = false;
    await expect(startBrowserTakeover(REQUEST)).rejects.toThrow(/reached by DM/);
    expect(removed()).toEqual([sidecarName(sidecarRuns()[0])]);
    expect(consumeTakeoverLink(linkFromLastDm())).toBeNull();
  });

  it("a new request replaces the session's open takeover: its sidecar, link and binding all go", async () => {
    await startBrowserTakeover(REQUEST);
    const spent = consumeTakeoverLink(linkFromLastDm());
    await startBrowserTakeover(REQUEST);
    const unspent = linkFromLastDm();
    await startBrowserTakeover(REQUEST);

    const [first, second] = sidecarRuns().map(sidecarName);
    expect(removed()).toEqual([first, second]);
    expect(resolveTakeoverBinding(spent!.bindingId)).toBeNull();
    expect(consumeTakeoverLink(unspent)).toBeNull();
    expect(consumeTakeoverLink(linkFromLastDm())).not.toBeNull();
  });
});

describe('overlapping requests', () => {
  it("an older request's failed DM does not tear down the newer takeover that replaced it", async () => {
    let release!: () => void;
    h.holdDm = new Promise((r) => (release = r));
    h.reached = false;
    const older = startBrowserTakeover(REQUEST);
    await vi.waitFor(() => expect(h.dms).toHaveLength(1));
    h.holdDm = null;
    h.reached = true;
    await startBrowserTakeover(REQUEST);
    const newer = linkFromLastDm();
    release();
    await expect(older).rejects.toThrow(/reached by DM/);

    expect(consumeTakeoverLink(newer)).not.toBeNull();
  });
});

describe('finishBrowserTakeover', () => {
  it("files only the target host's session as a 0600 login, never the identity provider's, then removes the sidecar", async () => {
    await startBrowserTakeover(REQUEST);
    const spent = consumeTakeoverLink(linkFromLastDm());
    const name = sidecarName(sidecarRuns()[0]);

    await expect(finishBrowserTakeover(REQUEST.sessionId)).resolves.toEqual({
      path: '/workspace/browser-state/example.json',
    });
    const file = path.join(h.dataDir, 'browser-state', 'example-wg', 'example.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      cookies: [
        { name: 'app', value: 'a', domain: 'app.example.com' },
        { name: 'parent', value: 'p', domain: '.example.com' },
      ],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'token', value: 't' }] }],
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(removed()).toEqual([name]);
    expect(resolveTakeoverBinding(spent!.bindingId)).toBeNull();
    await expect(finishBrowserTakeover(REQUEST.sessionId)).rejects.toThrow(/No takeover is open/);
  });

  it('refuses to file a sign-in that left nothing for the target host', async () => {
    const full = h.stateJson;
    h.stateJson = JSON.stringify({ cookies: [{ name: 'idp', value: 'i', domain: 'login.idp.example' }], origins: [] });
    await startBrowserTakeover(REQUEST);
    await expect(finishBrowserTakeover(REQUEST.sessionId)).rejects.toThrow(/no session for app\.example\.com/);
    expect(fs.existsSync(path.join(h.dataDir, 'browser-state', 'example-wg', 'example.json'))).toBe(false);
    h.stateJson = full;
  });

  it('replaces a container-planted symlink at the login path instead of writing through it', async () => {
    const outside = path.join(h.dataDir, 'v2.db');
    fs.writeFileSync(outside, 'central');
    const dir = path.join(h.dataDir, 'browser-state', 'example-wg');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync('../../v2.db', path.join(dir, 'example.json'));
    await startBrowserTakeover(REQUEST);

    await finishBrowserTakeover(REQUEST.sessionId);
    expect(fs.readFileSync(outside, 'utf8')).toBe('central');
    const saved = fs.lstatSync(path.join(dir, 'example.json'));
    expect(saved.isFile()).toBe(true);
    expect(saved.mode & 0o777).toBe(0o600);
  });
});

describe('takeover lifetime', () => {
  it('a link expires after its TTL, a binding after its own', async () => {
    vi.useFakeTimers();
    await startBrowserTakeover({ ...REQUEST, sessionId: 'sess-late' });
    const late = linkFromLastDm();
    await startBrowserTakeover(REQUEST);
    const spent = consumeTakeoverLink(linkFromLastDm());

    vi.advanceTimersByTime(LINK_TTL_MS + 1);
    expect(consumeTakeoverLink(late)).toBeNull();
    expect(resolveTakeoverBinding(spent!.bindingId)).not.toBeNull();

    vi.advanceTimersByTime(BINDING_TTL_MS);
    expect(resolveTakeoverBinding(spent!.bindingId)).toBeNull();
  });
});
