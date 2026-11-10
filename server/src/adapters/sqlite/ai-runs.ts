/**
 * SQLite storage of execution runs (ports/ai-runs.ts), bound to one company —
 * built only by the company handle (adapters/sqlite/company-data.ts), every
 * statement limited to `companyId`. The unique index on open runs
 * (db/schema/ai-runs.ts) keeps one open run per subject and step.
 *
 * A run's subject (B PR 2, option A: a column added, the table never rebuilt) is stored as
 * `subject_kind` + `record_id`: the column keeps its old name and holds the subject's id for every
 * kind. Only this module knows that; the port speaks `subject: { kind, id }`.
 */
import type Database from 'better-sqlite3'
import type { AiRunEventRow, AiRunOperationRow, AiRunRepository, AiRunRow } from '../../ports/ai-runs'
import type { RunSubjectKind } from '../../ports/run-subjects'

const RUN_COLUMNS = `id, subject_kind, record_id, step, user_id, state, generation, device_id, conversation_id, claim_expires_at, failure_class, failure_code,
  retry_at, attempts, plugin_version, steps_version, procedure, created_at, updated_at, closed_at`
type RunDbRow = {
  id: string; subject_kind: string; record_id: string; step: string; user_id: string; state: AiRunRow['state']; generation: number; device_id: string | null
  conversation_id: string | null; claim_expires_at: string | null; failure_class: AiRunRow['failureClass']; failure_code: string | null
  retry_at: string | null; attempts: number; plugin_version: string | null; steps_version: string | null; procedure: string | null; created_at: string; updated_at: string
  closed_at: string | null
}
const toRun = (r: RunDbRow): AiRunRow => ({
  // A kind this build does not know is passed on as stored: every record-only path asks `kind === 'record'`.
  id: r.id, subject: { kind: r.subject_kind as RunSubjectKind, id: r.record_id }, step: r.step, userId: r.user_id, state: r.state, generation: r.generation, deviceId: r.device_id,
  conversationId: r.conversation_id, claimExpiresAt: r.claim_expires_at, failureClass: r.failure_class, failureCode: r.failure_code,
  retryAt: r.retry_at, attempts: r.attempts, pluginVersion: r.plugin_version, stepsVersion: r.steps_version, procedure: r.procedure, createdAt: r.created_at,
  updatedAt: r.updated_at, closedAt: r.closed_at,
})
const runValues = (r: AiRunRow) => [r.subject.kind, r.subject.id, r.step, r.userId, r.state, r.generation, r.deviceId, r.conversationId, r.claimExpiresAt,
  r.failureClass, r.failureCode, r.retryAt, r.attempts, r.pluginVersion, r.stepsVersion, r.procedure, r.createdAt, r.updatedAt, r.closedAt]

const OP_COLUMNS = 'run_id, key, fingerprint, kind, state, generation, ref_kind, ref_id, status, reconciled_by, created_at, updated_at'
type OpDbRow = {
  run_id: string; key: string; fingerprint: string; kind: string; state: AiRunOperationRow['state']; generation: number
  ref_kind: string | null; ref_id: string | null; status: number | null; reconciled_by: string | null; created_at: string; updated_at: string
}
const toOp = (r: OpDbRow): AiRunOperationRow => ({
  runId: r.run_id, key: r.key, fingerprint: r.fingerprint, kind: r.kind, state: r.state, generation: r.generation, refKind: r.ref_kind,
  refId: r.ref_id, status: r.status, reconciledBy: r.reconciled_by, createdAt: r.created_at, updatedAt: r.updated_at,
})
const OP_CHANGE_COLUMNS: Record<string, string> = {
  state: 'state', refKind: 'ref_kind', refId: 'ref_id', status: 'status', reconciledBy: 'reconciled_by', generation: 'generation', fingerprint: 'fingerprint',
}

