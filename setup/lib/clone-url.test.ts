/**
 * The "clone the repo" hint nanoclaw.sh prints for a root user names the
 * checkout's own origin, so a public clone never points a person at another
 * project, and a credential in the remote never reaches the terminal.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, 'clone-url.sh');
const roots: string[] = [];
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function checkout(origin: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-url-'));
  roots.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv() });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir, env: cleanEnv() });
  return dir;
}

function cloneUrlOf(dir: string): string {
  return execFileSync('/bin/bash', ['-c', 'source "$1"; clone_url_of "$2"', 'test', SCRIPT, dir], {
    env: cleanEnv(),
    encoding: 'utf8',
  });
}

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('clone_url_of', () => {
  it.each([
    [
      'an https origin',
      'https://github.com/example-owner/example-agent.git',
      'https://github.com/example-owner/example-agent.git',
    ],
    [
      'a credential in the origin',
      'https://x-access-token:secret123@gitserver/example-owner/example-agent.git',
      'https://gitserver/example-owner/example-agent.git',
    ],
    [
      'an ssh origin',
      'ssh://example.invalid/example-owner/example-agent.git',
      'ssh://example.invalid/example-owner/example-agent.git',
    ],
    [
      'a credential behind a transport prefix',
      'https::https://example-user:secret123@gitserver/example-owner/example-agent.git',
      'https::https://gitserver/example-owner/example-agent.git',
    ],
    [
      'an ssh password, keeping the login',
      'ssh://deploy:secret123@gitserver/example-owner/example-agent.git',
      'ssh://deploy@gitserver/example-owner/example-agent.git',
    ],
    ['an scp-style origin', 'gitserver:example-agent.git', 'gitserver:example-agent.git'],
    ['an absolute local origin', '/srv/example-agent.git', '/srv/example-agent.git'],
  ])('prints %s as given, minus credentials', (_name, origin, expected) => {
    expect(cloneUrlOf(checkout(origin))).toBe(expected);
  });

  it('prints a relative local origin as an absolute path', () => {
    const dir = checkout('../source.git');
    expect(cloneUrlOf(dir)).toBe(path.resolve(dir, '../source.git'));
  });

  it('prints nothing for a checkout with no origin', () => {
    expect(cloneUrlOf(checkout(null))).toBe('');
  });
});
