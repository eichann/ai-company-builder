/**
 * Meeting version 4 (minutes.md "A まとまり chosen later"): a まとまり chosen after the reading is
 * only linked, so version 3's まとまり's part (bundle_waiting / bundle_working) is gone.
 *
 * Guards (each mutation-checked):
 * - a meeting left in either state goes back to `read` at startup as a ledger entry of the
 *   server's migration (cause `system`, never a person), which replays to the stored state; once,
 *   per company; a meeting in another state and other types are left alone.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateBundleParts } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { BUNDLE_PART_ENDED_ACTION, coreTypeDefinitions, MIGRATION_ACTOR } from '../../shared/core/core-types'
import { ledgerCause, replayRecordState } from '../../shared/core/record-ledger'

const TS = '2026-11-02T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  for (const id of ['a', 'b']) {
    conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  }
})

const q = (sql: string, ...args: unknown[]) => conn.prepare(sql).all(...args) as Array<Record<string, unknown>>
function record(co: string, id: string, type: string, state: string) {
  conn.prepare('INSERT INTO records (company_id, id, type, type_version, title, created_at, updated_at) VALUES (?, ?, ?, 3, ?, ?, ?)').run(co, id, type, id, TS, TS)
  conn.prepare('INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES (?, ?, ?, ?, 1, ?)').run(co, id, state, '{}', TS)
  conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, at, changes, type_version)
    VALUES (?, ?, 1, 'create', NULL, ?, 'acb:google', 'external', ?, ?, 3)`).run(co, id, state, TS, JSON.stringify([{ field: 'state', before: null, after: state }]))
}

describe('meeting version 4: the まとまり\'s part is gone', () => {
  it('the core meeting has no bundle_waiting / bundle_working and none of their actions', () => {
    const meeting = coreTypeDefinitions().find(d => d.name === 'meeting')!
    expect(meeting.version).toBeGreaterThanOrEqual(4)
    expect(meeting.states).not.toContain('bundle_waiting')
    expect(meeting.states).not.toContain('bundle_working')
    expect(Object.keys(meeting.actions).filter(a => a.endsWith('_bundle_work'))).toEqual([])
  })

  it('a meeting left in the まとまり\'s part goes back to read as the system\'s ledger entry, once, per company; others are left alone', () => {
    record('a', 'meeting-000001', 'meeting', 'bundle_waiting')
    record('a', 'meeting-000002', 'meeting', 'bundle_working')
    record('a', 'meeting-000003', 'meeting', 'reading')
    record('b', 'meeting-000004', 'meeting', 'bundle_working')
    record('a', 'task-000001', 'task', 'bundle_waiting')

    migrateBundleParts(conn)
    const once = q('SELECT company_id, record_id, version, action FROM record_ledger ORDER BY company_id, record_id, version')
    migrateBundleParts(conn) // a second start changes nothing
    expect(q('SELECT company_id, record_id, version, action FROM record_ledger ORDER BY company_id, record_id, version')).toEqual(once)

    for (const [co, id, from] of [['a', 'meeting-000001', 'bundle_waiting'], ['a', 'meeting-000002', 'bundle_working'], ['b', 'meeting-000004', 'bundle_working']]) {
      const recs = source.forCompany(co).records
      const entries = recs.ledger(id)
      expect(entries).toHaveLength(2)
      expect(entries[1]).toMatchObject({
        version: 2, action: BUNDLE_PART_ENDED_ACTION, fromState: from, toState: 'read', actorId: MIGRATION_ACTOR.id, actorKind: 'external', typeVersion: 4,
      })
      expect(ledgerCause(entries[1])).toBe('system')
      const state = recs.states([id])[0]
      expect([state.state, state.version]).toEqual(['read', 2])
      expect(replayRecordState(entries, 2).state).toBe('read')
    }
    expect(source.forCompany('a').records.states(['meeting-000003'])[0]).toMatchObject({ state: 'reading', version: 1 })
    expect(source.forCompany('a').records.states(['task-000001'])[0]).toMatchObject({ state: 'bundle_waiting', version: 1 })
  })
})
