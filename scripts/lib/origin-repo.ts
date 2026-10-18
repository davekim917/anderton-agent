import { execFileSync } from 'node:child_process';

import { parseRemote } from '../check-public-boundary.js';

/** `owner/name` of the checkout's `origin` on github.com: the fork these operator scripts report on. */
export function originRepo(cwd: string = process.cwd()): string {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim();
  const parsed = parseRemote(url);
  if (parsed.kind !== 'network' || parsed.host !== 'github.com') {
    throw new Error('origin is not a github.com repository; pass --repo <owner/name>');
  }
  return `${parsed.owner}/${parsed.repo}`;
}
