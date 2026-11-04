/**
 * Notices (知らせ, stage 2 S5, `.claude/rules/notifications.md`) on the real
 * schema, the real state engine and the real push channel, wired as in
 * composition.ts.
 *
 * Guards (each fails when its check in services/notifications.ts or the
 * company handle is removed):
 * - a member never receives — nor marks read — another member's notices;
 * - another company's notices are never listed or changed through this one;
 * - the push carries only `{ kind: 'notifications', version }`, to the told
 *   members of that company, never the actor;
 * - a notice disappears when the member can no longer read the record;
 * - the read state is the server's: a second PC sees it and is told;
 * - the owner's default kinds (E-25), and a member's switch;
 * - overdue (once per due, to the requester only) and a stuck AI turn (24 h,
 *   once per version) are computed when read.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordChange, type RecordEngine, type ServiceRecordWriter } from '../../src/services/record-engine'
import { createNotificationService, type NotificationService } from '../../src/services/notifications'
import { createPushChannel, type PushChannel } from '../../src/services/push-channel'
import type { Member } from '../../src/services/access'
import type { PushEvent } from '../../../shared/types/agent-stop'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'
import { INBOX_ACTOR } from '../../../shared/core/core-types'

const TS = '2026-11-01T00:00:00.000Z'
const MEMBERS: Record<string, string[]> = {
  a: ['u-owner', 'u-alice', 'u-bob', 'u-carol', 'u-mallory'],
  b: ['u-owner', 'u-alice', 'u-bob', 'u-zed'],
}
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let writer: ServiceRecordWriter
let notices: NotificationService
let push: PushChannel
let nowMs: number

const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN = { kind: 'human' as const }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

/** A job only the AI moves (`run` is `who: [ai]`), requested of someone: 「AI の番」. */
const JOB_TYPE = `---
label: 下ごしらえ
version: 1
storage: server
implements: [request]
fields:
  requested_by: { label: 依頼した人, kind: person, source: server }
  assignee:     { label: 担当, kind: person, source: server }
  next_actor:   { label: 次に動く人, kind: person, source: server }
  waiting_on:   { label: 待っているもの, kind: text, source: server }
  due:          { label: 期限, kind: date, source: server }
states: [queued, done]
initial: queued
final: [done]
actions:
  run: { label: 進める, from: [queued], to: done, who: [ai] }
---
`

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 経理: everyone reads, until a rule closes it to someone.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '経理', 'folder', ?)").run(`${id}-acc`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-acc-e`, `${id}-acc`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  const job = parseTypeFile('job', JOB_TYPE)
  if (!job.ok) throw new Error(job.errors.join())
  records.insertTypeVersion({ name: 'job', version: 1, definition: canonicalTypeJson(job.definition), source: 'plugin', commitSha: null, createdAt: TS })
}

function closeAccounting(userId: string, co = 'a') {
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', ?, 0, 0, ?)").run(`${co}-acc-${userId}`, `${co}-acc`, userId, TS)
}

/** A task alice asked bob for, to be checked first (so bob finishes it on someone's OK), started (version 2). */
async function startedTask(opts: { folder?: string; co?: string; title?: string; due?: string } = {}) {
  const co = opts.co ?? 'a'
  const t = ok(engine.create(m('u-alice', co), HUMAN, {
    type: 'task', title: opts.title ?? '提案書を作る', ...(opts.folder ? { folder: opts.folder } : {}),
    fields: { assignee: 'u-bob', when_done: 'check', ...(opts.due ? { due: opts.due } : {}) },
  })).record
  ok(await engine.act(m('u-bob', co), HUMAN, t.id, 'start', { expectedVersion: 1 }))
  return t
}

const list = (userId: string, co = 'a', service = notices) => ok(service.list(m(userId, co)))

/** The events one open connection (one PC) of this member receives. */
function subscribe(co: string, userId: string): PushEvent[] {
  const got: PushEvent[] = []
  const r = push.open(co, userId, { send: e => got.push(e) })
  if (!r.ok) throw new Error(r.reason)
  return got
}

/** The company's acceptance setting for the engine (team mode: every request waits for 引き受ける). */
let autoAccepts: ((companyId: string) => boolean) | undefined

