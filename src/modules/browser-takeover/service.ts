// The owner signs in to a throwaway sidecar browser, never the agent's own: anything typed into the agent's browser
// is readable by the agent's code (eval, network capture). Only the resulting session state reaches the agent.
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';

import { BROWSER_TAKEOVER_ORIGIN, EGRESS_LOCKDOWN } from '../../config.js';
import { containerIdentityFor } from '../../container-runner.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { replaceUntrustedFile } from '../../fs-safety.js';
import { notifyOperators } from '../../operator-alert.js';
import { DASHBOARD_CONTAINER_PORT } from './bridge.js';
import { browserStateMount } from './state-dir.js';

const execFileAsync = promisify(execFile);

export const LINK_TTL_MS = 30 * 60_000;
export const BINDING_TTL_MS = 2 * 60 * 60_000;
const SIDECAR_LIFETIME_S = Math.ceil((LINK_TTL_MS + BINDING_TTL_MS) / 1000);
const DOCKER_TIMEOUT_MS = 60_000;
const STATE_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_REASON_CHARS = 200;
const SITE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SIDECAR_STATE_PATH = '/tmp/takeover-state.json';
const SIDECAR_VIEWPORT = [430, 900] as const;

interface Sidecar {
  containerName: string;
  target: URL;
  site: string;
  workgroupKey: string;
  dashboardToken: string;
  expiresAt: number;
}

const sidecars = new Map<string, Sidecar>();
const links = new Map<string, { sessionId: string; expiresAt: number }>();
const bindings = new Map<string, { sessionId: string; containerName: string; expiresAt: number }>();

const docker = (...args: string[]) =>
  execFileAsync(CONTAINER_RUNTIME_BIN, args, { timeout: DOCKER_TIMEOUT_MS, maxBuffer: STATE_EXPORT_MAX_BYTES });

function prune(now: number): void {
  for (const map of [links, bindings, sidecars] as Map<string, { expiresAt: number }>[]) {
    for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
  }
}

/** Compare-and-delete: a caller that awaited in between must not remove a takeover started meanwhile. */
async function removeSidecar(sessionId: string, containerName: string): Promise<void> {
  if (sidecars.get(sessionId)?.containerName === containerName) {
    sidecars.delete(sessionId);
    for (const [key, l] of links) if (l.sessionId === sessionId) links.delete(key);
  }
  for (const [key, b] of bindings) if (b.containerName === containerName) bindings.delete(key);
  await docker('rm', '-f', containerName).catch(() => {});
}

interface StorageState {
  cookies?: Array<{ domain?: string }>;
  origins?: Array<{ origin?: string }>;
}

/**
 * Keeps only what the browser would send to `target` and that origin's storage. Everything else the sign-in left
 * behind, above all the identity provider's own session, would hand the agent every app behind that SSO.
 */
function stateForTarget(raw: string, target: URL): StorageState {
  const state = JSON.parse(raw) as StorageState;
  const host = target.hostname;
  // A server-set Domain cookie exports with a leading dot. A bare domain is matched as host-only, which can only drop a
  // cookie the export also writes bare (seen for a script-set one), never hand over one the browser would not send.
  const sentTo = (domain = '') => {
    const d = domain.toLowerCase();
    return d.startsWith('.') ? host === d.slice(1) || host.endsWith(d) : host === d;
  };
  const sameOrigin = (origin = '') => {
    try {
      return new URL(origin).origin === target.origin;
    } catch {
      return false;
    }
  };
  return {
    cookies: (state.cookies ?? []).filter((c) => sentTo(c.domain)),
    origins: (state.origins ?? []).filter((o) => sameOrigin(o.origin)),
  };
}

