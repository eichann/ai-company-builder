/**
 * Task version 12 (owner decision 2026-11-03 「②」, records.md "Task version 12"): 「返事待ちにする」
 * says until when — the 見込み (`wait_until`) is set with the wait in one entry; left out it is
 * 3 business days after the company's today; when it passes, the server clock gives the task back
 * once, with a 経緯 line that says why, and 「あなたの番」 marks it (`waitCameBack`).
 *
 * Guards (each fails when its check is removed — mutation-checked):
 * - the default skips weekends, public holidays and the company's own holidays;
 * - an app released before (no `wait_until`, or null) still makes it wait, with the default;
 * - a 見込み still ahead stays when left out; one that passed is replaced (「もう少し待つ」);
 * - the clock moves it exactly once, never before, with 「返事の見込み（11/6）を過ぎました」;
 * - 「もう少し待つ」 after it came back waits again until the new 見込み;
 * - `waitCameBack` only for a task the clock gave back, not one a person moved on;
 * - an old waiting task without `wait_until` is never moved and never marked.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordChange, type RecordEngine } from '../../src/services/record-engine'
import { companyNow, createNotificationService, type NotificationService } from '../../src/services/notifications'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createServerClock, type ServerClock } from '../../src/services/server-clock'
import type { Member } from '../../src/services/access'
import { argDefaultValue, CLOCK_ACTOR, waitCameBack, WAIT_OVER_ACTION } from '../../../shared/core/core-types'

const TS = '2026-11-01T00:00:00.000Z'
const MEMBERS = ['u-owner', 'u-alice', 'u-bob']
const HUMAN = { kind: 'human' as const }
const AI = { kind: 'ai' as const, source: 'claude-code' }
const m = (userId: string): Member => ({ companyId: 'a', userId, role: userId === 'u-owner' ? 'owner' : 'member' })

let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let records: RecordService
let notices: NotificationService
let clock: ServerClock
let nowMs: number
let holidays: string[]

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const jst = (local: string) => Date.parse(`${local}:00+09:00`)

beforeEach(() => {
  // Monday 2026-11-02, 10:00 in Japan; 11-03 is 文化の日.
  nowMs = jst('2026-11-02T10:00')
  holidays = []
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-root', 'a', '', 'company', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-root-r', 'a-root', 'everyone', NULL, 1, 1, ?)").run(TS)
  const shared = {
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') },
  }
  const roleOf = (_co: string, userId: string) => (MEMBERS.includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null)
  const isMember = (_co: string, userId: string) => MEMBERS.includes(userId)
  notices = createNotificationService({ ...shared, roleOf, accounts: { byIds: ids => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }])) }, push: () => {} })
  const notify = (co: string, userIds: string[], change?: RecordChange) => { if (change) notices.recordChange(co, userIds, change) }
  // As composition.ts: the company's now and its own holidays.
  engine = createRecordEngine({
    ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf, notify,
    companyDay: () => ({ now: companyNow(nowMs, 'Asia/Tokyo'), holidays }),
  })
  records = createRecordService({ ...shared, indexer: { schedule: async () => {} } as never })
  clock = createServerClock({
    ...shared, companyIds: () => ['a'], writer: createServiceRecordWriter({ ...shared, isMember, roleOf, notify }), notifications: notices,
    autoRunFor: () => false, timeZoneOf: () => 'Asia/Tokyo', yieldNow: async () => {}, log: () => {},
  })
  const r = source.forCompany('a').records
  r.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(r, TS)
})

const task = () => ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積の返事', fields: { assignee: 'u-bob' } })).record.id
const stateOf = (id: string) => source.forCompany('a').records.states([id])[0]
const fieldsOf = (id: string) => JSON.parse(stateOf(id).fields) as Record<string, unknown>
const ledger = (id: string) => source.forCompany('a').records.ledger(id)
const wait = (id: string, args: Record<string, unknown>, actor: typeof HUMAN | typeof AI = HUMAN) =>
  engine.act(m('u-bob'), actor, id, 'wait', { expectedVersion: stateOf(id).version, args })
const mine = () => ok(records.myTurn(m('u-bob'))).records

describe('返事待ち with its 見込み (task version 12)', () => {
  it('nothing chosen → 3 business days later, skipping the public and the company’s own holidays', async () => {
    const id = task()
    // Mon 11-02: Tue 11-03 文化の日 is off → Wed 11-04, Thu 11-05, Fri 11-06.
    ok(await wait(id, { waiting_on: '先方の返事' }))
    expect(fieldsOf(id)).toMatchObject({ waiting_on: '先方の返事', wait_until: '2026-11-06' })
    expect(stateOf(id).state).toBe('waiting')
    // One entry: the wait and its 見込み together.
    expect(ledger(id).at(-1)?.changes.map(c => c.field).sort()).toEqual(['state', 'wait_until', 'waiting_on'])

    holidays = ['2026-11-05']
    const other = task()
    ok(await wait(other, { waiting_on: '先方の返事', wait_until: null }))
    expect(fieldsOf(other).wait_until).toBe('2026-11-09')
  })

  it('a chosen 見込み is kept as given (day, or day and time)', async () => {
    const id = task()
    ok(await wait(id, { waiting_on: '先方の返事', wait_until: '2026-11-10T15:00' }))
    expect(fieldsOf(id).wait_until).toBe('2026-11-10T15:00')
    expect((await wait(task(), { waiting_on: 'x', wait_until: 'あした' })).ok).toBe(false)
  })

  it('the AI giving none gets the default too; a 見込み already ahead stays when left out', async () => {
    const id = task()
    ok(await engine.act(m('u-bob'), HUMAN, id, 'set_wait_until', { expectedVersion: 1, args: { wait_until: '2026-11-20' } }))
    ok(await wait(id, { waiting_on: '先方の返事' }, AI))
    expect(fieldsOf(id).wait_until).toBe('2026-11-20')
    const other = task()
    ok(await wait(other, { waiting_on: '先方の返事' }, AI))
    expect(fieldsOf(other).wait_until).toBe('2026-11-06')
  })

  it('the clock gives it back exactly once when the 見込み has passed — never before — and 経緯 says why', async () => {
    const id = task()
    ok(await wait(id, { waiting_on: '先方の返事' }))
    nowMs = jst('2026-11-06T23:59')
    expect((await clock.runOnce()).moved).toBe(0)
    expect(stateOf(id).state).toBe('waiting')
    expect(mine().find(r => r.id === id)).not.toHaveProperty('waitCameBack')

    nowMs = jst('2026-11-07T00:05')
    expect((await clock.runOnce()).moved).toBe(1)
    expect(stateOf(id).state).toBe('todo')
    expect(ledger(id).at(-1)).toMatchObject({ action: 'wait_over', actorId: CLOCK_ACTOR.id, note: '返事の見込み（11/6）を過ぎました' })
    expect((await clock.runOnce()).moved).toBe(0)
    expect(ledger(id).filter(e => e.action === 'wait_over')).toHaveLength(1)

    // 「あなたの番」 marks it, with when the wait began.
    const row = mine().find(r => r.id === id)
    expect(row?.waitCameBack).toEqual({ waitedSince: new Date(jst('2026-11-02T10:00')).toISOString(), overAt: new Date(jst('2026-11-07T00:05')).toISOString() })
    expect(ok(notices.list(m('u-bob'))).items.map(i => i.text)).toEqual(['「見積の返事」の返事・届く見込みの日時が過ぎました。追いかけてください'])
  })

  it('［もう少し待つ］ waits again until a new 見込み (the passed one is not kept), and the mark goes', async () => {
    const id = task()
    ok(await wait(id, { waiting_on: '先方の返事', wait_until: '2026-11-04' }))
    nowMs = jst('2026-11-05T09:00')
    await clock.runOnce()
    expect(stateOf(id).state).toBe('todo')

    ok(await wait(id, { waiting_on: '先方の返事' }))
    // Thu 11-05 → Fri 11-06, Mon 11-09, Tue 11-10.
    expect(fieldsOf(id)).toMatchObject({ wait_until: '2026-11-10' })
    expect(stateOf(id).state).toBe('waiting')
    expect(mine().find(r => r.id === id)).not.toHaveProperty('waitCameBack')
    nowMs = jst('2026-11-10T18:00')
    expect((await clock.runOnce()).moved).toBe(0)
    nowMs = jst('2026-11-11T00:01')
    expect((await clock.runOnce()).moved).toBe(1)
    expect(ledger(id).at(-1)?.note).toBe('返事の見込み（11/10）を過ぎました')
  })

  it('a task a person moved on after it came back is not marked', async () => {
    const id = task()
    ok(await wait(id, { waiting_on: '先方の返事', wait_until: '2026-11-01' }))
    await clock.runOnce()
    expect(mine().find(r => r.id === id)?.waitCameBack).toBeTruthy()
    ok(await engine.act(m('u-bob'), HUMAN, id, 'start', { expectedVersion: stateOf(id).version }))
    expect(mine().find(r => r.id === id)).not.toHaveProperty('waitCameBack')
  })

  it('a task that waited before version 12 (no 見込み) is never moved nor marked', async () => {
    const id = task()
    ok(await wait(id, { waiting_on: '先方の返事' }))
    // As stored by an older server: waiting, no wait_until.
    const fields = { ...fieldsOf(id) }
    delete fields.wait_until
    conn.prepare('UPDATE record_state SET fields = ? WHERE company_id = ? AND record_id = ?').run(JSON.stringify(fields), 'a', id)
    nowMs = jst('2027-01-01T10:00')
    expect((await clock.runOnce()).moved).toBe(0)
    expect(stateOf(id).state).toBe('waiting')
    expect(mine().find(r => r.id === id)).not.toHaveProperty('waitCameBack')
  })
})

describe('argDefaultValue', () => {
  const rule = { businessDays: 3 }
  it('keeps a 見込み still ahead (a later day, today’s day, a time later today); else counts from today', () => {
    expect(argDefaultValue(rule, '2026-11-20', '2026-11-02T10:00')).toBe('2026-11-20')
    expect(argDefaultValue(rule, '2026-11-02', '2026-11-02T10:00')).toBe('2026-11-02')
    expect(argDefaultValue(rule, '2026-11-02T11:00', '2026-11-02T10:00')).toBe('2026-11-02T11:00')
    expect(argDefaultValue(rule, '2026-11-02T09:00', '2026-11-02T10:00')).toBe('2026-11-06')
    expect(argDefaultValue(rule, '2026-11-01', '2026-11-02T10:00')).toBe('2026-11-06')
    expect(argDefaultValue(rule, null, '2026-11-02T10:00', ['2026-11-04'])).toBe('2026-11-09')
  })
})

describe('waitCameBack', () => {
  const e = (action: string, fromState: string | null, toState: string | null, at = '2026-11-02T01:00:00.000Z', actorId = 'u-bob') => ({ action, actorId, at, fromState, toState })
  const waited = [e('create', null, 'todo'), e('wait', 'todo', 'waiting', '2026-11-02T01:00:00.000Z')]
  const over = e(WAIT_OVER_ACTION, 'waiting', 'todo', '2026-11-07T00:00:00.000Z', CLOCK_ACTOR.id)
  it('the clock’s move, or through the AI’s turn back to the person; not after any other move, nor a wait_over by anyone else', () => {
    expect(waitCameBack('task', [...waited, over])).toEqual({ waitedSince: '2026-11-02T01:00:00.000Z', overAt: '2026-11-07T00:00:00.000Z' })
    // Field-only entries (a new tag) keep it.
    expect(waitCameBack('task', [...waited, over, e('set_tags', 'todo', 'todo')])).not.toBeNull()
    // 自動で進める: preparing → the AI hands the nudge draft over (finish_prep).
    const viaAi = [...waited, { ...over, toState: 'preparing' }, e('finish_prep', 'preparing', 'todo')]
    expect(waitCameBack('task', viaAi)?.waitedSince).toBe('2026-11-02T01:00:00.000Z')
    // Reassigned and accepted back into 未着手: not the clock's any more.
    expect(waitCameBack('task', [...waited, over, e('assign', 'todo', 'awaiting_acceptance'), e('accept', 'awaiting_acceptance', 'todo')])).toBeNull()
    expect(waitCameBack('task', [...waited, { ...over, actorId: 'u-bob' }])).toBeNull()
    expect(waitCameBack('meeting', [...waited, over])).toBeNull()
  })
})
