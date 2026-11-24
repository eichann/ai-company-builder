/**
 * SQLite storage of the plans of opened lines (ports/browser-lines.ts), bound to one company — built only by the company
 * handle (adapters/sqlite/company-data.ts), every statement limited to `companyId`. State changes are compare-and-set on
 * the current state (`changes === 1`).
 *
 * `sqliteBrowserLineExecutionLookup` is the control plane's lookup of a write execution's company by its secret's hash
 * (company-scoped-sql.test.ts lists it, as the old path's).
 */
import type Database from 'better-sqlite3'
import type {
  BrowserLineExecutionChange, BrowserLineExecutionLookup, BrowserLineExecutionRow, BrowserLineGrantRow, BrowserLinePlanChange,
  BrowserLinePlanRow, BrowserLineReportRow, BrowserLineRepository, BrowserShapeNoticeRow, BrowserStepChange, BrowserStepRow,
} from '../../ports/browser-lines'

const PLAN_COLUMNS = `id, user_id, shape, site, line_name, line_version, map_version, meaning_hash, mechanics_hash, writes, content, content_hash,
  state, close_reason, created_at, expires_at, approved_at, closed_at, conversation_id, result, reported_at`
type PlanDbRow = {
  id: string; user_id: string; shape: number; site: string; line_name: string; line_version: string; map_version: string; meaning_hash: string
  mechanics_hash: string; writes: number; content: string; content_hash: string; state: BrowserLinePlanRow['state']; close_reason: string | null
  created_at: string; expires_at: string; approved_at: string | null; closed_at: string | null; conversation_id: string | null
  result: string | null; reported_at: string | null
}
const toPlan = (r: PlanDbRow): BrowserLinePlanRow => ({
  id: r.id, userId: r.user_id, shape: r.shape, site: r.site, lineName: r.line_name, lineVersion: r.line_version, mapVersion: r.map_version,
  meaningHash: r.meaning_hash, mechanicsHash: r.mechanics_hash, writes: r.writes, content: r.content, contentHash: r.content_hash, state: r.state,
  closeReason: r.close_reason, createdAt: r.created_at, expiresAt: r.expires_at, approvedAt: r.approved_at, closedAt: r.closed_at,
  conversationId: r.conversation_id, result: r.result, reportedAt: r.reported_at,
})

const EXEC_COLUMNS = 'id, plan_id, user_id, secret_hash, state, void_reason, claimed_at, first_permitted_at, settled_at, confirmed_by'
type ExecDbRow = {
  id: string; plan_id: string; user_id: string; secret_hash: string; state: BrowserLineExecutionRow['state']; void_reason: string | null
  claimed_at: string; first_permitted_at: string | null; settled_at: string | null; confirmed_by: string | null
}
const toExec = (r: ExecDbRow): BrowserLineExecutionRow => ({
  id: r.id, planId: r.plan_id, userId: r.user_id, secretHash: r.secret_hash, state: r.state, voidReason: r.void_reason, claimedAt: r.claimed_at,
  firstPermittedAt: r.first_permitted_at, settledAt: r.settled_at, confirmedBy: r.confirmed_by,
})

const STEP_COLUMNS = 'execution_id, idx, write_kind, state, permitted_at, permitted_mono_ms, permitted_boot, settled_at, created_id, created_lock_key, confirmed_by'
type StepDbRow = {
  execution_id: string; idx: number; write_kind: BrowserStepRow['kind']; state: BrowserStepRow['state']; permitted_at: string | null
  permitted_mono_ms: number | null; permitted_boot: string | null; settled_at: string | null; created_id: string | null; created_lock_key: string | null
  confirmed_by: string | null
}
const toStep = (r: StepDbRow): BrowserStepRow => ({
  executionId: r.execution_id, index: r.idx, kind: r.write_kind, state: r.state, permittedAt: r.permitted_at, permittedMonoMs: r.permitted_mono_ms,
  permittedBoot: r.permitted_boot, settledAt: r.settled_at, createdId: r.created_id, createdLockKey: r.created_lock_key, confirmedBy: r.confirmed_by,
})

