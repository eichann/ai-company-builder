/**
 * The server clock (stage 2 S14, notifications.md "The server clock") on the
 * real schema, the real engine, service writer and notices, wired as in
 * composition.ts. The AI never runs here: the clock only moves the turn and
 * writes notices.
 *
 * Guards (each fails when its check is removed — mutation-checked):
 * - nothing moves before its time (a time today, a day not over yet);
 * - running twice does nothing more (no second move, entry or notice);
 * - the AI's turn only with 自動で進める on — the assignee's own switch (their PC
 *   runs it), within the company's 使ってよいか; else the assignee's;
 * - an owner-only record's notices reach its owner only, never another
 *   member named in it, nor an owner/admin;
 * - another company is untouched, and one company's failure does not stop it;
 * - one company's backlog is capped per run, so another's work still runs;
 * - a run never overlaps another.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordChange, type RecordEngine } from '../../src/services/record-engine'
import { createNotificationService, type NotificationService } from '../../src/services/notifications'
import { createServerClock, type ServerClock } from '../../src/services/server-clock'
import { createWorkSwitches, type WorkSwitches } from '../../src/services/work-switches'
import type { Member } from '../../src/services/access'
import { CLOCK_ACTOR } from '../../../shared/core/core-types'
import { defaultTaskSettings } from '../../../shared/core/task-settings'

const TS = '2026-11-01T00:00:00.000Z'
const MEMBERS: Record<string, string[]> = {
  a: ['u-owner', 'u-alice', 'u-bob'],
  b: ['u-owner', 'u-alice', 'u-bob'],
}
const HUMAN = { kind: 'human' as const }
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })

let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let notices: NotificationService
let clock: ServerClock
let switches: WorkSwitches
let nowMs: number
let autoRun: Record<string, boolean>
let failing: Set<string>
let pushed: Array<{ co: string; users: string[] }>

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

/** Japan time → epoch ms. */
const jst = (local: string) => Date.parse(`${local}:00+09:00`)

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
}

function wire(limits?: { moves: number; notices: number }) {
  const shared = {
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') },
  }
  const roleOf = (co: string, userId: string) => ((MEMBERS[co] ?? []).includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null)
  const isMember = (co: string, userId: string) => (MEMBERS[co] ?? []).includes(userId)
  notices = createNotificationService({
    ...shared, roleOf,
    accounts: { byIds: ids => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }])) },
    push: (co, users) => pushed.push({ co, users }),
  })
  const notify = (co: string, userIds: string[], change?: RecordChange) => { if (change) notices.recordChange(co, userIds, change) }
  engine = createRecordEngine({ ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf, notify })
  const writer = createServiceRecordWriter({ ...shared, isMember, roleOf, notify })
  // As composition.ts: the assignee's own switch, within the company's settings.
  switches = createWorkSwitches({
    ...shared,
    settingsOf: co => {
      if (failing.has(co)) throw new Error('broken')
      const s = defaultTaskSettings()
      s.autoRun.enabled = autoRun[co] ?? false
      return s
    },
  })
  clock = createServerClock({
    ...shared,
    companyIds: () => ['a', 'b'],
    writer,
    notifications: notices,
    autoRunFor: (co, assignee) => switches.isOn(co, assignee, 'autoRun'),
    timeZoneOf: () => 'Asia/Tokyo',
    yieldNow: () => new Promise<void>(resolve => setImmediate(resolve)),
    log: () => {},
    ...(limits ? { limits } : {}),
  })
}

/** A task alice asked bob for, now waiting for a reply expected at `waitUntil`. */
async function waitingTask(waitUntil: string, co = 'a') {
  const t = ok(engine.create(m('u-alice', co), HUMAN, { type: 'task', title: '見積の返事', fields: { assignee: 'u-bob' } })).record
  // Task version 12: the 見込み is set with the wait, in one entry.
  ok(await engine.act(m('u-bob', co), HUMAN, t.id, 'wait', { expectedVersion: 1, args: { waiting_on: '先方の返事', wait_until: waitUntil } }))
  return t.id
}

