import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-wiring engagement allowlist (JSON array of `users.id`), for alert bots that never @-mention. Engagement only,
 * never admission. NULL by default, so a trunk update alone engages no new message.
 */
export const migration088: Migration = {
  version: 88,
  name: 'wiring-engage-senders',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('engage_senders')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN engage_senders TEXT`);
    }
  },
};