// Sign-in pages (Google, reCAPTCHA) refuse a browser that reports itself automated: headless Chromium sends a
// "HeadlessChrome" user agent and sets navigator.webdriver. agent-browser reads these settings only from the
// environment its daemon starts in, so they go on the container, not on an exec.
async function humanBrowserEnv(image: string): Promise<string[]> {
  const { stdout } = await docker('run', '--rm', '--entrypoint', 'chromium', image, '--version');
  const major = /\b(\d+)\.\d+\.\d+/.exec(stdout)?.[1];
  const env = ['-e', 'AGENT_BROWSER_ARGS=--disable-blink-features=AutomationControlled'];
  if (major) {
    env.push(
      '-e',
      `AGENT_BROWSER_USER_AGENT=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    );
  }
  return env;
}

/** `sleep` bounds the sidecar's life, so it exits even after a host restart forgets it. */
async function startSidecar(agentContainer: string, url: string): Promise<{ containerName: string; token: string }> {
  const { stdout: image } = await docker('inspect', '--format', '{{.Image}}', agentContainer);
  const containerName = `nanoclaw-browser-takeover-${randomBytes(6).toString('hex')}`;
  await docker(
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '--label',
    'nanoclaw.browser-takeover=1',
    '--memory',
    '1g',
    ...(await humanBrowserEnv(image.trim())),
    '--entrypoint',
    'sleep',
    image.trim(),
    String(SIDECAR_LIFETIME_S),
  );
  try {
    await docker('exec', containerName, 'agent-browser', 'open', url);
    // The owner is usually on a phone; a phone-width page stays legible in the viewer.
    await docker(
      'exec',
      containerName,
      'agent-browser',
      'set',
      'viewport',
      String(SIDECAR_VIEWPORT[0]),
      String(SIDECAR_VIEWPORT[1]),
    );
    const { stdout } = await docker(
      'exec',
      containerName,
      'agent-browser',
      'dashboard',
      'start',
      '--port',
      String(DASHBOARD_CONTAINER_PORT),
      '--allowed-origins',
      BROWSER_TAKEOVER_ORIGIN,
    );
    const token = /#dashboard-access-token=([A-Za-z0-9_-]+)/.exec(stdout)?.[1];
    if (!token) throw new Error('agent-browser dashboard started but printed no access URL.');
    return { containerName, token };
  } catch (err) {
    await docker('rm', '-f', containerName).catch(() => {});
    throw err;
  }
}

export interface TakeoverRequest {
  sessionId: string;
  agentGroupId: string;
  url: string;
  site: string;
  reason?: string;
}

export async function startBrowserTakeover(input: TakeoverRequest): Promise<{ expiresAt: string }> {
  if (!BROWSER_TAKEOVER_ORIGIN) {
    throw new Error('Browser takeover is not configured on this host (BROWSER_TAKEOVER_ORIGIN is unset).');
  }
  // The sidecar has no route through the gateway, and its first request goes to an agent-chosen URL.
  if (EGRESS_LOCKDOWN) throw new Error('Browser takeover is unavailable while egress lockdown is on.');
  if (!SITE_RE.test(input.site))
    throw new Error('--site must be a short name like "amplitude" (letters, digits, . _ -).');
  let url: URL;
  try {
    url = new URL(input.url);
  } catch (err) {
    throw new Error('--url must be an absolute http(s) URL.', { cause: err });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('--url must be an absolute http(s) URL.');
  const agentContainer = containerIdentityFor(input.sessionId)?.containerName;
  if (!agentContainer) throw new Error('This session has no running container.');
  const group = await getAgentGroup(input.agentGroupId);
  if (!group) throw new Error('Agent group not found.');

  const previous = sidecars.get(input.sessionId);
  if (previous) await removeSidecar(input.sessionId, previous.containerName);
  const { containerName, token } = await startSidecar(agentContainer, url.href);
  const superseded = sidecars.get(input.sessionId);
  if (superseded) await removeSidecar(input.sessionId, superseded.containerName);
  const now = Date.now();
  prune(now);
  sidecars.set(input.sessionId, {
    containerName,
    target: url,
    site: input.site,
    workgroupKey: group.workgroup_id ?? group.folder,
    dashboardToken: token,
    expiresAt: now + LINK_TTL_MS + BINDING_TTL_MS,
  });
  const linkToken = randomBytes(24).toString('base64url');
  links.set(linkToken, { sessionId: input.sessionId, expiresAt: now + LINK_TTL_MS });

  const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);
  const reached = await notifyOperators(
    `${group.name} needs you to sign in to ${url.host}${reason ? `: ${reason}` : ''}\n` +
      `${BROWSER_TAKEOVER_ORIGIN}/t/${linkToken}\n` +
      `The link opens once and expires in ${LINK_TTL_MS / 60_000} minutes. You sign in to a separate browser the agent ` +
      `cannot see; only its session for ${url.hostname} is handed over. Tell the agent in its conversation when you ` +
      'are done.',
    { event: 'browser-takeover', agentGroupId: input.agentGroupId },
  );
  if (!reached) {
    await removeSidecar(input.sessionId, containerName);
    throw new Error('No owner or global admin could be reached by DM, so no takeover link was sent.');
  }
  return { expiresAt: new Date(now + LINK_TTL_MS).toISOString() };
}

export async function finishBrowserTakeover(sessionId: string): Promise<{ path: string }> {
  prune(Date.now());
  const sidecar = sidecars.get(sessionId);
  if (!sidecar)
    throw new Error('No takeover is open for this session (none started, it expired, or the host restarted).');
  try {
    await docker('exec', sidecar.containerName, 'agent-browser', 'state', 'save', SIDECAR_STATE_PATH);
    const { stdout } = await docker('exec', sidecar.containerName, 'cat', SIDECAR_STATE_PATH);
    const state = stateForTarget(stdout, sidecar.target);
    if (state.cookies?.length === 0 && state.origins?.length === 0) {
      throw new Error(
        `The sign-in left no session for ${sidecar.target.host}; start a new takeover with the app's own URL.`,
      );
    }
    const mount = browserStateMount(sidecar.workgroupKey);
    if (!mount) throw new Error(`Workgroup "${sidecar.workgroupKey}" has no browser-state directory.`);
    replaceUntrustedFile(mount.hostPath, `${sidecar.site}.json`, JSON.stringify(state), 0o600);
    return { path: `${mount.containerPath}/${sidecar.site}.json` };
  } finally {
    await removeSidecar(sessionId, sidecar.containerName);
  }
}

export function consumeTakeoverLink(linkToken: string): { bindingId: string; maxAgeSeconds: number } | null {
  const now = Date.now();
  const link = links.get(linkToken);
  links.delete(linkToken);
  const sidecar = link && sidecars.get(link.sessionId);
  if (!link || !sidecar || link.expiresAt <= now) return null;
  prune(now);
  const bindingId = randomBytes(24).toString('base64url');
  bindings.set(bindingId, {
    sessionId: link.sessionId,
    containerName: sidecar.containerName,
    expiresAt: now + BINDING_TTL_MS,
  });
  return { bindingId, maxAgeSeconds: BINDING_TTL_MS / 1000 };
}

export function resolveTakeoverBinding(bindingId: string): { containerName: string; dashboardToken: string } | null {
  const binding = bindings.get(bindingId);
  if (!binding) return null;
  const sidecar = sidecars.get(binding.sessionId);
  if (binding.expiresAt <= Date.now() || sidecar?.containerName !== binding.containerName) {
    bindings.delete(bindingId);
    return null;
  }
  return { containerName: sidecar.containerName, dashboardToken: sidecar.dashboardToken };
}
