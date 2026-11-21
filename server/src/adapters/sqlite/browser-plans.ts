/**
 * SQLite storage of 「ブラウザ操作」 plans (ports/browser-plans.ts), bound to one company — built only
 * by the company handle (adapters/sqlite/company-data.ts), every statement limited to `companyId`.
 * State changes are compare-and-set on the current state (`changes === 1`).
 *
 * `sqliteBrowserExecutionLookup` is the control plane's one lookup: an execution's company by its
 * secret's hash (company-scoped-sql.test.ts lists it, as a key-broker token's).
 */
import type Database from 'better-sqlite3'
import type {
  BrowserExecutionChange, BrowserExecutionLookup, BrowserExecutionRow, BrowserPlanChange, BrowserPlanRepository, BrowserPlanRow,
  BrowserReportRow, BrowserTypeGrantRow,
} from '../../ports/browser-plans'

const PLAN_COLUMNS = `id, user_id, connector_id, connector_version, operation, declaration_hash, checker_hash, facts_version, account, content, content_hash,
  state, close_reason, created_at, expires_at, approved_at, closed_at`
type PlanDbRow = {
  id: string; user_id: string; connector_id: string; connector_version: string; operation: string; declaration_hash: string; checker_hash: string
  facts_version: number; account: string; content: string; content_hash: string; state: BrowserPlanRow['state']; close_reason: string | null
  created_at: string; expires_at: string; approved_at: string | null; closed_at: string | null
}
const toPlan = (r: PlanDbRow): BrowserPlanRow => ({
  id: r.id, userId: r.user_id, connectorId: r.connector_id, connectorVersion: r.connector_version, operation: r.operation,
  declarationHash: r.declaration_hash, checkerHash: r.checker_hash, factsVersion: r.facts_version, account: r.account, content: r.content,
  contentHash: r.content_hash, state: r.state, closeReason: r.close_reason, createdAt: r.created_at, expiresAt: r.expires_at,
  approvedAt: r.approved_at, closedAt: r.closed_at,
})

const EXEC_COLUMNS = 'id, plan_id, user_id, secret_hash, lock_key, state, void_reason, claimed_at, permitted_at, settled_at, confirmed_by'
type ExecDbRow = {
  id: string; plan_id: string; user_id: string; secret_hash: string; lock_key: string; state: BrowserExecutionRow['state']; void_reason: string | null
  claimed_at: string; permitted_at: string | null; settled_at: string | null; confirmed_by: string | null
}
const toExec = (r: ExecDbRow): BrowserExecutionRow => ({
  id: r.id, planId: r.plan_id, userId: r.user_id, secretHash: r.secret_hash, lockKey: r.lock_key, state: r.state, voidReason: r.void_reason,
  claimedAt: r.claimed_at, permittedAt: r.permitted_at, settledAt: r.settled_at, confirmedBy: r.confirmed_by,
})

const PLAN_CHANGE: Record<keyof BrowserPlanChange, string> = { approvedAt: 'approved_at', closedAt: 'closed_at', closeReason: 'close_reason' }
const EXEC_CHANGE: Record<keyof BrowserExecutionChange, string> = {
  permittedAt: 'permitted_at', settledAt: 'settled_at', voidReason: 'void_reason', confirmedBy: 'confirmed_by',
}

function sets<K extends string>(change: Partial<Record<K, string>>, columns: Record<K, string>): { sql: string; values: string[] } {
  const parts = ['state = ?']
  const values: string[] = []
  for (const [name, value] of Object.entries(change) as Array<[K, string | undefined]>) {
    if (value === undefined) continue
    const column = columns[name]
    if (!column) throw new Error(`browser plans: unknown column ${name}`)
    parts.push(`${column} = ?`)
    values.push(value)
  }
  return { sql: parts.join(', '), values }
}

