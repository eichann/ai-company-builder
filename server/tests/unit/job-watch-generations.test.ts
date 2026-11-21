/**
 * Watch generations' startup migration (stage 4b-0.5, owner memo 「段4b 設計メモ」 第4版 §5-3 corrected by Codex's 4th review
 * #1; db/schema/jobs.ts `migrateJobWatchGenerations`) on the frozen database from before it
 * (tests/fixtures/app-schema-before-watch-generations.sql, 4b-0), holding what 4a may have written.
 *
 * Guards (each mutation-checked): additive and idempotent (two columns, nothing else; a second start changes nothing,
 * also no second notice); an occurrence gets the watch's generation only when its provenance is certain — the watch
 * fired, its chain is not stopped, and it is the job's one occurrence of the watched record, still waiting or running —
 * never inferred from which pending one is newest (F8); everything else stays isolated; a watch that fired, is not
 * stopped and has no occurrence of its own is stopped once and its responsible person told once (F9) — never its
 * creator, never a retired job, a responsible person who left is not told; a chain already stopped is left as it is.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'

const BEFORE = readFileSync(new URL('../fixtures/app-schema-before-watch-generations.sql', import.meta.url), 'utf8')
const TS = '2026-11-20T00:00:00.000Z'
const CO = 'co-g'

const objects = (conn: Database.Database) => conn.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all() as Array<{ name: string; sql: string | null }>

function frozen(): Database.Database {
  const conn = new Database(':memory:')
  conn.exec(BEFORE)
  conn.pragma('foreign_keys = ON')
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, 'G', 'g', 'u-owner', TS, TS)
  for (const [user, role] of [['u-owner', 'owner'], ['u-alice', 'member']]) {
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${user}`, user, CO, role, TS, TS)
  }
  return conn
}

let n = 0
const hex = () => (++n).toString(16).padStart(32, '0')
/** A 4a event job (schema 2) approved for `acting`, with its cursor watching `watch`. */
function eventJob(conn: Database.Database, opts: { watch: string; fired: boolean; stop?: string | null; acting?: string; state?: string; schema?: number }): string {
  const job = `job.${hex()}`
  const definition = JSON.stringify({ schema: opts.schema ?? 2, name: '次のやること', actingUser: opts.acting ?? 'u-alice', trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: opts.watch, followMadeTask: true } })
  conn.prepare(`INSERT INTO ai_jobs (company_id, id, name, state, acting_user_id, latest_version, approved_version, approved_fingerprint, accepted_version, accepted_consent, created_by, created_at, updated_at)
    VALUES (?, ?, '次のやること', ?, ?, 1, 1, 'f', 1, 'c', 'u-owner', ?, ?)`).run(CO, job, opts.state ?? 'active', opts.acting ?? 'u-alice', TS, TS)
  conn.prepare(`INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at, approved_by, approved_at)
    VALUES (?, ?, 1, ?, ?, 'f', 'c', ?, 'u-owner', ?, 'u-owner', ?)`).run(CO, job, opts.schema ?? 2, definition, opts.acting ?? 'u-alice', TS, TS)
  conn.prepare(`INSERT INTO ai_job_event_cursors (company_id, job_id, seen_seq, watch_record_id, watch_start, watch_fired, chain_stop_code, chain_stop_record, chain_stop_at, updated_at)
    VALUES (?, ?, 10, ?, ?, ?, ?, ?, ?, ?)`).run(CO, job, opts.watch, opts.watch, opts.fired ? 1 : 0, opts.stop ?? null, opts.stop ? opts.watch : null, opts.stop ? TS : null, TS)
  return job
}
function eventOccurrence(conn: Database.Database, job: string, record: string, state: string, seq: number): string {
  const id = `occ.${hex()}`
  conn.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at, event_seq, event_record_id, event_version, event_day)
    VALUES (?, ?, ?, 1, ?, 'Asia/Tokyo', ?, ?, ?, ?, ?, ?, ?, 1, '2026-11-20')`).run(CO, id, job, `ev:${seq}`, TS, TS, state, TS, TS, seq, record)
  return id
}
const genOf = (conn: Database.Database, occ: string) => (conn.prepare('SELECT watch_generation AS g FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, occ) as { g: number | null }).g
const cursorOf = (conn: Database.Database, job: string) => conn.prepare('SELECT watch_generation AS g, chain_stop_code AS stop, chain_stop_record AS record FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?').get(CO, job) as { g: number | null; stop: string | null; record: string | null }
const told = (conn: Database.Database, job: string) => (conn.prepare("SELECT user_id FROM notifications WHERE company_id = ? AND kind = 'job_chain_stopped' AND dedupe_key LIKE ?").all(CO, `job_chain_stopped:${job}:%`) as Array<{ user_id: string }>).map(r => r.user_id)

describe('watch generations are additive', () => {
  it('upgrading adds the two columns and nothing else; a second start changes nothing; a new database gets the same', () => {
    const conn = frozen()
    const before = objects(conn)
    initDatabase(conn)
    const once = objects(conn)
    initDatabase(conn)
    expect(objects(conn)).toEqual(once)
    const changed = once.filter(o => !before.some(b => b.name === o.name && b.sql === o.sql))
    expect(changed.map(o => o.name).sort()).toEqual(['ai_job_event_cursors', 'ai_job_occurrences'])
    for (const o of changed) {
      const was = before.find(b => b.name === o.name)?.sql as string
      expect(o.sql).toContain(', watch_generation INTEGER')
      expect(o.sql?.replace(', watch_generation INTEGER', '')).toBe(was)
    }
    const fresh = new Database(':memory:')
    initDatabase(fresh)
    expect(objects(fresh)).toEqual(once)
  })
})

describe('an occurrence gets its watch’s generation only when its provenance is certain (F8)', () => {
  it('the job’s one occurrence of the watched record, waiting or running, of a watch that fired and goes on', () => {
    const conn = frozen()
    const waiting = eventJob(conn, { watch: 'task-a', fired: true })
    const occ = eventOccurrence(conn, waiting, 'task-a', 'due', 1)
    const running = eventJob(conn, { watch: 'task-b', fired: true })
    const run = eventOccurrence(conn, running, 'task-b', 'running', 2)
    // An occurrence of a record the job watched before: isolated whatever its state.
    const earlier = eventOccurrence(conn, running, 'task-old', 'due', 3)
    initDatabase(conn)
    expect(genOf(conn, occ)).toBe(1)
    expect(genOf(conn, run)).toBe(1)
    expect(genOf(conn, earlier)).toBeNull()
    for (const job of [waiting, running]) {
      expect(cursorOf(conn, job)).toEqual({ g: 1, stop: null, record: null })
      expect(told(conn, job)).toEqual([])
    }
  })

  it('a watch that has not fired: nothing is its own, nothing stopped', () => {
    const conn = frozen()
    const job = eventJob(conn, { watch: 'task-a', fired: false })
    // Made for the same record before it was chosen again (a rewatch resets `fired`).
    const old = eventOccurrence(conn, job, 'task-a', 'due', 1)
    initDatabase(conn)
    expect(genOf(conn, old)).toBeNull()
    expect(cursorOf(conn, job)).toEqual({ g: 1, stop: null, record: null })
    expect(told(conn, job)).toEqual([])
  })

  it('the same record chosen again, then a firing that made no occurrence (a paused gap): the older pending one stays isolated, the stop as it was', () => {
    const conn = frozen()
    const job = eventJob(conn, { watch: 'task-a', fired: true, stop: 'PAUSED_EVENT' })
    const old = eventOccurrence(conn, job, 'task-a', 'due', 1)
    initDatabase(conn)
    expect(genOf(conn, old)).toBeNull()
    expect(cursorOf(conn, job)).toEqual({ g: 1, stop: 'PAUSED_EVENT', record: 'task-a' })
    expect(told(conn, job)).toEqual([])
  })
})

describe('a cursor that has its generation already is left as it is', () => {
  it('a later build’s watch (its occurrence ended, nothing pending) is not taken for an orphan when this build starts again', () => {
    const conn = frozen()
    initDatabase(conn)
    const job = eventJob(conn, { watch: 'task-a', fired: true })
    const done = eventOccurrence(conn, job, 'task-a', 'done', 1)
    conn.prepare('UPDATE ai_job_event_cursors SET watch_generation = 5 WHERE company_id = ? AND job_id = ?').run(CO, job)
    conn.prepare('UPDATE ai_job_occurrences SET watch_generation = 5 WHERE company_id = ? AND id = ?').run(CO, done)
    initDatabase(conn)
    expect(cursorOf(conn, job)).toEqual({ g: 5, stop: null, record: null })
    expect(genOf(conn, done)).toBe(5)
    expect(told(conn, job)).toEqual([])
  })
})

describe('an orphaned watch is stopped once and its responsible person told once (F9)', () => {
  it('the newest occurrence ended while an older one waits: neither is the watch’s; the chain stops, only the responsible person is told', () => {
    const conn = frozen()
    const job = eventJob(conn, { watch: 'task-a', fired: true })
    const older = eventOccurrence(conn, job, 'task-a', 'due', 1)
    const newer = eventOccurrence(conn, job, 'task-a', 'done', 2)
    initDatabase(conn)
    expect(genOf(conn, older)).toBeNull()
    expect(genOf(conn, newer)).toBeNull()
    expect(cursorOf(conn, job)).toEqual({ g: 1, stop: 'WATCH_RESET', record: 'task-a' })
    expect(told(conn, job)).toEqual(['u-alice'])
    // A second start: no second stop, no second notice.
    initDatabase(conn)
    expect(told(conn, job)).toEqual(['u-alice'])
  })

  it('a firing that made no occurrence and whose stop an earlier watch’s occurrence cleared: the one occurrence (done) is not the watch’s', () => {
    const conn = frozen()
    const job = eventJob(conn, { watch: 'task-a', fired: true })
    const done = eventOccurrence(conn, job, 'task-a', 'done', 1)
    const none = eventJob(conn, { watch: 'task-b', fired: true })
    initDatabase(conn)
    expect(genOf(conn, done)).toBeNull()
    for (const j of [job, none]) {
      expect(cursorOf(conn, j)).toEqual({ g: 1, stop: 'WATCH_RESET', record: j === job ? 'task-a' : 'task-b' })
      expect(told(conn, j)).toEqual(['u-alice'])
    }
  })

  it('a responsible person who left is not told; a retired job, and one whose approved version is not a 4a event job, are left as they are', () => {
    const conn = frozen()
    const left = eventJob(conn, { watch: 'task-a', fired: true, acting: 'u-gone' })
    const retired = eventJob(conn, { watch: 'task-b', fired: true, state: 'retired' })
    const later = eventJob(conn, { watch: 'task-c', fired: true, schema: 3 })
    initDatabase(conn)
    expect(cursorOf(conn, left)).toEqual({ g: 1, stop: 'WATCH_RESET', record: 'task-a' })
    expect(told(conn, left)).toEqual([])
    for (const j of [retired, later]) {
      expect(cursorOf(conn, j)).toEqual({ g: 1, stop: null, record: null })
      expect(told(conn, j)).toEqual([])
    }
  })
})
