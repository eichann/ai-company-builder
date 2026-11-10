/**
 * The run tables from before runs got a subject kind (B "separating AI runs from records";
 * tests/fixtures/app-schema-before-run-subjects.sql, frozen as production had them) and the upgrade
 * of B PR 2 (db/schema/ai-runs.ts `migrateAiRunSubjects`, owner decision D2 = option A: add a column,
 * never rebuild). Guards:
 * - upgrading that database loses not one run or idempotency key and keeps `ai_run_operations`'
 *   `ON DELETE CASCADE` foreign key (a rebuild or drop of `ai_runs` would delete every key that stops
 *   a second send); running the migrations again changes nothing;
 * - today's migrations make exactly the frozen tables plus PR 2's additions (the subject kind, the
 *   unused grant fingerprint, the new open-run index beside the kept old one, `ai_run_events`), the
 *   same on a new database as on an upgraded one;
 * - an older build still works on the upgraded database: its insert (no subject kind) is a record's
 *   run, and one open run per record and step still holds;
 * - the new index alone keeps one open run per (subject, step), and the lookups keep kinds apart
 *   (what still holds once the kept old index is dropped).
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'

const BEFORE = readFileSync(new URL('../fixtures/app-schema-before-run-subjects.sql', import.meta.url), 'utf8')
const TS = '2026-11-10T00:00:00.000Z'

/** The run tables' definitions, indexes, triggers and columns, and the run columns other tables carry. */
function runSchema(conn: Database.Database) {
  const objects = conn.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE tbl_name IN ('ai_runs', 'ai_run_operations', 'ai_run_events') ORDER BY type, name`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  const columns = (table: string) => conn.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid`).all(table) as Array<{ name: string }>
  const runColumns = (table: string, names: string[]) => columns(table).filter(c => names.includes(c.name))
  const keys = (table: string) => conn.prepare('SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(table)
  return {
    objects,
    aiRuns: columns('ai_runs'),
    operations: columns('ai_run_operations'),
    events: columns('ai_run_events'),
    operationKeys: keys('ai_run_operations'),
    eventKeys: keys('ai_run_events'),
    tokens: runColumns('record_ai_tokens', ['run_id', 'run_generation']),
    ledger: runColumns('record_ledger', ['run_id', 'procedure']),
    pluginOperations: runColumns('plugin_operations', ['run_id']),
  }
}

function frozen(): Database.Database {
  const conn = new Database(':memory:')
  conn.exec(BEFORE)
  conn.pragma('foreign_keys = ON')
  return conn
}