const PLAN_CHANGE: Record<keyof BrowserLinePlanChange, string> = {
  approvedAt: 'approved_at', closedAt: 'closed_at', closeReason: 'close_reason', result: 'result', reportedAt: 'reported_at',
}
const EXEC_CHANGE: Record<keyof BrowserLineExecutionChange, string> = {
  firstPermittedAt: 'first_permitted_at', settledAt: 'settled_at', voidReason: 'void_reason', confirmedBy: 'confirmed_by',
}
const STEP_CHANGE: Record<keyof BrowserStepChange, string> = {
  permittedAt: 'permitted_at', permittedMonoMs: 'permitted_mono_ms', permittedBoot: 'permitted_boot', settledAt: 'settled_at',
  createdId: 'created_id', createdLockKey: 'created_lock_key', confirmedBy: 'confirmed_by',
}

function sets<K extends string>(change: Partial<Record<K, string | number>>, columns: Record<K, string>): { sql: string; values: Array<string | number> } {
  const parts = ['state = ?']
  const values: Array<string | number> = []
  for (const [name, value] of Object.entries(change) as Array<[K, string | number | undefined]>) {
    if (value === undefined) continue
    const column = columns[name]
    if (!column) throw new Error(`browser lines: unknown column ${name}`)
    parts.push(`${column} = ?`)
    values.push(value)
  }
  return { sql: parts.join(', '), values }
}
const inList = (states: readonly string[]) => JSON.stringify(states)

type GrantDbRow = { user_id: string; site: string; line_name: string; meaning_hash: string; mechanics_hash: string; granted_by: string; granted_at: string }
const toGrant = (r: GrantDbRow): BrowserLineGrantRow => ({
  userId: r.user_id, site: r.site, lineName: r.line_name, meaningHash: r.meaning_hash, mechanicsHash: r.mechanics_hash, grantedBy: r.granted_by, grantedAt: r.granted_at,
})
const GRANT_COLUMNS = 'user_id, site, line_name, meaning_hash, mechanics_hash, granted_by, granted_at'

type NoticeDbRow = { site: string; map_version: string; thing: string; unknown_keys: number; missing_keys: number; unreadable: number; reports: number; first_at: string; last_at: string }
const toNotice = (r: NoticeDbRow): BrowserShapeNoticeRow => ({
  site: r.site, mapVersion: r.map_version, thing: r.thing, unknownKeys: r.unknown_keys, missingKeys: r.missing_keys, unreadable: r.unreadable,
  reports: r.reports, firstAt: r.first_at, lastAt: r.last_at,
})
const NOTICE_COLUMNS = 'site, map_version, thing, unknown_keys, missing_keys, unreadable, reports, first_at, last_at'

