import { describe, expect, it } from 'vitest';

import { grantDockerSocketAccess, type SocketAccessDeps } from './docker-socket-access.js';

function host(opts: { tools: string[]; installs?: boolean; failFirstInstall?: boolean; failSetfacl?: boolean }) {
  const tools = new Set(opts.tools);
  const ran: string[] = [];
  let installs = 0;
  const deps: SocketAccessDeps = {
    commandExists: (name) => tools.has(name),
    run: (argv) => {
      ran.push(argv.join(' '));
      if (argv.includes('setfacl')) {
        if (opts.failSetfacl) throw new Error('setfacl failed');
        return;
      }
      if (argv.includes('install') || argv.includes('add') || argv.includes('-S')) {
        installs++;
        if (opts.failFirstInstall && installs === 1) throw new Error('stale package lists');
        if (opts.installs !== false) tools.add('setfacl');
      }
    },
  };
  return { deps, ran };
}

describe('grantDockerSocketAccess', () => {
  it('installs acl when setfacl is missing, then grants this user on the socket', () => {
    const { deps, ran } = host({ tools: ['apt-get'] });
    expect(grantDockerSocketAccess('stranger', deps)).toBe('granted');
    expect(ran).toEqual([
      'sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y acl',
      'sudo setfacl -m u:stranger:rw /var/run/docker.sock',
    ]);
  });

  it('refreshes the package lists once when the first install fails', () => {
    const { deps, ran } = host({ tools: ['apt-get'], failFirstInstall: true });
    expect(grantDockerSocketAccess('stranger', deps)).toBe('granted');
    expect(ran.slice(0, 3)).toEqual([
      'sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y acl',
      'sudo apt-get -o DPkg::Lock::Timeout=120 update',
      'sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y acl',
    ]);
  });

  it('grants directly when setfacl is already installed', () => {
    const { deps, ran } = host({ tools: ['setfacl', 'apt-get'] });
    expect(grantDockerSocketAccess('stranger', deps)).toBe('granted');
    expect(ran).toEqual(['sudo setfacl -m u:stranger:rw /var/run/docker.sock']);
  });

  it('reports no setfacl when no known package manager can install it', () => {
    const { deps, ran } = host({ tools: [] });
    expect(grantDockerSocketAccess('stranger', deps)).toBe('no-setfacl');
    expect(ran).toEqual([]);
  });

  it('reports no setfacl when the install ran but the tool is still absent', () => {
    const { deps } = host({ tools: ['dnf'], installs: false });
    expect(grantDockerSocketAccess('stranger', deps)).toBe('no-setfacl');
  });

  it('reports a failed grant', () => {
    const { deps } = host({ tools: ['setfacl'], failSetfacl: true });
    expect(grantDockerSocketAccess('stranger', deps)).toBe('failed');
  });
});
