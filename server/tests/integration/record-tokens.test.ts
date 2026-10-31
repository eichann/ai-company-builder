/**
 * Integration Test: who is acting on the company map is decided by the
 * server from the credential, never by the app (`.claude/rules/records.md`
 * "Who is acting").
 *
 * Guards:
 * - a call with a record token is the member's AI: it cannot run an action
 *   whose `who` excludes ai even when the body claims a human, and its ledger
 *   entry says ai;
 * - a call with the member's session is recorded as human even when the
 *   body claims ai;
 * - a `read` token only looks up; a token works only for its own company
 *   (another company's id in it finds nothing), not after it is revoked, not
 *   for someone who left the company, not while the company's AI is stopped;
 * - the AI routes never accept a session.
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
import { services } from '../../src/composition'

const app = new Hono()
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/records-ai', recordsAiRoute)

const CO = 'rt-co'
const OTHER = 'rt-other'
const ts = () => new Date().toISOString()

async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json() as { data?: Record<string, unknown>; code?: string } }
}
const session = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `/api/companies/${CO}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown) => call({ token, method, path: `/api/records-ai${path}`, body })

async function tokenFor(user: string, scope: 'read' | 'act', company = CO, agent = 'claude-code'): Promise<{ token: string; tokenId: string; scope: string }> {
  currentUser.id = user
  const res = await app.request(`/api/companies/${company}/me/record-tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'conv-1', agent, scope }),
  })
  const body = await res.json() as { data: { token: string; tokenId: string; scope: string } }
  if (res.status !== 201) throw new Error(JSON.stringify(body))
  return body.data
}

let taskId: string

beforeAll(async () => {
  initDatabase()
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', ts(), ts())
    for (const [user, role] of [['u-owner', 'owner'], ['u-bob', 'member']]) {
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${user}`, user, co, role, ts(), ts())
    }
    const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
    ensureCompanyScope(db, co)
    currentUser.id = 'u-owner'
    await app.request(`/api/companies/${co}/records/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    await services.records.refreshIndex({ companyId: co, userId: 'u-owner', role: 'owner' })
  }
  const made = await session('u-owner', 'POST', '/records/item', { type: 'task', title: '見積を作る', fields: { assignee: 'u-bob' } })
  taskId = (made.body.data?.record as { id: string }).id
})

const ledger = async (user: string) => ((await session(user, 'GET', `/records/item/${taskId}/history`)).body.data?.entries ?? []) as Array<{ action: string; actorKind: string; actorSource: string | null }>

describe('who is acting comes from the credential', () => {
  it('a record-token call is the AI: recorded as ai even when the body says human', async () => {
    const { token } = await tokenFor('u-bob', 'act')
    const r = await ai(token, 'POST', `/item/${taskId}/actions/start`, { expectedVersion: 1, actor: { kind: 'human' } })
    expect(r.status).toBe(200)
    expect((await ledger('u-bob')).at(-1)).toMatchObject({ action: 'start', actorKind: 'ai', actorSource: 'claude-code' })
  })

  it('a record-token call cannot run an action whose `who` excludes ai, whatever the body claims', async () => {
    // complete: who = requested_by (u-owner), reviewer — not ai.
    const { token } = await tokenFor('u-owner', 'act')
    const r = await ai(token, 'POST', `/item/${taskId}/actions/complete`, { expectedVersion: 2, actor: { kind: 'human' } })
    expect(r).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    expect((await ledger('u-owner')).map(e => e.action)).toEqual(['create', 'start'])
  })

  it('a session call is the member: recorded as human even when the body says ai', async () => {
    const r = await session('u-owner', 'POST', `/records/item/${taskId}/actions/complete`, { expectedVersion: 2, actor: { kind: 'ai', source: 'claude' } })
    expect(r.status).toBe(200)
    expect((await ledger('u-owner')).at(-1)).toMatchObject({ action: 'complete', actorKind: 'human', actorSource: null })
  })
})

describe('what a record token can reach', () => {
  it('a read token looks up but cannot act', async () => {
    const { token } = await tokenFor('u-bob', 'read')
    expect((await ai(token, 'GET', '/my-turn')).status).toBe(200)
    expect((await ai(token, 'GET', `/item/${taskId}`)).status).toBe(200)
    expect(await ai(token, 'POST', `/item/${taskId}/actions/reopen`, { expectedVersion: 3 })).toMatchObject({ status: 403, body: { code: 'READ_ONLY_TOKEN' } })
  })

  it('Codex (any agent not allowed to act) gets a read token even when the app asks for act', async () => {
    for (const agent of ['codex', 'api-key', 'something-else']) {
      const issued = await tokenFor('u-bob', 'act', CO, agent)
      expect(issued.scope).toBe('read')
      expect(await ai(issued.token, 'POST', `/item/${taskId}/actions/reopen`, { expectedVersion: 3 })).toMatchObject({ status: 403, body: { code: 'READ_ONLY_TOKEN' } })
      expect((await ai(issued.token, 'GET', '/my-turn')).status).toBe(200)
    }
    expect((await tokenFor('u-bob', 'act', CO, 'claude-code')).scope).toBe('act')
  })

  it('only its own company: another company’s id in the token, or its record ids, find nothing', async () => {
    const { token } = await tokenFor('u-bob', 'act')
    const forged = token.replace(`acb_rec_${CO}.`, `acb_rec_${OTHER}.`)
    expect((await ai(forged, 'GET', '/my-turn')).status).toBe(401)
    const theirs = await call({ user: 'u-owner', method: 'POST', path: `/api/companies/${OTHER}/records/item`, body: { type: 'task', title: '他社', fields: { assignee: 'u-bob' } } })
    const theirId = (theirs.body.data?.record as { id: string }).id
    expect(await ai(token, 'GET', `/item/${theirId}`)).toEqual(await ai(token, 'GET', '/item/task-zzzzzzzz'))
    expect(await ai(token, 'POST', `/item/${theirId}/actions/start`, { expectedVersion: 1 })).toMatchObject({ status: 404 })
  })

  it('not after it is revoked, not for someone who left, not while the AI is stopped, never with a session', async () => {
    const a = await tokenFor('u-bob', 'read')
    expect((await session('u-bob', 'DELETE', `/me/record-tokens/${a.tokenId}`)).status).toBe(200)
    expect((await ai(a.token, 'GET', '/my-turn')).status).toBe(401)

    const b = await tokenFor('u-bob', 'read')
    db.prepare("INSERT INTO agent_stops (id, company_id, user_id, tool, reason, stopped_at, stopped_by) VALUES ('rt-stop', ?, NULL, NULL, '', ?, 'u-owner')").run(CO, ts())
    expect(await ai(b.token, 'GET', '/my-turn')).toMatchObject({ status: 403, body: { code: 'ACB_STOPPED' } })
    db.prepare("UPDATE agent_stops SET released_at = ?, released_by = 'u-owner' WHERE id = 'rt-stop'").run(ts())
    expect((await ai(b.token, 'GET', '/my-turn')).status).toBe(200)
    db.prepare('DELETE FROM memberships WHERE company_id = ? AND user_id = ?').run(CO, 'u-bob')
    expect((await ai(b.token, 'GET', '/my-turn')).status).toBe(401)

    expect((await call({ user: 'u-owner', method: 'GET', path: '/api/records-ai/my-turn' })).status).toBe(401)
    expect((await ai('acb_rec_garbage', 'GET', '/my-turn')).status).toBe(401)
  })
})

describe('provenance in the ledger (informational, never authorizes)', () => {
  it('a person confirming their AI\'s suggestion is recorded as human with proposed_by ai and the consultation; the AI\'s conversation comes from its token', async () => {
    const made = await session('u-owner', 'POST', '/records/item', { type: 'task', title: '提案のお礼状', fields: { assignee: 'u-owner' } })
    const id = (made.body.data?.record as { id: string }).id
    const { token } = await tokenFor('u-owner', 'act')
    // The AI's call: whatever its body says, the conversation is its token's and proposed_by stays empty.
    expect((await ai(token, 'POST', `/item/${id}/actions/start`, { expectedVersion: 1, conversationId: 'forged', proposedBy: 'ai' })).status).toBe(200)
    // The member confirms what the AI suggested: still a human action, so it may do what the AI may not (complete).
    const done = await session('u-owner', 'POST', `/records/item/${id}/actions/complete`, { expectedVersion: 2, proposedBy: 'ai', conversationId: 'consult-42' })
    expect(done.status).toBe(200)
    const entries = ((await session('u-owner', 'GET', `/records/item/${id}/history`)).body.data?.entries ?? []) as Array<Record<string, unknown>>
    expect(entries.map(e => [e.action, e.actorKind, e.proposedBy, e.conversationId])).toEqual([
      ['create', 'human', null, null],
      ['start', 'ai', null, 'conv-1'],
      ['complete', 'human', 'ai', 'consult-42'],
    ])
    expect((await session('u-owner', 'GET', `/records/item/${id}/versions/3`)).body.data).toMatchObject({
      state: 'done', origin: { action: 'complete', actorKind: 'human', proposedBy: 'ai', conversationId: 'consult-42' },
    })
  })
})