/** Runs and keys as an older server left them: one waiting for reconciliation with a key of unknown result. */
function withRuns(conn: Database.Database) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('co-a', 'A', 'a', 'u', TS, TS)
  const run = conn.prepare(`INSERT INTO ai_runs (company_id, id, record_id, step, user_id, state, generation, device_id, conversation_id,
    claim_expires_at, attempts, created_at, updated_at, closed_at, procedure) VALUES (?, ?, ?, ?, 'u-alice', ?, ?, NULL, 'conv', NULL, 0, ?, ?, ?, ?)`)
  run.run('co-a', 'run-open', 'task-0001', 'task-wait-over', 'waiting_reconcile', 2, TS, TS, null, '{"step":"task-wait-over","app":null,"plugins":[]}')
  run.run('co-a', 'run-done', 'meeting-0001', 'minutes-reading', 'done', 1, TS, TS, TS, null)
  const op = conn.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, ref_kind, ref_id,
    status, reconciled_by, created_at, updated_at) VALUES ('co-a', ?, ?, 'fp', 'record-create', ?, 1, NULL, NULL, NULL, NULL, ?, ?)`)
  op.run('run-open', 'k-unknown', 'unknown', TS, TS)
  op.run('run-open', 'k-done', 'done', TS, TS)
  op.run('run-done', 'k-done', 'done', TS, TS)
}

const rows = (conn: Database.Database) => ({
  runs: conn.prepare('SELECT * FROM ai_runs ORDER BY id').all() as Array<Record<string, unknown>>,
  operations: conn.prepare('SELECT * FROM ai_run_operations ORDER BY run_id, key').all(),
})

describe('upgrading the run tables to subjects (B PR 2, option A)', () => {
  it('loses not one run or idempotency key, keeps the cascading foreign key, and a second run changes nothing', () => {
    const conn = frozen()
    withRuns(conn)
    const before = runSchema(conn)
    const rowsBefore = rows(conn)

    initDatabase(conn)
    const once = { schema: runSchema(conn), rows: rows(conn) }
    initDatabase(conn)
    expect(runSchema(conn)).toEqual(once.schema)
    expect(rows(conn)).toEqual(once.rows)

    // Every run, as it was, now a record's; every key, unchanged.
    expect(once.rows.runs).toEqual(rowsBefore.runs.map(r => ({ ...r, subject_kind: 'record', grant_fingerprint: null })))
    expect(once.rows.operations).toEqual(rowsBefore.operations)
    expect(once.rows.operations).toHaveLength(3)
    // The keys still belong to their runs, deleted with them (not orphaned, not lost by a rebuild).
    expect(once.schema.operationKeys).toEqual(before.operationKeys)
    expect(once.schema.operationKeys).toContainEqual(expect.objectContaining({ table: 'ai_runs', from: 'run_id', on_delete: 'CASCADE' }))
    expect(conn.prepare('SELECT * FROM pragma_foreign_key_check(?)').all('ai_run_operations')).toEqual([])
  })

  it('today\'s migrations make exactly the frozen tables plus PR 2\'s additions, on a new database as on an upgraded one', () => {
    const fresh = new Database(':memory:')
    initDatabase(fresh)
    const upgraded = frozen()
    const before = runSchema(upgraded)
    initDatabase(upgraded)
    const now = runSchema(fresh)
    expect(runSchema(upgraded)).toEqual(now)

    // ai_runs: the same columns, then the two added at the end (an older build's inserts keep working).
    expect(now.aiRuns.slice(0, before.aiRuns.length)).toEqual(before.aiRuns)
    expect(now.aiRuns.slice(before.aiRuns.length)).toEqual([
      { name: 'subject_kind', type: 'TEXT', notnull: 1, dflt_value: "'record'", pk: 0 },
      { name: 'grant_fingerprint', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    ])
    expect(now.operations).toEqual(before.operations)
    expect(now.tokens).toEqual(before.tokens)
    expect(now.ledger).toEqual(before.ledger)
    expect(now.pluginOperations).toEqual(before.pluginOperations)
    // Every object there was is there unchanged (the old open-run index kept), and the new ones beside it.
    // (ai_runs' own text gains the added columns: SQLite rewrites it on ALTER TABLE; its columns are compared above.)
    for (const o of before.objects) if (o.name !== 'ai_runs') expect(now.objects).toContainEqual(o)
    expect(now.objects.find(o => o.name === 'ai_runs')?.sql).toContain("subject_kind TEXT NOT NULL DEFAULT 'record'")
    expect(now.objects.filter(o => !before.objects.some(b => b.name === o.name)).map(o => o.name).sort())
      .toEqual(['ai_run_events', 'idx_ai_runs_open_subject', 'sqlite_autoindex_ai_run_events_1'])
    expect(now.eventKeys).toContainEqual(expect.objectContaining({ table: 'ai_runs', from: 'run_id', on_delete: 'CASCADE' }))
    expect(now.events.map(c => c.name)).toEqual(['company_id', 'run_id', 'seq', 'at', 'event', 'generation', 'state_after', 'code'])
  })

  it('an older build on the upgraded database: its run is a record\'s, and one open run per record and step still holds', () => {
    const conn = frozen()
    withRuns(conn)
    initDatabase(conn)
    // The statement of the build before PR 2 (no subject kind).
    const oldInsert = conn.prepare(`INSERT INTO ai_runs (company_id, id, record_id, step, user_id, state, generation, device_id, conversation_id,
      claim_expires_at, failure_class, failure_code, retry_at, attempts, plugin_version, steps_version, procedure, created_at, updated_at, closed_at)
      VALUES ('co-a', ?, ?, 'minutes-reading', 'u-alice', 'running', 1, 'dev-1', 'conv', ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, ?, NULL)`)
    oldInsert.run('run-old-build', 'meeting-0002', TS, TS, TS)
    expect(conn.prepare('SELECT subject_kind FROM ai_runs WHERE id = ?').get('run-old-build')).toEqual({ subject_kind: 'record' })
    expect(() => oldInsert.run('run-old-build-2', 'meeting-0002', TS, TS, TS)).toThrow(/UNIQUE/)
    // The older build's own lookup of an open run still finds exactly it.
    expect(conn.prepare(`SELECT id FROM ai_runs WHERE company_id = 'co-a' AND record_id = ? AND step = 'minutes-reading' AND closed_at IS NULL`).all('meeting-0002'))
      .toEqual([{ id: 'run-old-build' }])
  })
})

describe('one open run per subject and step, by the new index alone', () => {
  it('without the old index (a later PR may drop it): kinds are kept apart, and a second open run of one subject and step is refused', () => {
    const conn = new Database(':memory:')
    initDatabase(conn)
    conn.exec('DROP INDEX idx_ai_runs_open')
    conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('co-a', 'A', 'a', 'u', TS, TS)
    const runs = sqliteCompanyData(conn).forCompany('co-a').aiRuns
    const row = (id: string, kind: 'record' | 'occurrence') => ({
      id, subject: { kind, id: 'task-0001' }, step: 'task-prep', userId: 'u-alice', state: 'running' as const, generation: 1, deviceId: 'dev-1',
      conversationId: 'conv', claimExpiresAt: null, failureClass: null, failureCode: null, retryAt: null, attempts: 0, pluginVersion: null,
      stepsVersion: null, procedure: null, createdAt: TS, updatedAt: TS, closedAt: null,
    })
    runs.insert(row('run-record', 'record'))
    runs.insert(row('run-occurrence', 'occurrence'))
    expect(runs.openRun({ kind: 'record', id: 'task-0001' }, 'task-prep')?.id).toBe('run-record')
    expect(runs.openRun({ kind: 'occurrence', id: 'task-0001' }, 'task-prep')?.id).toBe('run-occurrence')
    expect(() => runs.insert(row('run-record-2', 'record'))).toThrow(/UNIQUE/)
  })
})