function wire() {
  const shared = {
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') },
  }
  const roleOf = (co: string, userId: string) => ((MEMBERS[co] ?? []).includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null)
  const service = createNotificationService({
    ...shared,
    roleOf,
    accounts: { byIds: ids => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id.replace('u-', '').replace(/^./, c => c.toUpperCase()) }])) },
    push: (companyId, userIds) => push.notify(companyId, userIds, { kind: 'notifications', version: shared.ids.newToken().slice(0, 32) }),
    membersOf: co => MEMBERS[co] ?? [],
  })
  const notify = (companyId: string, userIds: string[], change?: RecordChange) => {
    push.notify(companyId, userIds, { kind: 'records', version: shared.ids.newToken().slice(0, 32) })
    if (change) service.recordChange(companyId, userIds, change)
  }
  const isMember = (co: string, userId: string) => (MEMBERS[co] ?? []).includes(userId)
  engine = createRecordEngine({ ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf, notify, ...(autoAccepts ? { autoAccepts } : {}) })
  writer = createServiceRecordWriter({ ...shared, isMember, roleOf, notify })
  return service
}

beforeEach(() => {
  nowMs = Date.parse('2026-11-02T01:00:00.000Z')
  autoAccepts = undefined
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  push = createPushChannel()
  notices = wire()
  company('a')
  company('b')
})

