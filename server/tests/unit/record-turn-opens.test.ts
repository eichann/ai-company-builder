/**
 * Whose turn it was (records.md "Whose turn it was", owner decision 2026-11-01
 * 「流れを測れる記録」), on the real schema, engine and services:
 *
 * - the ledger alone says when the turn became whose (`turnsOf`): every change
 *   of next_actor / assignee / state that moves the turn starts a new stretch;
 * - the turn-holder's first opening is kept once per turn — not a view log:
 *   opening again keeps the first time; a requester or admin opening it keeps
 *   nothing; a new turn gets its own; the delegate covering the holder counts,
 *   marked as theirs; final and AI-turn states keep nothing;
 * - nobody learns more than before: the answer is the same whether anything
 *   was kept, an owner-only record is its owner's alone (an admin gets a
 *   missing record's answer), and another company's record does not exist.
 *
 * Each guard mutation-checked (remove it → a test here fails).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordChange, type RecordEngine } from '../../src/services/record-engine'
import { createNotificationService, type NotificationService } from '../../src/services/notifications'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createAbsenceService, type AbsenceService } from '../../src/services/absences'
import { currentTypes } from '../../src/services/record-index'
import { turnsOf } from '../../../shared/core/record-turns'
import type { Member } from '../../src/services/access'

const TS = '2026-11-01T00:00:00.000Z'
/** 2026-11-02 10:00 in Japan. */
const NOW = Date.parse('2026-11-02T01:00:00.000Z')
const MEMBERS: Record<string, string[]> = {
  a: ['u-owner', 'u-alice', 'u-bob', 'u-carol', 'u-dan', 'u-mallory'],
  b: ['u-owner', 'u-alice', 'u-bob'],
}
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let notices: NotificationService
let records: RecordService
let absences: AbsenceService
let nowMs: number

const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN = { kind: 'human' as const }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '経理', 'folder', ?)").run(`${id}-acc`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-acc-e`, `${id}-acc`, TS)
  for (const u of MEMBERS[id]) {
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-${u}`, u, id, u === 'u-owner' ? 'owner' : 'member', TS, TS)
  }
  // 経理 department: carol manages it, alice and bob belong to it.
  conn.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-d-acc`, id, '経理', '経理', TS, TS)
  conn.prepare('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}-d-acc`, 'u-carol', TS)
  source.forCompany(id).tasks.replaceDepartmentMembers(`${id}-d-acc`, ['u-alice', 'u-bob'], 'u-owner', TS)
  const recs = source.forCompany(id).records
  recs.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(recs, TS)
}

/** A task the owner asked alice for (waiting for her: todo, assignee alice). */
function taskForAlice(opts: { folder?: string; co?: string; personal?: boolean; title?: string } = {}) {
  const co = opts.co ?? 'a'
  const by = opts.personal ? 'u-alice' : 'u-owner'
  return ok(engine.create(m(by, co), HUMAN, {
    type: 'task', title: opts.title ?? '請求書を確かめる', ...(opts.folder ? { folder: opts.folder } : {}), ...(opts.personal ? { personal: true } : {}),
    fields: { assignee: 'u-alice' },
  })).record
}

const away = (userId: string, delegateId: string, from = '2026-11-02', until = '2026-11-02', by = userId, co = 'a') =>
  absences.create(m(by, co), { userId, from, until, delegateId })

function wire() {
  const shared = {
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') },
  }
  const roleOf = (co: string, userId: string) => ((MEMBERS[co] ?? []).includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null)
  const accounts = { byIds: (ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id.replace('u-', '').replace(/^./, c => c.toUpperCase()) }])) }
  absences = createAbsenceService({
    ...shared, accounts, memberships: { roleOf }, timeZoneOf: () => 'Asia/Tokyo',
    delegateCannotRead: (co, absentee, delegate, setter) => notices.delegateCannotRead(co, absentee, delegate, setter),
  })
  const actsFor = (co: string, userId: string) => absences.actsFor(co, userId)
  notices = createNotificationService({
    ...shared, roleOf, accounts, push: () => {},
    coverOf: (co, userId) => absences.coverOf(co, userId),
    managersOf: (co, userId) => absences.managersOf(co, userId),
    activeAbsences: co => absences.activeToday(co),
  })
  const notify = (companyId: string, userIds: string[], change?: RecordChange) => { if (change) notices.recordChange(companyId, userIds, change) }
  const isMember = (co: string, userId: string) => (MEMBERS[co] ?? []).includes(userId)
  engine = createRecordEngine({
    ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf, notify, actsFor,
  })
  records = createRecordService({ ...shared, indexer: { schedule: async () => {} } as never, actsFor })
}

