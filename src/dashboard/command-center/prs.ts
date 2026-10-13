/**
 * Recent PRs on the live checkout's `origin` repo and how far each got. `deployed` is git ancestry against the running
 * build's sha (`liveSha`), read-only in the live checkout; `unreviewed` is an open `gate-bypass` issue carrying the PR's marker.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import type { PrRow } from './types.js';

export type GithubGet = (path: string) => Promise<unknown>;

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const SHA_RE = /^[0-9a-f]{40}$/;
const GITHUB_REMOTE_RE =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const execFileAsync = promisify(execFile);
const BYPASS_MARKER_RE = /<!-- gate-bypass pr=(\d+) -->/g;

interface Pull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  updated_at: string;
}

interface Issue {
  body?: string | null;
  pull_request?: unknown;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot, timeout: 5_000 });
  return stdout.trim();
}

async function originSlug(repoRoot: string): Promise<string | null> {
  let url: string;
  try {
    url = await git(repoRoot, ['remote', 'get-url', 'origin']);
  } catch {
    return null;
  }
  const m = url.match(GITHUB_REMOTE_RE);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function isAncestor(repoRoot: string, sha: string, of: string): Promise<boolean> {
  if (!SHA_RE.test(sha) || !SHA_RE.test(of)) return false;
  try {
    await git(repoRoot, ['merge-base', '--is-ancestor', sha, of]);
    return true;
  } catch {
    // Exit 1 is "not an ancestor"; 128 (a commit this checkout has not fetched) cannot be live either.
    return false;
  }
}

/**
 * Pages until a short page, or until `done` says the rest is not wanted. Running out of pages first throws: a listing
 * cut at the cap would silently drop rows (an unreviewed PR shown as reviewed).
 */
async function listPages<T>(get: GithubGet, path: string, done: (page: T[]) => boolean = () => false): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = (await get(`${path}&per_page=${PAGE_SIZE}&page=${page}`)) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE || done(batch)) return rows;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} rows at ${path}`);
}

async function bypassedPrNumbers(slug: string, get: GithubGet): Promise<Set<number>> {
  const issues = await listPages<Issue>(get, `/repos/${slug}/issues?state=open&labels=gate-bypass`);
  const numbers = new Set<number>();
  for (const issue of issues) {
    if ('pull_request' in issue) continue;
    for (const m of (issue.body ?? '').matchAll(BYPASS_MARKER_RE)) numbers.add(Number(m[1]));
  }
  return numbers;
}

export async function readPrs(
  repoRoot: string,
  get: GithubGet,
  now: Date,
  live_sha: string | null,
): Promise<{ prs: PrRow[]; live_sha: string | null; gate_bypass_prs: number[] }> {
  const slug = await originSlug(repoRoot);
  if (!slug) throw new Error('origin is not a GitHub remote');

  const cutoff = now.getTime() - WINDOW_MS;
  const recent = (p: Pull) => Date.parse(p.updated_at) >= cutoff;
  const [pulls, bypassed] = await Promise.all([
    listPages<Pull>(get, `/repos/${slug}/pulls?state=all&sort=updated&direction=desc`, (page) => !page.every(recent)),
    bypassedPrNumbers(slug, get),
  ]);
  const prs: PrRow[] = [];
  for (const p of pulls.filter(recent)) {
    let stage: PrRow['stage'];
    if (p.merged_at) {
      stage =
        live_sha && p.merge_commit_sha && (await isAncestor(repoRoot, p.merge_commit_sha, live_sha))
          ? 'deployed'
          : 'merged';
    } else if (p.state === 'open') {
      stage = 'open';
    } else {
      continue;
    }
    prs.push({
      number: p.number,
      title: p.title,
      url: p.html_url,
      stage,
      unreviewed: bypassed.has(p.number),
      updated_at: p.updated_at,
    });
  }
  return { prs, live_sha, gate_bypass_prs: [...bypassed].sort((a, b) => a - b) };
}