export function sqliteBrowserPlanRepository(conn: Database.Database, companyId: string): BrowserPlanRepository {
  return {
    insertPlan(p) {
      conn.prepare(`INSERT INTO browser_plans (company_id, ${PLAN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, p.id, p.userId, p.connectorId, p.connectorVersion, p.operation, p.declarationHash, p.checkerHash, p.factsVersion, p.account,
          p.content, p.contentHash, p.state, p.closeReason, p.createdAt, p.expiresAt, p.approvedAt, p.closedAt)
    },
    plan(planId) {
      const r = conn.prepare(`SELECT ${PLAN_COLUMNS} FROM browser_plans WHERE company_id = ? AND id = ?`).get(companyId, planId) as PlanDbRow | undefined
      return r ? toPlan(r) : null
    },
    openPlansOf(userId) {
      return (conn.prepare(`SELECT ${PLAN_COLUMNS} FROM browser_plans WHERE company_id = ? AND user_id = ? AND state IN ('draft', 'approved') ORDER BY created_at, id`)
        .all(companyId, userId) as PlanDbRow[]).map(toPlan)
    },
    setPlanState(planId, from, to, change) {
      const s = sets(change, PLAN_CHANGE)
      return conn.prepare(`UPDATE browser_plans SET ${s.sql} WHERE company_id = ? AND id = ? AND state = ?`)
        .run(to, ...s.values, companyId, planId, from).changes === 1
    },

    insertExecution(e) {
      conn.prepare(`INSERT INTO browser_executions (company_id, ${EXEC_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, e.id, e.planId, e.userId, e.secretHash, e.lockKey, e.state, e.voidReason, e.claimedAt, e.permittedAt, e.settledAt, e.confirmedBy)
    },
    execution(executionId) {
      const r = conn.prepare(`SELECT ${EXEC_COLUMNS} FROM browser_executions WHERE company_id = ? AND id = ?`).get(companyId, executionId) as ExecDbRow | undefined
      return r ? toExec(r) : null
    },
    executionOfPlan(planId) {
      const r = conn.prepare(`SELECT ${EXEC_COLUMNS} FROM browser_executions WHERE company_id = ? AND plan_id = ?`).get(companyId, planId) as ExecDbRow | undefined
      return r ? toExec(r) : null
    },
    executionsIn(states, userId, page) {
      const where = ['state IN (SELECT value FROM json_each(?))']
      const values: unknown[] = [companyId, JSON.stringify(states)]
      if (userId !== undefined) { where.push('user_id = ?'); values.push(userId) }
      if (page?.after !== undefined) {
        where.push('(claimed_at, id) > (SELECT claimed_at, id FROM browser_executions WHERE company_id = ? AND id = ?)')
        values.push(companyId, page.after)
      }
      const limit = page ? ' LIMIT ?' : ''
      if (page) values.push(page.limit)
      return (conn.prepare(`SELECT ${EXEC_COLUMNS} FROM browser_executions WHERE company_id = ? AND ${where.join(' AND ')} ORDER BY claimed_at, id${limit}`)
        .all(...values) as ExecDbRow[]).map(toExec)
    },
    setExecutionState(executionId, from, to, change) {
      const s = sets(change, EXEC_CHANGE)
      return conn.prepare(`UPDATE browser_executions SET ${s.sql} WHERE company_id = ? AND id = ? AND state = ?`)
        .run(to, ...s.values, companyId, executionId, from).changes === 1
    },

    appendReport(r) {
      conn.prepare(`INSERT INTO browser_execution_reports (company_id, id, execution_id, result, reason, outcome, state_before, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, r.id, r.executionId, r.result, r.reason, r.outcome, r.stateBefore, r.at)
    },
    reports(executionId) {
      return (conn.prepare(`SELECT id, execution_id, result, reason, outcome, state_before, at FROM browser_execution_reports WHERE company_id = ? AND execution_id = ? ORDER BY at, rowid`)
        .all(companyId, executionId) as Array<{ id: string; execution_id: string; result: BrowserReportRow['result']; reason: string | null; outcome: BrowserReportRow['outcome']; state_before: BrowserReportRow['stateBefore']; at: string }>)
        .map(r => ({ id: r.id, executionId: r.execution_id, result: r.result, reason: r.reason, outcome: r.outcome, stateBefore: r.state_before, at: r.at }))
    },

    lockHolder(lockKey) {
      const r = conn.prepare('SELECT execution_id FROM browser_target_locks WHERE company_id = ? AND lock_key = ?').get(companyId, lockKey) as { execution_id: string } | undefined
      return r?.execution_id ?? null
    },
    takeLock(lockKey, executionId, at) {
      return conn.prepare('INSERT OR IGNORE INTO browser_target_locks (company_id, lock_key, execution_id, created_at) VALUES (?, ?, ?, ?)')
        .run(companyId, lockKey, executionId, at).changes === 1
    },
    releaseLock(lockKey, executionId) {
      conn.prepare('DELETE FROM browser_target_locks WHERE company_id = ? AND lock_key = ? AND execution_id = ?').run(companyId, lockKey, executionId)
    },

    grants() {
      return (conn.prepare('SELECT user_id, connector_id, operation, declaration_hash, granted_by, granted_at FROM browser_type_grants WHERE company_id = ? ORDER BY user_id, connector_id, operation, granted_at')
        .all(companyId) as GrantDbRow[]).map(toGrant)
    },
    grant(userId, connectorId, operation, declarationHash) {
      const r = conn.prepare(`SELECT user_id, connector_id, operation, declaration_hash, granted_by, granted_at FROM browser_type_grants
          WHERE company_id = ? AND user_id = ? AND connector_id = ? AND operation = ? AND declaration_hash = ?`)
        .get(companyId, userId, connectorId, operation, declarationHash) as GrantDbRow | undefined
      return r ? toGrant(r) : null
    },
    saveGrant(g) {
      conn.prepare(`INSERT OR REPLACE INTO browser_type_grants (company_id, user_id, connector_id, operation, declaration_hash, granted_by, granted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(companyId, g.userId, g.connectorId, g.operation, g.declarationHash, g.grantedBy, g.grantedAt)
    },
    removeGrant(userId, connectorId, operation, declarationHash) {
      conn.prepare('DELETE FROM browser_type_grants WHERE company_id = ? AND user_id = ? AND connector_id = ? AND operation = ? AND declaration_hash = ?')
        .run(companyId, userId, connectorId, operation, declarationHash)
    },
    removeGrantsOf(userId) {
      conn.prepare('DELETE FROM browser_type_grants WHERE company_id = ? AND user_id = ?').run(companyId, userId)
    },
  }
}

type GrantDbRow = { user_id: string; connector_id: string; operation: string; declaration_hash: string; granted_by: string; granted_at: string }
const toGrant = (r: GrantDbRow): BrowserTypeGrantRow => ({
  userId: r.user_id, connectorId: r.connector_id, operation: r.operation, declarationHash: r.declaration_hash, grantedBy: r.granted_by, grantedAt: r.granted_at,
})

export function sqliteBrowserExecutionLookup(conn: Database.Database): BrowserExecutionLookup {
  return {
    bySecretHash(secretHash) {
      const r = conn.prepare('SELECT company_id, id FROM browser_executions WHERE secret_hash = ?').get(secretHash) as { company_id: string; id: string } | undefined
      return r ? { companyId: r.company_id, executionId: r.id } : null
    },
  }
}
