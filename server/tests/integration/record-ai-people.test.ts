/**
 * Integration Test: the member's AI gets the names behind the person ids in its record answers
 * (services/people-names.ts, records.md "Typed tools in the app"; staging FB 9 — the AI told the
 * member 「記録には人の id だけで、名前は出ていません」).
 *
 * Guards:
 * - records_get / records_query / records_history / 「あなたの番」 answers carry `people`
 *   (id → display name) for the company members they name, the ids themselves unchanged;
 * - an id of someone outside the caller's company (another company's member, a removed member)
 *   gets no name even though the account exists and has one — nothing leaks across companies;
 * - only the display name is added: no email or other account field.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
// Every account exists and has a name (and an email): only the membership decides who is named.
const ACCOUNTS: Record<string, { email: string; name: string | null }> = {
  'u-owner': { email: 'owner@example.com', name: '山田 太郎' },
  'u-bob': { email: 'bob@example.com', name: '佐藤 花子' },
  'u-carol': { email: 'carol@example.com', name: '他社 次郎' },
}
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.filter(id => ACCOUNTS[id]).map(id => [id, ACCOUNTS[id]]))),
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

const CO = 'rp-co'
const OTHER = 'rp-other'
const ts = () => new Date().toISOString()

async function request(method: string, path: string, opts: { user?: string; token?: string; body?: unknown } = {}) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json() as { data?: Record<string, unknown> & { people?: Record<string, string> } } }
}

let token: string
let taskId: string

beforeAll(async () => {
  initDatabase()
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  const members: Array<[string, string, string]> = [[CO, 'u-owner', 'owner'], [CO, 'u-bob', 'member'], [OTHER, 'u-carol', 'owner']]
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, co === CO ? 'u-owner' : 'u-carol', ts(), ts())
    ensureCompanyScope(db, co)
  }
  for (const [co, user, role] of members) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${user}`, user, co, role, ts(), ts())
  }
  await request('PUT', `/api/companies/${CO}/records/settings`, { user: 'u-owner', body: { enabled: true } })
  await services.records.refreshIndex({ companyId: CO, userId: 'u-owner', role: 'owner' })
  // The summary names someone of another company by id: never named.
  const made = await request('POST', `/api/companies/${CO}/records/item`, { user: 'u-owner', body: { type: 'task', title: '見積を作る', summary: 'u-carol', fields: { assignee: 'u-bob' } } })
  expect(made.status).toBe(201)
  taskId = (made.body.data?.record as { id: string }).id
  const issued = await request('POST', `/api/companies/${CO}/me/record-tokens`, { user: 'u-bob', body: { conversationId: 'conv-1', agent: 'claude-code', scope: 'read' } })
  token = (issued.body.data as { token: string }).token
})

describe('the AI\'s record answers name the company members they mention', () => {
  it('records_get: the assignee and the requester by name, ids unchanged; an outsider\'s id gets none', async () => {
    const r = await request('GET', `/api/records-ai/item/${taskId}`, { token })
    expect(r.status).toBe(200)
    const record = r.body.data?.record as { fields: Record<string, unknown>; summary: string }
    expect(record.fields.assignee).toBe('u-bob')
    expect(record.summary).toBe('u-carol')
    expect(r.body.data?.people).toEqual({ 'u-bob': '佐藤 花子', 'u-owner': '山田 太郎' })
  })

  it('records_query, records_history and 「あなたの番」 carry the same names; only names are added', async () => {
    const query = await request('POST', '/api/records-ai/query', { token, body: { type: 'task' } })
    expect(query.body.data?.people).toEqual({ 'u-bob': '佐藤 花子', 'u-owner': '山田 太郎' })
    const history = await request('GET', `/api/records-ai/item/${taskId}/history`, { token })
    expect(history.status).toBe(200)
    expect(history.body.data?.people?.['u-owner']).toBe('山田 太郎')
    const myTurn = await request('GET', '/api/records-ai/my-turn', { token })
    expect(myTurn.body.data?.people?.['u-bob']).toBe('佐藤 花子')
    for (const answer of [query, history, myTurn]) {
      const text = JSON.stringify(answer.body)
      expect(text).not.toContain('他社 次郎')
      expect(text).not.toContain('@example.com')
    }
  })

  it('a member who left the company is no longer named', async () => {
    db.prepare('DELETE FROM memberships WHERE company_id = ? AND user_id = ?').run(CO, 'u-owner')
    try {
      const r = await request('GET', `/api/records-ai/item/${taskId}`, { token })
      expect(r.body.data?.people).toEqual({ 'u-bob': '佐藤 花子' })
    } finally {
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-u-owner`, 'u-owner', CO, 'owner', ts(), ts())
    }
  })
})