describe('notices from the engine', () => {
  it('the owner’s default kinds: the requester and the OK-giver are told, never the actor', async () => {
    const t = await startedTask()
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'set_due', { expectedVersion: 2, args: { due: '2026-11-20T15:00' } }))
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 3, ok: { by: 'u-carol' } }))

    const alice = list('u-alice')
    expect(alice.unread).toBe(2)
    expect(alice.items.map(i => [i.kind, i.text])).toEqual([
      ['request_done', 'Bobさんが「提案書を作る」を完了にしました'],
      ['due_changed', 'Bobさんが「提案書を作る」の期限を11月20日 15:00に変えました'],
    ])
    expect(list('u-carol').items.map(i => [i.kind, i.text])).toEqual([['ok_completed', 'Bobさんが「提案書を作る」を、あなたの OK で完了にしました']])
    // bob was asked (create: on by default) and acted on the rest himself.
    expect(list('u-bob').items.map(i => [i.kind, i.text])).toEqual([['asked', 'Aliceさんから「提案書を作る」を頼まれました']])
  })

  it('task v5: 受けられない comes back to the requester (on by default); the AI’s preparation tells the assignee', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積書', fields: { assignee: 'u-bob' } })).record
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'decline', { expectedVersion: 1, note: '今週は手が空きません' }))
    expect(list('u-alice').items.map(i => [i.kind, i.text])).toEqual([['request_returned', 'Bobさんが「見積書」をあなたに戻しました（受けられない）']])

    const p = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '下調べ', state: 'preparing', fields: { assignee: 'u-bob' } })).record
    expect(p.state).toBe('preparing')
    ok(notices.setSettings(m('u-bob'), { kinds: { others: true } }))
    // While it is the AI's turn nobody is told; the AI's hand-over tells the assignee.
    expect(list('u-bob').items.map(i => i.recordId)).not.toContain(p.id)
    ok(await engine.act(m('u-alice'), { kind: 'ai' as const, source: 'claude-code' }, p.id, 'finish_prep', { expectedVersion: 1, args: { prep_summary: '空きを確かめました' } }))
    expect(list('u-bob').items.filter(i => i.recordId === p.id).map(i => i.text)).toEqual(['Aliceさんから「下調べ」を頼まれました（AI が用意しました）'])
  })

  it('an approval’s result is the requester’s notice', async () => {
    const created = writer.create('a', {
      type: 'approval', title: '金額の変更', fields: { assignee: 'u-bob', operation: 'hubspot.update_deal', payload_hash: 'sha256:aa', payload_version: 1 },
      actor: { id: 'u-alice', kind: 'human', source: null },
    })
    if (!created.ok) throw new Error(created.reason)
    const r = writer.transition('a', { recordId: created.record.id, action: 'approve', expectedVersion: 1, to: 'approved', actor: { id: 'u-bob', kind: 'human', source: null }, notify: ['u-alice'] })
    expect(r.ok).toBe(true)
    expect(list('u-alice').items.map(i => [i.kind, i.text])).toEqual([['approval_result', '「金額の変更」が承認されました（Bobさん）']])
  })

  it('a member never receives, nor marks read, another member’s notices', async () => {
    const t = await startedTask()
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-carol' } }))
    const aliceIds = list('u-alice').items.map(i => i.id)
    expect(aliceIds).toHaveLength(1)
    for (const other of ['u-mallory', 'u-carol', 'u-owner']) {
      expect(list(other).items.map(i => i.id)).not.toContain(aliceIds[0])
      expect(ok(notices.markRead(m(other), { ids: aliceIds }))).toEqual({ changed: 0 })
    }
    expect(list('u-alice').unread).toBe(1)
  })

  it('another company’s notices are not listed or changed through this one', async () => {
    const t = await startedTask({ co: 'b' })
    // u-alice is a member of both: her notice from b is not hers in a.
    ok(await engine.act(m('u-bob', 'b'), HUMAN, t.id, 'set_due', { expectedVersion: 2, args: { due: '2026-11-20' } }))
    const inB = list('u-alice', 'b')
    expect(inB.items.map(i => i.kind)).toEqual(['due_changed'])
    expect(list('u-alice', 'a').items).toEqual([])
    expect(ok(notices.markRead(m('u-alice', 'a'), { ids: [inB.items[0].id] }))).toEqual({ changed: 0 })
    expect(ok(notices.markRead(m('u-alice', 'a'), { all: true }))).toEqual({ changed: 0 })
    expect(list('u-alice', 'b').unread).toBe(1)
  })

  it('the push carries only kind + version, to the told members of that company', async () => {
    const aliceA = subscribe('a', 'u-alice')
    const aliceB = subscribe('b', 'u-alice')
    const bob = subscribe('a', 'u-bob')
    const mallory = subscribe('a', 'u-mallory')
    const t = await startedTask({ title: '社外秘の提案書' })
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { note: '先方からメールで了承' } }))
    const told = aliceA.filter(e => e.kind === 'notifications')
    expect(told).toHaveLength(1)
    for (const e of told) {
      expect(Object.keys(e).sort()).toEqual(['kind', 'version'])
      expect(e.version).toMatch(/^[0-9a-f]{32}$/)
    }
    expect(JSON.stringify(aliceA)).not.toMatch(/社外秘|先方|task-/)
    expect(aliceB).toEqual([])
    expect(mallory).toEqual([])
    // bob was asked (one signal) and then acted: his own act tells him nothing more.
    expect(bob.filter(e => e.kind === 'notifications')).toHaveLength(1)
    // A writer that names the actor (a plugin's write done for bob): bob is still not told.
    const entry = source.forCompany('a').records.ledger(t.id).at(-1)!
    notices.recordChange('a', ['u-bob'], { type: 'task', entry, fields: {} })
    expect(bob.filter(e => e.kind === 'notifications')).toHaveLength(1)
    ok(notices.setSettings(m('u-bob'), { kinds: { others: true } }))
    expect(list('u-bob').items.map(i => i.version)).not.toContain(entry.version)
  })

  it('an owner-only record’s notices reach its owner alone — never another member, nor an owner/admin', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分用：歯医者の予約', personal: true, fields: { assignee: 'u-alice' } })).record
    for (const u of ['u-alice', 'u-bob', 'u-owner']) ok(notices.setSettings(m(u), { kinds: { others: true } }))
    const ownerPc = subscribe('a', 'u-owner')
    const bobPc = subscribe('a', 'u-bob')
    // A writer naming everyone (an outside system's change, so the owner is not the actor).
    const entry = { ...source.forCompany('a').records.ledger(t.id).at(-1)!, actorId: 'hubspot', actorKind: 'external' as const }
    notices.recordChange('a', ['u-alice', 'u-bob', 'u-owner'], { type: 'task', entry, fields: { assignee: 'u-alice', requested_by: 'u-alice' } })
    expect(list('u-alice').items.map(i => i.recordId)).toEqual([t.id])
    for (const other of ['u-bob', 'u-owner']) {
      expect(list(other)).toEqual({ available: true, unread: 0, items: [] })
      expect(JSON.stringify(list(other))).not.toMatch(/歯医者/)
    }
    // No signal either, and no row to find later.
    expect([...ownerPc, ...bobPc].filter(e => e.kind === 'notifications')).toEqual([])
    expect(conn.prepare("SELECT user_id FROM notifications WHERE record_id = ?").all(t.id)).toEqual([{ user_id: 'u-alice' }])
  })

  it('a notice disappears when the member can no longer read the record', async () => {
    const t = await startedTask({ folder: '経理' })
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-carol' } }))
    expect(list('u-carol').unread).toBe(1)
    closeAccounting('u-carol')
    const after = list('u-carol')
    expect(after).toEqual({ available: true, unread: 0, items: [] })
    expect(JSON.stringify(after)).not.toMatch(/提案書|経理/)
    // The company's records turned off: no bell at all.
    source.forCompany('a').records.setEnabled(false, 'u-owner', TS)
    expect(list('u-alice')).toEqual({ available: false, unread: 0, items: [] })
  })

  it('the read state is the server’s: a second PC sees it and is told', async () => {
    const t = await startedTask()
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-carol' } }))
    const pc2 = subscribe('a', 'u-alice')
    const secondPc = wire()
    const id = list('u-alice').items[0].id
    expect(ok(notices.markRead(m('u-alice'), { ids: [id] }))).toEqual({ changed: 1 })
    expect(pc2.filter(e => e.kind === 'notifications')).toHaveLength(1)
    expect(list('u-alice', 'a', secondPc)).toMatchObject({ unread: 0, items: [{ id, read: true }] })
    // Malformed bodies are refused.
    for (const body of [null, [], {}, { ids: 'x' }, { all: false }, { all: true, ids: [] }, { ids: Array(201).fill('x') }]) {
      expect(notices.markRead(m('u-alice'), body)).toMatchObject({ ok: false, kind: 'bad-request' })
    }
  })

  it('a member’s switches are kept on the server; an unknown kind is refused', () => {
    expect(ok(notices.settings(m('u-alice'))).kinds).toMatchObject({ request_done: true, approval_result: true, due_changed: true, others: false })
    ok(notices.setSettings(m('u-alice'), { kinds: { due_changed: false } }))
    expect(ok(wire().settings(m('u-alice'))).kinds).toMatchObject({ due_changed: false, request_done: true })
    expect(ok(notices.settings(m('u-bob'))).kinds.due_changed).toBe(true)
    expect(ok(notices.settings(m('u-alice', 'b'))).kinds.due_changed).toBe(true)
    for (const body of [{ kinds: { nope: true } }, { kinds: { due_changed: 'no' } }, { kinds: [] }, {}]) {
      expect(notices.setSettings(m('u-alice'), body)).toMatchObject({ ok: false, kind: 'bad-request' })
    }
  })
})

