import { describe, expect, it } from 'vitest';

import type { McpServerConfig } from '../src/container-config.js';
import { emptyWorkgroupAccess } from '../src/workgroup-access.js';
import { planWorkgroupLift, type MemberInput } from './lift-workgroup-access.js';

const bridge = (url: string): McpServerConfig => ({ command: 'bun', args: ['/app/src/remote-mcp-bridge.ts', url] });

function member(folder: string, config: MemberInput['config']): MemberInput {
  return { id: `ag-${folder}`, folder, config };
}

describe('planWorkgroupLift', () => {
  it('lifts what every member declares, drops what the workgroup then grants, and changes no one’s access', () => {
    const shared = { onecliSecrets: ['Estuary-MCP', 'Exa'], tools: ['exa', 'snowflake:qz'] };
    const optOuts = { excludeMcpServers: ['deepwiki'], excludePlugins: ['skills', 'kwp/data'] };
    const plan = planWorkgroupLift('qz', { ...emptyWorkgroupAccess(), onecliSecrets: ['Amplitude-MCP'] }, [
      member('qz', {
        ...shared,
        ...optOuts,
        onecliSecrets: [...shared.onecliSecrets, 'Amplitude-MCP'],
        mcpServers: { estuary: bridge('https://estuary.example') },
      }),
      member('qz-codex', {
        ...shared,
        ...optOuts,
        credentialFolder: 'qz',
        mcpServers: { estuary: bridge('https://estuary.example') },
      }),
      // No tools list = every surface: it neither narrows the tools lift nor loses anything to it.
      member('qz-opencode', {
        ...optOuts,
        onecliSecrets: shared.onecliSecrets,
        credentialFolder: 'qz',
        mcpServers: { estuary: bridge('https://estuary.example') },
      }),
      // A wiki actor inherits no workgroup access, so it neither narrows the lift nor is edited.
      member('qz-wiki', { tools: [], wikiMaintenance: true }),
    ]);

    expect(plan.excluded.map((x) => x.folder)).toEqual(['qz-wiki']);
    expect(plan.lift).toEqual({
      onecliSecrets: ['Estuary-MCP', 'Exa'],
      tools: ['exa', 'snowflake:qz'],
      mcpServers: { estuary: bridge('https://estuary.example') },
      excludeMcpServers: ['deepwiki'],
      excludePlugins: ['skills', 'kwp/data'],
    });
    expect(plan.edits).toEqual([
      {
        id: 'ag-qz',
        folder: 'qz',
        removeSecrets: ['Estuary-MCP', 'Exa', 'Amplitude-MCP'],
        removeTools: ['exa', 'snowflake:qz'],
        removeMcpServers: ['estuary'],
        removeExcludeMcpServers: ['deepwiki'],
        removeExcludePlugins: ['skills', 'kwp/data'],
      },
      {
        id: 'ag-qz-codex',
        folder: 'qz-codex',
        removeSecrets: ['Estuary-MCP', 'Exa'],
        removeTools: ['exa', 'snowflake:qz'],
        removeMcpServers: ['estuary'],
        removeExcludeMcpServers: ['deepwiki'],
        removeExcludePlugins: ['skills', 'kwp/data'],
      },
      {
        id: 'ag-qz-opencode',
        folder: 'qz-opencode',
        removeSecrets: ['Estuary-MCP', 'Exa'],
        removeTools: [],
        removeMcpServers: ['estuary'],
        removeExcludeMcpServers: ['deepwiki'],
        removeExcludePlugins: ['skills', 'kwp/data'],
      },
    ]);
    // Declared by one member only, yet every member already holds it through the workgroup.
    expect(plan.covered).toEqual([{ kind: 'secret', name: 'Amplitude-MCP', declaredBy: ['qz'] }]);
    expect(plan.drift).toEqual([]);
    expect(plan.violations).toEqual([]);
  });

  it('keeps flowctl per member when a member has no tools list, since a workgroup grant would hand it the key', () => {
    const plan = planWorkgroupLift('qz', emptyWorkgroupAccess(), [
      member('qz', { tools: ['flowctl', 'exa'] }),
      member('qz-codex', { tools: ['flowctl', 'exa'], credentialFolder: 'qz' }),
      member('qz-child', { credentialFolder: 'qz' }),
    ]);

    expect(plan.lift.tools).toEqual(['exa']);
    expect(plan.drift.map((d) => [d.kind, d.name, d.holders, d.missing])).toEqual([
      ['tool', 'flowctl', ['qz', 'qz-codex'], ['qz-child']],
    ]);
    expect(plan.violations).toEqual([]);
  });

  it('reports what only some members hold instead of granting it to the rest', () => {
    const plan = planWorkgroupLift(
      'team',
      { ...emptyWorkgroupAccess(), mcpServers: { docs: bridge('https://docs.workgroup') } },
      [
        member('team', {
          onecliSecrets: ['Personal-Key'],
          tools: ['exa', 'aws:prod'],
          excludePlugins: ['skills'],
          mcpServers: {
            variant: bridge('https://a.example'),
            owned: { command: 'bun', args: ['x'], plugin: 'some-plugin' },
            docs: bridge('https://docs.member'),
          },
        }),
        member('team-codex', {
          tools: ['exa'],
          excludePlugins: ['skills', 'data'],
          credentialFolder: 'team',
          mcpServers: {
            variant: bridge('https://b.example'),
            owned: { command: 'bun', args: ['x'], plugin: 'some-plugin' },
            docs: bridge('https://docs.member'),
          },
        }),
      ],
    );

    expect(plan.lift).toEqual({
      onecliSecrets: [],
      tools: ['exa'],
      mcpServers: {},
      excludeMcpServers: [],
      excludePlugins: ['skills'],
    });
    expect(plan.skipped).toEqual([
      { kind: 'mcp-server', name: 'owned', reason: 'carries per-group plugin field "plugin"' },
      {
        kind: 'mcp-server',
        name: 'docs',
        reason: 'the workgroup already declares a different entry under this name (each member keeps its own)',
      },
    ]);
    expect(plan.drift.map((d) => [d.kind, d.name, d.holders, d.missing])).toEqual([
      ['secret', 'Personal-Key', ['team'], ['team-codex']],
      ['tool', 'aws:prod', ['team'], ['team-codex']],
      ['mcp-server-variant', 'variant', ['team', 'team-codex'], []],
      ['mcp-server-variant', 'docs', ['team', 'team-codex'], []],
      ['exclude-plugin', 'data', ['team-codex'], ['team']],
    ]);
    expect(plan.violations).toEqual([]);
  });

  it("keeps an opt-out of a server the workgroup grants on the members, and flags another workgroup's credentials", () => {
    const plan = planWorkgroupLift('team', { ...emptyWorkgroupAccess(), mcpServers: { docs: bridge('https://d') } }, [
      member('team', { excludeMcpServers: ['docs', 'exa'] }),
      member('team-codex', { excludeMcpServers: ['docs', 'exa'], credentialFolder: 'other-tenant' }),
    ]);

    expect(plan.lift.excludeMcpServers).toEqual(['exa']);
    expect(plan.skipped).toEqual([
      { kind: 'exclude-mcp-server', name: 'docs', reason: 'the workgroup grants this MCP server itself' },
    ]);
    expect(plan.drift.map((d) => [d.kind, d.holders])).toContainEqual(['credential-folder', ['team-codex']]);
    expect(plan.violations).toEqual([]);
  });
});
