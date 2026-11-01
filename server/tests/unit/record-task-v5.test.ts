/**
 * Task version 5 (stage 2 S2, records.md "Task version 5"): preparing (the
 * AI's turn), 受けられない (decline), tags / wait_until / bundle / prepared,
 * and the query's ranges, sorting, "finished since" and link filter.
 *
 * Guards (each fails when its check in services/record-engine.ts,
 * services/records.ts or the task definition is removed):
 * - the AI can neither complete nor decline a task; only the assignee declines;
 * - a decline needs a note and tells only the requester, whose turn it becomes;
 * - a task created in `preparing` tells nobody and is not in 「あなたの番」
 *   until the AI hands it over; `prepared` holds only readable records of a
 *   type implementing `prepared` (one answer otherwise);
 * - ranges, sorting, finishedSince and the link filter return and count only
 *   records the member reads; an unreadable link target answers like a missing one;
 * - tasks made under version 4 stay valid under version 5.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type ActorInput, type RecordEngine, type ServiceRecordWriter } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'
import { CORE_TYPE_FILES } from '../../../shared/core/core-types'
import { canonicalTypeJson, compareTypeDefinitions, parseTypeFile, type TypeDefinition } from '../../../shared/core/record-types'
import { TASK_V4_TEXT } from '../helpers/task-v4'

const TS = '2026-10-31T00:00:00.000Z'
const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-mallory']
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let writer: ServiceRecordWriter
let notified: Array<[string, string[]]>
let tick = 0
const at = () => `2026-11-01T01:${String(Math.floor(tick / 60) % 60).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000Z`

const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code' }

const parse = (name: string, text: string): TypeDefinition => {
  const r = parseTypeFile(name, text)
  if (!r.ok) throw new Error(r.errors.join(' / '))
  return r.definition
}
const EFFORT = '---\nlabel: 取り組み\nversion: 1\nstorage: server\nimplements: [bundle]\nfields:\n  owner: { label: 持ち主, kind: person, source: server }\n  purpose: { label: 目的, kind: text, source: server }\nstates: [active]\n---\n'

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 経理: a folder u-mallory cannot read (scope rules).
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '経理', 'folder', ?)").run(`${id}-acc`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-acc-e`, `${id}-acc`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-mallory', 0, 0, ?)").run(`${id}-acc-m`, `${id}-acc`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  records.insertTypeVersion({ name: 'effort', version: 1, definition: canonicalTypeJson(parse('effort', EFFORT)), source: 'plugin', commitSha: null, createdAt: TS })
}

const ledger = (id: string, co = 'a') => source.forCompany(co).records.ledger(id)
const task = (by: Member, extra: Record<string, unknown> = {}, actor = HUMAN) =>
  ok(engine.create(by, actor, { type: 'task', title: '提案書を作る', ...extra, fields: { assignee: 'u-bob', ...(extra.fields as object | undefined) } })).record
/** A task requested by alice, assigned to bob, in progress (version 2). */
async function started(extra: Record<string, unknown> = {}) {
  const t = task(m('u-alice'), extra)
  ok(await engine.act(m('u-bob'), HUMAN, t.id, 'start', { expectedVersion: 1 }))
  notified = []
  return t
}
const effort = (folder?: string) => ok(engine.create(m('u-alice'), HUMAN, { type: 'effort', title: '春の講座', ...(folder ? { folder } : {}), fields: { owner: 'u-alice', purpose: '募集' } })).record
const ids = (r: { records: Array<{ id: string }> }) => r.records.map(x => x.id)

beforeEach(() => {
  tick = 0
  notified = []
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: at, nowMs: () => 0 }
  const base = {
    companyData: source, transactions: sqliteTransactions(conn), clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    isMember: (_c: string, userId: string) => PEOPLE.includes(userId),
    roleOf: (_c: string, userId: string) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null),
    notify: (companyId: string, userIds: string[]) => { notified.push([companyId, userIds]) },
  }
  engine = createRecordEngine({ ...base, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [] })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  writer = createServiceRecordWriter(base)
  company('a')
  company('b')
})

