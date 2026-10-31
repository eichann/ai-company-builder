import type Database from 'better-sqlite3'
import { generateId, now } from '../../db'
import type { PushRejectionQuery, PushRejectionRepository, PushRejectionRow } from '../../ports/push-rejections'

type Row = { id: string; user_id: string; marker: string; paths: string; created_at: string }

function toPushRejectionRow(r: Row): PushRejectionRow {
  let paths: string[] = []
  try {
    const parsed: unknown = JSON.parse(r.paths)
    if (Array.isArray(parsed)) paths = parsed.filter((p): p is string => typeof p === 'string')
  } catch {
    // Malformed row: show the rejection without paths.
  }
  return { id: r.id, userId: r.user_id, marker: r.marker, paths, createdAt: r.created_at }
}

/**
 * Table push_rejections. Rows are written by services/push-rejections.ts after
 * git-http hands back a rejected push (off the request).
 */
export function sqlitePushRejectionRepository(conn: Database.Database): PushRejectionRepository {
  function query(companyId: string, q: PushRejectionQuery = {}): { rows: PushRejectionRow[]; total: number } {
    const where = ['company_id = ?']
    const params: unknown[] = [companyId]
    if (q.userId) { where.push('user_id = ?'); params.push(q.userId) }
    if (q.marker) { where.push('marker = ?'); params.push(q.marker) }
    const total = (conn.prepare(`SELECT COUNT(*) AS n FROM push_rejections WHERE ${where.join(' AND ')}`).get(...params) as { n: number }).n
    const rows = conn.prepare(`
      SELECT id, user_id, marker, paths, created_at FROM push_rejections
      WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?
    `).all(...params, q.limit ?? 20, q.offset ?? 0) as Row[]
    return { rows: rows.map(toPushRejectionRow), total }
  }

  return {
    query,
    recent: (companyId, limit) => query(companyId, { limit }).rows,
    markers: companyId => (conn.prepare(`SELECT DISTINCT marker FROM push_rejections WHERE company_id = ? ORDER BY marker`)
      .all(companyId) as Array<{ marker: string }>).map(r => r.marker),

    record(companyId, userId, rejections) {
      const ts = now()
      const insert = conn.prepare(`
        INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `)
      conn.transaction(() => {
        for (const r of rejections) insert.run(generateId(), companyId, userId, r.marker, JSON.stringify(r.paths), ts)
      })()
    },
  }
}
