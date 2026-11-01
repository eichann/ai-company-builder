/**
 * The common outside time (records.md "Outside time", owner decision 2026-11-01
 * 「流れを測れる記録」): every core type of a thing that happened outside ACB
 * implements `outside_event`, so "when it happened there" is always
 * `occurred_at`, and "when ACB learned of it" the `create` entry's `at`.
 *
 * Guards (each mutation-checked):
 * - interaction and meeting keep the promise (a type claiming it without
 *   `occurred_at` is refused, a plugin's or company's type may claim it), and
 *   the new versions are additive over the old (no breaking change, so
 *   existing records and companies' extensions stay valid);
 * - the startup carry-over gives each older meeting `occurred_at` from
 *   `meeting_at` as a ledger entry (the ledger replays to the stored values),
 *   once, per company, without touching a meeting that already has one or
 *   another type.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateOutsideTimes } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { CORE_TYPE_FILES, coreTypeDefinitions, MIGRATION_ACTOR, OUTSIDE_TIME_ACTION } from '../../shared/core/core-types'
import { ledgerCause, replayRecordState } from '../../shared/core/record-ledger'
import { compareTypeDefinitions, parseTypeFile } from '../../shared/core/record-types'
import { INTERACTION_V4_TEXT } from '../helpers/core-types-before-inbox'

const TS = '2026-11-01T00:00:00.000Z'
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

const parse = (name: string, text: string) => parseTypeFile(name, text)
const def = (name: string) => coreTypeDefinitions().find(d => d.name === name)!

describe('the outside time is one field, through the interface', () => {
  it('interaction and meeting implement outside_event (and the reply request born of a message); outbound_message (made by ACB) does not', () => {
    const claiming = coreTypeDefinitions().filter(d => d.implements.includes('outside_event')).map(d => d.name).sort()
    expect(claiming).toEqual(['interaction', 'meeting', 'reply_request'])
    for (const name of claiming) expect(def(name).fields.occurred_at).toMatchObject({ kind: 'datetime', source: 'server' })
  })

  it('a type claiming it must have occurred_at (datetime, server); a plugin\'s type of incoming things may claim it', () => {
    const head = '---\nlabel: 問い合わせ\nversion: 1\nstorage: server\nimplements: [outside_event]\n'
    expect(parse('inquiry', `${head}fields:\n  received_at: { label: 受けた日時, kind: datetime, source: server }\nstates: [open]\n---\n`).ok).toBe(false)
    expect(parse('inquiry', `${head}fields:\n  occurred_at: { label: 受けた日時, kind: date, source: server }\nstates: [open]\n---\n`).ok).toBe(false)
    expect(parse('inquiry', `${head}fields:\n  occurred_at: { label: 受けた日時, kind: datetime, source: server }\nstates: [open]\n---\n`).ok).toBe(true)
  })

  it('the new versions only add over the old ones: existing records and a company\'s own extension stay valid', () => {
    const before: Record<string, string> = {
      // Version 4 as it was (interaction 5 is the inbox's: tests/unit/intake-core.test.ts).
      interaction: INTERACTION_V4_TEXT.replace('version: 4\nimplements: [outside_event]\n', 'version: 3\n'),
      meeting: CORE_TYPE_FILES.meeting.replace('version: 2\nimplements: [outside_event]\n', 'version: 1\n')
        .replace(/ {2}occurred_at: .*\n/, ''),
    }
    for (const [name, text] of Object.entries(before)) {
      const prev = parse(name, text)
      if (!prev.ok) throw new Error(prev.errors.join(' / '))
      const change = compareTypeDefinitions(prev.definition, def(name))
      expect(change).toMatchObject({ changed: true, breaking: [], versionProblem: null })
    }
  })
})

describe('the startup carry-over of meetings', () => {
  const q = (sql: string, ...args: unknown[]) => conn.prepare(sql).all(...args) as Array<Record<string, unknown>>
  function meeting(co: string, id: string, fields: Record<string, unknown>) {
    conn.prepare("INSERT INTO records (company_id, id, type, type_version, title, created_at, updated_at) VALUES (?, ?, 'meeting', 1, ?, ?, ?)").run(co, id, id, TS, TS)
    conn.prepare("INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES (?, ?, 'read', ?, 1, ?)").run(co, id, JSON.stringify(fields), TS)
    conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, at, changes, type_version)
      VALUES (?, ?, 1, 'create', NULL, 'read', 'acb:google', 'external', ?, ?, 1)`)
      .run(co, id, TS, JSON.stringify([{ field: 'state', before: null, after: 'read' }, ...Object.entries(fields).map(([field, after]) => ({ field, before: null, after }))]))
  }

  it('each older meeting gets occurred_at as a ledger entry, once, per company; others are left alone', () => {
    meeting('a', 'meeting-000001', { meeting_at: '2026-10-30T05:00:00.000Z', assignee: 'u-alice' })
    meeting('a', 'meeting-000002', { meeting_at: '2026-10-31T05:00:00.000Z', occurred_at: '2026-10-31T05:00:00.000Z' })
    meeting('b', 'meeting-000003', { meeting_at: '2026-10-29T01:00:00.000Z' })
    conn.prepare("INSERT INTO records (company_id, id, type, type_version, title, created_at, updated_at) VALUES ('a', 'interaction-000001', 'interaction', 3, 'x', ?, ?)").run(TS, TS)
    conn.prepare("INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES ('a', 'interaction-000001', 'received', ?, 1, ?)")
      .run(JSON.stringify({ meeting_at: 'not a meeting' }), TS)

    migrateOutsideTimes(conn)
    const once = q('SELECT company_id, record_id, version, action FROM record_ledger ORDER BY company_id, record_id, version')
    migrateOutsideTimes(conn) // a second start changes nothing
    expect(q('SELECT company_id, record_id, version, action FROM record_ledger ORDER BY company_id, record_id, version')).toEqual(once)

    for (const [co, id, at] of [['a', 'meeting-000001', '2026-10-30T05:00:00.000Z'], ['b', 'meeting-000003', '2026-10-29T01:00:00.000Z']]) {
      const recs = source.forCompany(co).records
      const entries = recs.ledger(id)
      expect(entries).toHaveLength(2)
      expect(entries[1]).toMatchObject({
        version: 2, action: OUTSIDE_TIME_ACTION, fromState: 'read', toState: 'read', actorId: MIGRATION_ACTOR.id, actorKind: 'external', typeVersion: 2,
        changes: [{ field: 'occurred_at', before: null, after: at }],
      })
      expect(ledgerCause(entries[1])).toBe('system')
      const state = recs.states([id])[0]
      expect(state.version).toBe(2)
      // The ledger replays to exactly what is stored.
      expect(replayRecordState(entries, 2).fields).toEqual(JSON.parse(state.fields))
      expect(q('SELECT type_version FROM records WHERE company_id = ? AND id = ?', co, id)).toEqual([{ type_version: 2 }])
    }
    expect(source.forCompany('a').records.ledger('meeting-000002')).toHaveLength(1)
    expect(q("SELECT version FROM record_state WHERE record_id = 'interaction-000001'")).toEqual([{ version: 1 }])
  })
})
