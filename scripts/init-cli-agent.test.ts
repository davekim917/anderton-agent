import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

const FOLDER = 'ping-test-0a1b2c3d';

function initCliAgent(installRoot: string, pickedProvider: string): void {
  execFileSync(
    tsx,
    [
      path.join(repoRoot, 'scripts', 'init-cli-agent.ts'),
      '--display-name',
      'Tester',
      '--agent-name',
      'Pal',
      '--folder',
      FOLDER,
    ],
    {
      cwd: installRoot,
      env: { PATH: process.env.PATH, HOME: installRoot, NANOCLAW_PICKED_PROVIDER: pickedProvider },
      stdio: 'pipe',
    },
  );
}

function fileProvider(installRoot: string): string | undefined {
  const raw = JSON.parse(fs.readFileSync(path.join(installRoot, 'groups', FOLDER, 'container.json'), 'utf8')) as {
    provider?: string;
  };
  return raw.provider;
}

function projectedProvider(installRoot: string): string | null | undefined {
  const db = new Database(path.join(installRoot, 'data', 'v2.db'), { readonly: true });
  const row = db
    .prepare(
      `SELECT cc.provider AS provider FROM agent_groups ag
       JOIN container_configs cc ON cc.agent_group_id = ag.id
       WHERE ag.folder = ?`,
    )
    .get(FOLDER) as { provider: string | null } | undefined;
  db.close();
  return row?.provider;
}

describe('init-cli-agent', () => {
  let installRoot: string;
  afterEach(() => fs.rmSync(installRoot, { recursive: true, force: true }));

  it('stamps the provider setup picked into container.json and its projection', () => {
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'init-cli-agent-'));
    initCliAgent(installRoot, 'codex');

    expect(projectedProvider(installRoot)).toBe('codex');
    expect(fileProvider(installRoot)).toBe('codex');
  }, 60_000);

  it('keeps the provider a reused group already boots', () => {
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'init-cli-agent-'));
    initCliAgent(installRoot, 'codex');
    const configPath = path.join(installRoot, 'groups', FOLDER, 'container.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(configPath, JSON.stringify({ ...config, provider: 'opencode' }, null, 2) + '\n');

    initCliAgent(installRoot, 'codex');
    expect(fileProvider(installRoot)).toBe('opencode');
    expect(projectedProvider(installRoot)).toBe('opencode');
  }, 60_000);

  it('leaves a reused group on the Claude its container.json boots, whatever this run picks', () => {
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'init-cli-agent-'));
    initCliAgent(installRoot, 'codex');
    const configPath = path.join(installRoot, 'groups', FOLDER, 'container.json');
    const { provider: _dropped, ...rest } = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(configPath, JSON.stringify(rest, null, 2) + '\n');

    initCliAgent(installRoot, 'opencode');
    expect(fileProvider(installRoot)).toBeUndefined();
    expect(projectedProvider(installRoot)).toBeNull();
  }, 60_000);
});
