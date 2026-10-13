/**
 * The `workgroups` access columns (`onecli_secrets`, `tools`, `mcp_servers`, `exclude_mcp_servers`,
 * `exclude_plugins`): raw reads and single-statement edits.
 * `src/workgroup-access.ts` parses what these read. The secret appender, `addWorkgroupOnecliSecret`, is in
 * `agent-groups.ts`.
 */
import { getDb } from './connection.js';

export interface WorkgroupAccessRow {
  id: string;
  onecli_secrets: string | null;
  tools: string | null;
  mcp_servers: string | null;
  exclude_mcp_servers: string | null;
  exclude_plugins: string | null;
}

const WORKGROUP_ACCESS_COLUMNS =
  'w.id, w.onecli_secrets, w.tools, w.mcp_servers, w.exclude_mcp_servers, w.exclude_plugins';

export async function getWorkgroupAccessRowById(workgroupId: string): Promise<WorkgroupAccessRow | undefined> {
  return getDb().get<WorkgroupAccessRow>(
    `SELECT ${WORKGROUP_ACCESS_COLUMNS} FROM workgroups w WHERE w.id = ?`,
    workgroupId,
  );
}

export async function getWorkgroupAccessRowForGroup(agentGroupId: string): Promise<WorkgroupAccessRow | undefined> {
  return getDb().get<WorkgroupAccessRow>(
    `SELECT ${WORKGROUP_ACCESS_COLUMNS} FROM workgroups w JOIN agent_groups a ON a.workgroup_id = w.id WHERE a.id = ?`,
    agentGroupId,
  );
}

export async function getAllWorkgroupAccessRows(): Promise<WorkgroupAccessRow[]> {
  return getDb().all<WorkgroupAccessRow>(`SELECT ${WORKGROUP_ACCESS_COLUMNS} FROM workgroups w ORDER BY w.id`);
}

type WorkgroupListColumn = 'tools' | 'onecli_secrets' | 'exclude_mcp_servers' | 'exclude_plugins';

/** One statement, so concurrent grants cannot drop each other's append. True when added. */
async function addToWorkgroupList(workgroupId: string, column: WorkgroupListColumn, value: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE workgroups
        SET ${column} = json_insert(COALESCE(${column}, '[]'), '$[#]', ?)
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(workgroups.${column}, '[]')) WHERE value = ?)`,
    value,
    workgroupId,
    value,
  );
  return result.changes > 0;
}

/** One statement; the rest of the list keeps its order. True when removed. */
async function removeFromWorkgroupList(
  workgroupId: string,
  column: WorkgroupListColumn,
  value: string,
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE workgroups
        SET ${column} = (SELECT json_group_array(e.value) FROM json_each(COALESCE(workgroups.${column}, '[]')) e
                          WHERE e.value != ?)
      WHERE id = ?
        AND EXISTS (SELECT 1 FROM json_each(COALESCE(workgroups.${column}, '[]')) WHERE value = ?)`,
    value,
    workgroupId,
    value,
  );
  return result.changes > 0;
}

export async function addWorkgroupTool(workgroupId: string, tool: string): Promise<boolean> {
  return addToWorkgroupList(workgroupId, 'tools', tool);
}

export async function removeWorkgroupTool(workgroupId: string, tool: string): Promise<boolean> {
  return removeFromWorkgroupList(workgroupId, 'tools', tool);
}

export type WorkgroupExclusionColumn = 'exclude_mcp_servers' | 'exclude_plugins';

export async function addWorkgroupExclusion(
  workgroupId: string,
  column: WorkgroupExclusionColumn,
  entry: string,
): Promise<boolean> {
  return addToWorkgroupList(workgroupId, column, entry);
}

export async function removeWorkgroupExclusion(
  workgroupId: string,
  column: WorkgroupExclusionColumn,
  entry: string,
): Promise<boolean> {
  return removeFromWorkgroupList(workgroupId, column, entry);
}

export async function removeWorkgroupOnecliSecret(workgroupId: string, secretName: string): Promise<boolean> {
  return removeFromWorkgroupList(workgroupId, 'onecli_secrets', secretName);
}

/** JSON path for a server name; names are charset-validated before they get here, the quoting covers `-`. */
function serverPath(name: string): string {
  return `$."${name}"`;
}

/**
 * `replace: false` adds only when the name is absent (an existing entry is left as it is). True when the row
 * changed.
 */
export async function putWorkgroupMcpServer(
  workgroupId: string,
  name: string,
  entry: unknown,
  options: { replace: boolean },
): Promise<boolean> {
  const fn = options.replace ? 'json_set' : 'json_insert';
  const result = await getDb().run(
    `UPDATE workgroups SET mcp_servers = ${fn}(COALESCE(mcp_servers, '{}'), ?, json(?))
      WHERE id = ?
        AND ${options.replace ? '1' : `json_extract(COALESCE(mcp_servers, '{}'), ?) IS NULL`}`,
    ...(options.replace
      ? [serverPath(name), JSON.stringify(entry), workgroupId]
      : [serverPath(name), JSON.stringify(entry), workgroupId, serverPath(name)]),
  );
  return result.changes > 0;
}

export async function removeWorkgroupMcpServer(workgroupId: string, name: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE workgroups SET mcp_servers = json_remove(COALESCE(mcp_servers, '{}'), ?)
      WHERE id = ? AND json_extract(COALESCE(mcp_servers, '{}'), ?) IS NOT NULL`,
    serverPath(name),
    workgroupId,
    serverPath(name),
  );
  return result.changes > 0;
}
