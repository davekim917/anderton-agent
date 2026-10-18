import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GithubRepository {
  owner: string;
  repo: string;
}

export type VisibilityVerdict = 'public' | 'private' | 'not_found' | 'failed';

/** Answers for some of `repositories`, keyed by `repositoryKey`; an omitted key counts as `failed`. */
export type VisibilityLookup = (repositories: GithubRepository[], timeoutMs: number) => Map<string, VisibilityVerdict>;

/** Lower-cased `owner/repo` keys of the repositories GitHub proved public. */
export type PublicRepositoryResolver = (repositories: GithubRepository[]) => Set<string>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A failure is cached too, so a private client repository (a 404 to this account) is not re-asked on every
// commit; a public verdict expires so a repository made private stops being exempt within a week.
const VERDICT_TTL_MS: Record<VisibilityVerdict, number> = {
  public: 7 * DAY_MS,
  private: 7 * DAY_MS,
  not_found: DAY_MS,
  failed: HOUR_MS,
};

const LOOKUP_BUDGET_MS = 8_000;
const CALL_TIMEOUT_MS = 5_000;
const REPOSITORIES_PER_CALL = 100;

export function repositoryKey(repository: GithubRepository): string {
  return `${repository.owner}/${repository.repo}`.toLowerCase();
}

// The cache names client repositories; store them hashed so the file is not a second plaintext list.
function cacheKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

interface CacheEntry {
  verdict: VisibilityVerdict;
  checkedAt: string;
}

const VERDICTS = new Set<string>(Object.keys(VERDICT_TTL_MS));

function readCache(cachePath: string): Map<string, CacheEntry> {
  const entries = new Map<string, CacheEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return entries;
  }
  const root = parsed as { version?: unknown; entries?: unknown } | null;
  if (!root || typeof root !== 'object' || root.version !== 1) return entries;
  const raw = root.entries;
  if (!raw || typeof raw !== 'object') return entries;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<CacheEntry> | null;
    if (typeof entry?.verdict !== 'string' || !VERDICTS.has(entry.verdict) || typeof entry.checkedAt !== 'string')
      continue;
    entries.set(key, { verdict: entry.verdict as VisibilityVerdict, checkedAt: entry.checkedAt });
  }
  return entries;
}

function writeCache(cachePath: string, entries: Map<string, CacheEntry>): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const temp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, entries: Object.fromEntries(entries) })}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temp, cachePath);
  } catch {
    // An unwritable cache costs a lookup next time, never a verdict.
  }
}

function isFresh(entry: CacheEntry, now: number): boolean {
  const checked = Date.parse(entry.checkedAt);
  return Number.isFinite(checked) && checked <= now && now - checked < VERDICT_TTL_MS[entry.verdict];
}

const VISIBILITY_FIELDS = 'nameWithOwner isPrivate visibility';

/** One GraphQL request per batch: a cold cache costs one round trip, not one per repository. */
export const ghVisibilityLookup: VisibilityLookup = (repositories, timeoutMs) => {
  const variables = repositories.flatMap((repository, i) => [
    '-f',
    `o${i}=${repository.owner}`,
    '-f',
    `n${i}=${repository.repo}`,
  ]);
  const declarations = repositories.map((_, i) => `$o${i}: String!, $n${i}: String!`).join(', ');
  const fields = repositories
    .map((_, i) => `r${i}: repository(owner: $o${i}, name: $n${i}) { ${VISIBILITY_FIELDS} }`)
    .join(' ');
  const result = spawnSync('gh', ['api', 'graphql', '-f', `query=query(${declarations}) { ${fields} }`, ...variables], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    // GH_HOST would send the question to another host, whose answer says nothing about github.com.
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  });
  // gh exits 1 when any alias is unresolvable, with every resolved alias still in the body.
  if (result.status !== 0 && result.status !== 1) return new Map();
  return parseVisibilityResponse(repositories, result.stdout);
};

/** Verdicts from a `ghVisibilityLookup` response body; a repository it cannot place is left out (failed). */
export function parseVisibilityResponse(
  repositories: GithubRepository[],
  stdout: string,
): Map<string, VisibilityVerdict> {
  const verdicts = new Map<string, VisibilityVerdict>();
  let body: { data?: Record<string, unknown> | null; errors?: { type?: unknown; path?: unknown }[] };
  try {
    body = JSON.parse(stdout) as typeof body;
  } catch {
    return verdicts;
  }
  const data = body?.data;
  if (!data || typeof data !== 'object') return verdicts;
  const notFound = new Set(
    (Array.isArray(body.errors) ? body.errors : [])
      .filter((error) => error?.type === 'NOT_FOUND' && Array.isArray(error.path) && error.path.length === 1)
      .map((error) => String((error.path as unknown[])[0])),
  );
  repositories.forEach((repository, i) => {
    const key = repositoryKey(repository);
    const node = data[`r${i}`] as { nameWithOwner?: unknown; isPrivate?: unknown; visibility?: unknown } | null;
    if (node && typeof node === 'object') {
      const exact = typeof node.nameWithOwner === 'string' && node.nameWithOwner.toLowerCase() === key;
      verdicts.set(key, exact && node.isPrivate === false && node.visibility === 'PUBLIC' ? 'public' : 'private');
    } else if (node === null && notFound.has(`r${i}`)) {
      verdicts.set(key, 'not_found');
    }
  });
  return verdicts;
}

export function defaultVisibilityCachePath(installRoot: string): string {
  return path.join(installRoot, '.nanoclaw', 'github-visibility-cache.json');
}

/**
 * Public only on a fresh `public` verdict. Uncached repositories are asked in batches inside one overall budget;
 * anything unanswered is cached as `failed` (never public) and stays private. Never throws.
 */
export function cachedGithubVisibility(options: {
  cachePath: string;
  lookup?: VisibilityLookup;
  now?: () => number;
  budgetMs?: number;
}): PublicRepositoryResolver {
  const lookup = options.lookup ?? ghVisibilityLookup;
  const clock = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? LOOKUP_BUDGET_MS;
  return (repositories) => {
    const publicKeys = new Set<string>();
    try {
      const start = clock();
      const cache = readCache(options.cachePath);
      const stale = new Map<string, GithubRepository>();
      for (const repository of repositories) {
        const key = repositoryKey(repository);
        const entry = cache.get(cacheKey(key));
        if (entry && isFresh(entry, start)) {
          if (entry.verdict === 'public') publicKeys.add(key);
        } else {
          stale.set(key, repository);
        }
      }
      if (stale.size === 0) return publicKeys;

      const pending = [...stale.values()];
      const answered = new Map<string, VisibilityVerdict>();
      for (let i = 0; i < pending.length; i += REPOSITORIES_PER_CALL) {
        const remaining = budgetMs - (clock() - start);
        if (remaining <= 0) break;
        const batch = pending.slice(i, i + REPOSITORIES_PER_CALL);
        let verdicts: Map<string, VisibilityVerdict>;
        try {
          verdicts = lookup(batch, Math.min(CALL_TIMEOUT_MS, remaining));
        } catch {
          verdicts = new Map();
        }
        for (const repository of batch) {
          const key = repositoryKey(repository);
          answered.set(key, verdicts.get(key) ?? 'failed');
        }
      }
      const checkedAt = new Date(clock()).toISOString();
      for (const [key] of stale) {
        const verdict = answered.get(key) ?? 'failed';
        cache.set(cacheKey(key), { verdict, checkedAt });
        if (verdict === 'public') publicKeys.add(key);
      }
      writeCache(options.cachePath, cache);
    } catch {
      return new Set();
    }
    return publicKeys;
  };
}