describe('notices computed when read', () => {
  it('overdue: once per due, to the requester only, the next business morning (company clock)', async () => {
    await startedTask({ due: '2026-11-02' })
    // 2026-11-02 10:00 in Japan: the day is not over.
    expect(list('u-alice').items).toEqual([])
    nowMs = Date.parse('2026-11-02T15:00:00.000Z') // 11-03 00:00 in Japan (文化の日: no business morning yet)
    expect(list('u-alice').items).toEqual([])
    nowMs = Date.parse('2026-11-03T23:59:00.000Z') // 11-04 08:59 in Japan
    expect(list('u-alice').items).toEqual([])
    nowMs = Date.parse('2026-11-04T00:00:00.000Z') // 11-04 09:00 in Japan
    expect(list('u-alice').items.map(i => [i.kind, i.text])).toEqual([['overdue', '「提案書を作る」が期限（11月2日）を過ぎています']])
    expect(list('u-alice').items).toHaveLength(1)
    expect(list('u-bob').items.filter(i => i.kind !== 'asked')).toEqual([])
    // Their own task (requester = assignee) is no notice.
    ok(engine.create(m('u-carol'), HUMAN, { type: 'task', title: '自分の', fields: { assignee: 'u-carol', due: '2026-11-01' } }))
    expect(list('u-carol').items).toEqual([])
  })

  it('a stuck AI turn: after 24 h, to the requester, once per version', () => {
    ok(engine.create(m('u-alice'), HUMAN, { type: 'job', title: '下ごしらえ', fields: { assignee: 'u-bob' } }))
    nowMs += 23 * 3600_000
    expect(list('u-alice').items).toEqual([])
    nowMs += 2 * 3600_000
    expect(list('u-alice').items.map(i => i.kind)).toEqual(['ai_turn_stuck'])
    nowMs += 48 * 3600_000
    expect(list('u-alice').items).toHaveLength(1)
    expect(list('u-bob').items.filter(i => i.kind !== 'asked')).toEqual([])
  })
})

