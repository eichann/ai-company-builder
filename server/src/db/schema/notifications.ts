/**
 * Notices and each member's notice kinds (notifications.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
import type Database from 'better-sqlite3'

export const notificationSchema = `
    -- Notices (知らせ, stage 2 S5, .claude/rules/notifications.md), behind the
    -- company handle (ports/notifications.ts): per company × member, no text
    -- (built when read), the read state shared by the member's PCs.
    CREATE TABLE IF NOT EXISTS notifications (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_version INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT,
      actor_kind TEXT CHECK (actor_kind IS NULL OR actor_kind IN ('human', 'ai', 'external')),
      dedupe_key TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT,
      PRIMARY KEY (company_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(company_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications(company_id, user_id, created_at);

    -- A member's notice kinds turned on / off (JSON object kind → boolean).
    CREATE TABLE IF NOT EXISTS notification_settings (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      kinds TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id)
    );
`

/**
 * A notice a delegate gets for an absent member, or a stop told to a department
 * manager (records.md "Absence and the delegate"): the absent member's id.
 * Additive and nullable.
 */
export function migrateNotificationsForUser(conn: Database.Database): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(notifications)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('for_user_id')) conn.exec(`ALTER TABLE notifications ADD COLUMN for_user_id TEXT`)
}
