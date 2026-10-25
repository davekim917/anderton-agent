import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * One row per open live preview, so a host restart that adopts the container serving it keeps the link working. The
 * in-memory registry in `modules/preview/service.ts` stays the read path; these rows are read only at boot. `id` is
 * the preview's bearer credential.
 */
export const migration089: Migration = {
  version: 89,
  name: 'previews',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS previews (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        container_name TEXT NOT NULL,
        port           INTEGER NOT NULL,
        label          TEXT,
        expires_at     TEXT NOT NULL
      );
    `);
  },
};
