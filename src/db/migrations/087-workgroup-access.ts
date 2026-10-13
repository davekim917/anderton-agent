import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Workgroup-level access beside `onecli_secrets`: `tools` (JSON array, the same vocabulary as container.json
 * `tools`), `mcp_servers` (JSON object keyed by server name), and the opt-outs `exclude_mcp_servers` /
 * `exclude_plugins` (JSON arrays, the container.json `excludeMcpServers` / `excludePlugins` vocabulary). Every member
 * unions them with its own declarations at spawn (`src/workgroup-access.ts`). Empty defaults, no backfill: a trunk
 * update alone changes no member's access.
 */
export const migration087: Migration = {
  version: 87,
  name: 'workgroup-access',
  up(db: Database.Database) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(workgroups)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has('tools')) {
      db.exec(`ALTER TABLE workgroups ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!columns.has('mcp_servers')) {
      db.exec(`ALTER TABLE workgroups ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '{}'`);
    }
    if (!columns.has('exclude_mcp_servers')) {
      db.exec(`ALTER TABLE workgroups ADD COLUMN exclude_mcp_servers TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!columns.has('exclude_plugins')) {
      db.exec(`ALTER TABLE workgroups ADD COLUMN exclude_plugins TEXT NOT NULL DEFAULT '[]'`);
    }
  },
};