export function sqliteAiRunRepository(conn: Database.Database, companyId: string): AiRunRepository {
  return {
    byId(runId) {
      const r = conn.prepare(`SELECT ${RUN_COLUMNS} FROM ai_runs WHERE company_id = ? AND id = ?`).get(companyId, runId) as RunDbRow | undefined
      return r ? toRun(r) : null
    },
    openRun(subject, step) {
      const r = conn.prepare(`SELECT ${RUN_COLUMNS} FROM ai_runs WHERE company_id = ? AND subject_kind = ? AND record_id = ? AND step = ? AND closed_at IS NULL`)
        .get(companyId, subject.kind, subject.id, step) as RunDbRow | undefined
      return r ? toRun(r) : null
    },
    liveOtherStep(subject, step, nowIso) {
      return conn.prepare(`SELECT 1 FROM ai_runs WHERE company_id = ? AND subject_kind = ? AND record_id = ? AND step <> ? AND closed_at IS NULL
          AND state = 'running' AND claim_expires_at > ? LIMIT 1`)
        .get(companyId, subject.kind, subject.id, step, nowIso) !== undefined
    },
    openOf(userId) {
      return (conn.prepare(`SELECT ${RUN_COLUMNS} FROM ai_runs WHERE company_id = ? AND user_id = ? AND closed_at IS NULL ORDER BY created_at DESC, id LIMIT 500`)
        .all(companyId, userId) as RunDbRow[]).map(toRun)
    },
    insert(row) {
      conn.prepare(`INSERT INTO ai_runs (company_id, ${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, row.id, ...runValues(row))
    },
    update(row, expected) {
      return conn.prepare(`UPDATE ai_runs SET subject_kind = ?, record_id = ?, step = ?, user_id = ?, state = ?, generation = ?, device_id = ?, conversation_id = ?,
          claim_expires_at = ?, failure_class = ?, failure_code = ?, retry_at = ?, attempts = ?, plugin_version = ?, steps_version = ?, procedure = ?, created_at = ?,
          updated_at = ?, closed_at = ?
        WHERE company_id = ? AND id = ? AND generation = ? AND state = ?`)
        .run(...runValues(row), companyId, row.id, expected.generation, expected.state).changes === 1
    },

    operation(runId, key) {
      const r = conn.prepare(`SELECT ${OP_COLUMNS} FROM ai_run_operations WHERE company_id = ? AND run_id = ? AND key = ?`)
        .get(companyId, runId, key) as OpDbRow | undefined
      return r ? toOp(r) : null
    },
    operations(runId) {
      return (conn.prepare(`SELECT ${OP_COLUMNS} FROM ai_run_operations WHERE company_id = ? AND run_id = ? ORDER BY created_at, key`)
        .all(companyId, runId) as OpDbRow[]).map(toOp)
    },
    insertOperation(o) {
      return conn.prepare(`INSERT OR IGNORE INTO ai_run_operations (company_id, ${OP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, o.runId, o.key, o.fingerprint, o.kind, o.state, o.generation, o.refKind, o.refId, o.status, o.reconciledBy, o.createdAt, o.updatedAt)
        .changes === 1
    },
    updateOperation(runId, key, from, change, at) {
      const sets: string[] = []
      const values: unknown[] = []
      for (const [name, value] of Object.entries(change)) {
        const column = OP_CHANGE_COLUMNS[name]
        if (!column) throw new Error(`ai_run_operations: unknown column ${name}`)
        sets.push(`${column} = ?`)
        values.push(value)
      }
      return conn.prepare(`UPDATE ai_run_operations SET ${[...sets, 'updated_at = ?'].join(', ')}
        WHERE company_id = ? AND run_id = ? AND key = ? AND state IN (SELECT value FROM json_each(?))`)
        .run(...values, at, companyId, runId, key, JSON.stringify(from)).changes === 1
    },
    deleteOperation(runId, key, state) {
      return conn.prepare('DELETE FROM ai_run_operations WHERE company_id = ? AND run_id = ? AND key = ? AND state = ?').run(companyId, runId, key, state).changes === 1
    },

    appendEvent(e) {
      conn.prepare(`INSERT INTO ai_run_events (company_id, run_id, seq, at, event, generation, state_after, code)
          VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ai_run_events WHERE company_id = ? AND run_id = ?), ?, ?, ?, ?, ?)`)
        .run(companyId, e.runId, companyId, e.runId, e.at, e.event, e.generation, e.stateAfter, e.code)
    },
    lastEvent(runId) {
      const r = conn.prepare(`SELECT run_id, event, generation, state_after, code, at FROM ai_run_events WHERE company_id = ? AND run_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(companyId, runId) as { run_id: string; event: AiRunEventRow['event']; generation: number; state_after: AiRunEventRow['stateAfter']; code: string | null; at: string } | undefined
      return r ? { runId: r.run_id, event: r.event, generation: r.generation, stateAfter: r.state_after, code: r.code, at: r.at } : null
    },
  }
}
