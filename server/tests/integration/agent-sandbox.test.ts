/**
 * Integration Test: the AI sandbox setting (routes/agent-sandbox.ts) on the
 * real routes and database — who may read and change it, validation, the
 * per-member override (staged rollout), the change history, and the policy
 * each member's app receives from GET /me/agent-policy (+ ETag).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'sb-owner' as string | null }))

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
import { agentSandboxRoute } from '../../src/routes/agent-sandbox'
import { DEFAULT_SANDBOX_ALLOWED_DOMAINS } from '../../shared/core/agent-sandbox'

const app = new Hono()
app.route('/api/companies/:companyId', agentSandboxRoute)

const CO = 'sb-co'
const BASE = `/api/companies/${CO}`
const ROLE: Record<string, string> = { 'sb-owner': 'owner', 'sb-admin': 'admin', 'sb-member': 'member', 'sb-member2': 'member' }
const ts = () => new Date().toISOString()

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

const enforce = { mode: 'enforce', allowedDomains: ['api.github.com', '*.r2.cloudflarestorage.com'], deniedReadPaths: ['~/顧客'], onUnavailable: 'stop' }

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'sb-owner', ts(), ts())
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('sb-other', 'other', 'sb-other', 'sb-stranger', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-sb-stranger', 'sb-stranger', 'sb-other', 'owner', ts(), ts())
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
})

describe('the AI sandbox setting', () => {
  it('only owners and admins read or change it; strangers learn nothing', async () => {
    expect((await call(null, 'GET', `${BASE}/agent-sandbox`)).status).toBe(401)
    expect((await call('sb-stranger', 'GET', `${BASE}/agent-sandbox`)).status).toBe(404)
    expect((await call('sb-member', 'GET', `${BASE}/agent-sandbox`)).status).toBe(403)
    expect((await call('sb-member', 'PUT', `${BASE}/agent-sandbox`, enforce)).status).toBe(403)
    expect((await call('sb-member', 'PUT', `${BASE}/agent-sandbox/overrides/sb-member`, { mode: 'off' })).status).toBe(403)
    expect((await call('sb-admin', 'GET', `${BASE}/agent-sandbox`)).status).toBe(200)
  })

  it('starts off with the default host list, and a member\'s app gets exactly that', async () => {
    const view = (await call('sb-owner', 'GET', `${BASE}/agent-sandbox`)).json.data
    expect(view.settings).toEqual({ mode: 'off', allowedDomains: [...DEFAULT_SANDBOX_ALLOWED_DOMAINS], deniedReadPaths: [], onUnavailable: 'record-only' })
    const policy = (await call('sb-member', 'GET', `${BASE}/me/agent-policy`)).json.data
    expect(policy.sandbox).toEqual({ ...view.settings, source: 'company' })
  })

  it('refuses a setting that would open every host or hide the whole home folder', async () => {
    for (const bad of [
      { ...enforce, allowedDomains: ['*'] },
      { ...enforce, allowedDomains: ['localhost'] },
      { ...enforce, deniedReadPaths: ['~'] },
      { ...enforce, mode: 'strict' },
      { ...enforce, onUnavailable: undefined },
      'not json',
    ]) {
      expect((await call('sb-owner', 'PUT', `${BASE}/agent-sandbox`, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await call('sb-owner', 'GET', `${BASE}/agent-sandbox`)).json.data.settings.mode).toBe('off')
  })

  it('a saved setting reaches every member\'s policy, normalized, and the change is recorded', async () => {
    const r = await call('sb-admin', 'PUT', `${BASE}/agent-sandbox`, { ...enforce, allowedDomains: ['API.GitHub.com', ...enforce.allowedDomains] })
    expect(r.status).toBe(200)
    expect(r.json.data.settings).toEqual(enforce)
    expect(r.json.data.history[0]).toMatchObject({ changedBy: 'sb-admin', change: { target: 'company', before: { mode: 'off' }, after: enforce } })
    const policy = (await call('sb-member2', 'GET', `${BASE}/me/agent-policy`)).json.data
    expect(policy.sandbox).toEqual({ ...enforce, source: 'company' })
    // Saving the same thing again is not a change.
    const again = await call('sb-admin', 'PUT', `${BASE}/agent-sandbox`, enforce)
    expect(again.json.data.history.length).toBe(r.json.data.history.length)
  })

  it('a per-member override changes only that member\'s mode (staged rollout), and can be removed', async () => {
    const set = await call('sb-owner', 'PUT', `${BASE}/agent-sandbox/overrides/sb-member`, { mode: 'observe' })
    expect(set.status).toBe(200)
    expect(set.json.data.overrides).toEqual([expect.objectContaining({ userId: 'sb-member', mode: 'observe', name: 'Name sb-member' })])
    expect(set.json.data.history[0].change).toMatchObject({ target: 'member', userId: 'sb-member', before: null, after: 'observe' })
    const own = (await call('sb-member', 'GET', `${BASE}/me/agent-policy`)).json.data.sandbox
    expect(own).toEqual({ ...enforce, mode: 'observe', source: 'member' })
    const other = (await call('sb-member2', 'GET', `${BASE}/me/agent-policy`)).json.data.sandbox
    expect(other.mode).toBe('enforce')
    // Not a member of this company / bad mode.
    expect((await call('sb-owner', 'PUT', `${BASE}/agent-sandbox/overrides/sb-stranger`, { mode: 'off' })).status).toBe(404)
    expect((await call('sb-owner', 'PUT', `${BASE}/agent-sandbox/overrides/sb-member`, { mode: 'on' })).status).toBe(400)
    expect((await call('sb-owner', 'PUT', `${BASE}/agent-sandbox/overrides/sb-member`, {})).status).toBe(400)
    // Back to the company's mode.
    const cleared = await call('sb-owner', 'PUT', `${BASE}/agent-sandbox/overrides/sb-member`, { mode: null })
    expect(cleared.json.data.overrides).toEqual([])
    expect((await call('sb-member', 'GET', `${BASE}/me/agent-policy`)).json.data.sandbox).toEqual({ ...enforce, source: 'company' })
  })

  it('the policy carries a version: unchanged → 304, any change → a new version', async () => {
    const first = await call('sb-member', 'GET', `${BASE}/me/agent-policy`)
    const etag = first.headers.get('ETag')!
    expect(etag).toBe(`"${first.json.data.version}"`)
    expect((await call('sb-member', 'GET', `${BASE}/me/agent-policy`, undefined, { 'If-None-Match': etag })).status).toBe(304)
    await call('sb-owner', 'PUT', `${BASE}/agent-sandbox/overrides/sb-member`, { mode: 'off' })
    const changed = await call('sb-member', 'GET', `${BASE}/me/agent-policy`, undefined, { 'If-None-Match': etag })
    expect(changed.status).toBe(200)
    expect(changed.json.data.version).not.toBe(first.json.data.version)
    expect((await call('sb-stranger', 'GET', `${BASE}/me/agent-policy`)).status).toBe(404)
  })
})