const stateOf = (id: string, co = 'a') => source.forCompany(co).records.states([id])[0]
const fieldsOf = (id: string, co = 'a') => JSON.parse(stateOf(id, co).fields) as Record<string, unknown>
const noticeRows = (co = 'a') => conn.prepare("SELECT user_id, kind, record_id, action FROM notifications WHERE company_id = ? AND action IN ('wait_over', '') ORDER BY rowid").all(co) as Array<{ user_id: string; kind: string; record_id: string; action: string }>

beforeEach(() => {
  nowMs = jst('2026-11-05T10:00')
  autoRun = {}
  failing = new Set()
  pushed = []
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  wire()
  company('a')
  company('b')
})

describe('the server clock: a wait that is over', () => {
  it('nothing moves before its time; then once to the assignee’s turn, marked as the clock — a second run does nothing more', async () => {
    const timed = await waitingTask('2026-11-05T15:00')
    const dayOnly = await waitingTask('2026-11-05')
    nowMs = jst('2026-11-05T14:59')
    expect((await clock.runOnce()).moved).toBe(0)
    expect([stateOf(timed).state, stateOf(dayOnly).state]).toEqual(['waiting', 'waiting'])

    nowMs = jst('2026-11-05T15:01')
    expect((await clock.runOnce()).moved).toBe(1)
    expect(stateOf(timed)).toMatchObject({ state: 'todo', version: 3 })
    expect(fieldsOf(timed).next_actor).toBe('u-bob')
    expect(source.forCompany('a').records.ledger(timed).at(-1)).toMatchObject({ action: 'wait_over', actorId: CLOCK_ACTOR.id, actorKind: 'external', actorSource: CLOCK_ACTOR.source })
    // A day-only wait is over when its day is.
    expect(stateOf(dayOnly).state).toBe('waiting')
    expect(ok(notices.list(m('u-bob'))).items.filter(i => i.kind === 'wait_over').map(i => i.text)).toEqual(['「見積の返事」の返事・届く見込みの日時が過ぎました。追いかけてください'])

    const before = { ledger: source.forCompany('a').records.ledger(timed).length, notices: noticeRows().length, pushes: pushed.length }
    expect((await clock.runOnce()).moved).toBe(0)
    expect({ ledger: source.forCompany('a').records.ledger(timed).length, notices: noticeRows().length, pushes: pushed.length }).toEqual(before)

    nowMs = jst('2026-11-06T00:01')
    expect((await clock.runOnce()).moved).toBe(1)
    expect(stateOf(dayOnly).state).toBe('todo')
  })

  it('with 自動で進める on it becomes the AI’s turn (preparing), and the assignee is told', async () => {
    const id = await waitingTask('2026-11-04')
    autoRun.a = true
    await clock.runOnce()
    expect(stateOf(id).state).toBe('preparing')
    expect(ok(notices.list(m('u-bob'))).items.filter(i => i.kind === 'wait_over').map(i => i.text)).toEqual(['「見積の返事」の返事・届く見込みの日時が過ぎました。AI が追いかけを用意します'])
  })

  it('the assignee’s own 自動で進める decides: off → their turn; the company not allowing it → nobody’s AI', async () => {
    autoRun.a = true
    ok(await switches.set(m('u-bob'), { switch: 'autoRun', on: false }))
    // alice's own switch (on) does not matter: bob is the assignee, his PC would run it.
    ok(await switches.set(m('u-alice'), { switch: 'autoRun', on: true }))
    const id = await waitingTask('2026-11-04')
    await clock.runOnce()
    expect(stateOf(id).state).toBe('todo')

    ok(await switches.set(m('u-bob'), { switch: 'autoRun', on: true }))
    autoRun.a = false
    const second = await waitingTask('2026-11-04')
    await clock.runOnce()
    expect(stateOf(second).state).toBe('todo')
  })

  it('another company is untouched, and keeps running when one company fails', async () => {
    const inA = await waitingTask('2026-11-04', 'a')
    const inB = await waitingTask('2026-11-04', 'b')
    const notYet = await waitingTask('2026-11-09', 'b')
    failing.add('a')
    const run = await clock.runOnce()
    expect(run).toMatchObject({ moved: 1, failedCompanies: 1 })
    expect([stateOf(inA, 'a').state, stateOf(inB, 'b').state, stateOf(notYet, 'b').state]).toEqual(['waiting', 'todo', 'waiting'])
    expect(noticeRows('a')).toEqual([])
    expect(noticeRows('b').map(r => r.record_id)).toEqual([inB])
  })

  it('one company’s backlog is capped per run; the other company’s work still runs, the rest next time', async () => {
    wire({ moves: 3, notices: 500 })
    const many = []
    for (let i = 0; i < 5; i++) many.push(await waitingTask('2026-11-0' + (1 + (i % 3)), 'a'))
    const other = await waitingTask('2026-11-04', 'b')
    await clock.runOnce()
    expect(many.filter(id => stateOf(id, 'a').state === 'todo')).toHaveLength(3)
    expect(stateOf(other, 'b').state).toBe('todo')
    await clock.runOnce()
    expect(many.filter(id => stateOf(id, 'a').state === 'todo')).toHaveLength(5)
  })

  it('a run never overlaps one still going', async () => {
    await waitingTask('2026-11-04')
    const [first, second] = await Promise.all([clock.runOnce(), clock.runOnce()])
    expect([first.ran, second.ran]).toEqual([true, false])
    expect(first.moved).toBe(1)
  })
})

