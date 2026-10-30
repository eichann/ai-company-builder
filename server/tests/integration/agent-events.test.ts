/**
 * Integration Test: the AI action log API (routes/agent-events.ts) on the real
 * routes and database — sending (session user, validation, re-sends, the
 * per-member budget), reading (filters, pagination, who may read, a manager's
 * scope with a private folder masked), settings (+ history), the retention
 * preview, the viewer list and the prune.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'ae-owner' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id
      ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true }
      : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `Name ${id}` }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { agentEventsRoute } from '../../src/routes/agent-events'
import { permissionsRoute } from '../../src/routes/permissions'
import { services } from '../../src/composition'
import { replaceDepartmentManagers } from '../../src/lib/permission-store'
import type { AgentToolEvent } from '../../shared/types/agent-events'

const app = new Hono()
app.route('/api/companies/:companyId', agentEventsRoute)
app.route('/api/companies/:companyId', permissionsRoute)

const CO = 'ae-co'
const BASE = `/api/companies/${CO}/agent-events`
const ROLE: Record<string, string> = { 'ae-owner': 'owner', 'ae-admin': 'admin', 'ae-manager': 'member', 'ae-member': 'member', 'ae-viewer': 'member' }
const ts = () => new Date().toISOString()

let n = 0
function event(over: Partial<AgentToolEvent> = {}): AgentToolEvent {
  n++
  return {
    version: 1, id: `ae-${n}`, callId: `toolu_${n}`, at: new Date(Date.now() - n * 1000).toISOString(), conversationId: 'conv-a',
    agent: 'claude-code', tool: 'Read', category: 'read', target: { kind: 'file', path: '営業部/a.md' }, department: '営業部',
    decision: 'auto-allowed', outcome: 'ok', ...over,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
async function call(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
  const json: Json = await res.json().catch(() => null)
  return { status: res.status, json, headers: res.headers }
}
const send = (user: string, events: unknown[], headers?: Record<string, string>) => call(user, 'POST', BASE, { events }, headers)
const list = (user: string, qs = '') => call(user, 'GET', `${BASE}${qs ? `?${qs}` : ''}`)
const ids = (r: { json: Json }) => (r.json?.data?.events ?? []).map((e: Json) => e.id)

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'ae-owner', ts(), ts())
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('ae-other', 'other', 'ae-other', 'ae-stranger', ts(), ts())
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  for (const [id, folder, order] of [['ae-d-sales', '営業部', 0], ['ae-d-hr', '人事', 1]] as const) {
    db.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, CO, folder, folder, order, ts(), ts())
  }
  initDatabase()
  replaceDepartmentManagers(db, 'ae-d-sales', ['ae-manager'], 'ae-owner')
  // 営業部/顧客: a private folder only ae-viewer may read.
  db.prepare(`INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES ('ae-r1', ?, 'ae-s-private', ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('ae-s-private', ?, '営業部/顧客', 'folder', 'ae-r1', ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('ae-ru1', 'ae-s-private', 'everyone', NULL, 0, 0, ?), ('ae-ru2', 'ae-s-private', 'user', 'ae-viewer', 1, 0, ?)`).run(ts(), ts())
})

beforeEach(() => { services.agentEvents.resetRateLimits() })

describe('POST /agent-events', () => {
  it('needs a session and membership', async () => {
    expect((await send(null as unknown as string, [event()])).status).toBe(401)
    expect((await send('ae-stranger', [event()])).status).toBe(404)
  })

  it('stores events under the session user (never the body), skips invalid ones, ignores re-sends', async () => {
    const a = event({ id: 'ae-first', companyId: 'someone-else' }) as AgentToolEvent & { userId?: string }
    a.userId = 'ae-owner'
    const r = await send('ae-member', [a, { ...event(), decision: 'maybe' }, event({ id: 'ae-second' })], { 'X-ACB-Client-Version': '0.0.1+abc1234.20261025000000' })
    expect(r.status).toBe(200)
    expect(r.json.data).toEqual({ accepted: 2, duplicates: 0, rejected: 1 })
    expect((await send('ae-member', [a])).json.data).toEqual({ accepted: 0, duplicates: 1, rejected: 0 })
    const row = db.prepare('SELECT user_id, client_version FROM agent_events WHERE company_id = ? AND id = ?').get(CO, 'ae-first')
    expect(row).toEqual({ user_id: 'ae-member', client_version: '0.0.1+abc1234.20261025000000' })
  })

  it('400 for bad JSON or a body without events, 413 beyond 200 events', async () => {
    expect((await call('ae-member', 'POST', BASE, '{not json')).status).toBe(400)
    expect((await call('ae-member', 'POST', BASE, { nothing: true })).status).toBe(400)
    const big = await send('ae-member', Array.from({ length: 201 }, () => event()))
    expect(big.status).toBe(413)
    expect(big.json.code).toBe('TOO_MANY_EVENTS')
  })

  it('429 with Retry-After past 3,000 events per 10 minutes', async () => {
    for (let i = 0; i < 15; i++) {
      const r = await send('ae-admin', Array.from({ length: 200 }, () => event({ id: `ae-bulk-${i}-${n}` })))
      expect(r.status).toBe(200)
    }
    const refused = await send('ae-admin', [event()])
    expect(refused.status).toBe(429)
    expect(refused.json.code).toBe('RATE_LIMITED')
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0)
    db.prepare(`DELETE FROM agent_events WHERE id LIKE 'ae-bulk-%'`).run()
  })
})

describe('GET /agent-events', () => {
  beforeAll(async () => {
    db.prepare('DELETE FROM agent_events WHERE company_id = ?').run(CO)
    services.agentEvents.resetRateLimits()
    await send('ae-member', [
      event({ id: 'ev-sales' }),
      event({ id: 'ev-write', category: 'write', tool: 'Write', decision: 'guard-denied', guardReason: 'read-only-folder', outcome: undefined, target: { kind: 'file', path: '人事/規程.md' }, department: '人事', conversationId: 'conv-b' }),
      event({ id: 'ev-private', target: { kind: 'file', path: '営業部/顧客/リスト.md' } }),
      event({ id: 'ev-cmd', category: 'command', tool: 'Bash', target: { kind: 'command', programs: ['git push'] }, department: undefined, conversationId: 'conv-b' }),
    ])
    await send('ae-viewer', [event({ id: 'ev-viewer', department: '人事', target: { kind: 'web', host: 'example.com' }, category: 'web', tool: 'WebFetch' })])
  })

  it('owner/admin: everything, newest first, with names; filters', async () => {
    const all = await list('ae-owner')
    expect(all.status).toBe(200)
    expect(ids(all)).toEqual(['ev-sales', 'ev-write', 'ev-private', 'ev-cmd', 'ev-viewer'])
    expect(all.json.data.events[0]).toMatchObject({ userId: 'ae-member', name: 'Name ae-member', email: 'ae-member@example.com', department: '営業部', target: { kind: 'file', path: '営業部/a.md' } })
    expect(ids(await list('ae-admin', 'category=write'))).toEqual(['ev-write'])
    expect(ids(await list('ae-admin', 'decision=guard-denied'))).toEqual(['ev-write'])
    expect(ids(await list('ae-admin', 'userId=ae-viewer'))).toEqual(['ev-viewer'])
    expect(ids(await list('ae-admin', 'conversationId=conv-b'))).toEqual(['ev-write', 'ev-cmd'])
    expect(ids(await list('ae-admin', `q=${encodeURIComponent('GIT')}`))).toEqual(['ev-cmd'])
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(ids(await list('ae-admin', `from=${encodeURIComponent(future)}`))).toEqual([])
    expect((await list('ae-admin', 'category=nope')).status).toBe(400)
  })

  it('pages with a cursor, no event twice', async () => {
    const seen: string[] = []
    let cursor: string | null = ''
    for (let i = 0; i < 5 && cursor !== null; i++) {
      const page = await list('ae-owner', `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      seen.push(...ids(page))
      cursor = page.json.data.nextCursor
    }
    expect(seen).toEqual(['ev-sales', 'ev-write', 'ev-private', 'ev-cmd', 'ev-viewer'])
    expect(cursor).toBeNull()
  })

  it('managers: refused while only admins may read; their departments’ part, private folder masked, once allowed', async () => {
    expect((await list('ae-manager')).status).toBe(403)
    expect((await call('ae-owner', 'PUT', `${BASE}/settings`, { viewers: 'admins-and-managers' })).status).toBe(200)
    const page = await list('ae-manager')
    expect(page.status).toBe(200)
    expect(ids(page)).toEqual(['ev-sales', 'ev-private'])
    expect(page.json.data.events[1].target).toEqual({ kind: 'hidden' })
    expect(JSON.stringify(page.json)).not.toContain('顧客')
    expect(ids(await list('ae-manager', `q=${encodeURIComponent('顧客')}`))).toEqual([])
    // Members never; the summary follows the same scope.
    expect((await list('ae-member')).status).toBe(403)
    expect((await call('ae-member', 'GET', `${BASE}/summary`)).status).toBe(403)
    const summary = await call('ae-manager', 'GET', `${BASE}/summary?tzOffsetMinutes=540`)
    expect(summary.status).toBe(200)
    expect(summary.json.data.days.reduce((s: number, d: Json) => s + d.total, 0)).toBe(2)
    expect((await call('ae-owner', 'PUT', `${BASE}/settings`, { viewers: 'admins' })).status).toBe(200)
    expect((await list('ae-manager')).status).toBe(403)
  })

  it('/me/capabilities says who may open the log (the admin console navigation)', async () => {
    const can = async (user: string) => (await call(user, 'GET', `/api/companies/${CO}/me/capabilities`)).json.data.canViewAgentEvents
    expect(await can('ae-owner')).toBe(true)
    expect(await can('ae-admin')).toBe(true)
    expect(await can('ae-manager')).toBe(false)
    expect(await can('ae-member')).toBe(false)
    await call('ae-owner', 'PUT', `${BASE}/settings`, { viewers: 'admins-and-managers' })
    expect(await can('ae-manager')).toBe(true)
    // A member who manages no department still cannot.
    expect(await can('ae-member')).toBe(false)
    await call('ae-owner', 'PUT', `${BASE}/settings`, { viewers: 'admins' })
    expect(await can('ae-manager')).toBe(false)
  })

  it('summary: per member and day, by category, denied counted', async () => {
    const r = await call('ae-owner', 'GET', `${BASE}/summary`)
    expect(r.status).toBe(200)
    const member = r.json.data.days.filter((d: Json) => d.userId === 'ae-member')
    const total = member.reduce((s: number, d: Json) => s + d.total, 0)
    expect(total).toBe(4)
    expect(member.reduce((s: number, d: Json) => s + d.denied, 0)).toBe(1)
    expect(member.reduce((s: number, d: Json) => s + (d.byCategory.command ?? 0), 0)).toBe(1)
    expect(r.json.data.members).toEqual(expect.arrayContaining([{ userId: 'ae-member', name: 'Name ae-member', email: 'ae-member@example.com' }]))
    expect((await call('ae-owner', 'GET', `${BASE}/summary?from=2026-01-01T00:00:00Z&to=2020-01-01T00:00:00Z`)).status).toBe(400)
  })
})

describe('settings, preview, viewers, prune', () => {
  it('settings: defaults, owner/admin only, validated, every change in the history', async () => {
    db.prepare('DELETE FROM agent_event_settings WHERE company_id = ?').run(CO)
    db.prepare('DELETE FROM agent_event_settings_history WHERE company_id = ?').run(CO)
    const first = await call('ae-admin', 'GET', `${BASE}/settings`)
    expect(first.json.data).toEqual({ retentionDays: 180, viewers: 'admins', updatedAt: null, updatedBy: null, history: [] })
    expect((await call('ae-manager', 'GET', `${BASE}/settings`)).status).toBe(403)
    expect((await call('ae-member', 'PUT', `${BASE}/settings`, { retentionDays: 30 })).status).toBe(403)
    for (const bad of [{ retentionDays: 6 }, { retentionDays: 3651 }, { retentionDays: 30.5 }, { viewers: 'everyone' }, {}]) {
      expect((await call('ae-owner', 'PUT', `${BASE}/settings`, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    const changed = await call('ae-admin', 'PUT', `${BASE}/settings`, { retentionDays: 90 })
    expect(changed.json.data).toMatchObject({ retentionDays: 90, viewers: 'admins', updatedBy: 'ae-admin' })
    await call('ae-owner', 'PUT', `${BASE}/settings`, { retentionDays: 90 }) // no change: no history row
    await call('ae-owner', 'PUT', `${BASE}/settings`, { viewers: 'admins-and-managers', retentionDays: 365 })
    const history = (await call('ae-owner', 'GET', `${BASE}/settings`)).json.data.history
    expect(history.map((h: Json) => [h.changedBy, h.before, h.after])).toEqual([
      ['ae-owner', { retentionDays: 90, viewers: 'admins' }, { retentionDays: 365, viewers: 'admins-and-managers' }],
      ['ae-admin', { retentionDays: 180, viewers: 'admins' }, { retentionDays: 90, viewers: 'admins' }],
    ])
    expect(history[0].name).toBe('Name ae-owner')
    await call('ae-owner', 'PUT', `${BASE}/settings`, { viewers: 'admins', retentionDays: 180 })
  })

  it('viewers: owner/admin as `all`; managers with their departments in the managers mode', async () => {
    const admins = await call('ae-owner', 'GET', `${BASE}/viewers?mode=admins`)
    expect(admins.json.data.viewers.map((v: Json) => [v.userId, v.scope])).toEqual([['ae-owner', 'all'], ['ae-admin', 'all']])
    const managers = await call('ae-owner', 'GET', `${BASE}/viewers?mode=admins-and-managers`)
    expect(managers.json.data.mode).toBe('admins-and-managers')
    expect(managers.json.data.viewers.at(-1)).toEqual({
      userId: 'ae-manager', name: 'Name ae-manager', email: 'ae-manager@example.com', role: 'member', scope: 'departments',
      departments: [{ id: 'ae-d-sales', name: '営業部', folder: '営業部' }],
    })
    expect((await call('ae-owner', 'GET', `${BASE}/viewers?mode=all`)).status).toBe(400)
    expect((await call('ae-manager', 'GET', `${BASE}/viewers`)).status).toBe(403)
  })

  it('retention preview and prune agree', async () => {
    const old = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString()
    for (const id of ['ae-old-1', 'ae-old-2']) {
      db.prepare(`INSERT INTO agent_events (company_id, id, user_id, received_at, at, client_at, version, call_id, agent, tool, category, target_kind, target, decision)
        VALUES (?, ?, 'ae-member', ?, ?, ?, 1, 'c', 'claude-code', 'Read', 'read', 'none', '{"kind":"none"}', 'auto-allowed')`).run(CO, id, old, old, old)
    }
    const preview = await call('ae-owner', 'GET', `${BASE}/settings/retention-preview?days=180`)
    expect(preview.json.data).toMatchObject({ days: 180, wouldDelete: 2 })
    expect((await call('ae-owner', 'GET', `${BASE}/settings/retention-preview?days=abc`)).status).toBe(400)
    const { deleted } = await services.agentEvents.prune()
    expect(deleted).toBeGreaterThanOrEqual(2)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_events WHERE id LIKE 'ae-old-%'`).get()).toEqual({ n: 0 })
    expect((await list('ae-owner')).json.data.events.length).toBe(5)
  })
})

describe('the AI sandbox in the log (「AI の囲い」)', () => {
  it('keeps the sandbox mark, the hosts and the skill; tables them by host, skill and secret place for owners/admins', async () => {
    const sb = [
      event({ id: 'sb-1', tool: 'Bash', category: 'command', target: { kind: 'command', programs: ['curl'], hosts: ['upload.example.net'] }, decision: 'policy-default', outcome: 'ok', sandbox: 'would-block', skill: 'create-movie' }),
      event({ id: 'sb-2', tool: 'Bash', category: 'command', target: { kind: 'command', programs: ['python3'], hosts: ['upload.example.net', 'cdn.example.net'] }, decision: 'policy-default', outcome: 'error', guardReason: 'sandbox', sandbox: 'blocked', skill: 'create-movie' }),
      event({ id: 'sb-3', tool: 'Read', category: 'read', target: { kind: 'outside', sensitive: 'ssh' }, decision: 'policy-denied', guardReason: 'denied-read', outcome: undefined }),
      event({ id: 'sb-4', tool: 'Read', category: 'read' }),
    ]
    expect((await send('ae-member', sb)).json.data).toEqual({ accepted: 4, duplicates: 0, rejected: 0 })
    const listed = (await list('ae-owner', 'q=cdn.example.net')).json.data.events
    expect(listed.map((e: Json) => [e.id, e.sandbox, e.skill])).toEqual([['sb-2', 'blocked', 'create-movie']])

    const impact = await call('ae-owner', 'GET', `${BASE}/sandbox`)
    expect(impact.status).toBe(200)
    const d = impact.json.data
    expect(d.byHost.map((h: Json) => [h.host, h.wouldBlock, h.blocked, h.members])).toEqual([['upload.example.net', 1, 1, 1], ['cdn.example.net', 0, 1, 1]])
    expect(d.bySkill.map((s: Json) => [s.skill, s.wouldBlock, s.blocked, s.deniedReads])).toEqual([['create-movie', 1, 1, 0], [null, 0, 0, 1]])
    expect(d.byPlace.map((p: Json) => [p.place, p.deniedReads])).toEqual([['ssh', 1]])
    expect(d.total).toBe(3)
    expect((await call('ae-manager', 'GET', `${BASE}/sandbox`)).status).toBe(403)
    expect((await call('ae-member', 'GET', `${BASE}/sandbox`)).status).toBe(403)
    expect((await call('ae-owner', 'GET', `${BASE}/sandbox?from=nope`)).status).toBe(400)
  })
})