beforeEach(() => {
  nowMs = NOW
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  wire()
  company('a')
  company('b')
})


const opens = (id: string, co = 'a') => source.forCompany(co).records.turnOpens(id).map(o => [o.turnVersion, o.holderId, o.openedBy, o.openedAt])
const turns = (id: string, co = 'a') => {
  const recs = source.forCompany(co).records
  const def = currentTypes(recs).get('task')!.definition
  return turnsOf(def, recs.ledger(id)).map(t => [t.holder, t.sinceVersion])
}
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

describe('when the turn became whose: from the ledger alone', () => {
  it('a hand-off to the reviewer and back starts a new turn each time; work by the holder does not', async () => {
    const t = taskForAlice()
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'start', { expectedVersion: 1 }))
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-carol' } }))
    ok(await engine.act(m('u-carol'), HUMAN, t.id, 'send_back', { expectedVersion: 3, note: '数字を直してください' }))
    ok(await engine.act(m('u-owner'), HUMAN, t.id, 'cancel', { expectedVersion: 4, note: '不要になった' }))
    expect(turns(t.id)).toEqual([['u-alice', 1], ['u-carol', 3], ['u-alice', 4], [null, 5]])
  })
})

describe('the turn-holder\'s first opening', () => {
  it('kept once per turn, by the holder only; a new turn gets its own', async () => {
    const t = taskForAlice()
    // The requester (an owner) opening it: not their turn, nothing kept.
    expect(ok(records.opened(m('u-owner'), t.id))).toEqual({})
    expect(opens(t.id)).toEqual([])
    nowMs = NOW + 60_000
    expect(ok(records.opened(m('u-alice'), t.id))).toEqual({})
    nowMs = NOW + 120_000
    ok(records.opened(m('u-alice'), t.id))
    expect(opens(t.id)).toEqual([[1, 'u-alice', 'u-alice', at(1)]])
    // Her own work keeps the turn: still the first opening.
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'start', { expectedVersion: 1 }))
    ok(records.opened(m('u-alice'), t.id))
    expect(opens(t.id)).toHaveLength(1)
    // Handed to carol: alice opening it now keeps nothing, carol's opening is the new turn's.
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-carol' } }))
    nowMs = NOW + 180_000
    ok(records.opened(m('u-alice'), t.id))
    ok(records.opened(m('u-carol'), t.id))
    expect(opens(t.id)).toEqual([[1, 'u-alice', 'u-alice', at(1)], [3, 'u-carol', 'u-carol', at(3)]])
  })

  it('the delegate covering the holder counts, marked as theirs; only during the absence', () => {
    const t = taskForAlice()
    ok(records.opened(m('u-bob'), t.id))
    expect(opens(t.id)).toEqual([])
    ok(away('u-alice', 'u-bob'))
    ok(records.opened(m('u-bob'), t.id))
    expect(opens(t.id)).toEqual([[1, 'u-alice', 'u-bob', at(0)]])
  })

  it('a final state and the AI\'s turn keep nothing', async () => {
    const done = taskForAlice()
    ok(await engine.act(m('u-owner'), HUMAN, done.id, 'cancel', { expectedVersion: 1, note: '不要' }))
    ok(records.opened(m('u-alice'), done.id))
    const prep = ok(engine.create(m('u-owner'), HUMAN, { type: 'task', title: '下調べ', state: 'preparing', fields: { assignee: 'u-alice' } })).record
    ok(records.opened(m('u-alice'), prep.id))
    expect([...opens(done.id), ...opens(prep.id)]).toEqual([])
  })

  it('an owner-only record is its owner\'s alone; another company\'s and a missing one are the same 404', () => {
    const mine = taskForAlice({ personal: true, title: '自分用' })
    const missing = records.opened(m('u-owner'), 'task-nosuch0001')
    expect(missing).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
    expect(records.opened(m('u-owner'), mine.id)).toEqual(missing)
    const other = taskForAlice({ co: 'b' })
    expect(records.opened(m('u-alice'), other.id)).toEqual(missing)
    expect(opens(other.id, 'b')).toEqual([])
    ok(records.opened(m('u-alice'), mine.id))
    expect(opens(mine.id)).toEqual([[1, 'u-alice', 'u-alice', at(0)]])
  })
})