/** `YYYY-MM-DDTHH:MM` in Japan → the server clock's ms. */
const jst = (local: string) => Date.parse(`${local}:00+09:00`)
const ofKind = (userId: string, kind: string) => list(userId).items.filter(i => i.kind === kind)
const rowsOf = (kind: string) => conn.prepare('SELECT user_id, dedupe_key FROM notifications WHERE kind = ? ORDER BY rowid').all(kind) as Array<{ user_id: string; dedupe_key: string }>

describe('noticing one’s own turn without Slack (owner decision 2026-11-03)', () => {
  it('「今日のあなたの番」: once per business morning per member with a turn, counts when read, none on days off or late', async () => {
    nowMs = jst('2026-11-02T10:00')
    await startedTask({ title: '見積書', due: '2026-11-04' })
    await startedTask({ title: '議事録', due: '2026-11-02' })
    // Not started, no due (「いつか」): in bob's turn but not counted (shared/core/turn-timing.ts).
    ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '下書き', fields: { assignee: 'u-bob' } }))
    // 文化の日 (a holiday): no morning.
    nowMs = jst('2026-11-03T09:00')
    notices.sweep('a', 500)
    expect(rowsOf('morning_summary')).toEqual([])
    nowMs = jst('2026-11-04T08:29')
    notices.sweep('a', 500)
    expect(rowsOf('morning_summary')).toEqual([])
    nowMs = jst('2026-11-04T08:30')
    const bobPc = subscribe('a', 'u-bob')
    notices.sweep('a', 500)
    notices.sweep('a', 500)
    // Only bob has something in あなたの番 (alice asked; the others have nothing): one notice, one signal.
    expect(rowsOf('morning_summary')).toEqual([{ user_id: 'u-bob', dedupe_key: 'morning_summary:2026-11-04' }])
    expect(bobPc.filter(e => e.kind === 'notifications')).toHaveLength(1)
    const [summary] = ofKind('u-bob', 'morning_summary')
    expect(summary).toMatchObject({
      recordId: '', text: '今日のあなたの番 2件（期限が今日 1件・期限を過ぎた 1件）',
      desktop: { title: '今日のあなたの番 2件（期限が今日 1件・期限を過ぎた 1件）' },
    })
    // Opened after 15:00: no Mac notification any more (the notice stays in the bell).
    nowMs = jst('2026-11-04T15:00')
    expect(ofKind('u-bob', 'morning_summary')[0].desktop).toBeUndefined()
    // A day the server first runs after 15:00 gets none; Saturday none.
    nowMs = jst('2026-11-05T15:01')
    notices.sweep('a', 500)
    nowMs = jst('2026-11-07T09:00')
    notices.sweep('a', 500)
    expect(rowsOf('morning_summary')).toHaveLength(1)
    // The next business morning: one more. The kind turned off: not shown.
    nowMs = jst('2026-11-09T09:00')
    notices.sweep('a', 500)
    expect(ofKind('u-bob', 'morning_summary')).toHaveLength(2)
    ok(notices.setSettings(m('u-bob'), { kinds: { morning_summary: false } }))
    expect(ofKind('u-bob', 'morning_summary')).toEqual([])
  })

  it('「今日のあなたの番」 counts only this week: a task not started with no due or a due after this week is not counted, nor greeted for', async () => {
    nowMs = jst('2026-11-02T10:00')
    // carol: only resting tasks — no due (いつか) and due next week, not started (先のこと).
    ok(engine.create(m('u-carol'), HUMAN, { type: 'task', title: 'いつか読む', fields: { assignee: 'u-carol' } }))
    ok(engine.create(m('u-carol'), HUMAN, { type: 'task', title: '来週の準備', fields: { assignee: 'u-carol', due: '2026-11-12' } }))
    // bob: one due this week (counted), one started with no due (counted), one resting (not).
    ok(engine.create(m('u-bob'), HUMAN, { type: 'task', title: '今週の見積', fields: { assignee: 'u-bob', due: '2026-11-06' } }))
    const started = ok(engine.create(m('u-bob'), HUMAN, { type: 'task', title: '進めている', fields: { assignee: 'u-bob' } })).record
    ok(await engine.act(m('u-bob'), HUMAN, started.id, 'start', { expectedVersion: 1 }))
    ok(engine.create(m('u-bob'), HUMAN, { type: 'task', title: 'いつか', fields: { assignee: 'u-bob' } }))
    nowMs = jst('2026-11-04T08:30')
    notices.sweep('a', 500)
    expect(rowsOf('morning_summary')).toEqual([{ user_id: 'u-bob', dedupe_key: 'morning_summary:2026-11-04' }])
    expect(ofKind('u-bob', 'morning_summary')[0].text).toBe('今日のあなたの番 2件')
  })

  it('「明日が期限」: to the assignee on the last business day before the due, once per due value, never when finished', async () => {
    nowMs = jst('2026-11-02T10:00')
    const t = await startedTask({ title: '見積書', due: '2026-11-05' })
    const monday = await startedTask({ title: '月曜の資料', due: '2026-11-09T10:00' })
    const done = await startedTask({ title: '終わったもの', due: '2026-11-05' })
    ok(await engine.act(m('u-alice'), HUMAN, done.id, 'cancel', { expectedVersion: 2, note: '不要になりました' }))
    nowMs = jst('2026-11-04T08:59')
    notices.sweep('a', 500)
    expect(rowsOf('due_tomorrow')).toEqual([])
    nowMs = jst('2026-11-04T09:00')
    notices.sweep('a', 500)
    notices.sweep('a', 500)
    expect(rowsOf('due_tomorrow')).toEqual([{ user_id: 'u-bob', dedupe_key: `due_tomorrow:${t.id}:2026-11-05` }])
    expect(ofKind('u-bob', 'due_tomorrow')).toMatchObject([{ text: '「見積書」は明日（11月5日）が期限です', desktop: { title: '明日が期限です', body: '見積書' } }])
    expect(ofKind('u-alice', 'due_tomorrow')).toEqual([])
    // The due moved: the old one is no longer news; told again for the new value, on its own eve.
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'set_due', { expectedVersion: 2, args: { due: '2026-11-06' } }))
    expect(ofKind('u-bob', 'due_tomorrow')[0].desktop).toBeUndefined()
    nowMs = jst('2026-11-05T09:00')
    notices.sweep('a', 500)
    expect(rowsOf('due_tomorrow').map(r => r.dedupe_key)).toEqual([`due_tomorrow:${t.id}:2026-11-05`, `due_tomorrow:${t.id}:2026-11-06`])
    // A Monday due: Friday is the last business day before it (nothing on Wednesday or Thursday).
    nowMs = jst('2026-11-06T09:00')
    notices.sweep('a', 500)
    expect(ofKind('u-bob', 'due_tomorrow').filter(i => i.recordId === monday.id))
      .toMatchObject([{ text: '「月曜の資料」の期限は11月9日 10:00です（その前の最後の営業日のお知らせ）', desktop: { title: '11月9日が期限です' } }])
    // The cancelled task was never told; the kind off → not shown.
    expect(rowsOf('due_tomorrow').map(r => r.dedupe_key).join()).not.toContain(done.id)
    expect(rowsOf('due_tomorrow')).toHaveLength(3)
    ok(notices.setSettings(m('u-bob'), { kinds: { due_tomorrow: false } }))
    expect(ofKind('u-bob', 'due_tomorrow')).toEqual([])
  })

  it('being asked: once per assignment — by a person, by someone’s AI, and when the own AI hands over', async () => {
    const bobPc = subscribe('a', 'u-bob')
    // A person asks.
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積書', fields: { assignee: 'u-bob' } })).record
    expect(ofKind('u-bob', 'asked')).toMatchObject([{ recordId: t.id, text: 'Aliceさんから「見積書」を頼まれました', desktop: { title: 'Aliceさんから頼まれました', body: '見積書' } }])
    expect(bobPc.filter(e => e.kind === 'notifications')).toHaveLength(1)
    // The same change told again (a retry) writes and signals nothing more.
    const entry = source.forCompany('a').records.ledger(t.id).at(-1)!
    notices.recordChange('a', ['u-bob'], { type: 'task', entry, fields: { assignee: 'u-bob', requested_by: 'u-alice', next_actor: 'u-bob' } })
    expect(ofKind('u-bob', 'asked')).toHaveLength(1)
    expect(bobPc.filter(e => e.kind === 'notifications')).toHaveLength(1)
    // Someone's AI asks (alice's AI creates it for bob).
    const byAi = ok(engine.create(m('u-alice'), { kind: 'ai' as const, source: 'claude-code' }, { type: 'task', title: '下調べ', fields: { assignee: 'u-bob' } })).record
    expect(ofKind('u-bob', 'asked').filter(i => i.recordId === byAi.id).map(i => i.text)).toEqual(['Aliceさんから「下調べ」を頼まれました'])
    // Prepared by bob's own AI first: told when his AI hands it over (he did not ask it of himself), once.
    const p = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '準備', state: 'preparing', fields: { assignee: 'u-bob' } })).record
    expect(ofKind('u-bob', 'asked').map(i => i.recordId)).not.toContain(p.id)
    ok(await engine.act(m('u-bob'), { kind: 'ai' as const, source: 'claude-code' }, p.id, 'finish_prep', { expectedVersion: 1, args: { prep_summary: '確かめました' } }))
    expect(ofKind('u-bob', 'asked').filter(i => i.recordId === p.id).map(i => i.text)).toEqual(['Aliceさんから「準備」を頼まれました（AI が用意しました）'])
    // His own AI making his own task: nothing.
    const own = ok(engine.create(m('u-bob'), { kind: 'ai' as const, source: 'claude-code' }, { type: 'task', title: '自分の', fields: { assignee: 'u-bob' } })).record
    expect(ofKind('u-bob', 'asked').map(i => i.recordId)).not.toContain(own.id)
    expect(ofKind('u-bob', 'asked')).toHaveLength(3)
    // Asking is about the assignee: alice (the requester) never gets `asked`.
    expect(ofKind('u-alice', 'asked')).toEqual([])
    // Twelve hours on, being asked is no longer a Mac notification.
    nowMs += 12 * 3600_000
    expect(ofKind('u-bob', 'asked').every(i => i.desktop === undefined)).toBe(true)
  })

  it('being asked with team mode on: the 引き受け待ち notice asks to decide, once', async () => {
    autoAccepts = () => false
    notices = wire()
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積書', fields: { assignee: 'u-bob' } })).record
    expect(t.state).toBe('awaiting_acceptance')
    expect(ofKind('u-bob', 'asked').map(i => i.text)).toEqual(['Aliceさんから「見積書」を頼まれました。引き受けるか、受けられないかを決めてください'])
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'accept', { expectedVersion: 1 }))
    expect(ofKind('u-bob', 'asked')).toHaveLength(1)
    ok(notices.setSettings(m('u-bob'), { kinds: { asked: false } }))
    expect(ofKind('u-bob', 'asked')).toEqual([])
  })
})

