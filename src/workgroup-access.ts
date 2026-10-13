/**
 * Workgroup-level access: the OneCLI secrets, `tools` and MCP servers declared on a `workgroups` row, which every
 * member inherits at spawn, and the opt-outs that withhold fleet-wide MCP servers and plugins from every member.
 * Each kind resolves through one function shared by the spawn path and the capability snapshot — secrets
 * `mergeWorkgroupAndGroupSecrets` (src/onecli-secrets.ts), tools `effectiveTools` and plugin opt-outs
 * `effectiveExcludePlugins` (src/plugin-exclusions.ts), MCP servers `effectiveMcpServers` (src/fleet-mcp-servers.ts) — so what an agent
 * is told matches what it gets.
 *
 * Every kind is a union: a member's own container.json can add to the workgroup's grants and opt-outs, never
 * subtract from them.
 */
import type { McpServerConfig } from './container-config.js';
import { validateMcpServerName } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getWorkgroupAccessRowById, getWorkgroupAccessRowForGroup } from './db/workgroup-access.js';
import { validateInheritedMcpServers } from './fleet-mcp-servers.js';
import { validateExcludePlugins } from './plugin-exclusions.js';

export interface WorkgroupAccess {
  onecliSecrets: string[];
  tools: string[];
  mcpServers: Record<string, McpServerConfig>;
  /** Fleet MCP servers no member inherits. */
  excludeMcpServers: string[];
  /** `~/plugins` entries or sub-plugin paths no member receives. */
  excludePlugins: string[];
}

export function emptyWorkgroupAccess(): WorkgroupAccess {
  return { onecliSecrets: [], tools: [], mcpServers: {}, excludeMcpServers: [], excludePlugins: [] };
}

/** `name` or `name:scope`, the container.json `tools` vocabulary. Scopes name credential files, so no separators. */
const TOOL_ENTRY_RE = /^[a-z0-9][a-z0-9-]*(?::[A-Za-z0-9_-]+)?$/;

export function validateToolEntry(tool: string): void {
  if (!TOOL_ENTRY_RE.test(tool)) {
    throw new Error(
      `Invalid tool "${tool}": expected a lowercase name ("flowctl") or name:scope ("snowflake:prod"), scope limited to letters, digits, "_" and "-"`,
    );
  }
}

/**
 * Workgroup tools first, then the group's additions. A group with no `tools` list is unrestricted (every credential
 * surface), and a union with everything is still everything, so it stays `undefined`.
 */
export function effectiveTools(workgroupTools: string[], groupTools: string[] | undefined): string[] | undefined {
  if (groupTools === undefined) return undefined;
  return [...new Set([...workgroupTools, ...groupTools])];
}

/**
 * The entries a member holds by declaration: its workgroup's plus its own, even when it has no list of its own.
 * `effectiveTools` answers what the spawn may stage; this answers what was granted by name, which decides an
 * explicit-only tool (flowctl) and which services the capability snapshot describes.
 */
export function declaredTools(workgroupTools: readonly string[], groupTools: readonly string[] | undefined): string[] {
  return [...new Set([...workgroupTools, ...(groupTools ?? [])])];
}

/**
 * `credentialFolder` names whose folder-keyed host credentials a group gets (`<NAME>_<FOLDER>` env vars, OAuth
 * sets, key files). It must be the group's own folder or a fellow member's; any other folder would hand one
 * workgroup another's credentials. `workgroupKey` is the spawn's (`workgroup_id`, else the group's own folder).
 */
export async function assertCredentialFolderInWorkgroup(
  group: { id: string; folder: string },
  credentialFolder: string | undefined,
  workgroupKey: string,
): Promise<void> {
  if (credentialFolder === undefined || credentialFolder === group.folder) return;
  const owner = (await getAllAgentGroups()).find((g) => g.folder === credentialFolder);
  if (owner && (owner.workgroup_id ?? owner.folder) === workgroupKey) return;
  throw new Error(
    `group ${group.id} has credentialFolder "${credentialFolder}", which is not the folder of a member of its ` +
      `workgroup ${workgroupKey}: refusing to hand it another workgroup's credentials. Set credentialFolder to a ` +
      "fellow member's folder or remove it.",
  );
}

/**
 * The stored row → access. A column that does not parse throws: only the host writes these columns, so a bad value
 * is corruption, and dropping it would silently strip every member's access.
 */
export function parseWorkgroupAccessRow(
  workgroupId: string,
  row: {
    onecli_secrets: string | null;
    tools: string | null;
    mcp_servers: string | null;
    exclude_mcp_servers: string | null;
    exclude_plugins: string | null;
  },
): WorkgroupAccess {
  const parse = (column: string, value: string | null, fallback: unknown): unknown => {
    if (value === null) return fallback;
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error(
        `workgroup ${workgroupId} ${column} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
  const stringList = (column: string, value: string | null): string[] => {
    const parsed = parse(column, value, []);
    if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
      throw new Error(`workgroup ${workgroupId} ${column} must be a JSON array of strings`);
    }
    return parsed;
  };
  const servers = parse('mcp_servers', row.mcp_servers, {});
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`workgroup ${workgroupId} mcp_servers must be a JSON object keyed by server name`);
  }
  const excludeMcpServers = stringList('exclude_mcp_servers', row.exclude_mcp_servers);
  for (const name of excludeMcpServers) validateMcpServerName(name);
  const excludePlugins = stringList('exclude_plugins', row.exclude_plugins);
  validateExcludePlugins(excludePlugins);
  return {
    onecliSecrets: stringList('onecli_secrets', row.onecli_secrets),
    tools: stringList('tools', row.tools),
    mcpServers: validateInheritedMcpServers(
      servers as Record<string, McpServerConfig>,
      `workgroup ${workgroupId} mcp_servers`,
    ),
    excludeMcpServers,
    excludePlugins,
  };
}

/** Takes the spawn-resolved workgroup id; an absent row grants nothing. */
export async function getWorkgroupAccessById(workgroupId: string): Promise<WorkgroupAccess> {
  const row = await getWorkgroupAccessRowById(workgroupId);
  return row ? parseWorkgroupAccessRow(row.id, row) : emptyWorkgroupAccess();
}

/** Through `agent_groups.workgroup_id`; a group with no workgroup inherits nothing. */
export async function getWorkgroupAccessForGroup(agentGroupId: string): Promise<WorkgroupAccess> {
  const row = await getWorkgroupAccessRowForGroup(agentGroupId);
  return row ? parseWorkgroupAccessRow(row.id, row) : emptyWorkgroupAccess();
}