export function sqliteBrowserLineRepository(conn: Database.Database, companyId: string): BrowserLineRepository {
  return {
    insertPlan(p) {
      conn.prepare(`INSERT INTO browser_line_plans (company_id, ${PLAN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, p.id, p.userId, p.shape, p.site, p.lineName, p.lineVersion, p.mapVersion, p.meaningHash, p.mechanicsHash, p.writes, p.content,
          p.contentHash, p.state, p.closeReason, p.createdAt, p.expiresAt, p.approvedAt, p.closedAt, p.conversationId, p.result, p.reportedAt)
    },
    plan(planId) {
      const r = conn.prepare(`SELECT ${PLAN_COLUMNS} FROM browser_line_plans WHERE company_id = ? AND id = ?`).get(companyId, planId) as PlanDbRow | undefined
      return r ? toPlan(r) : null
    },
    plansOf(userId, states) {
      return (conn.prepare(`SELECT ${PLAN_COLUMNS} FROM browser_line_plans WHERE company_id = ? AND user_id = ? AND state IN (SELECT value FROM json_each(?)) ORDER BY created_at, id`)
        .all(companyId, userId, inList(states)) as PlanDbRow[]).map(toPlan)
    },
    setPlanState(planId, from, to, change) {
      const s = sets(change, PLAN_CHANGE)
      return conn.prepare(`UPDATE browser_line_plans SET ${s.sql} WHERE company_id = ? AND id = ? AND state = ?`).run(to, ...s.values, companyId, planId, from).changes === 1
    },

    insertExecution(e, steps) {
      conn.prepare(`INSERT INTO browser_line_executions (company_id, ${EXEC_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, e.id, e.planId, e.userId, e.secretHash, e.state, e.voidReason, e.claimedAt, e.firstPermittedAt, e.settledAt, e.confirmedBy)
      const insert = conn.prepare(`INSERT INTO browser_execution_steps (company_id, ${STEP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const s of steps) {
        insert.run(companyId, s.executionId, s.index, s.kind, s.state, s.permittedAt, s.permittedMonoMs, s.permittedBoot, s.settledAt, s.createdId, s.createdLockKey, s.confirmedBy)
      }
    },
    execution(executionId) {
      const r = conn.prepare(`SELECT ${EXEC_COLUMNS} FROM browser_line_executions WHERE company_id = ? AND id = ?`).get(companyId, executionId) as ExecDbRow | undefined
      return r ? toExec(r) : null
    },
    executionOfPlan(planId) {
      const r = conn.prepare(`SELECT ${EXEC_COLUMNS} FROM browser_line_executions WHERE company_id = ? AND plan_id = ?`).get(companyId, planId) as ExecDbRow | undefined
      return r ? toExec(r) : null
    },
    executionsOf(userId, states) {
      return (conn.prepare(`SELECT ${EXEC_COLUMNS} FROM browser_line_executions WHERE company_id = ? AND user_id = ? AND state IN (SELECT value FROM json_each(?)) ORDER BY claimed_at, id`)
        .all(companyId, userId, inList(states)) as ExecDbRow[]).map(toExec)
    },
    setExecutionState(executionId, from, to, change) {
      const s = sets(change, EXEC_CHANGE)
      return conn.prepare(`UPDATE browser_line_executions SET ${s.sql} WHERE company_id = ? AND id = ? AND state = ?`).run(to, ...s.values, companyId, executionId, from).changes === 1
    },

    steps(executionId) {
      return (conn.prepare(`SELECT ${STEP_COLUMNS} FROM browser_execution_steps WHERE company_id = ? AND execution_id = ? ORDER BY idx`)
        .all(companyId, executionId) as StepDbRow[]).map(toStep)
    },
    setStepState(executionId, index, from, to, change) {
      const s = sets(change, STEP_CHANGE)
      return conn.prepare(`UPDATE browser_execution_steps SET ${s.sql} WHERE company_id = ? AND execution_id = ? AND idx = ? AND state = ?`)
        .run(to, ...s.values, companyId, executionId, index, from).changes === 1
    },

    appendReport(r) {
      conn.prepare(`INSERT INTO browser_line_reports (company_id, id, execution_id, write_index, result, reason, created_id, outcome, state_before, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, r.id, r.executionId, r.index, r.result, r.reason, r.createdId, r.outcome, r.stateBefore, r.at)
    },
    reports(executionId) {
      return (conn.prepare(`SELECT id, execution_id, write_index, result, reason, created_id, outcome, state_before, at FROM browser_line_reports WHERE company_id = ? AND execution_id = ? ORDER BY at, rowid`)
        .all(companyId, executionId) as Array<{ id: string; execution_id: string; write_index: number; result: BrowserLineReportRow['result']; reason: string | null; created_id: string | null; outcome: BrowserLineReportRow['outcome']; state_before: BrowserLineReportRow['stateBefore']; at: string }>)
        .map(r => ({ id: r.id, executionId: r.execution_id, index: r.write_index, result: r.result, reason: r.reason, createdId: r.created_id, outcome: r.outcome, stateBefore: r.state_before, at: r.at }))
    },

    lockHolder(lockKey) {
      const r = conn.prepare('SELECT execution_id FROM browser_line_locks WHERE company_id = ? AND lock_key = ?').get(companyId, lockKey) as { execution_id: string } | undefined
      return r?.execution_id ?? null
    },
    takeLock(lockKey, executionId, at) {
      return conn.prepare('INSERT OR IGNORE INTO browser_line_locks (company_id, lock_key, execution_id, created_at) VALUES (?, ?, ?, ?)').run(companyId, lockKey, executionId, at).changes === 1
    },
    releaseLocksOf(executionId) {
      conn.prepare('DELETE FROM browser_line_locks WHERE company_id = ? AND execution_id = ?').run(companyId, executionId)
    },

    grants() {
      return (conn.prepare(`SELECT ${GRANT_COLUMNS} FROM browser_line_grants WHERE company_id = ? ORDER BY user_id, site, line_name, granted_at`).all(companyId) as GrantDbRow[]).map(toGrant)
    },
    grantsOf(userId, site, lineName) {
      return (conn.prepare(`SELECT ${GRANT_COLUMNS} FROM browser_line_grants WHERE company_id = ? AND user_id = ? AND site = ? AND line_name = ?`)
        .all(companyId, userId, site, lineName) as GrantDbRow[]).map(toGrant)
    },
    saveGrant(g) {
      conn.prepare(`INSERT OR REPLACE INTO browser_line_grants (company_id, ${GRANT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, g.userId, g.site, g.lineName, g.meaningHash, g.mechanicsHash, g.grantedBy, g.grantedAt)
    },
    removeLineGrantsOf(userId, site, lineName) {
      conn.prepare('DELETE FROM browser_line_grants WHERE company_id = ? AND user_id = ? AND site = ? AND line_name = ?').run(companyId, userId, site, lineName)
    },
    removeGrantsOf(userId) {
      conn.prepare('DELETE FROM browser_line_grants WHERE company_id = ? AND user_id = ?').run(companyId, userId)
    },

    shapeNotices() {
      return (conn.prepare(`SELECT ${NOTICE_COLUMNS} FROM browser_shape_notices WHERE company_id = ? ORDER BY last_at DESC, site, map_version, thing`).all(companyId) as NoticeDbRow[]).map(toNotice)
    },
    shapeNotice(site, mapVersion, thing) {
      const r = conn.prepare(`SELECT ${NOTICE_COLUMNS} FROM browser_shape_notices WHERE company_id = ? AND site = ? AND map_version = ? AND thing = ?`)
        .get(companyId, site, mapVersion, thing) as NoticeDbRow | undefined
      return r ? toNotice(r) : null
    },
    saveShapeNotice(n) {
      conn.prepare(`INSERT OR REPLACE INTO browser_shape_notices (company_id, ${NOTICE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, n.site, n.mapVersion, n.thing, n.unknownKeys, n.missingKeys, n.unreadable, n.reports, n.firstAt, n.lastAt)
    },
    countShapeReport(userId, site, day) {
      conn.prepare(`INSERT INTO browser_shape_report_counts (company_id, user_id, site, day, count) VALUES (?, ?, ?, ?, 1)
          ON CONFLICT (company_id, user_id, site, day) DO UPDATE SET count = count + 1`).run(companyId, userId, site, day)
      return (conn.prepare('SELECT count FROM browser_shape_report_counts WHERE company_id = ? AND user_id = ? AND site = ? AND day = ?').get(companyId, userId, site, day) as { count: number }).count
    },
    shapeReportsOn(site, day) {
      return (conn.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM browser_shape_report_counts WHERE company_id = ? AND site = ? AND day = ?').get(companyId, site, day) as { n: number }).n
    },
  }
}

export function sqliteBrowserLineExecutionLookup(conn: Database.Database): BrowserLineExecutionLookup {
  return {
    bySecretHash(secretHash) {
      const r = conn.prepare('SELECT company_id, id FROM browser_line_executions WHERE secret_hash = ?').get(secretHash) as { company_id: string; id: string } | undefined
      return r ? { companyId: r.company_id, executionId: r.id } : null
    },
  }
}