/** A message that came in (来た連絡) as the inbox records it: alice's own, or a department's. */
function message(opts: { folder?: string } = {}): string {
  const made = writer.create('a', {
    type: 'interaction', title: '経費精算の承認依頼',
    ...(opts.folder ? { folder: opts.folder } : { personalOwner: 'u-alice' }),
    fields: { assignee: 'u-alice', next_actor: 'u-alice', occurred_at: '2026-11-02T01:00:00.000Z', channel: 'email' },
    actor: INBOX_ACTOR, state: 'received', quiet: true,
  })
  if (!made.ok) throw new Error(made.reason)
  return made.record.id
}

describe('a task from a message (owner FB #13)', () => {
  const AI_ACTOR = { kind: 'ai' as const, source: 'claude-code' }

  it('the member’s own AI making their task from a message tells them once; a person’s own create and the AI’s other work do not', async () => {
    const msg = message()
    const alicePc = subscribe('a', 'u-alice')
    const t = ok(engine.createByAi(m('u-alice'), AI_ACTOR, { type: 'task', title: '経費精算を承認する', personal: true, fields: { assignee: 'u-alice' }, links: { interaction: [msg] } })).record
    expect(ofKind('u-alice', 'from_message')).toMatchObject([{ recordId: t.id, text: '来た連絡から、やることを作りました：「経費精算を承認する」' }])
    expect(alicePc.filter(e => e.kind === 'notifications')).toHaveLength(1)
    // Owner-only like its message: nobody else — the owner included — hears of it.
    for (const u of ['u-bob', 'u-owner']) expect(list(u).items).toEqual([])
    // A retried notify writes nothing more (once per record).
    const entry = source.forCompany('a').records.ledger(t.id)[0]
    notices.recordChange('a', ['u-alice'], { type: 'task', entry, fields: { assignee: 'u-alice', requested_by: 'u-alice', next_actor: 'u-alice' } })
    expect(ofKind('u-alice', 'from_message')).toHaveLength(1)
    // The AI's other work on it (a due changed) is not a new notice of this kind.
    ok(await engine.act(m('u-alice'), AI_ACTOR, t.id, 'set_due', { expectedVersion: 1, args: { due: '2026-11-06' } }))
    expect(ofKind('u-alice', 'from_message')).toHaveLength(1)
    // The AI's own task not made from a message, and a person's own create from it: nothing.
    const plain = ok(engine.createByAi(m('u-alice'), AI_ACTOR, { type: 'task', title: 'メモを整理する', fields: { assignee: 'u-alice' } })).record
    const byHand = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分で作った', personal: true, fields: { assignee: 'u-alice' }, links: { interaction: [msg] } })).record
    expect(list('u-alice').items.map(i => i.recordId)).not.toContain(plain.id)
    expect(list('u-alice').items.map(i => i.recordId)).not.toContain(byHand.id)
    // A member switches the kind off like any other.
    ok(notices.setSettings(m('u-alice'), { kinds: { from_message: false } }))
    expect(ofKind('u-alice', 'from_message')).toEqual([])
  })

  it('made in the AI’s preparation: told when the AI hands it over, once', async () => {
    const msg = message()
    const p = ok(engine.createByAi(m('u-alice'), AI_ACTOR, { type: 'task', title: '請求書を確かめる', personal: true, state: 'preparing', fields: { assignee: 'u-alice' }, links: { interaction: [msg] } })).record
    expect(ofKind('u-alice', 'from_message')).toEqual([])
    ok(await engine.act(m('u-alice'), AI_ACTOR, p.id, 'finish_prep', { expectedVersion: 1, args: { prep_summary: '金額を確かめました' } }))
    expect(ofKind('u-alice', 'from_message').map(i => i.recordId)).toEqual([p.id])
    // Made by the person (in the AI's preparation), handed over by their AI: their own create, no notice.
    const own = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分で頼んだ', personal: true, state: 'preparing', fields: { assignee: 'u-alice' }, links: { interaction: [msg] } })).record
    ok(await engine.act(m('u-alice'), AI_ACTOR, own.id, 'finish_prep', { expectedVersion: 1, args: { prep_summary: '確かめました' } }))
    expect(ofKind('u-alice', 'from_message').map(i => i.recordId)).toEqual([p.id])
  })

  it('a department’s message: only the assignee is told, and not once they cannot read it', async () => {
    const msg = message({ folder: '経理' })
    // Made for bob (he is `asked`); alice's AI later giving it to her is not a task made from a message for her.
    const forBob = ok(engine.createByAi(m('u-alice'), AI_ACTOR, { type: 'task', title: '請求を確かめる', folder: '経理', fields: { assignee: 'u-bob' }, links: { interaction: [msg] } })).record
    expect(ofKind('u-bob', 'asked').map(i => i.recordId)).toEqual([forBob.id])
    expect(ofKind('u-bob', 'from_message')).toEqual([])
    ok(await engine.act(m('u-alice'), AI_ACTOR, forBob.id, 'assign', { expectedVersion: 1, note: '私がやります', args: { assignee: 'u-alice' } }))
    expect(ofKind('u-alice', 'from_message')).toEqual([])
    const t = ok(engine.createByAi(m('u-alice'), AI_ACTOR, { type: 'task', title: '支払いを確かめる', personal: false, folder: '経理', fields: { assignee: 'u-alice' }, links: { interaction: [msg] } })).record
    expect(ofKind('u-alice', 'from_message').map(i => i.recordId)).toEqual([t.id])
    expect(ofKind('u-carol', 'from_message')).toEqual([])
    closeAccounting('u-alice')
    expect(list('u-alice').items).toEqual([])
    expect(JSON.stringify(list('u-alice'))).not.toMatch(/支払い/)
  })
})
