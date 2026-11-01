/**
 * SQLite storage of the notices (ports/notifications.ts), bound to one
 * company — built only by the company handle (adapters/sqlite/company-data.ts);
 * every statement is limited to `companyId` and the member it names.
 */
import type Database from 'better-sqlite3'
import type { NotificationRepository, NotificationRow } from '../../ports/notifications'

type Row = {
  id: string; user_id: string; kind: string; record_id: string; record_version: number; action: string
  actor_id: string | null; actor_kind: NotificationRow['actorKind']; dedupe_key: string | null; created_at: string; read_at: string | null
}
const toRow = (r: Row): NotificationRow => ({
  id: r.id, userId: r.user_id, kind: r.kind, recordId: r.record_id, recordVersion: r.record_version, action: r.action,
  actorId: r.actor_id, actorKind: r.actor_kind, dedupeKey: r.dedupe_key, createdAt: r.created_at, readAt: r.read_at,
})
const COLUMNS = 'id, user_id, kind, record_id, record_version, action, actor_id, actor_kind, dedupe_key, created_at, read_at'

export function sqliteNotificationRepository(conn: Database.Database, companyId: string): NotificationRepository {
  return {
    insert(rows) {
      const stmt = conn.prepare(
        `INSERT OR IGNORE INTO notifications (company_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const written: string[] = []
      conn.transaction(() => {
        for (const r of rows) {
          const run = stmt.run(companyId, r.id, r.userId, r.kind, r.recordId, r.recordVersion, r.action, r.actorId, r.actorKind, r.dedupeKey, r.createdAt, r.readAt)
          if (run.changes > 0) written.push(r.id)
        }
      })()
      return written
    },
    list(userId, limit) {
      const rows = conn.prepare(
        `SELECT ${COLUMNS} FROM notifications WHERE company_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).all(companyId, userId, limit) as Row[]
      return rows.map(toRow)
    },
    markRead(userId, ids, at) {
      if (ids === null) {
        return conn.prepare('UPDATE notifications SET read_at = ? WHERE company_id = ? AND user_id = ? AND read_at IS NULL').run(at, companyId, userId).changes
      }
      if (ids.length === 0) return 0
      return conn.prepare(
        'UPDATE notifications SET read_at = ? WHERE company_id = ? AND user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))',
      ).run(at, companyId, userId, JSON.stringify(ids)).changes
    },
    prune(userId, before) {
      conn.prepare('DELETE FROM notifications WHERE company_id = ? AND user_id = ? AND created_at < ?').run(companyId, userId, before)
    },
    settings(userId) {
      const r = conn.prepare('SELECT kinds FROM notification_settings WHERE company_id = ? AND user_id = ?').get(companyId, userId) as { kinds: string } | undefined
      return r ? r.kinds : null
    },
    setSettings(userId, kinds, at) {
      conn.prepare(
        `INSERT INTO notification_settings (company_id, user_id, kinds, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(company_id, user_id) DO UPDATE SET kinds = excluded.kinds, updated_at = excluded.updated_at`,
      ).run(companyId, userId, kinds, at)
    },
  }
}
