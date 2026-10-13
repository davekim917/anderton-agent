/**
 * `GET /dashboard/api/command-center`: every live host Claude Code session and every recent PR's stage, read-only.
 * Host sessions belong to no agent group, so only the owner sees them; anyone else gets the same 404 as an unknown
 * route.
 */
import os from 'os';
import path from 'path';

import { runningBuildInfo } from '../../build-info.js';
import { REPO_ROOT, TIMEZONE } from '../../config.js';
import { resolveHostGitHubToken } from '../../github-host-token.js';
import { log } from '../../log.js';
import { githubGet } from '../github-api.js';
import type { AuthHandler } from '../router.js';
import { readPrs, type GithubGet } from './prs.js';
import { readHerdrTitles, readHostSessions } from './sessions.js';
import type { CommandCenter, PrRow } from './types.js';

/**
 * The page polls every 15 s; GitHub is asked at most this often. A failed ask keeps serving the last good answer (or
 * none) for another TTL, so an outage logs once a minute rather than once per poll.
 */
const PR_CACHE_TTL_MS = 60_000;

export interface CommandCenterDeps {
  sessionsDir: string;
  repoRoot: string;
  liveSha: () => string | null;
  titles: () => Promise<Map<string, string>>;
  github: () => Promise<GithubGet | null>;
  isAlive?: (pid: number, procStart: unknown) => boolean;
  now?: () => Date;
}

type PrRead = { prs: PrRow[]; live_sha: string | null; prs_as_of: string | null; gate_bypass_prs: number[] };

let prCache: (PrRead & { at: number }) | null = null;
let prRefresh: Promise<PrRead> | null = null;

export function _resetCommandCenterCacheForTesting(): void {
  prCache = null;
  prRefresh = null;
}

function cachedPrs(deps: CommandCenterDeps, now: Date): Promise<PrRead> {
  if (prCache && now.getTime() - prCache.at < PR_CACHE_TTL_MS) return Promise.resolve(prCache);
  prRefresh ??= refreshPrs(deps, now).finally(() => {
    prRefresh = null;
  });
  return prRefresh;
}

async function refreshPrs(deps: CommandCenterDeps, now: Date): Promise<PrRead> {
  try {
    const get = await deps.github();
    if (!get) throw new Error('no host GitHub token');
    const fresh = await readPrs(deps.repoRoot, get, now, deps.liveSha());
    const done = deps.now?.() ?? new Date();
    prCache = { at: done.getTime(), ...fresh, prs_as_of: done.toISOString() };
    return prCache;
  } catch (err) {
    log.warn('command-center PR read failed', { error: String(err) });
    prCache = {
      prs: [],
      live_sha: deps.liveSha(),
      prs_as_of: null,
      gate_bypass_prs: [],
      ...prCache,
      at: now.getTime(),
    };
    return prCache;
  }
}

export async function buildCommandCenter(deps: CommandCenterDeps): Promise<CommandCenter> {
  const now = deps.now?.() ?? new Date();
  const [titles, { prs, live_sha, prs_as_of, gate_bypass_prs }] = await Promise.all([
    deps.titles(),
    cachedPrs(deps, now),
  ]);
  // Stamped after the awaits: session ages are measured against it, and the sessions are read now.
  return {
    generated_at: (deps.now?.() ?? new Date()).toISOString(),
    sessions: readHostSessions(deps.sessionsDir, titles, deps.isAlive),
    prs,
    live_sha,
    prs_as_of,
    gate_bypass_prs,
    timezone: TIMEZONE,
  };
}

const liveDeps: CommandCenterDeps = {
  sessionsDir: path.join(os.homedir(), '.claude', 'sessions'),
  repoRoot: REPO_ROOT,
  liveSha: () => runningBuildInfo(REPO_ROOT)?.sha ?? null,
  titles: () => readHerdrTitles(),
  github: async () => {
    const token = await resolveHostGitHubToken();
    return token ? (p) => githubGet(p, token) : null;
  },
};

export const commandCenterHandler: AuthHandler = async (_req, _params, ctx) => {
  if (ctx.scopes.role !== 'owner') {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(await buildCommandCenter(liveDeps)), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
