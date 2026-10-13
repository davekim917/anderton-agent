import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addWorkgroupOnecliSecret, createAgentGroup } from './db/agent-groups.js';
import {
  addWorkgroupExclusion,
  addWorkgroupTool,
  putWorkgroupMcpServer,
  removeWorkgroupExclusion,
  removeWorkgroupMcpServer,
  removeWorkgroupOnecliSecret,
  removeWorkgroupTool,
} from './db/workgroup-access.js';
import { closeDb, getDb, initMigratedTestDb } from './db/index.js';
import {
  assertCredentialFolderInWorkgroup,
  effectiveTools,
  emptyWorkgroupAccess,
  getWorkgroupAccessById,
  getWorkgroupAccessForGroup,
  parseWorkgroupAccessRow,
} from './workgroup-access.js';

describe('effectiveTools', () => {
  it.each([
    [
      'unions the workgroup ahead of the group',
      ['flowctl', 'exa'],
      ['exa', 'snowflake:qz'],
      ['flowctl', 'exa', 'snowflake:qz'],
    ],
    ['grants the workgroup to a group whose own list is empty', ['flowctl'], [], ['flowctl']],
    ['keeps a group with no tools list unrestricted', ['flowctl'], undefined, undefined],
  ])('%s', (_label, workgroup, group, expected) => {
    expect(effectiveTools(workgroup, group)).toEqual(expected);
  });
});

const EMPTY_ROW = {
  onecli_secrets: '[]',
  tools: '[]',
  mcp_servers: '{}',
  exclude_mcp_servers: '[]',
  exclude_plugins: '[]',
};

describe('parseWorkgroupAccessRow', () => {
  it('fails closed on a column it cannot read, rather than granting nothing', () => {
    expect(() => parseWorkgroupAccessRow('wg', { ...EMPTY_ROW, tools: 'not json' })).toThrow(
      /workgroup wg tools is not valid JSON/,
    );
    expect(() =>
      parseWorkgroupAccessRow('wg', {
        ...EMPTY_ROW,
        mcp_servers: JSON.stringify({ x: { command: 'bun', plugin: 'some-plugin' } }),
      }),
    ).toThrow(/workgroup wg mcp_servers: server x has unsupported field "plugin"/);
    expect(() => parseWorkgroupAccessRow('wg', { ...EMPTY_ROW, exclude_plugins: '["/abs"]' })).toThrow(
      /excludePlugins entry "\/abs" must be relative/,
    );
    expect(() => parseWorkgroupAccessRow('wg', { ...EMPTY_ROW, exclude_mcp_servers: '["bad name"]' })).toThrow();
  });
});

describe('workgroup access store', () => {
  beforeEach(async () => {
    await initMigratedTestDb();
    await getDb().run(
      `INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES ('wg', '["A","B","C"]', ?)`,
      new Date().toISOString(),
    );
    await createAgentGroup({
      id: 'ag-member',
      name: 'Member',
      folder: 'member',
      agent_provider: null,
      created_at: new Date().toISOString(),
      workgroup_id: 'wg',
    });
    await createAgentGroup({
      id: 'ag-alone',
      name: 'Alone',
      folder: 'alone',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => closeDb());

  it('adds and removes entries in place, and a member reads them back', async () => {
    expect(await addWorkgroupTool('wg', 'flowctl')).toBe(true);
    expect(await addWorkgroupTool('wg', 'flowctl')).toBe(false);
    await addWorkgroupTool('wg', 'snowflake:qz');
    await addWorkgroupTool('wg', 'exa');
    expect(await removeWorkgroupTool('wg', 'snowflake:qz')).toBe(true);
    expect(await removeWorkgroupTool('wg', 'snowflake:qz')).toBe(false);
    expect(await removeWorkgroupOnecliSecret('wg', 'B')).toBe(true);
    expect(await addWorkgroupOnecliSecret('wg', 'D')).toBe(true);

    const first = { command: 'bun', args: ['one.ts'] };
    const second = { type: 'http', url: 'https://mcp.example.com/mcp' };
    expect(await putWorkgroupMcpServer('wg', 'cloudflare-api', first, { replace: false })).toBe(true);
    expect(await putWorkgroupMcpServer('wg', 'cloudflare-api', second, { replace: false })).toBe(false);
    expect(await putWorkgroupMcpServer('wg', 'estuary', first, { replace: false })).toBe(true);
    expect(await putWorkgroupMcpServer('wg', 'estuary', second, { replace: true })).toBe(true);
    expect(await removeWorkgroupMcpServer('wg', 'missing')).toBe(false);
    expect(await addWorkgroupExclusion('wg', 'exclude_plugins', 'skills')).toBe(true);
    expect(await addWorkgroupExclusion('wg', 'exclude_plugins', 'skills')).toBe(false);
    await addWorkgroupExclusion('wg', 'exclude_plugins', 'kwp/data');
    await addWorkgroupExclusion('wg', 'exclude_mcp_servers', 'deepwiki');
    expect(await removeWorkgroupExclusion('wg', 'exclude_plugins', 'skills')).toBe(true);
    expect(await removeWorkgroupExclusion('wg', 'exclude_mcp_servers', 'missing')).toBe(false);

    expect(await getWorkgroupAccessForGroup('ag-member')).toEqual({
      onecliSecrets: ['A', 'C', 'D'],
      tools: ['flowctl', 'exa'],
      mcpServers: { 'cloudflare-api': first, estuary: second },
      excludeMcpServers: ['deepwiki'],
      excludePlugins: ['kwp/data'],
    });
    expect(await removeWorkgroupMcpServer('wg', 'cloudflare-api')).toBe(true);
    expect(Object.keys((await getWorkgroupAccessById('wg')).mcpServers)).toEqual(['estuary']);
  });

  it("confines credentialFolder to the folders of the group's own workgroup", async () => {
    await getDb().run(
      `INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES ('wg2', '[]', ?)`,
      new Date().toISOString(),
    );
    for (const [id, folder, workgroup_id] of [
      ['ag-sibling', 'sibling', 'wg'],
      ['ag-other', 'other', 'wg2'],
    ]) {
      await createAgentGroup({
        id,
        name: id,
        folder,
        agent_provider: null,
        created_at: new Date().toISOString(),
        workgroup_id,
      });
    }
    const sibling = { id: 'ag-sibling', folder: 'sibling' };

    await expect(assertCredentialFolderInWorkgroup(sibling, undefined, 'wg')).resolves.toBeUndefined();
    await expect(assertCredentialFolderInWorkgroup(sibling, 'member', 'wg')).resolves.toBeUndefined();
    await expect(assertCredentialFolderInWorkgroup(sibling, 'other', 'wg')).rejects.toThrow(
      /not the folder of a member of its workgroup wg/,
    );
    await expect(assertCredentialFolderInWorkgroup(sibling, 'no-such-folder', 'wg')).rejects.toThrow();
    // A group in no workgroup is its own tenant: only its own folder.
    const alone = { id: 'ag-alone', folder: 'alone' };
    await expect(assertCredentialFolderInWorkgroup(alone, 'alone', 'alone')).resolves.toBeUndefined();
    await expect(assertCredentialFolderInWorkgroup(alone, 'member', 'alone')).rejects.toThrow();
  });

  it('grants nothing to a group in no workgroup, or for a workgroup with no row', async () => {
    await addWorkgroupTool('wg', 'flowctl');
    const empty = emptyWorkgroupAccess();
    expect(await getWorkgroupAccessForGroup('ag-alone')).toEqual(empty);
    expect(await getWorkgroupAccessById('no-such-wg')).toEqual(empty);
  });
});
