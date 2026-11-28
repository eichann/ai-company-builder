/**
 * Integration Test: the AI at the member's request (records.md "The AI at the member's request", owner
 * decision 2026-11-26 「AI に完了を頼めるようにする」). Over HTTP, with real record tokens.
 *
 * Guards:
 * - the member's own setting decides: off (the default) → the fixed refusal `AI_ASK_OFF`, nothing written;
 *   nobody else's setting (the owner's) reaches it;
 * - only the record's assignee's own AI, only where `who` lets the assignee do it now: a task the member
 *   only requested, a 「確かめてから」 task, decline / cancel → refused;
 * - only a token of a turn the member started (`memberTurn`): a released app's plain token, and a token bound
 *   to an execution run (「AI の番」, a plugin step's, a job's — the server drops the mark) are refused;
 * - at most `AI_ASKED_PER_TURN` a token, counted with the write; the next turn's token starts again;
 * - the ledger keeps who asked and the conversation; ［取り消す］ (the member's generic undo) works.
 * - 「AI の毎日の操作」 (task 17, owner decision 2026-11-27): アーカイブ only of a task the member asked for, 引き受ける only
 *   of one asked of them — accepted as theirs —, each with their setting on; 「取り消して」 only of the member's own change
 *   (themselves or their AI), at most 24 hours old, in their own turn, counted, never an admin's reach over others; the
 *   案件 link taken off with set_bundle, never wider.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { recordsRoute } from '../../src/routes/records'
import { recordsAiRoute } from '../../src/routes/records-ai'
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { taskSettingsRoute } from '../../src/routes/task-settings'
import { services } from '../../src/composition'
import { AI_ASKED_PER_TURN } from '../../../shared/core/record-types'

const app = new Hono()
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', taskSettingsRoute)
app.route('/api/records-ai', recordsAiRoute)

const CO = 'ask-co'
const ts = () => new Date().toISOString()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const session = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `/api/companies/${CO}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown) => call({ token, method, path: `/api/records-ai${path}`, body })

let conv = 0
async function token(user: string, extra: Record<string, unknown> = { memberTurn: true }) {
  const r = await session(user, 'POST', '/me/record-tokens', { conversationId: `conv-${++conv}`, agent: 'claude-code', scope: 'act', ...extra })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data as { token: string; tokenId: string; memberTurn: boolean }
}
async function task(user: string, title: string, fields: Record<string, unknown>, state?: string): Promise<string> {
  const r = await session(user, 'POST', '/records/item', { type: 'task', title, fields, ...(state ? { state } : {}) })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.record.id
}
const record = async (id: string) => (await session('u-owner', 'GET', `/records/item/${id}`)).body.data.record as { state: string; version: number }
const history = async (user: string, id: string) => (await session(user, 'GET', `/records/item/${id}/history`)).body.data.entries as Json[]
const complete = (t: string, id: string, expectedVersion: number) => ai(t, 'POST', `/item/${id}/actions/complete`, { expectedVersion })
const setOwn = (user: string, on: boolean) => session(user, 'PUT', '/me/work-switches', { switch: 'aiCompletes', on })

beforeAll(async () => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', ts(), ts())
  for (const [user, role] of [['u-owner', 'owner'], ['u-bob', 'member'], ['u-carol', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  currentUser.id = 'u-owner'
  await app.request(`/api/companies/${CO}/records/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
  await services.records.refreshIndex({ companyId: CO, userId: 'u-owner', role: 'owner' })
})

describe('the member\'s own setting', () => {
  it('off by default, the member\'s alone: the AI is refused with the fixed sentence and nothing is written; the owner turning theirs on changes nothing for bob', async () => {
    const mine = (await session('u-bob', 'GET', '/me/work-switches')).body.data.aiCompletes
    expect(mine).toMatchObject({ on: false, allowed: true, chosen: null })
    expect((await setOwn('u-owner', true)).status).toBe(200)
    const id = await task('u-bob', '請求書を送る', { assignee: 'u-bob' })
    const { token: t } = await token('u-bob')
    const r = await complete(t, id, 1)
    expect(r).toMatchObject({ status: 403, body: { code: 'AI_ASK_OFF' } })
    expect(r.body.error).toContain('設定の「AI に任せること」でオンにすると')
    expect(await record(id)).toMatchObject({ state: 'todo', version: 1 })
  })
})

describe('asked in the member\'s own turn', () => {
  it('completes the assignee\'s own task, recorded as the AI at their request in that conversation; their ［取り消す］ undoes it', async () => {
    expect((await setOwn('u-bob', true)).body.data.aiCompletes).toMatchObject({ on: true })
    const id = await task('u-bob', '見積を出す', { assignee: 'u-bob' })
    const issued = await token('u-bob')
    expect(issued.memberTurn).toBe(true)
    expect((await complete(issued.token, id, 1)).status).toBe(200)
    expect(await record(id)).toMatchObject({ state: 'done', version: 2 })
    const entry = (await history('u-bob', id)).at(-1)
    expect(entry).toMatchObject({ action: 'complete', actorId: 'u-bob', actorKind: 'ai', askedBy: 'u-bob', cause: 'ai' })
    expect(entry.conversationId).toMatch(/^conv-/)
    expect(entry.note).toBe('')
    const undone = await session('u-bob', 'POST', `/records/item/${id}/undo`, { version: 2, expectedVersion: 2 })
    expect(undone.status).toBe(200)
    expect(await record(id)).toMatchObject({ state: 'todo', version: 3 })
  })

  it('never another member\'s record, nor one the member only requested, nor a 「確かめてから」 task; never decline', async () => {
    const { token: t } = await token('u-bob')
    const carols = await task('u-carol', 'キャロルの仕事', { assignee: 'u-carol' })
    expect(await complete(t, carols, 1)).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    // Bob asked Carol: as requester he completes it on screen, his AI never.
    const requested = await task('u-bob', 'キャロルに頼んだ', { assignee: 'u-carol' })
    const v = (await record(requested)).version
    expect(await complete(t, requested, v)).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    const check = await task('u-bob', '確かめてもらう', { assignee: 'u-bob', when_done: 'check' })
    expect(await complete(t, check, 1)).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    const own = await task('u-bob', '自分の', { assignee: 'u-bob' })
    expect((await ai(t, 'POST', `/item/${own}/actions/decline`, { expectedVersion: 1, note: 'できない' })).status).toBe(403)
    for (const id of [carols, check, own]) expect((await record(id)).state).toBe('todo')
  })
})

describe('only a turn the member started', () => {
  it('a released app\'s plain token (no mark) is refused', async () => {
    const id = await task('u-bob', '古いアプリから', { assignee: 'u-bob' })
    const plain = await token('u-bob', {})
    expect(plain.memberTurn).toBe(false)
    expect(await complete(plain.token, id, 1)).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
  })

  it('a token bound to an execution run (「AI の番」, a step, a job) never carries the mark, whatever the app asked', async () => {
    const prep = await task('u-bob', '下ごしらえ', { assignee: 'u-bob' }, 'preparing')
    const claim = await session('u-bob', 'POST', '/ai-run-claims', { recordId: prep, step: 'task-prep', deviceId: 'device-aaaa', conversationId: 'conv-run', stepsVersion: 'steps-1' })
    expect(claim.status).toBe(201)
    const run = claim.body.data.run as { id: string; generation: number }
    const bound = await token('u-bob', { memberTurn: true, conversationId: 'conv-run', run: { id: run.id, generation: run.generation } })
    expect(bound.memberTurn).toBe(false)
    const id = await task('u-bob', '走っている AI から', { assignee: 'u-bob' })
    expect(await complete(bound.token, id, 1)).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    expect((await record(id)).state).toBe('todo')
  })
})

describe('the per-turn cap', () => {
  it(`${AI_ASKED_PER_TURN} a turn; the next one is refused and writes nothing; the next turn starts again`, async () => {
    const ids: string[] = []
    for (let i = 0; i <= AI_ASKED_PER_TURN; i++) ids.push(await task('u-bob', `まとめて ${i}`, { assignee: 'u-bob' }))
    const { token: t } = await token('u-bob')
    for (const id of ids.slice(0, AI_ASKED_PER_TURN)) expect((await complete(t, id, 1)).status).toBe(200)
    const last = ids[AI_ASKED_PER_TURN]
    expect(await complete(t, last, 1)).toMatchObject({ status: 409, body: { code: 'AI_ASK_LIMIT' } })
    expect(await record(last)).toMatchObject({ state: 'todo', version: 1 })
    expect((await history('u-bob', last)).map(e => e.action)).toEqual(['create'])
    // A refused write (a stale version) does not use one up.
    const { token: next } = await token('u-bob')
    expect((await complete(next, last, 7)).status).toBe(409)
    expect((await complete(next, last, 1)).status).toBe(200)
  })

  it('turned off later: refused again at once', async () => {
    const id = await task('u-bob', 'あとで', { assignee: 'u-bob' })
    const { token: t } = await token('u-bob')
    await setOwn('u-bob', false)
    expect(await complete(t, id, 1)).toMatchObject({ status: 403, body: { code: 'AI_ASK_OFF' } })
  })
})

describe('the daily operations at the member\'s request (task 17, owner decision 2026-11-27)', () => {
  it('アーカイブ: only a task the member asked for, only with their setting on; marked as asked by them, undone by them', async () => {
    await setOwn('u-bob', false)
    const own = await task('u-bob', '自分で頼んだ', { assignee: 'u-bob' })
    const { token: t } = await token('u-bob')
    expect(await ai(t, 'POST', `/item/${own}/actions/cancel`, { expectedVersion: 1, note: 'もう要らない' })).toMatchObject({ status: 403, body: { code: 'AI_ASK_OFF' } })
    await setOwn('u-bob', true)
    // Carol asked it of bob: archiving is hers (the one who asked), never bob's AI.
    const asked = await task('u-carol', 'キャロルが頼んだ', { assignee: 'u-bob' })
    const v = (await record(asked)).version
    expect(await ai(t, 'POST', `/item/${asked}/actions/cancel`, { expectedVersion: v, note: 'やめる' })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    // A plain token (no member's turn) never.
    const plain = await token('u-bob', {})
    expect(await ai(plain.token, 'POST', `/item/${own}/actions/cancel`, { expectedVersion: 1, note: 'やめる' })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    expect((await ai(t, 'POST', `/item/${own}/actions/cancel`, { expectedVersion: 1, note: 'もう要らない' })).status).toBe(200)
    expect((await record(own)).state).toBe('cancelled')
    expect((await history('u-bob', own)).at(-1)).toMatchObject({ action: 'cancel', actorKind: 'ai', askedBy: 'u-bob' })
    expect((await session('u-bob', 'POST', `/records/item/${own}/undo`, { version: 2, expectedVersion: 2 })).status).toBe(200)
    expect((await record(own)).state).toBe('todo')
  })

  it('引き受ける: only a request asked of the member, accepted as theirs (引き受けた人 = the member, their turn); never someone else\'s', async () => {
    await setOwn('u-bob', true)
    const asked = await task('u-carol', 'ボブにお願い', { assignee: 'u-bob' })
    expect((await record(asked)).state).toBe('awaiting_acceptance')
    const { token: t } = await token('u-bob')
    // A correction of words at his request never accepts on his behalf (only an action that moves the state does).
    expect((await ai(t, 'POST', `/item/${asked}/actions/retitle`, { expectedVersion: (await record(asked)).version, args: { title: 'ボブへのお願い' } })).status).toBe(200)
    expect((await record(asked)).state).toBe('awaiting_acceptance')
    const v = (await record(asked)).version
    // Carol's AI cannot accept what is asked of bob.
    await setOwn('u-carol', true)
    const carols = await token('u-carol')
    expect(await ai(carols.token, 'POST', `/item/${asked}/actions/accept`, { expectedVersion: v })).toMatchObject({ status: 403 })
    expect((await ai(t, 'POST', `/item/${asked}/actions/accept`, { expectedVersion: v })).status).toBe(200)
    const after = (await session('u-bob', 'GET', `/records/item/${asked}`)).body.data.record
    expect(after.state).toBe('todo')
    expect(after.fields).toMatchObject({ accepted_by: 'u-bob', next_actor: 'u-bob' })
    expect((await history('u-bob', asked)).at(-1)).toMatchObject({ action: 'accept', actorKind: 'ai', askedBy: 'u-bob' })
  })

  it('「取り消して」: the member\'s own recent change (themselves or their AI), in their own turn, counted and marked; never another\'s, never older than 24 hours, never a run\'s or a plain token', async () => {
    const id = await task('u-bob', '期限を変えた', { assignee: 'u-bob', due: '2026-12-01' })
    expect((await session('u-bob', 'POST', `/records/item/${id}/actions/set_due`, { expectedVersion: 1, args: { due: '2026-12-05' } })).status).toBe(200)
    const { token: t } = await token('u-bob')
    const plain = await token('u-bob', {})
    expect(await ai(plain.token, 'POST', `/item/${id}/undo`, { version: 2, expectedVersion: 2 })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    // Carol's change on bob's task: never bob's AI (an owner's AI neither: no admin reach through the AI).
    expect((await session('u-carol', 'POST', `/records/item/${id}/actions/set_tags`, { expectedVersion: 2, args: { tags: ['急ぎ'] } })).status).toBe(403)
    const owners = await token('u-owner')
    expect(await ai(owners.token, 'POST', `/item/${id}/undo`, { version: 2, expectedVersion: 2 })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    const done = await ai(t, 'POST', `/item/${id}/undo`, { version: 2, expectedVersion: 2 })
    expect(done.status).toBe(200)
    expect((await session('u-bob', 'GET', `/records/item/${id}`)).body.data.record.fields.due).toBe('2026-12-01')
    expect((await history('u-bob', id)).at(-1)).toMatchObject({ action: 'undo', actorKind: 'ai', askedBy: 'u-bob', reversesVersion: 2 })
    // Older than 24 hours: refused, nothing written.
    const old = await task('u-bob', '前の日の変更', { assignee: 'u-bob' })
    expect((await session('u-bob', 'POST', `/records/item/${old}/actions/set_due`, { expectedVersion: 1, args: { due: '2026-12-09' } })).status).toBe(200)
    db.prepare("UPDATE record_ledger SET at = '2020-01-01T00:00:00.000Z' WHERE company_id = ? AND record_id = ? AND version = 2").run(CO, old)
    expect(await ai(t, 'POST', `/item/${old}/undo`, { version: 2, expectedVersion: 2 })).toMatchObject({ status: 409, body: { code: 'UNDO_TOO_OLD' } })
    expect((await record(old)).version).toBe(2)
  })

  it('「取り消して」 only of an action the AI may run itself (review of #892): its own asked 完了 yes (with the setting), the member\'s やり直す never', async () => {
    await setOwn('u-bob', true)
    const id = await task('u-bob', '頼んで完了', { assignee: 'u-bob' })
    const { token: t } = await token('u-bob')
    expect((await complete(t, id, 1)).status).toBe(200)
    // The setting off: the undo would reopen what it guards — refused.
    await setOwn('u-bob', false)
    expect(await ai(t, 'POST', `/item/${id}/undo`, { version: 2, expectedVersion: 2 })).toMatchObject({ status: 403, body: { code: 'AI_ASK_OFF' } })
    await setOwn('u-bob', true)
    expect((await ai(t, 'POST', `/item/${id}/undo`, { version: 2, expectedVersion: 2 })).status).toBe(200)
    expect((await record(id)).state).toBe('todo')
    // His own やり直す (reopen: not an action his AI may run) is never taken back by it.
    expect((await session('u-bob', 'POST', `/records/item/${id}/actions/complete`, { expectedVersion: 3 })).status).toBe(200)
    expect((await session('u-bob', 'POST', `/records/item/${id}/actions/reopen`, { expectedVersion: 4 })).status).toBe(200)
    const r = await ai(t, 'POST', `/item/${id}/undo`, { version: 5, expectedVersion: 5 })
    expect(r).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    expect(r.body.error).toContain('AI からは取り消せません')
    expect((await record(id)).state).toBe('in_progress')
  })

  it('「取り消して」 counts toward the turn\'s cap: past it, refused and nothing written', async () => {
    const { token: t, tokenId } = await token('u-bob')
    db.prepare('UPDATE record_ai_tokens SET asked_closes = ? WHERE company_id = ? AND id = ?').run(AI_ASKED_PER_TURN, CO, tokenId)
    const id = await task('u-bob', '上限', { assignee: 'u-bob' })
    expect((await session('u-bob', 'POST', `/records/item/${id}/actions/set_due`, { expectedVersion: 1, args: { due: '2026-12-09' } })).status).toBe(200)
    expect(await ai(t, 'POST', `/item/${id}/undo`, { version: 2, expectedVersion: 2 })).toMatchObject({ status: 409, body: { code: 'AI_ASK_LIMIT' } })
    expect((await record(id)).version).toBe(2)
  })

  it('案件 taken off with set_bundle (links.bundle null), undone by the member; linking never makes it wider', async () => {
    const project = await session('u-bob', 'POST', '/records/item', { type: 'project', title: 'ボブの案件', fields: { owner: 'u-bob' }, place: 'company' })
    expect(project.status).toBe(201)
    const pid = project.body.data.record.id
    const id = await task('u-bob', '案件のやること', { assignee: 'u-bob' })
    const { token: t } = await token('u-bob')
    expect((await ai(t, 'POST', `/item/${id}/actions/set_bundle`, { expectedVersion: 1, links: { bundle: pid } })).status).toBe(200)
    expect((await ai(t, 'POST', `/item/${id}/actions/set_bundle`, { expectedVersion: 2, links: { bundle: null } })).status).toBe(200)
    const links = (await session('u-bob', 'GET', `/records/item/${id}`)).body.data.links as Json[]
    expect(links.some(l => l.name === 'bundle')).toBe(false)
    expect((await session('u-bob', 'POST', `/records/item/${id}/undo`, { version: 3, expectedVersion: 3 })).status).toBe(200)
  })
})

describe('the requester\'s and the 責任者\'s settings at their request (task 18, project 3; PR C)', () => {
  it('確かめる人・終わったら: only the requester\'s own AI, with their setting; never the assignee\'s; a 確かめる人 who cannot read it is refused as always', async () => {
    await setOwn('u-bob', false)
    const id = await task('u-bob', 'キャロルに頼む', { assignee: 'u-carol' })
    const { token: t } = await token('u-bob')
    let v = (await record(id)).version
    expect(await ai(t, 'POST', `/item/${id}/actions/set_when_done`, { expectedVersion: v, args: { when_done: 'check' } })).toMatchObject({ status: 403, body: { code: 'AI_ASK_OFF' } })
    await setOwn('u-bob', true)
    expect((await ai(t, 'POST', `/item/${id}/actions/set_when_done`, { expectedVersion: v, args: { when_done: 'check' } })).status).toBe(200)
    v = (await record(id)).version
    expect((await ai(t, 'POST', `/item/${id}/actions/set_reviewer`, { expectedVersion: v, args: { reviewer: 'u-owner' } })).status).toBe(200)
    const after = (await session('u-bob', 'GET', `/records/item/${id}`)).body.data.record
    expect(after.fields).toMatchObject({ when_done: 'check', reviewer: 'u-owner' })
    expect((await history('u-bob', id)).at(-1)).toMatchObject({ action: 'set_reviewer', actorKind: 'ai', askedBy: 'u-bob' })
    // Carol (the assignee) is no requester: her AI never.
    await setOwn('u-carol', true)
    const carols = await token('u-carol')
    v = (await record(id)).version
    expect(await ai(carols.token, 'POST', `/item/${id}/actions/set_when_done`, { expectedVersion: v, args: { when_done: 'notify' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    // A plain token never.
    const plain = await token('u-bob', {})
    expect(await ai(plain.token, 'POST', `/item/${id}/actions/set_when_done`, { expectedVersion: v, args: { when_done: 'notify' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    // An owner-only task of his: a 確かめる人 who cannot read it is refused (the engine's own rule, unchanged).
    const own = (await session('u-bob', 'POST', '/records/item', { type: 'task', title: '自分だけ', personal: true, fields: { assignee: 'u-bob' } })).body.data.record.id
    expect(await ai(t, 'POST', `/item/${own}/actions/set_reviewer`, { expectedVersion: 1, args: { reviewer: 'u-carol' } })).toMatchObject({ status: 400, body: { code: 'REVIEWER_CANNOT_READ' } })
  })

  it('a プロジェクト\'s なんのため (no setting: words)・期限・責任者 (setting) by its 責任者\'s own AI only; never 終える; once handed over, no more', async () => {
    await setOwn('u-bob', false)
    const p = (await session('u-bob', 'POST', '/records/item', { type: 'project', title: 'ボブのプロジェクト', fields: { owner: 'u-bob' }, place: 'company' })).body.data.record.id
    const { token: t } = await token('u-bob')
    expect((await ai(t, 'POST', `/item/${p}/actions/set_purpose`, { expectedVersion: 1, args: { purpose: '新しいお客さんを増やす' } })).status).toBe(200)
    expect(await ai(t, 'POST', `/item/${p}/actions/set_due`, { expectedVersion: 2, args: { due: '2026-12-25' } })).toMatchObject({ status: 403, body: { code: 'AI_ASK_OFF' } })
    await setOwn('u-bob', true)
    expect((await ai(t, 'POST', `/item/${p}/actions/set_due`, { expectedVersion: 2, args: { due: '2026-12-25' } })).status).toBe(200)
    expect(await ai(t, 'POST', `/item/${p}/actions/finish`, { expectedVersion: 3 })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    await setOwn('u-carol', true)
    const carols = await token('u-carol')
    expect(await ai(carols.token, 'POST', `/item/${p}/actions/set_due`, { expectedVersion: 3, args: { due: '2026-12-31' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    expect((await ai(t, 'POST', `/item/${p}/actions/set_owner`, { expectedVersion: 3, args: { owner: 'u-carol' } })).status).toBe(200)
    expect((await history('u-bob', p)).at(-1)).toMatchObject({ action: 'set_owner', actorKind: 'ai', askedBy: 'u-bob' })
    // No longer the 責任者: his AI may not change it any more; he takes his own change back on screen.
    expect(await ai(t, 'POST', `/item/${p}/actions/set_due`, { expectedVersion: 4, args: { due: '2026-12-31' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    expect((await session('u-bob', 'POST', `/records/item/${p}/undo`, { version: 4, expectedVersion: 4 })).status).toBe(200)
  })

  it('責任者を替える: never to someone who cannot open it, on every path (review of #894); the new 責任者 is told', async () => {
    await setOwn('u-bob', true)
    // Bob's own プロジェクト (only he sees it): Carol cannot be its 責任者 — not on create, not by his press, not by his AI.
    const made = await session('u-bob', 'POST', '/records/item', { type: 'project', title: 'ボブだけの', personal: true, fields: { owner: 'u-carol' } })
    expect(made).toMatchObject({ status: 400, body: { code: 'OWNER_CANNOT_READ' } })
    const own = (await session('u-bob', 'POST', '/records/item', { type: 'project', title: 'ボブだけの', personal: true, fields: { owner: 'u-bob' } })).body.data.record.id
    expect(await session('u-bob', 'POST', `/records/item/${own}/actions/set_owner`, { expectedVersion: 1, args: { owner: 'u-carol' } })).toMatchObject({ status: 400, body: { code: 'OWNER_CANNOT_READ' } })
    const { token: t } = await token('u-bob')
    expect(await ai(t, 'POST', `/item/${own}/actions/set_owner`, { expectedVersion: 1, args: { owner: 'u-carol' } })).toMatchObject({ status: 400, body: { code: 'OWNER_CANNOT_READ' } })
    expect((await session('u-bob', 'GET', `/records/item/${own}`)).body.data.record.version).toBe(1)
    // One everyone sees: handed to Carol by his AI, and Carol is told.
    const p = (await session('u-bob', 'POST', '/records/item', { type: 'project', title: 'みんなの', fields: { owner: 'u-bob' }, place: 'company' })).body.data.record.id
    expect((await ai(t, 'POST', `/item/${p}/actions/set_owner`, { expectedVersion: 1, args: { owner: 'u-carol' } })).status).toBe(200)
    const told = db.prepare('SELECT user_id FROM notifications WHERE company_id = ? AND record_id = ? AND record_version = 2').all(CO, p) as Array<{ user_id: string }>
    expect(told.map(r => r.user_id)).toContain('u-carol')
  })

  it('nobody else\'s AI through a role or the fallback: an owner / admin or a 部署の管理役 who is not the 責任者, a reader of one with no 責任者', async () => {
    await setOwn('u-owner', true)
    await setOwn('u-carol', true)
    db.prepare("INSERT OR IGNORE INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES ('ask-sales', ?, '営業部', '営業部', ?, ?)").run(CO, ts(), ts())
    db.prepare("INSERT OR IGNORE INTO department_managers (department_id, user_id, created_at) VALUES ('ask-sales', 'u-carol', ?)").run(ts())
    const created = await session('u-bob', 'POST', '/records/item', { type: 'project', title: '営業部の', fields: { owner: 'u-bob' }, folder: '営業部' })
    expect(created.status).toBe(201)
    const p = created.body.data.record.id
    // On screen they may (a role in `who`); their AI may not (the key names only the record's own 責任者).
    const owners = await token('u-owner')
    const managers = await token('u-carol')
    for (const t of [owners.token, managers.token]) {
      expect(await ai(t, 'POST', `/item/${p}/actions/set_due`, { expectedVersion: 1, args: { due: '2026-12-25' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    }
    expect((await session('u-carol', 'POST', `/records/item/${p}/actions/set_due`, { expectedVersion: 1, args: { due: '2026-12-25' } })).status).toBe(200)
    // A プロジェクト with no 責任者: any reader may name one on screen (`who_fallback`), never their AI.
    const none = (await session('u-bob', 'POST', '/records/item', { type: 'project', title: '責任者なし', fields: { owner: 'u-bob' }, place: 'company' })).body.data.record.id
    db.prepare("UPDATE record_state SET fields = json_remove(fields, '$.owner') WHERE company_id = ? AND record_id = ?").run(CO, none)
    expect(await ai(managers.token, 'POST', `/item/${none}/actions/set_owner`, { expectedVersion: 1, args: { owner: 'u-carol' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    expect((await session('u-carol', 'POST', `/records/item/${none}/actions/set_owner`, { expectedVersion: 1, args: { owner: 'u-carol' } })).status).toBe(200)
  })
})
