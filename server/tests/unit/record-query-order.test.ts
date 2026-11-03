/**
 * The query's default order, "most recently changed first" (records.md "Reading"): an action
 * changes only the record's state row, so its time must count. The app's archive (アーカイブ,
 * tasks-ui.md "The archive") pages archived tasks 20 at a time in this order and merges two
 * queries by the summaries' `updatedAt` — the order and that field must agree.
 *
 * Guards:
 * - a task archived later comes first, though it was created first (failed while the order was
 *   the records row's own time);
 * - pages by offset follow the same order, with `total`;
 * - someone's own (owner-only) archived task is in nobody else's answer.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type ActorInput, type RecordEngine } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'

const TS = '2026-11-01T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let tick = 0

const PEOPLE = ['u-owner', 'u-alice', 'u-bob']
const m = (userId: string): Member => ({ companyId: 'a', userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN: ActorInput = { kind: 'human' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  // Each call a second later: the order is by time.
  const clock = { now: () => new Date(Date.parse('2026-11-01T01:00:00.000Z') + 1000 * tick++).toISOString(), nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (PEOPLE.includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null),
    notify: () => {},
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-root', 'a', '', 'company', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-root-r', 'a-root', 'everyone', NULL, 1, 1, ?)").run(TS)
  const records = source.forCompany('a').records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
})

const own = (title: string, who = 'u-alice', personal = true) =>
  ok(engine.create(m(who), HUMAN, { type: 'task', title, personal, fields: { assignee: who } })).record
const archive = async (who: string, id: string, version: number) =>
  ok(await engine.act(m(who), HUMAN, id, 'cancel', { expectedVersion: version, note: 'もう要らない' }))

describe('the query is most recently changed first', () => {
  it('a task archived later comes first, though it was made first; offsets page in that order', async () => {
    const first = own('最初に作った')
    const second = own('次に作った')
    const third = own('最後に作った')
    await archive('u-alice', third.id, 1)
    await archive('u-alice', second.id, 1)
    await archive('u-alice', first.id, 1)
    const q = (offset: number) => ok(service.query(m('u-alice'), { type: 'task', state: ['cancelled'], fields: { assignee: 'u-alice' }, limit: 2, offset }))
    expect(q(0).records.map(r => r.title)).toEqual(['最初に作った', '次に作った'])
    expect(q(0).total).toBe(3)
    expect(q(2).records.map(r => r.title)).toEqual(['最後に作った'])
    // The summaries carry the time the order used (the app merges two queries by it).
    const times = q(0).records.map(r => r.updatedAt)
    expect([...times].sort().reverse()).toEqual(times)
  })

  it('someone\'s own archived task is in nobody else\'s answer, the company owner\'s included', async () => {
    const mine = own('自分用：歯医者')
    await archive('u-alice', mine.id, 1)
    const shared = own('みんなの：備品', 'u-bob', false)
    await archive('u-bob', shared.id, 1)
    for (const who of ['u-bob', 'u-owner']) {
      const ids = ok(service.query(m(who), { type: 'task', state: ['cancelled'], limit: 20 })).records.map(r => r.id)
      expect(ids).not.toContain(mine.id)
      expect(ids).toContain(shared.id)
    }
  })
})