describe('the server clock: notices', () => {
  /** alice asked bob, due `due` (bob started it). */
  async function dueTask(due: string, co = 'a') {
    const t = ok(engine.create(m('u-alice', co), HUMAN, { type: 'task', title: '提案書', fields: { assignee: 'u-bob', due } })).record
    ok(await engine.act(m('u-bob', co), HUMAN, t.id, 'start', { expectedVersion: 1 }))
    return t.id
  }

  it('overdue is written by the clock the next business morning, once, to the requester only — reading adds no duplicate', async () => {
    // Friday 11-06; the morning after is Monday 11-09.
    const id = await dueTask('2026-11-06')
    pushed = []
    nowMs = jst('2026-11-09T08:59')
    await clock.runOnce()
    expect(noticeRows()).toEqual([])
    nowMs = jst('2026-11-09T09:00')
    expect((await clock.runOnce()).notices).toBe(1)
    expect(noticeRows()).toEqual([{ user_id: 'u-alice', kind: 'overdue', record_id: id, action: '' }])
    expect(pushed.filter(p => p.users.includes('u-alice'))).toHaveLength(1)
    expect((await clock.runOnce()).notices).toBe(0)
    expect(ok(notices.list(m('u-alice'))).items).toHaveLength(1)
    expect(noticeRows()).toHaveLength(1)
  })

  it('an owner-only record’s notices reach its owner only — never another member named in it, nor an owner/admin', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分用：歯医者', personal: true, fields: { assignee: 'u-alice' } })).record
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'wait', { expectedVersion: 1, args: { waiting_on: '予約', wait_until: '2026-11-04' } }))
    // Say its stored values name bob as requester and it is overdue (e.g. data written before
    // owner-only records): the requester still has to read it.
    const s = stateOf(t.id)
    const fields = { ...JSON.parse(s.fields), requested_by: 'u-bob', due: '2026-11-01' }
    conn.prepare('UPDATE record_state SET fields = ? WHERE company_id = ? AND record_id = ?').run(JSON.stringify(fields), 'a', t.id)
    await clock.runOnce()
    expect(stateOf(t.id).state).toBe('todo')
    expect(new Set(noticeRows().map(r => r.user_id))).toEqual(new Set(['u-alice']))
    for (const other of ['u-bob', 'u-owner']) expect(ok(notices.list(m(other))).items).toEqual([])
  })
})
