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

/** A task alice asked bob for, started (version 2). */
async function startedTask(opts: { folder?: string; co?: string; title?: string; due?: string } = {}) {
  const co = opts.co ?? 'a'
  const t = ok(engine.create(m('u-alice', co), HUMAN, {
    type: 'task', title: opts.title ?? '提案書を作る', ...(opts.folder ? { folder: opts.folder } : {}),
    fields: { assignee: 'u-bob', ...(opts.due ? { due: opts.due } : {}) },
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
  })
  const notify = (companyId: string, userIds: string[], change?: RecordChange) => {
    push.notify(companyId, userIds, { kind: 'records', version: shared.ids.newToken().slice(0, 32) })
    if (change) service.recordChange(companyId, userIds, change)
  }
  const isMember = (co: string, userId: string) => (MEMBERS[co] ?? []).includes(userId)
  engine = createRecordEngine({ ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf, notify })
  writer = createServiceRecordWriter({ ...shared, isMember, roleOf, notify })
  return service
}

beforeEach(() => {
  nowMs = Date.parse('2026-11-02T01:00:00.000Z')
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
    // bob was handed the task (create) — someone else's affair by default (off) — and acted on the rest.
    expect(list('u-bob')).toMatchObject({ available: true, unread: 0, items: [] })
    ok(notices.setSettings(m('u-bob'), { kinds: { others: true } }))
    expect(list('u-bob').items.map(i => i.text)).toEqual(['Aliceさんが「提案書を作る」であなたを担当にしました'])
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
    expect(list('u-bob').items.filter(i => i.recordId === p.id).map(i => i.text)).toEqual(['「下調べ」の用意ができた（Aliceさんの AI）'])
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
    // bob acted: his own act tells him nothing (only the records signal of being handed the task).
    expect(bob.filter(e => e.kind === 'notifications')).toEqual([])
    // A writer that names the actor (a plugin's write done for bob): bob is still not told.
    const entry = source.forCompany('a').records.ledger(t.id).at(-1)!
    notices.recordChange('a', ['u-bob'], { type: 'task', entry, fields: {} })
    expect(bob.filter(e => e.kind === 'notifications')).toEqual([])
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
  it('overdue: once per due, to the requester only, after the day (company clock)', async () => {
    await startedTask({ due: '2026-11-02' })
    // 2026-11-02 10:00 in Japan: the day is not over.
    expect(list('u-alice').items).toEqual([])
    nowMs = Date.parse('2026-11-02T15:00:00.000Z') // 11-03 00:00 in Japan
    expect(list('u-alice').items.map(i => [i.kind, i.text])).toEqual([['overdue', '「提案書を作る」が期限（11月2日）を過ぎています']])
    expect(list('u-alice').items).toHaveLength(1)
    expect(list('u-bob').items).toEqual([])
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
    expect(list('u-bob').items).toEqual([])
  })
})
