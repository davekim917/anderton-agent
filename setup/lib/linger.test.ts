import { describe, expect, it } from 'vitest';

import { enableLinger, lingerWarning, type LingerDeps } from './linger.js';

function host(opts: { lingering?: boolean; plainWorks?: boolean; sudoWorks?: boolean; showUserFails?: boolean }) {
  let lingering = opts.lingering ?? false;
  const ran: string[] = [];
  const deps: LingerDeps = {
    run: (argv) => {
      ran.push(argv.join(' '));
      const viaSudo = argv[0] === 'sudo';
      if (viaSudo ? opts.sudoWorks : opts.plainWorks) lingering = true;
      else throw new Error('Access denied');
    },
    read: () => {
      if (opts.showUserFails) throw new Error('User casey is not logged in or lingering');
      return `Linger=${lingering ? 'yes' : 'no'}\n`;
    },
  };
  return { deps, ran };
}

describe('enableLinger', () => {
  it('does nothing when linger is already on', () => {
    const { deps, ran } = host({ lingering: true });
    expect(enableLinger('casey', deps)).toBe(true);
    expect(ran).toEqual([]);
  });

  it('enables linger without sudo when polkit allows it', () => {
    const { deps, ran } = host({ plainWorks: true });
    expect(enableLinger('casey', deps)).toBe(true);
    expect(ran).toEqual(['loginctl enable-linger casey']);
  });

  it('retries through non-interactive sudo when polkit denies it', () => {
    const { deps, ran } = host({ sudoWorks: true });
    expect(enableLinger('casey', deps)).toBe(true);
    expect(ran).toEqual(['loginctl enable-linger casey', 'sudo -n loginctl enable-linger casey']);
  });

  it('reports false when both attempts fail', () => {
    const { deps } = host({});
    expect(enableLinger('casey', deps)).toBe(false);
  });

  it('trusts loginctl show-user over a zero exit code', () => {
    const { deps } = host({});
    deps.run = () => {};
    expect(enableLinger('casey', deps)).toBe(false);
  });

  it('reports false when show-user cannot answer', () => {
    const { deps } = host({ plainWorks: true, showUserFails: true });
    expect(enableLinger('casey', deps)).toBe(false);
  });
});

describe('lingerWarning', () => {
  it('names the fix when a user service has no linger', () => {
    expect(lingerWarning({ SERVICE_TYPE: 'systemd-user', LINGER_ENABLED: 'false' }, 'casey')).toContain(
      'sudo loginctl enable-linger casey',
    );
  });

  it('stays quiet when linger is on or the service is not a user unit', () => {
    expect(lingerWarning({ SERVICE_TYPE: 'systemd-user', LINGER_ENABLED: 'true' }, 'casey')).toBeNull();
    expect(lingerWarning({ SERVICE_TYPE: 'systemd-system', LINGER_ENABLED: 'false' }, 'casey')).toBeNull();
  });
});
