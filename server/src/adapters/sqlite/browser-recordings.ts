/**
 * SQLite storage of 「ブラウザ操作」 recordings (ports/browser-recordings.ts), bound to one company — built only by the
 * company handle (adapters/sqlite/company-data.ts), every statement limited to `companyId`.
 */
import type Database from 'better-sqlite3'
import type { BrowserRecordingHead, BrowserRecordingRepository } from '../../ports/browser-recordings'

type DbRow = { id: string; user_id: string; domain: string; lines: number; content: string; created_at: string; delete_at: string }
const HEAD = 'id, user_id, domain, lines, created_at, delete_at'
const toHead = (r: Omit<DbRow, 'content'>): BrowserRecordingHead => ({
  id: r.id, userId: r.user_id, domain: r.domain, lines: r.lines, createdAt: r.created_at, deleteAt: r.delete_at,
})

export function sqliteBrowserRecordingRepository(conn: Database.Database, companyId: string): BrowserRecordingRepository {
  return {
    insert(row) {
      conn.prepare('INSERT INTO browser_recordings (company_id, id, user_id, domain, lines, content, created_at, delete_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(companyId, row.id, row.userId, row.domain, row.lines, row.content, row.createdAt, row.deleteAt)
    },
    byId(id, now) {
      const r = conn.prepare(`SELECT ${HEAD}, content FROM browser_recordings WHERE company_id = ? AND id = ? AND delete_at > ?`).get(companyId, id, now) as DbRow | undefined
      return r ? { ...toHead(r), content: r.content } : null
    },
    list(now, limit, only) {
      const rows = only
        ? conn.prepare(`SELECT ${HEAD} FROM browser_recordings WHERE company_id = ? AND delete_at > ? AND user_id = ? AND created_at >= ?
            ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(companyId, now, only.userId, only.since, limit)
        : conn.prepare(`SELECT ${HEAD} FROM browser_recordings WHERE company_id = ? AND delete_at > ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
          .all(companyId, now, limit)
      return (rows as Array<Omit<DbRow, 'content'>>).map(toHead)
    },
    delete(id) {
      return conn.prepare('DELETE FROM browser_recordings WHERE company_id = ? AND id = ?').run(companyId, id).changes === 1
    },
    deleteExpired(now) {
      return conn.prepare('DELETE FROM browser_recordings WHERE company_id = ? AND delete_at <= ?').run(companyId, now).changes
    },
  }
}
