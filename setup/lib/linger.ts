import { execFileSync } from 'child_process';

export interface LingerDeps {
  run(argv: string[]): void;
  read(argv: string[]): string;
}

const defaultDeps: LingerDeps = {
  run: (argv) => {
    execFileSync(argv[0], argv.slice(1), { stdio: 'ignore' });
  },
  read: (argv) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
};

function lingering(user: string, deps: LingerDeps): boolean {
  try {
    return deps.read(['loginctl', 'show-user', user, '-p', 'Linger']).trim() === 'Linger=yes';
  } catch {
    return false;
  }
}

/**
 * Without polkit, `loginctl enable-linger` is denied for a non-root user, so it retries through sudo; `-n` keeps a
 * sudo that wants a password from stalling setup behind a spinner. The exit code is not the answer: only
 * `show-user` says whether linger is on.
 */
export function enableLinger(user: string, deps: LingerDeps = defaultDeps): boolean {
  if (lingering(user, deps)) return true;
  for (const argv of [
    ['loginctl', 'enable-linger', user],
    ['sudo', '-n', 'loginctl', 'enable-linger', user],
  ]) {
    try {
      deps.run(argv);
    } catch {
      continue;
    }
    if (lingering(user, deps)) return true;
  }
  return false;
}

export function lingerWarning(fields: Record<string, string>, user: string): string | null {
  if (fields.SERVICE_TYPE !== 'systemd-user' || fields.LINGER_ENABLED !== 'false') return null;
  return `NanoClaw will stop when you log out until you run \`sudo loginctl enable-linger ${user}\`.`;
}
