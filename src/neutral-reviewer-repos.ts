import { log } from './log.js';
import { notifyOwner, type NotifyOwnerOptions, type NotifyResult } from './notify-owner.js';

export const NEUTRAL_REVIEWER_REPOS_ENV = 'CODEX_REVIEW_NEUTRAL_REVIEWER_REPOS';

const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Read at spawn, not import: `.env` reaches `process.env` only once boot runs loadEnvIntoProcess. */
export function neutralReviewerReposEnvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const value = env[NEUTRAL_REVIEWER_REPOS_ENV];
  if (!value || !value.trim()) return [];
  return ['-e', `${NEUTRAL_REVIEWER_REPOS_ENV}=${value}`];
}

export function malformedNeutralReviewerRepos(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && !OWNER_REPO.test(entry));
}

/**
 * Boot check. A malformed list is still forwarded: the skill refuses unlisted receipts while one is present, and
 * dropping the list would let every client repo's receipt name the model.
 */
export async function checkNeutralReviewerRepos(
  env: NodeJS.ProcessEnv = process.env,
  notify: (opts: NotifyOwnerOptions) => Promise<NotifyResult> = notifyOwner,
): Promise<void> {
  const value = env[NEUTRAL_REVIEWER_REPOS_ENV];
  if (!value) return;
  const malformed = malformedNeutralReviewerRepos(value);
  if (malformed.length === 0) return;
  log.warn(`${NEUTRAL_REVIEWER_REPOS_ENV} holds entries that are not owner/repo`, { malformed });
  const result = await notify({
    title: `${NEUTRAL_REVIEWER_REPOS_ENV} is malformed`,
    body:
      `These entries are not owner/repo and match nothing: ${malformed.join(', ')}.\n\n` +
      'Containers still receive the list as written. Until it is fixed, `codex-review.sh receipt` posts nothing ' +
      'for a repo that neither the list nor its base config opts in. Fix the value in `.env`, then restart the ' +
      'host; each container picks it up at its next spawn.',
  });
  if (result.code !== 0)
    log.warn('neutral-reviewer-repos: could not DM the owner', { code: result.code, message: result.message });
}
