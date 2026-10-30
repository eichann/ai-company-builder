/** SQLite storage of the emergency stop (ports/agent-stops.ts). */
import type Database from 'better-sqlite3'
import type { AgentStopClientRow, AgentStopRepository, StoredAgentStop } from '../../ports/agent-stops'

type Row = {
  id: string; user_id: string | null; tool: string | null; reason: string
  stopped_at: string; stopped_by: string; released_at: string | null; released_by: string | null
}
const COLUMNS = 'id, user_id, tool, reason, stopped_at, stopped_by, released_at, released_by'
const toStop = (r: Row): StoredAgentStop => ({
  id: r.id, userId: r.user_id, tool: r.tool, reason: r.reason,
  stoppedAt: r.stopped_at, stoppedBy: r.stopped_by, releasedAt: r.released_at, releasedBy: r.released_by,
})

export function sqliteAgentStopRepository(conn: Database.Database): AgentStopRepository {
  return {
    active(companyId) {
      return (conn.prepare(`SELECT ${COLUMNS} FROM agent_stops WHERE company_id = ? AND released_at IS NULL ORDER BY stopped_at DESC, rowid DESC`)
        .all(companyId) as Row[]).map(toStop)
    },
    activeFor(companyId, userId) {
      return (conn.prepare(`SELECT ${COLUMNS} FROM agent_stops WHERE company_id = ? AND released_at IS NULL AND (user_id IS NULL OR user_id = ?) ORDER BY stopped_at DESC, rowid DESC`)
        .all(companyId, userId) as Row[]).map(toStop)
    },
    history(companyId, limit) {
      return (conn.prepare(`SELECT ${COLUMNS} FROM agent_stops WHERE company_id = ? ORDER BY COALESCE(released_at, stopped_at) DESC, rowid DESC LIMIT ?`)
        .all(companyId, limit) as Row[]).map(toStop)
    },
    find(companyId, stopId) {
      const r = conn.prepare(`SELECT ${COLUMNS} FROM agent_stops WHERE company_id = ? AND id = ?`).get(companyId, stopId) as Row | undefined
      return r ? toStop(r) : null
    },
    insert(companyId, stop) {
      conn.prepare('INSERT INTO agent_stops (id, company_id, user_id, tool, reason, stopped_at, stopped_by, released_at, released_by) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)')
        .run(stop.id, companyId, stop.userId, stop.tool, stop.reason, stop.stoppedAt, stop.stoppedBy)
    },
    release(companyId, stopId, at, by) {
      conn.prepare('UPDATE agent_stops SET released_at = ?, released_by = ? WHERE company_id = ? AND id = ? AND released_at IS NULL').run(at, by, companyId, stopId)
    },
    seen(companyId, userId, clientVersion, at) {
      conn.prepare(`
        INSERT INTO agent_stop_clients (company_id, user_id, client_version, last_seen_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id, user_id) DO UPDATE SET client_version = excluded.client_version, last_seen_at = excluded.last_seen_at
      `).run(companyId, userId, clientVersion, at)
    },
    clients(companyId) {
      const rows = conn.prepare('SELECT user_id, client_version, last_seen_at FROM agent_stop_clients WHERE company_id = ?')
        .all(companyId) as Array<{ user_id: string; client_version: string | null; last_seen_at: string }>
      return new Map(rows.map(r => [r.user_id, { userId: r.user_id, clientVersion: r.client_version, lastSeenAt: r.last_seen_at } satisfies AgentStopClientRow]))
    },
  }
}
