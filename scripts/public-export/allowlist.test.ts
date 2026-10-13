import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

function productGlobs(): { include: string[]; exclude: string[] } {
  const config = fs.readFileSync(path.join(HERE, 'copy.bara.sky'), 'utf8');
  const block = /PRODUCT_FILES\s*=\s*glob\(([\s\S]*?)\n\)/.exec(config)?.[1];
  if (!block) throw new Error('PRODUCT_FILES glob not found in copy.bara.sky');
  const list = (name: string) => {
    const body = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(block)?.[1];
    if (body === undefined) throw new Error(`${name} list not found in PRODUCT_FILES`);
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  };
  return { include: list('include'), exclude: list('exclude') };
}

function exported(): string[] {
  const { include, exclude } = productGlobs();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      ...include.map((glob) => `:(glob)${glob}`),
      ...exclude.map((glob) => `:(glob,exclude)${glob}`),
    ],
    { cwd: REPO, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean);
}

const PRIVATE = [
  /^docs\/specs\//,
  /^docs\/retros\//,
  /^docs\/review-notes/,
  /^docs\/handoffs\//,
  /^data\//,
  /^\.github\//,
  /^\.agents\//,
  /^\.design-artifact-loop\//,
  /(^|\/)groups\//,
  /(^|\/)\.context\//,
  /^PROGRESS\.md$/,
  /^\.public-boundary-/,
  /^\.mcp\.json$/,
  /^\.claude\/settings/,
  /^CLAUDE\.md$/,
  /^AGENTS\.md$/,
  /^README[^/]*\.md$/,
  /^docs\/(CUTOVER_RUNBOOK|MIGRATION_FROM_V1|SPIKE_NOTES|V2_BACKLOG|profound|project-scope|review-policy|codex-parity-test-plan|codex-hook-support)\.md$/,
  /^docs\/PHASE_[^/]*\.md$/,
  /^docs\/always-on-directive-[^/]*\.md$/,
  /^container\/skills\/smoke-test\/scripts\/(testdata\/controller-replay-corpus\.ndjson|smoke-controller-shadow-report\.test\.sh)$/,
];

describe('copy.bara.sky PRODUCT_FILES over the tracked tree', () => {
  const files = exported();

  it('exports no private path', () => {
    expect(files.filter((file) => PRIVATE.some((pattern) => pattern.test(file)))).toEqual([]);
  });

  it('exports the product', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'package.json',
        'LICENSE',
        'container/Dockerfile',
        'docs/architecture.md',
        'scripts/public-export/gate.ts',
        'src/router.ts',
        'public-overlay/README.md',
        'public-overlay/CLAUDE.md',
        'public-overlay/AGENTS.md',
      ]),
    );
  });
});
