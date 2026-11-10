/**
 * The run tables as the server leaves them before runs get a subject kind (B "separating AI runs
 * from records"; tests/fixtures/app-schema-before-run-subjects.sql, frozen). PR 1 changes no
 * schema: today's migrations produce exactly the frozen run tables, and starting a server on a
 * database at that schema keeps every run and every idempotency key — `ai_run_operations` is
 * deleted with its run (`ON DELETE CASCADE`), so a migration that rebuilt or dropped `ai_runs`
 * would lose the keys that stop a second send. A later change to these tables (PR 2's
 * `subject_kind`) changes this test on purpose, against the frozen copy.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'

const BEFORE = readFileSync(new URL('../fixtures/app-schema-before-run-subjects.sql', import.meta.url), 'utf8')
const TS = '2026-11-10T00:00:00.000Z'

/** The run tables' definitions, indexes, triggers and columns, and the run columns other tables carry. */
function runSchema(conn: Database.Database) {
  const objects = conn.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name IN ('ai_runs', 'ai_run_operations') ORDER BY type, name`).all()
  const columns = (table: string) => conn.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`).all(table)
  const runColumns = (table: string, names: string[]) => (columns(table) as Array<{ name: string }>).filter(c => names.includes(c.name))
  return {
    objects,
    aiRuns: columns('ai_runs'),
    operations: columns('ai_run_operations'),
    operationKeys: conn.prepare('SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq').all('ai_run_operations'),
    tokens: runColumns('record_ai_tokens', ['run_id', 'run_generation']),
    ledger: runColumns('record_ledger', ['run_id', 'procedure']),
    pluginOperations: runColumns('plugin_operations', ['run_id']),
  }
}

function frozen(): Database.Database {
  const conn = new Database(':memory:')
  conn.exec(BEFORE)
  return conn
}

describe('the run tables before run subjects', () => {
  it('today\'s migrations make exactly the frozen run tables', () => {
    const fresh = new Database(':memory:')
    initDatabase(fresh)
    const before = runSchema(frozen())
    expect(before.objects.length).toBeGreaterThan(0)
    expect(runSchema(fresh)).toEqual(before)
  })

  it('a server started on that database keeps its runs, their keys and the schema', () => {
    const conn = frozen()
    conn.pragma('foreign_keys = ON')
    conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('co-a', 'A', 'a', 'u', TS, TS)
    const run = conn.prepare(`INSERT INTO ai_runs (company_id, id, record_id, step, user_id, state, generation, device_id, conversation_id,
      claim_expires_at, attempts, created_at, updated_at, closed_at, procedure) VALUES (?, ?, ?, ?, 'u-alice', ?, ?, NULL, 'conv', NULL, 0, ?, ?, ?, NULL)`)
    run.run('co-a', 'run-open', 'task-0001', 'task-wait-over', 'waiting_reconcile', 2, TS, TS, null)
    run.run('co-a', 'run-done', 'meeting-0001', 'minutes-reading', 'done', 1, TS, TS, TS)
    const op = conn.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, ref_kind, ref_id,
      status, reconciled_by, created_at, updated_at) VALUES ('co-a', ?, ?, 'fp', 'record-create', ?, 1, NULL, NULL, NULL, NULL, ?, ?)`)
    op.run('run-open', 'k-unknown', 'unknown', TS, TS)
    op.run('run-open', 'k-done', 'done', TS, TS)
    op.run('run-done', 'k-done', 'done', TS, TS)
    const rows = () => ({
      runs: conn.prepare('SELECT * FROM ai_runs ORDER BY id').all(),
      operations: conn.prepare('SELECT * FROM ai_run_operations ORDER BY run_id, key').all(),
    })
    const schemaBefore = runSchema(conn)
    const rowsBefore = rows()

    initDatabase(conn)
    initDatabase(conn)

    expect(runSchema(conn)).toEqual(schemaBefore)
    expect(rows()).toEqual(rowsBefore)
    expect(rows().operations).toHaveLength(3)
  })
})
