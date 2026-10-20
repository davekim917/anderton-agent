import { execFileSync } from 'child_process';

import { commandExists } from '../platform.js';

const DOCKER_SOCKET = '/var/run/docker.sock';

export type SocketAccess = 'granted' | 'no-setfacl' | 'failed';

export interface SocketAccessDeps {
  commandExists(name: string): boolean;
  run(argv: string[]): void;
}

const defaultDeps: SocketAccessDeps = {
  commandExists,
  run: (argv) => {
    execFileSync(argv[0], argv.slice(1), { stdio: 'inherit' });
  },
};

// A fresh Ubuntu VM's unattended-upgrades often holds the dpkg lock; without a timeout apt fails at once.
const APT_INSTALL_ACL = [
  'sudo',
  'env',
  'DEBIAN_FRONTEND=noninteractive',
  'apt-get',
  '-o',
  'DPkg::Lock::Timeout=120',
  'install',
  '-y',
  'acl',
];

/** Minimal images (Docker's own ubuntu:24.04, cloud minimal) ship without the `acl` package that provides setfacl. */
const ACL_INSTALLERS: { manager: string; argv: string[][] }[] = [
  {
    manager: 'apt-get',
    argv: [APT_INSTALL_ACL, ['sudo', 'apt-get', '-o', 'DPkg::Lock::Timeout=120', 'update'], APT_INSTALL_ACL],
  },
  { manager: 'dnf', argv: [['sudo', 'dnf', 'install', '-y', 'acl']] },
  { manager: 'yum', argv: [['sudo', 'yum', 'install', '-y', 'acl']] },
  { manager: 'zypper', argv: [['sudo', 'zypper', '--non-interactive', 'install', 'acl']] },
  { manager: 'pacman', argv: [['sudo', 'pacman', '-S', '--noconfirm', '--needed', 'acl']] },
  { manager: 'apk', argv: [['sudo', 'apk', 'add', 'acl']] },
];

function installSetfacl(deps: SocketAccessDeps): boolean {
  const installer = ACL_INSTALLERS.find((i) => deps.commandExists(i.manager));
  if (!installer) return false;
  const [first, ...retry] = installer.argv;
  try {
    deps.run(first);
  } catch {
    try {
      for (const argv of retry) deps.run(argv);
    } catch {
      return false;
    }
  }
  return deps.commandExists('setfacl');
}

/**
 * The user's systemd manager keeps the groups it started with, and with linger it lives until reboot, so a user
 * added to `docker` during setup cannot reach the socket from a user unit. An ACL entry for this user on the socket
 * alone grants that access now. dockerd recreates the socket on restart, which drops the entry; after a reboot the
 * manager has the group and needs no entry.
 */
export function grantDockerSocketAccess(user: string, deps: SocketAccessDeps = defaultDeps): SocketAccess {
  if (!deps.commandExists('setfacl') && !installSetfacl(deps)) return 'no-setfacl';
  try {
    deps.run(['sudo', 'setfacl', '-m', `u:${user}:rw`, DOCKER_SOCKET]);
    return 'granted';
  } catch {
    return 'failed';
  }
}