describe('the AI never completes or declines', () => {
  it('is refused for the assignee’s and the requester’s AI; only the assignee declines', async () => {
    const t = await started()
    for (const who of ['u-bob', 'u-alice']) {
      for (const action of ['decline', 'complete']) {
        expect(await engine.act(m(who), AI, t.id, action, { expectedVersion: 2, note: '無理です' }), `${who} ${action}`)
          .toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'NOT_ALLOWED' } })
      }
    }
    expect(await engine.act(m('u-alice'), HUMAN, t.id, 'decline', { expectedVersion: 2, note: '無理です' })).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(ledger(t.id)).toHaveLength(2)
    expect(notified).toEqual([])
  })
})

describe('受けられない (decline)', () => {
  it('needs a note, tells only the requester, and makes it their turn to reassign, cancel or reopen', async () => {
    const t = await started()
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'decline', { expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'NOTE_REQUIRED' } })
    const r = ok(await engine.act(m('u-bob'), HUMAN, t.id, 'decline', { expectedVersion: 2, note: '今月は手が回りません' }))
    expect(r.record).toMatchObject({ state: 'declined', fields: { next_actor: 'u-alice', assignee: 'u-bob' } })
    expect(notified).toEqual([['a', ['u-alice']]])
    expect(ids(ok(service.myTurn(m('u-alice'))))).toEqual([t.id])
    expect(ids(ok(service.myTurn(m('u-bob'))))).toEqual([])
    notified = []
    const again = ok(await engine.act(m('u-alice'), HUMAN, t.id, 'assign', { expectedVersion: 3, note: '代わりにお願いします', args: { assignee: 'u-owner' } }))
    expect(again.record).toMatchObject({ state: 'declined', fields: { assignee: 'u-owner', next_actor: 'u-owner' } })
    expect(notified).toEqual([['a', ['u-owner']]])
  })
})

describe('preparing: the AI’s turn before the person’s', () => {
  it('tells nobody and stays out of 「あなたの番」 until the AI hands it over with what it prepared', async () => {
    const t = task(m('u-alice'), { state: 'preparing' }, AI)
    expect(t.state).toBe('preparing')
    expect(notified).toEqual([])
    expect(ids(ok(service.myTurn(m('u-bob'))))).toEqual([])
    expect(ids(ok(service.aiTurn(m('u-bob'))))).toEqual([t.id])
    // Only a state the type lists may be named.
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', state: 'done' })).toMatchObject({ ok: false, body: { code: 'BAD_STATE' } })

    const mail = (co: string, folder?: string) => {
      const r = writer.create(co, { type: 'outbound_message', title: 'お礼', ...(folder ? { folder } : {}), fields: { requested_by: 'u-alice', assignee: 'u-alice' }, links: {}, actor: { id: 'u-alice', kind: 'ai', source: 'claude-code' } })
      if (!r.ok) throw new Error(r.reason)
      return r.record.id
    }
    // Not a type implementing `prepared`, a record the actor cannot read, another company's, a missing id: one answer.
    const closed = mail('a', '経理')
    const answers = await Promise.all([t.id, closed, mail('b'), 'outbound_message-0000000000000000'].map(id =>
      engine.act(m('u-mallory'), AI, t.id, 'finish_prep', { expectedVersion: 1, args: { prep_summary: '空きを確かめた' }, links: { prepared: [id] } })))
    for (const a of answers) expect(a).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
    expect(new Set(answers.map(a => JSON.stringify(a)))).toHaveProperty('size', 1)
    expect(ledger(t.id)).toHaveLength(1)

    const draft = mail('a')
    const r = ok(await engine.act(m('u-alice'), AI, t.id, 'finish_prep', { expectedVersion: 1, args: { prep_summary: '先方の空きを確かめ、返事の下書きを作りました' }, links: { prepared: [draft] } }))
    expect(r.record).toMatchObject({ state: 'todo', fields: { next_actor: 'u-bob', prep_summary: '先方の空きを確かめ、返事の下書きを作りました' } })
    expect(r.entry.changes).toEqual(expect.arrayContaining([{ field: 'links.prepared', before: null, after: draft }]))
    expect(notified).toEqual([['a', ['u-bob']]])
    expect(ids(ok(service.myTurn(m('u-bob'))))).toEqual([t.id])
  })
})

