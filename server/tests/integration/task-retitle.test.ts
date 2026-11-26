/**
 * Integration Test: 「件名・目的を直す」 (task version 16, owner decision 2026-11-27; records.md "Task version 16").
 * Over HTTP, with the member's session and real record tokens.
 *
 * Guards:
 * - the record's own title is an action argument (`retitle`'s `title`): written to the record, kept in the ledger as
 *   `record.title` before / after, version + 1, undone by the generic undo (and refused once something changed since);
 * - one title rule with the create (`normalizeRecordTitle`): trimmed, 1–200 characters, one line — else nothing written;
 * - who: the requester and the assignee only (another reader, the company's owner: refused); a record the caller cannot
 *   read (owner-only, members-only) and another company's record answer exactly as a missing one;
 * - their AI only in a turn the member started (`memberTurn`), with no member setting (it ends nothing); never a plain
 *   token, a run-bound one, or another member's task;
 * - a stale version is refused with nothing written; a finished task is not edited;
 * - the title's text is content: never in `records` / `record_ledger` rows, never in the logs.
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
import { RECORD_TITLE_CHANGE } from '../../../shared/core/record-ledger'
import { sqliteRecordContentEraser } from '../../src/adapters/sqlite/record-contents'

const app = new Hono()
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', taskSettingsRoute)
app.route('/api/records-ai', recordsAiRoute)

const CO = 'retitle-co'
const OTHER = 'retitle-other'
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
const session = (user: string, method: string, path: string, body?: unknown, co = CO) => call({ user, method, path: `/api/companies/${co}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown) => call({ token, method, path: `/api/records-ai${path}`, body })

let conv = 0
async function token(user: string, extra: Record<string, unknown> = { memberTurn: true }) {
  const r = await session(user, 'POST', '/me/record-tokens', { conversationId: `conv-${++conv}`, agent: 'claude-code', scope: 'act', ...extra })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data as { token: string; tokenId: string; memberTurn: boolean }
}
async function task(user: string, title: string, extra: Record<string, unknown>, co = CO): Promise<string> {
  const r = await session(user, 'POST', '/records/item', { type: 'task', title, ...extra }, co)
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.record.id
}
const detail = async (id: string, user = 'u-owner', co = CO) => (await session(user, 'GET', `/records/item/${id}`, undefined, co)).body.data.record as { title: string; state: string; version: number; fields: Record<string, unknown> }
const history = async (user: string, id: string) => (await session(user, 'GET', `/records/item/${id}/history`)).body.data.entries as Json[]
const retitle = (user: string, id: string, title: unknown, expectedVersion: number) => session(user, 'POST', `/records/item/${id}/actions/retitle`, { expectedVersion, args: { title } })
const setPurpose = (user: string, id: string, purpose: string, expectedVersion: number) => session(user, 'POST', `/records/item/${id}/actions/set_purpose`, { expectedVersion, args: { purpose } })

beforeAll(async () => {
  initDatabase()
  for (const [co, owner] of [[CO, 'u-owner'], [OTHER, 'u-zed']]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, owner, ts(), ts())
  }
  for (const [co, user, role] of [[CO, 'u-owner', 'owner'], [CO, 'u-bob', 'member'], [CO, 'u-carol', 'member'], [CO, 'u-dan', 'member'], [OTHER, 'u-zed', 'owner']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${user}`, user, co, role, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  for (const [co, owner] of [[CO, 'u-owner'], [OTHER, 'u-zed']]) {
    ensureCompanyScope(db, co)
    currentUser.id = owner
    await app.request(`/api/companies/${co}/records/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    await services.records.refreshIndex({ companyId: co, userId: owner, role: 'owner' })
  }
})

describe('件名を直す by a person', () => {
  it('the assignee renames it: the record\'s title, one entry with the title before / after, version + 1; ［取り消す］ brings it back', async () => {
    const id = await task('u-bob', '古い件名', { fields: { assignee: 'u-bob' }, place: 'company' })
    const v = (await detail(id)).version
    const r = await retitle('u-bob', id, '  新しい件名  ', v)
    expect(r.status).toBe(200)
    expect(r.body.data.record.title).toBe('新しい件名')
    expect(await detail(id)).toMatchObject({ title: '新しい件名', version: v + 1 })
    const entry = (await history('u-bob', id)).at(-1)
    expect(entry).toMatchObject({ action: 'retitle', actorId: 'u-bob', actorKind: 'human', version: v + 1, fromState: 'todo', toState: 'todo' })
    expect(entry.changes).toEqual([{ field: RECORD_TITLE_CHANGE, before: '古い件名', after: '新しい件名' }])
    // The title never lands in the server fields.
    expect((await detail(id)).fields).not.toHaveProperty('title')
    expect((await detail(id)).fields).not.toHaveProperty(RECORD_TITLE_CHANGE)
    // Text search follows the new title only.
    const found = await session('u-bob', 'POST', '/records/query', { type: 'task', text: '新しい件名' })
    expect(found.body.data.records.map((x: Json) => x.id)).toContain(id)
    expect((await session('u-bob', 'POST', '/records/query', { type: 'task', text: '古い件名' })).body.data.records.map((x: Json) => x.id)).not.toContain(id)

    const undone = await session('u-bob', 'POST', `/records/item/${id}/undo`, { version: v + 1, expectedVersion: v + 1 })
    expect(undone.status).toBe(200)
    expect(await detail(id)).toMatchObject({ title: '古い件名', version: v + 2 })
    expect((await detail(id)).fields).not.toHaveProperty(RECORD_TITLE_CHANGE)
    expect((await history('u-bob', id)).at(-1)).toMatchObject({ action: 'undo', reversesVersion: v + 1, changes: [{ field: RECORD_TITLE_CHANGE, before: '新しい件名', after: '古い件名' }] })
  })

  it('an undo after a later rename is refused (CHANGED_SINCE), nothing written', async () => {
    const id = await task('u-bob', '一回目', { fields: { assignee: 'u-bob' }, place: 'company' })
    expect((await retitle('u-bob', id, '二回目', 1)).status).toBe(200)
    expect((await retitle('u-bob', id, '三回目', 2)).status).toBe(200)
    expect(await session('u-bob', 'POST', `/records/item/${id}/undo`, { version: 2, expectedVersion: 3 })).toMatchObject({ status: 409, body: { code: 'CHANGED_SINCE' } })
    expect(await detail(id)).toMatchObject({ title: '三回目', version: 3 })
  })

  it('an undo never writes an erased title back as live text', async () => {
    const id = await task('u-bob', '消す前の件名', { fields: { assignee: 'u-bob' }, place: 'company' })
    expect((await retitle('u-bob', id, '消す前の新しい件名', 1)).status).toBe(200)
    sqliteRecordContentEraser(db).eraseRecord(CO, id, 'request', ts())
    expect((await detail(id)).title).toMatch(/^消去済み/)
    expect(await session('u-bob', 'POST', `/records/item/${id}/undo`, { version: 2, expectedVersion: 2 })).toMatchObject({ status: 409, body: { code: 'CHANGED_SINCE' } })
    expect(await detail(id)).toMatchObject({ version: 2 })
    expect(JSON.stringify(db.prepare('SELECT text FROM record_contents WHERE company_id = ? AND record_id = ? AND text IS NOT NULL').all(CO, id))).not.toContain('消す前')
  })

  it('the requester may too; another reader, and the company\'s owner, may not (nothing written)', async () => {
    const id = await task('u-bob', 'ボブが頼んだ', { fields: { assignee: 'u-carol' }, place: 'company' })
    const v = (await detail(id)).version
    expect((await retitle('u-bob', id, '頼んだ人が直す', v)).status).toBe(200)
    // The requester renaming a request still waiting to be accepted does not accept it for the assignee.
    expect((await detail(id)).state).toBe((await history('u-bob', id))[0].toState)
    for (const who of ['u-dan', 'u-owner']) {
      expect(await retitle(who, id, 'ほかの人が直す', v + 1)).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    }
    expect(await detail(id)).toMatchObject({ title: '頼んだ人が直す', version: v + 1 })
  })

  it('one title rule with the create: empty, too long, two lines → 400, nothing written; the create refuses two lines the same way', async () => {
    const id = await task('u-bob', 'ルール', { fields: { assignee: 'u-bob' }, place: 'company' })
    for (const bad of ['   ', 'あ'.repeat(201), '一行目\n二行目', '改\u2028行', 42]) {
      expect(await retitle('u-bob', id, bad, 1)).toMatchObject({ status: 400, body: { code: 'BAD_VALUE' } })
    }
    expect(await retitle('u-bob', id, null, 1)).toMatchObject({ status: 400, body: { code: 'ARG_REQUIRED' } })
    expect(await detail(id)).toMatchObject({ title: 'ルール', version: 1 })
    expect((await session('u-bob', 'POST', '/records/item', { type: 'task', title: '一行目\n二行目', place: 'company' })).status).toBe(400)
    // 200 characters is fine.
    expect((await retitle('u-bob', id, 'い'.repeat(200), 1)).status).toBe(200)
  })

  it('a stale version is refused with nothing written; a finished task is not edited', async () => {
    const id = await task('u-bob', '版', { fields: { assignee: 'u-bob' }, place: 'company' })
    expect(await retitle('u-bob', id, '古い版から', 0)).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' } })
    expect(await detail(id)).toMatchObject({ title: '版', version: 1 })
    expect((await session('u-bob', 'POST', `/records/item/${id}/actions/complete`, { expectedVersion: 1 })).status).toBe(200)
    expect(await retitle('u-bob', id, '終わったあと', 2)).toMatchObject({ status: 409, body: { code: 'ACTION_NOT_ALLOWED_IN_STATE' } })
    expect((await detail(id)).title).toBe('版')
  })
})

describe('no leaks', () => {
  it('an owner-only task, a members-only task the caller is not on, and another company\'s task answer exactly as a missing one', async () => {
    const missing = await retitle('u-owner', 'task-0000000000000000', 'x', 1)
    expect(missing.status).toBe(404)
    const mine = await task('u-bob', 'ボブだけ', { personal: true, fields: { assignee: 'u-bob' } })
    const listed = await task('u-bob', '二人だけ', { members: ['u-carol'], fields: { assignee: 'u-bob' } })
    const theirs = await task('u-zed', 'よその会社', { fields: { assignee: 'u-zed' }, place: 'company' }, OTHER)
    for (const [who, id] of [['u-owner', mine], ['u-carol', mine], ['u-owner', listed], ['u-dan', listed], ['u-owner', theirs]] as const) {
      const r = await retitle(who, id, '見えないはず', 1)
      expect({ status: r.status, body: r.body }).toEqual({ status: missing.status, body: missing.body })
    }
    expect((await detail(mine, 'u-bob')).title).toBe('ボブだけ')
    expect((await detail(theirs, 'u-zed', OTHER)).title).toBe('よその会社')
  })

  it('the title\'s text is content: never in the records / ledger rows, never in the logs', async () => {
    const logged: string[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map(k => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')) }))
    try {
      const id = await task('u-bob', '秘密の件名その一', { fields: { assignee: 'u-bob' }, place: 'company' })
      expect((await retitle('u-bob', id, '秘密の件名その二', 1)).status).toBe(200)
      const t = await token('u-bob')
      expect((await ai(t.token, 'POST', `/item/${id}/actions/retitle`, { expectedVersion: 2, args: { title: '秘密の件名その三' } })).status).toBe(200)
      expect((await session('u-bob', 'POST', `/records/item/${id}/undo`, { version: 3, expectedVersion: 3 })).status).toBe(200)
      const rows = JSON.stringify([
        db.prepare('SELECT * FROM records WHERE company_id = ? AND id = ?').all(CO, id),
        db.prepare('SELECT * FROM record_ledger WHERE company_id = ? AND record_id = ?').all(CO, id),
        db.prepare('SELECT * FROM record_state WHERE company_id = ? AND record_id = ?').all(CO, id),
      ])
      expect(rows).not.toContain('秘密の件名')
      expect(rows).toContain(RECORD_TITLE_CHANGE)
    } finally {
      for (const s of spies) s.mockRestore()
    }
    expect(logged.join('\n')).not.toContain('秘密の件名')
  })
})

describe('the member\'s AI', () => {
  it('in a turn the member started, without the member\'s setting: the assignee\'s and the requester\'s AI rename and set the purpose, recorded as asked', async () => {
    expect((await session('u-bob', 'GET', '/me/work-switches')).body.data.aiCompletes).toMatchObject({ on: false })
    const id = await task('u-carol', 'AI が直す', { fields: { assignee: 'u-bob' }, place: 'company' })
    const v = (await detail(id)).version
    const bob = await token('u-bob')
    expect((await ai(bob.token, 'POST', `/item/${id}/actions/retitle`, { expectedVersion: v, args: { title: 'AI が直した件名' } })).status).toBe(200)
    expect((await ai(bob.token, 'POST', `/item/${id}/actions/set_purpose`, { expectedVersion: v + 1, args: { purpose: '目的も新しく' } })).status).toBe(200)
    const carol = await token('u-carol')
    expect((await ai(carol.token, 'POST', `/item/${id}/actions/retitle`, { expectedVersion: v + 2, args: { title: '頼んだ人の AI が直した' } })).status).toBe(200)
    expect(await detail(id)).toMatchObject({ title: '頼んだ人の AI が直した', fields: { purpose: '目的も新しく' } })
    const entries = (await history('u-bob', id)).slice(-3)
    expect(entries.map(e => [e.action, e.actorId, e.actorKind, e.askedBy])).toEqual([
      ['retitle', 'u-bob', 'ai', 'u-bob'], ['set_purpose', 'u-bob', 'ai', 'u-bob'], ['retitle', 'u-carol', 'ai', 'u-carol'],
    ])
    // The member undoes what their AI did.
    expect((await session('u-carol', 'POST', `/records/item/${id}/undo`, { version: v + 3, expectedVersion: v + 3 })).status).toBe(200)
    expect((await detail(id)).title).toBe('AI が直した件名')
  })

  it('never another member\'s task, never with a plain token or a token bound to a run (nothing written)', async () => {
    const carols = await task('u-carol', 'キャロルのもの', { fields: { assignee: 'u-carol' }, place: 'company' })
    const bob = await token('u-bob')
    expect(await ai(bob.token, 'POST', `/item/${carols}/actions/retitle`, { expectedVersion: 1, args: { title: 'ボブの AI' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    const own = await task('u-bob', 'ボブのもの', { fields: { assignee: 'u-bob' }, place: 'company' })
    const plain = await token('u-bob', {})
    expect(await ai(plain.token, 'POST', `/item/${own}/actions/retitle`, { expectedVersion: 1, args: { title: '古いアプリ' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    expect(await ai(plain.token, 'POST', `/item/${own}/actions/set_purpose`, { expectedVersion: 1, args: { purpose: '古いアプリ' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    const prep = await task('u-bob', '下ごしらえ', { fields: { assignee: 'u-bob' }, place: 'company', state: 'preparing' })
    const claim = await session('u-bob', 'POST', '/ai-run-claims', { recordId: prep, step: 'task-prep', deviceId: 'device-bbbb', conversationId: 'conv-run-retitle', stepsVersion: 'steps-1' })
    expect(claim.status).toBe(201)
    const run = claim.body.data.run as { id: string; generation: number }
    const bound = await token('u-bob', { memberTurn: true, conversationId: 'conv-run-retitle', run: { id: run.id, generation: run.generation } })
    expect(bound.memberTurn).toBe(false)
    expect(await ai(bound.token, 'POST', `/item/${prep}/actions/retitle`, { expectedVersion: 1, args: { title: '走っている AI' } })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    for (const [id, title] of [[carols, 'キャロルのもの'], [own, 'ボブのもの'], [prep, '下ごしらえ']]) expect((await detail(id)).title).toBe(title)
  })
})

describe('目的を直す by a person', () => {
  it('the assignee sets and clears the purpose; another reader may not', async () => {
    const id = await task('u-bob', '目的', { fields: { assignee: 'u-bob', purpose: '最初の目的' }, place: 'company' })
    const v = (await detail(id)).version
    expect((await setPurpose('u-bob', id, '直した目的', v)).status).toBe(200)
    expect((await history('u-bob', id)).at(-1).changes).toEqual([{ field: 'purpose', before: '最初の目的', after: '直した目的' }])
    expect(await setPurpose('u-dan', id, 'ほかの人', v + 1)).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    expect((await setPurpose('u-bob', id, '', v + 1)).status).toBe(200)
    expect((await detail(id)).fields.purpose ?? '').toBe('')
  })
})
