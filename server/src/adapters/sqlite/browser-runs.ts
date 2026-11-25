/**
 * SQLite storage of the operator's runs of 「ブラウザ操作」 (ports/browser-runs.ts), bound to one company — built only by the
 * company handle (adapters/sqlite/company-data.ts), every statement limited to `companyId`. State changes are
 * compare-and-set on `running` (`changes === 1`); the lock is the partial unique index on a running row per domain.
 */
import type Database from 'better-sqlite3'
import type { BrowserRunLogRow, BrowserRunRepository, BrowserRunRow } from '../../ports/browser-runs'
import type { BrowserRunWriteStep } from '../../../shared/core/browser-run-log'

const COLUMNS = 'id, user_id, host, device_id, conversation_id, state, reason, started_at, lease_until, ended_at, budget, steps'
type DbRow = {
  id: string; user_id: string; host: string; device_id: string | null; conversation_id: string | null; state: BrowserRunRow['state']
  reason: string | null; started_at: string; lease_until: string; ended_at: string | null; budget: BrowserRunRow['budget']; steps: number
}
const toRow = (r: DbRow): BrowserRunRow => ({
  id: r.id, userId: r.user_id, host: r.host, deviceId: r.device_id, conversationId: r.conversation_id, state: r.state,
  reason: r.reason, startedAt: r.started_at, leaseUntil: r.lease_until, endedAt: r.ended_at, budget: r.budget, steps: r.steps,
})

export function sqliteBrowserRunRepository(conn: Database.Database, companyId: string): BrowserRunRepository {
  return {
    insert(row) {
      try {
        conn.prepare(`INSERT INTO browser_runs (company_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          companyId, row.id, row.userId, row.host, row.deviceId, row.conversationId, row.state, row.reason, row.startedAt, row.leaseUntil, row.endedAt, row.budget, row.steps,
        )
        return true
      } catch (error) {
        // The lock: one running row per company × domain (idx_browser_runs_lock).
        if (error instanceof Error && /UNIQUE constraint failed: browser_runs\.company_id, browser_runs\.host/.test(error.message)) return false
        throw error
      }
    },
    byId(id) {
      const r = conn.prepare(`SELECT ${COLUMNS} FROM browser_runs WHERE company_id = ? AND id = ?`).get(companyId, id) as DbRow | undefined
      return r ? toRow(r) : null
    },
    runningOn(host) {
      const r = conn.prepare(`SELECT ${COLUMNS} FROM browser_runs WHERE company_id = ? AND host = ? AND state = 'running'`).get(companyId, host) as DbRow | undefined
      return r ? toRow(r) : null
    },
    renew(id, leaseUntil, maxSteps) {
      return conn.prepare("UPDATE browser_runs SET lease_until = ?, steps = steps + 1 WHERE company_id = ? AND id = ? AND state = 'running' AND steps < ?")
        .run(leaseUntil, companyId, id, maxSteps).changes === 1
    },
    end(id, state, reason, at) {
      return conn.prepare("UPDATE browser_runs SET state = ?, reason = ?, ended_at = ? WHERE company_id = ? AND id = ? AND state = 'running'")
        .run(state, reason, at, companyId, id).changes === 1
    },
    runningOf(userId) {
      return (conn.prepare("SELECT id FROM browser_runs WHERE company_id = ? AND user_id = ? AND state = 'running' ORDER BY rowid").all(companyId, userId) as Array<{ id: string }>).map(r => r.id)
    },
    markLogWritten(id) {
      return conn.prepare('UPDATE browser_runs SET log_written = 1 WHERE company_id = ? AND id = ? AND log_written = 0').run(companyId, id).changes === 1
    },
    appendLog(rows: readonly BrowserRunLogRow[]) {
      const insert = conn.prepare('INSERT INTO browser_run_log (company_id, run_id, idx, page, action, label) VALUES (?, ?, ?, ?, ?, ?)')
      for (const r of rows) insert.run(companyId, r.runId, r.idx, r.page, r.action, r.label)
    },
    logOf(runIds) {
      if (runIds.length === 0) return []
      const marks = runIds.map(() => '?').join(', ')
      return (conn.prepare(`SELECT run_id, idx, page, action, label FROM browser_run_log WHERE company_id = ? AND run_id IN (${marks}) ORDER BY run_id, idx`)
        .all(companyId, ...runIds) as Array<{ run_id: string; idx: number; page: string; action: BrowserRunLogRow['action']; label: string | null }>)
        .map(r => ({ runId: r.run_id, idx: r.idx, page: r.page, action: r.action, label: r.label }))
    },
    appendWrites(runId, rows) {
      const insert = conn.prepare('INSERT INTO browser_run_writes (company_id, run_id, idx, after_step, frame, method, page, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      rows.forEach((w, i) => insert.run(companyId, runId, i + 1, w.after, w.frame, w.method, w.page, w.outcome))
    },
    writesOf(runIds) {
      if (runIds.length === 0) return []
      const marks = runIds.map(() => '?').join(', ')
      return (conn.prepare(`SELECT run_id, after_step, frame, method, page, outcome FROM browser_run_writes WHERE company_id = ? AND run_id IN (${marks}) ORDER BY run_id, idx`)
        .all(companyId, ...runIds) as Array<{ run_id: string; after_step: number; frame: number | null; method: BrowserRunWriteStep['method']; page: string; outcome: BrowserRunWriteStep['outcome'] }>)
        .map(r => ({ runId: r.run_id, after: r.after_step, frame: r.frame, method: r.method, page: r.page, outcome: r.outcome }))
    },
    list(limit, userId) {
      const rows = userId === undefined
        ? conn.prepare(`SELECT ${COLUMNS} FROM browser_runs WHERE company_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(companyId, limit)
        : conn.prepare(`SELECT ${COLUMNS} FROM browser_runs WHERE company_id = ? AND user_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(companyId, userId, limit)
      return (rows as DbRow[]).map(toRow)
    },
  }
}