describe('the query: ranges, sorting, finished since, by link', () => {
  it('returns and counts only what the member reads', async () => {
    const t1 = task(m('u-alice'), { fields: { due: '2026-11-05T15:00' } })
    const t2 = task(m('u-alice'), { folder: '経理', fields: { due: '2026-11-05' } })
    const t3 = task(m('u-alice'), { fields: { due: '2026-11-03' } })
    const t4 = task(m('u-alice'))
    const week = { type: 'task', fields: { due: { gte: '2026-11-04', lt: '2026-11-06' } }, sort: { field: 'due' } }
    expect(ok(service.query(m('u-bob'), week))).toMatchObject({ total: 2, records: [{ id: t2.id }, { id: t1.id }] })
    expect(ok(service.query(m('u-mallory'), week))).toMatchObject({ total: 1, records: [{ id: t1.id }] })
    expect(ok(service.query(m('u-mallory'), { ...week, countOnly: true })).total).toBe(1)
    expect(ids(ok(service.query(m('u-bob'), { type: 'task', sort: { field: 'due' } })))).toEqual([t3.id, t2.id, t1.id, t4.id])
    expect(ids(ok(service.query(m('u-mallory'), { type: 'task', sort: { field: 'due', order: 'desc' } })))).toEqual([t1.id, t3.id, t4.id])
    // Only ordered kinds.
    expect(service.query(m('u-bob'), { type: 'task', sort: { field: 'purpose' } })).toMatchObject({ ok: false })

    // Finished since: in a final state entered after the time.
    const since = at()
    for (const t of [t1, t2]) ok(await engine.act(m('u-alice'), HUMAN, t.id, 'cancel', { expectedVersion: 1, note: '不要' }))
    const finished = { finishedSince: since }
    expect(ids(ok(service.query(m('u-bob'), finished))).sort()).toEqual([t1.id, t2.id].sort())
    expect(ok(service.query(m('u-mallory'), finished))).toMatchObject({ total: 1, records: [{ id: t1.id }] })
    expect(ok(service.query(m('u-mallory'), { ...finished, countOnly: true })).total).toBe(1)
    expect(ok(service.query(m('u-bob'), { finishedSince: at() })).total).toBe(0)

    // By bundle.
    const e = effort()
    for (const t of [t3, t4]) ok(await engine.act(m('u-alice'), HUMAN, t.id, 'set_bundle', { expectedVersion: 1, links: { bundle: e.id } }))
    const closedTask = task(m('u-alice'), { folder: '経理', links: { bundle: e.id } })
    const inBundle = { link: { name: 'bundle', id: e.id } }
    expect(ids(ok(service.query(m('u-bob'), inBundle))).sort()).toEqual([t3.id, t4.id, closedTask.id].sort())
    expect(ok(service.query(m('u-mallory'), { ...inBundle, countOnly: true })).total).toBe(2)
    // A bundle the member cannot read answers like one that does not exist.
    const closedBundle = effort('経理')
    const hidden = service.query(m('u-mallory'), { link: { name: 'bundle', id: closedBundle.id } })
    expect(hidden).toMatchObject({ ok: false, kind: 'not-found' })
    expect(hidden).toEqual(service.query(m('u-mallory'), { link: { name: 'bundle', id: 'effort-0000000000000000' } }))
    // Another company's bundle is one that does not exist.
    expect(service.query(m('u-alice', 'b'), inBundle)).toEqual(hidden)
  })
})

describe('version 5 only adds to version 4', () => {
  it('a task made under version 4 keeps working under version 5', async () => {
    const v4 = parse('task', TASK_V4_TEXT)
    const v5 = parse('task', CORE_TYPE_FILES.task)
    expect(compareTypeDefinitions(v4, v5)).toMatchObject({ breaking: [], versionProblem: null, changed: true })
    // Company c still on version 4 when the task was made.
    company('c')
    const records = source.forCompany('c').records
    conn.prepare("DELETE FROM record_types WHERE company_id = 'c' AND name = 'task'").run()
    records.insertTypeVersion({ name: 'task', version: 4, definition: canonicalTypeJson(v4), source: 'core', commitSha: null, createdAt: TS })
    const t = ok(engine.create(m('u-alice', 'c'), HUMAN, { type: 'task', title: '古いタスク', fields: { assignee: 'u-bob' } })).record
    expect(t.typeVersion).toBe(4)
    ensureCoreTypes(records, at())
    ok(await engine.act(m('u-bob', 'c'), HUMAN, t.id, 'start', { expectedVersion: 1 }))
    const r = ok(await engine.act(m('u-bob', 'c'), HUMAN, t.id, 'decline', { expectedVersion: 2, note: '担当外でした' }))
    expect(r.record).toMatchObject({ state: 'declined', typeVersion: 4 })
  })
})
