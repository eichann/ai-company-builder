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
    expect(r.body.error).toContain('自分の設定')
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

  it('never another member\'s record, nor one the member only requested, nor a 「確かめてから」 task; never decline or cancel', async () => {
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
    expect((await ai(t, 'POST', `/item/${own}/actions/cancel`, { expectedVersion: 1, note: 'やめる' })).status).toBe(403)
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
