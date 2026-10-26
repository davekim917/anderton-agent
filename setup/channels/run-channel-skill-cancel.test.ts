import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHANNEL_SKIPPED } from '../lib/back-nav.js';
import { runChannelSkill } from './run-channel-skill.js';

const CANCEL = Symbol('test-cancel');
const clack = vi.hoisted(() => ({ info: [] as string[] }));
vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    password: vi.fn(async () => CANCEL),
    isCancel: (v: unknown) => v === CANCEL || actual.isCancel(v),
    log: { ...actual.log, info: (m: string) => void clack.info.push(m) },
  };
});

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  clack.info = [];
});

describe('runChannelSkill when the operator cancels a credential prompt', () => {
  it('skips the channel: no restart, no pairing, no wire, and says how to add it later', async () => {
    root = mkdtempSync(join(tmpdir(), 'rcs-cancel-'));
    mkdirSync(join(root, 'src/channels'), { recursive: true });
    writeFileSync(join(root, 'src/channels/index.ts'), '// barrel\n');
    mkdirSync(join(root, 'setup'), { recursive: true });
    writeFileSync(join(root, 'setup/index.ts'), '  // >>> nanoclaw:setup-steps\n  // <<< nanoclaw:setup-steps\n');
    writeFileSync(join(root, '.env'), '');
    writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');

    const cmds: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.startsWith('git show')) return '// placeholder branch content\n';
      if (c === 'pnpm run build') {
        mkdirSync(join(root, 'dist/channels'), { recursive: true });
        writeFileSync(join(root, 'dist/channels/telegram.js'), '// compiled\n');
      }
    };
    const streamed: string[] = [];
    const wire = vi.fn(() => true);
    const fail = vi.fn(async () => undefined as never);

    const result = await runChannelSkill('telegram', 'Robin Example', {
      projectRoot: root,
      exec,
      execStream: async (c) => {
        streamed.push(c);
        return { ok: true, fields: {} };
      },
      resolveRemote: () => 'origin',
      confirm: async () => false,
      agentName: 'Nano',
      role: 'owner',
      wire,
      fail,
    });

    expect(cmds.some((c) => c.includes('restart.sh'))).toBe(false);
    expect(streamed).toEqual([]);
    expect(wire).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(result).toBe(CHANNEL_SKIPPED);
    expect(clack.info.join('\n')).toContain('/add-telegram');
  });
});
