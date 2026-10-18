import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

/**
 * Tests for the environment check step.
 *
 * Verifies: config detection, Docker/AC detection, DB queries.
 */

describe('environment detection', () => {
  it('detects platform correctly', async () => {
    const { getPlatform } = await import('./platform.js');
    const platform = getPlatform();
    expect(['macos', 'linux', 'unknown']).toContain(platform);
  });
});

describe('detectRegisteredGroups', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-test-'));
    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when no registration state exists', async () => {
    const { detectRegisteredGroups } = await import('./environment.js');
    expect(detectRegisteredGroups(tempDir)).toBe(false);
  });

  it('detects pre-migration registered_groups.json', async () => {
    const { detectRegisteredGroups } = await import('./environment.js');
    fs.writeFileSync(path.join(tempDir, 'data', 'registered_groups.json'), '[]');
    expect(detectRegisteredGroups(tempDir)).toBe(true);
  });

  it('returns false for an empty v2 central DB', async () => {
    const { detectRegisteredGroups } = await import('./environment.js');
    const db = new Database(path.join(tempDir, 'data', 'v2.db'));
    db.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
      CREATE TABLE messaging_group_agents (
        id TEXT PRIMARY KEY,
        messaging_group_id TEXT NOT NULL,
        agent_group_id TEXT NOT NULL
      );
    `);
    db.close();

    expect(detectRegisteredGroups(tempDir)).toBe(false);
  });

  it('detects wired agent groups in the v2 central DB', async () => {
    const { detectRegisteredGroups } = await import('./environment.js');
    const db = new Database(path.join(tempDir, 'data', 'v2.db'));
    db.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
      CREATE TABLE messaging_group_agents (
        id TEXT PRIMARY KEY,
        messaging_group_id TEXT NOT NULL,
        agent_group_id TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO agent_groups (id) VALUES (?)').run('ag-1');
    db.prepare(
      'INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id) VALUES (?, ?, ?)',
    ).run('mga-1', 'mg-1', 'ag-1');
    db.close();

    expect(detectRegisteredGroups(tempDir)).toBe(true);
  });
});

describe('credentials detection', () => {
  it('detects ANTHROPIC_API_KEY in env content', () => {
    const content =
      'SOME_KEY=value\nANTHROPIC_API_KEY=sk-ant-test123\nOTHER=foo';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(content);
    expect(hasCredentials).toBe(true);
  });

  it('detects CLAUDE_CODE_OAUTH_TOKEN in env content', () => {
    const content = 'CLAUDE_CODE_OAUTH_TOKEN=token123';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(content);
    expect(hasCredentials).toBe(true);
  });

  it('detects ANTHROPIC_AUTH_TOKEN in env content', () => {
    const content = 'ANTHROPIC_AUTH_TOKEN=token123\nANTHROPIC_BASE_URL=http://localhost:8080';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(content);
    expect(hasCredentials).toBe(true);
  });

  it('returns false when no credentials', () => {
    const content = 'ASSISTANT_NAME="Andy"\nOTHER=foo';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(content);
    expect(hasCredentials).toBe(false);
  });
});

describe('Docker detection logic', () => {
  it('commandExists returns boolean', async () => {
    const { commandExists } = await import('./platform.js');
    expect(typeof commandExists('docker')).toBe('boolean');
    expect(typeof commandExists('nonexistent_binary_xyz')).toBe('boolean');
  });
});

describe('channel auth detection', () => {
  it('detects non-empty auth directory', () => {
    const hasAuth = (authDir: string) => {
      try {
        return fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
      } catch {
        return false;
      }
    };

    // Non-existent directory
    expect(hasAuth('/tmp/nonexistent_auth_dir_xyz')).toBe(false);
  });
});


describe('findStalePingAgentFolders', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ping-test-'));
    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns setup ping agents wired to nothing but the local CLI chat', async () => {
    const { findStalePingAgentFolders } = await import('./environment.js');
    const db = new Database(path.join(tempDir, 'data', 'v2.db'));
    db.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT);
      CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, channel_type TEXT, platform_id TEXT);
      CREATE TABLE messaging_group_agents (id TEXT PRIMARY KEY, messaging_group_id TEXT, agent_group_id TEXT);
      INSERT INTO messaging_groups VALUES ('mg-cli', 'cli', 'local'), ('mg-chat', 'slack', 'slack:D0FAKE01');
      INSERT INTO agent_groups VALUES
        ('ag-1', 'ping-test-0a1b2c3d'),
        ('ag-2', 'ping-test-11223344'),
        ('ag-3', 'ping-test-deadbeef'),
        ('ag-4', 'cli-with-tester'),
        ('ag-5', 'ping-test-notahex');
      INSERT INTO messaging_group_agents VALUES
        ('w-1', 'mg-cli', 'ag-1'),
        ('w-3a', 'mg-cli', 'ag-3'),
        ('w-3b', 'mg-chat', 'ag-3'),
        ('w-4', 'mg-cli', 'ag-4'),
        ('w-5', 'mg-cli', 'ag-5');
    `);
    db.close();

    expect(findStalePingAgentFolders(tempDir).sort()).toEqual(['ping-test-0a1b2c3d', 'ping-test-11223344']);
  });

  it('returns nothing when there is no central DB', async () => {
    const { findStalePingAgentFolders } = await import('./environment.js');
    expect(findStalePingAgentFolders(tempDir)).toEqual([]);
  });
});
