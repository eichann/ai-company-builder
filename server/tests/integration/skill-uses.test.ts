/**
 * Integration Test: which company Skill a consultation used
 * (`.claude/rules/records.md` "Which Skill", owner decision 2026-11-01).
 *
 * Guards:
 * - a report is a skill folder name, a git tree id and a dirty flag — a path, a private
 *   folder's name or anything else in `name` is refused, nothing kept;
 * - the first report of a (name, tree, dirty) keeps its time; a repeat changes nothing;
 *   past the per-consultation limit nothing more is kept;
 * - the AI's ledger entry copies the Skills its consultation had used when it was written:
 *   a Skill used later never rewrites it, the next entry carries both; only the member's
 *   own consultation counts (another member's report under the same id is not theirs);
 * - a person's entry carries none, even with the consultation's id in its body.
 * The Drive receipt's copy is in google-drive.test.ts.
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
import { skillUsesRoute } from '../../src/routes/skill-uses'
import { services } from '../../src/composition'
import { SKILL_USES_PER_CONSULTATION } from '../../shared/core/skill-uses'

const app = new Hono()
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', skillUsesRoute)
app.route('/api/records-ai', recordsAiRoute)

const CO = 'su-co'
const ts = () => new Date().toISOString()
const V1 = '1'.repeat(40)
const V2 = '2'.repeat(40)
const V256 = 'c'.repeat(64)

async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json() as { data?: Record<string, unknown>; code?: string; error?: string } }
}
const session = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `/api/companies/${CO}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown) => call({ token, method, path: `/api/records-ai${path}`, body })
const report = (user: string, body: Record<string, unknown>) => session(user, 'POST', '/me/skill-uses', body)
const use = (conversationId: string, tree: string, over: Record<string, unknown> = {}) => ({ conversationId, name: 'sales-proposal', tree, dirty: false, ...over })

async function tokenFor(user: string, conversationId: string): Promise<string> {
  const r = await session(user, 'POST', '/me/record-tokens', { conversationId, agent: 'claude-code', scope: 'act' })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return (r.body.data as { token: string }).token
}
const rows = (user: string, conversationId: string) => db.prepare(
  'SELECT skill, tree, dirty, first_used_at FROM consultation_skill_uses WHERE company_id = ? AND user_id = ? AND conversation_id = ? ORDER BY first_used_at, tree',
).all(CO, user, conversationId) as Array<{ skill: string; tree: string; dirty: number; first_used_at: string }>

beforeAll(async () => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', ts(), ts())
  for (const [user, role] of [['u-owner', 'owner'], ['u-bob', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${user}`, user, CO, role, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  currentUser.id = 'u-owner'
  await app.request(`/api/companies/${CO}/records/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
  await services.records.refreshIndex({ companyId: CO, userId: 'u-owner', role: 'owner' })
})

describe('a report', () => {
  it('is a skill folder name, a tree id and dirty: a path, a Japanese folder name or a bad tree is refused and nothing kept', async () => {
    for (const bad of [
      use('c-bad', V1, { name: '営業/秘密/.claude/skills/x' }), use('c-bad', V1, { name: '../x' }), use('c-bad', V1, { name: '秘密の提案' }),
      use('c-bad', V1, { name: 'Sales' }), use('c-bad', 'HEAD'), use('c-bad', V1.slice(1)), use('c-bad', V1, { dirty: 'no' }),
      use('', V1), { name: 'sales-proposal', tree: V1, dirty: false },
    ]) {
      expect((await report('u-bob', bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect(rows('u-bob', 'c-bad')).toEqual([])
    expect((await report('u-bob', use('c-ok', V256, { dirty: true }))).body.data).toEqual({ recorded: true })
  })

  it('keeps the first time of each (name, tree, dirty); a repeat changes nothing; past the limit nothing more is kept', async () => {
    expect((await report('u-bob', use('c-once', V1))).status).toBe(200)
    const first = rows('u-bob', 'c-once')
    expect(first).toHaveLength(1)
    await new Promise(r => setTimeout(r, 5))
    expect((await report('u-bob', use('c-once', V1))).body.data).toEqual({ recorded: true })
    expect(rows('u-bob', 'c-once')).toEqual(first)
    // The same tree with local changes is another version.
    expect((await report('u-bob', use('c-once', V1, { dirty: true }))).status).toBe(200)
    expect(rows('u-bob', 'c-once').map(r => r.dirty)).toEqual([0, 1])

    for (let i = 0; i < SKILL_USES_PER_CONSULTATION; i++) await report('u-bob', use('c-full', i.toString(16).padStart(40, '0')))
    expect((await report('u-bob', use('c-full', V2))).body.data).toEqual({ recorded: false })
    expect(rows('u-bob', 'c-full')).toHaveLength(SKILL_USES_PER_CONSULTATION)
  })
})

describe('the AI\'s ledger entries', () => {
  it('copy the Skills the consultation had used when written; a later Skill never rewrites an earlier entry; only the member\'s own consultation counts', async () => {
    const made = await session('u-owner', 'POST', '/records/item', { type: 'task', title: '提案書を作る', fields: { assignee: 'u-owner' } })
    const id = (made.body.data?.record as { id: string }).id
    expect((await report('u-owner', use('c-sales', V1))).status).toBe(200)
    // Not this consultation's: another member's report under the same id, and another consultation.
    expect((await report('u-bob', use('c-sales', V2, { name: 'bob-skill' }))).status).toBe(200)
    expect((await report('u-owner', use('c-elsewhere', V2, { name: 'other-skill' }))).status).toBe(200)

    const token = await tokenFor('u-owner', 'c-sales')
    expect((await ai(token, 'POST', `/item/${id}/actions/start`, { expectedVersion: 1 })).status).toBe(200)
    // v2 used later in the same consultation.
    expect((await report('u-owner', use('c-sales', V2))).status).toBe(200)
    expect((await ai(token, 'POST', `/item/${id}/actions/wait`, { expectedVersion: 2, args: { waiting_on: '先方の返事' } })).status).toBe(200)
    // A person's action naming the consultation: no Skills (only what the AI wrote).
    expect((await session('u-owner', 'POST', `/records/item/${id}/actions/start`, { expectedVersion: 3, proposedBy: 'ai', conversationId: 'c-sales' })).status).toBe(200)

    const entries = ((await session('u-owner', 'GET', `/records/item/${id}/history`)).body.data?.entries ?? []) as Array<{ action: string; skills?: unknown }>
    const skillsOf = (action: string) => entries.find(e => e.action === action)?.skills
    expect(skillsOf('create')).toBeUndefined()
    expect(entries[1].skills).toEqual([{ name: 'sales-proposal', tree: V1, dirty: false, firstUsedAt: expect.any(String) }])
    expect(skillsOf('wait')).toEqual([
      { name: 'sales-proposal', tree: V1, dirty: false, firstUsedAt: expect.any(String) },
      { name: 'sales-proposal', tree: V2, dirty: false, firstUsedAt: expect.any(String) },
    ])
    expect(entries[3].skills).toBeUndefined()
  })
})
