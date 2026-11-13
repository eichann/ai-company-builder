/**
 * The scheduled jobs' tables (B PR 3a, db/schema/jobs.ts) on the frozen database from before them
 * (tests/fixtures/app-schema-before-jobs.sql, origin/main d973d9bf). Guards (each mutation-checked):
 * - additive: upgrading changes no object that was there (every table, index and trigger the same
 *   text) and only adds the four job tables with their indexes and triggers; a second run changes
 *   nothing; a new database gets exactly the same;
 * - one occurrence per job and due slot; an occurrence id must have its own shape (never a record id's),
 *   and so must a job id;
 * - a version's definition is never rewritten, and approved / accepted are set once.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'

const BEFORE = readFileSync(new URL('../fixtures/app-schema-before-jobs.sql', import.meta.url), 'utf8')
const TS = '2026-11-11T00:00:00.000Z'
const JOB = `job.${'1'.repeat(32)}`
const NEW_TABLES = ['ai_jobs', 'ai_job_versions', 'ai_job_occurrences', 'ai_job_settings']
/** Tables later builds add (each its own additive `CREATE TABLE IF NOT EXISTS`): expected beside the job tables. */
const LATER_TABLES = [
  // google-drive.md "Picker and its token": the one-time pick tickets.
  'google_drive_pick_tickets',
  // google-drive.md "Continuing a document people edited": what the AI read, and an overwrite waiting for the member's press.
  'google_drive_doc_reads',
  'google_drive_overwrite_confirmations',
  'google_drive_folder_trust',
]
/**
 * Columns later builds add to a table that was there before (each an idempotent `ALTER TABLE … ADD COLUMN`, so
 * the table's text grows by exactly that): taken out before comparing, and nothing else may differ.
 */
const LATER_COLUMNS: Record<string, string[]> = {
  // google-drive.md "Overwriting": the file a put gave a new revision; "A Google document's own changes": its baseline.
  google_drive_puts: ['updated_file_id TEXT', 'doc_fingerprint TEXT', 'doc_revision TEXT', 'doc_revision_at TEXT', 'doc_baseline_at TEXT'],
}

const objects = (conn: Database.Database) => (conn.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>)
  .map(o => (o.type === 'table' && o.sql && LATER_COLUMNS[o.name] ? { ...o, sql: LATER_COLUMNS[o.name].reduce((s, col) => s.replace(`, ${col}`, ''), o.sql) } : o))

function frozen(): Database.Database {
  const conn = new Database(':memory:')
  conn.exec(BEFORE)
  conn.pragma('foreign_keys = ON')
  return conn
}

function withJob(conn: Database.Database) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('co-a', 'A', 'a', 'u', TS, TS)
  conn.prepare(`INSERT INTO ai_jobs (company_id, id, name, state, acting_user_id, latest_version, created_by, created_at, updated_at)
    VALUES ('co-a', ?, '仕事', 'draft', 'u', 1, 'u', ?, ?)`).run(JOB, TS, TS)
  conn.prepare(`INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at)
    VALUES ('co-a', ?, 1, 1, '{}', 'f', 'c', 'u', 'u', ?)`).run(JOB, TS)
}
const occurrence = (conn: Database.Database, id: string, slot: string) => conn.prepare(`INSERT INTO ai_job_occurrences
  (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at)
  VALUES ('co-a', ?, ?, 1, ?, 'Asia/Tokyo', ?, ?, 'due', ?, ?)`).run(id, JOB, slot, TS, TS, TS, TS)

describe('the job tables are additive', () => {
  it('upgrading keeps every object there was, adds only the job tables, and a second run changes nothing', () => {
    const conn = frozen()
    const before = objects(conn)
    initDatabase(conn)
    const once = objects(conn)
    initDatabase(conn)
    expect(objects(conn)).toEqual(once)
    for (const o of before) expect(once, o.name).toContainEqual(o)
    const added = once.filter(o => !before.some(b => b.name === o.name))
    expect([...new Set(added.map(o => o.tbl_name))].sort()).toEqual([...NEW_TABLES, ...LATER_TABLES].sort())
    // A new database: the same objects.
    const fresh = new Database(':memory:')
    initDatabase(fresh)
    expect(objects(fresh)).toEqual(once)
  })
})

describe('what the tables hold', () => {
  it('one occurrence per job and due slot; ids keep their own shapes', () => {
    const conn = frozen()
    initDatabase(conn)
    withJob(conn)
    occurrence(conn, `occ.${'a'.repeat(32)}`, '2026-11-16T09:00')
    expect(() => occurrence(conn, `occ.${'b'.repeat(32)}`, '2026-11-16T09:00')).toThrow(/UNIQUE/)
    // A record id's shape, or an occurrence id with a dash or upper case, is not an occurrence id.
    for (const bad of ['task-0123456789abcdef', `occ-${'c'.repeat(32)}`, `occ.${'C'.repeat(32)}`, `occ.${'c'.repeat(31)}`]) {
      expect(() => occurrence(conn, bad, `2026-11-2${bad.length % 10}T09:00`), bad).toThrow(/CHECK/)
    }
    expect(() => conn.prepare(`INSERT INTO ai_jobs (company_id, id, name, state, acting_user_id, latest_version, created_by, created_at, updated_at)
      VALUES ('co-a', 'task-0123456789abcdef', 'x', 'draft', 'u', 1, 'u', ?, ?)`).run(TS, TS)).toThrow(/CHECK/)
  })

  it('a version is never rewritten; approved and accepted are set once', () => {
    const conn = frozen()
    initDatabase(conn)
    withJob(conn)
    const v = "WHERE company_id = 'co-a' AND version = 1"
    expect(() => conn.exec(`UPDATE ai_job_versions SET definition = '{"x":1}' ${v}`)).toThrow(/never rewritten/)
    expect(() => conn.exec(`UPDATE ai_job_versions SET fingerprint = 'g' ${v}`)).toThrow(/never rewritten/)
    expect(() => conn.exec(`UPDATE ai_job_versions SET acting_user_id = 'other' ${v}`)).toThrow(/never rewritten/)
    conn.exec(`UPDATE ai_job_versions SET approved_by = 'u', approved_at = '${TS}' ${v}`)
    expect(() => conn.exec(`UPDATE ai_job_versions SET approved_by = 'v', approved_at = '${TS}' ${v}`)).toThrow(/approved once/)
    conn.exec(`UPDATE ai_job_versions SET accepted_by = 'u', accepted_at = '${TS}' ${v}`)
    expect(() => conn.exec(`UPDATE ai_job_versions SET accepted_by = 'v' ${v}`)).toThrow(/accepted once/)
  })
})
