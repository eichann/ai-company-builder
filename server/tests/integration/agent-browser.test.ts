/**
 * Integration Test: 「ブラウザ操作」 (routes/agent-browser.ts) on the real routes and
 * database — who may read and change it, validation, the per-member override, the change
 * history, and the `browser` part of each member's GET /me/agent-policy (+ its version).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'br-owner' as string | null }))

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
import { agentBrowserRoute } from '../../src/routes/agent-browser'
import { agentSandboxRoute } from '../../src/routes/agent-sandbox'
import { services } from '../../src/composition'

const app = new Hono()
app.route('/api/companies/:companyId', agentSandboxRoute)
app.route('/api/companies/:companyId', agentBrowserRoute)

const CO = 'br-co'
const BASE = `/api/companies/${CO}`
const ROLE: Record<string, string> = { 'br-owner': 'owner', 'br-admin': 'admin', 'br-member': 'member', 'br-member2': 'member', 'br-leaver': 'member' }
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
async function call(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
  const json: Json = await res.json().catch(() => null)
  return { status: res.status, json }
}
const policyOf = async (user: string) => (await call(user, 'GET', `${BASE}/me/agent-policy`)).json.data

const on = {
  mode: 'on',
  sites: [{ host: 'crm.example.com', level: 'write', assetHosts: ['cdn.example.net'] }],
}

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'br-owner', ts(), ts())
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('br-other', 'other', 'br-other', 'br-stranger', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-br-stranger', 'br-stranger', 'br-other', 'owner', ts(), ts())
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
})

describe('「ブラウザ操作」', () => {
  it('only owners and admins read or change it; strangers learn nothing', async () => {
    expect((await call(null, 'GET', `${BASE}/agent-browser`)).status).toBe(401)
    expect((await call('br-stranger', 'GET', `${BASE}/agent-browser`)).status).toBe(404)
    expect((await call('br-member', 'GET', `${BASE}/agent-browser`)).status).toBe(403)
    expect((await call('br-member', 'PUT', `${BASE}/agent-browser`, on)).status).toBe(403)
    expect((await call('br-member', 'PUT', `${BASE}/agent-browser/overrides/br-member`, { mode: 'on' })).status).toBe(403)
    expect((await call('br-admin', 'GET', `${BASE}/agent-browser`)).status).toBe(200)
    // Nothing was saved by the refused calls.
    expect((await policyOf('br-member')).browser.mode).toBe('off')
  })

  it('starts off with no sites (no row), and every member\'s policy says so', async () => {
    const view = (await call('br-owner', 'GET', `${BASE}/agent-browser`)).json.data
    expect(view).toMatchObject({ settings: { mode: 'off', sites: [] }, overrides: [], updatedAt: null, history: [] })
    expect((await policyOf('br-member')).browser).toEqual({ mode: 'off', sites: [], source: 'company' })
  })

  it('refuses a wildcard, a duplicate site, the operated host as a parts host, or an unknown level', async () => {
    const site = on.sites[0]
    for (const bad of [
      { ...on, sites: [{ ...site, host: '*.example.com' }] },
      { ...on, sites: [site, { ...site, host: 'CRM.Example.com' }] },
      { ...on, sites: [{ ...site, assetHosts: ['crm.example.com'] }] },
      { ...on, sites: [{ ...site, level: 'admin' }] },
      { ...on, sites: [{ ...site, assetHosts: ['*.cdn.example.net'] }] },
      { ...on, mode: 'enforce' },
      'not json',
    ]) {
      expect((await call('br-owner', 'PUT', `${BASE}/agent-browser`, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await call('br-owner', 'GET', `${BASE}/agent-browser`)).json.data).toMatchObject({ settings: { mode: 'off', sites: [] }, history: [] })
  })

  it('a saved setting reaches every member\'s policy with a new version; saving it again records nothing', async () => {
    const before = await policyOf('br-member2')
    const r = await call('br-admin', 'PUT', `${BASE}/agent-browser`, { ...on, sites: [{ ...on.sites[0], host: 'CRM.Example.com' }] })
    expect(r.status).toBe(200)
    expect(r.json.data.settings).toEqual(on)
    expect(r.json.data.history).toHaveLength(1)
    expect(r.json.data.history[0]).toMatchObject({ changedBy: 'br-admin', change: { target: 'company', before: { mode: 'off', sites: [] }, after: on } })
    const after = await policyOf('br-member2')
    expect(after.browser).toEqual({ ...on, source: 'company' })
    expect(after.version).not.toBe(before.version)
    // The sandbox part is untouched.
    expect(after.sandbox).toEqual(before.sandbox)
    const again = await call('br-admin', 'PUT', `${BASE}/agent-browser`, on)
    expect(again.json.data.history).toHaveLength(1)
    expect((await policyOf('br-member2')).version).toBe(after.version)
  })

  it('a member\'s override changes only that member, and only members can have one', async () => {
    const other = await policyOf('br-member2')
    const set = await call('br-owner', 'PUT', `${BASE}/agent-browser/overrides/br-member`, { mode: 'off' })
    expect(set.status).toBe(200)
    expect(set.json.data.overrides).toEqual([expect.objectContaining({ userId: 'br-member', mode: 'off', name: 'Name br-member' })])
    expect(set.json.data.history[0].change).toMatchObject({ target: 'member', userId: 'br-member', before: null, after: 'off' })
    expect((await policyOf('br-member')).browser).toEqual({ ...on, mode: 'off', source: 'member' })
    expect(await policyOf('br-member2')).toEqual(other)
    expect((await call('br-owner', 'PUT', `${BASE}/agent-browser/overrides/br-stranger`, { mode: 'on' })).status).toBe(404)
    expect((await call('br-owner', 'PUT', `${BASE}/agent-browser/overrides/br-member`, { mode: 'enforce' })).status).toBe(400)
    expect((await call('br-owner', 'PUT', `${BASE}/agent-browser/overrides/br-member`, {})).status).toBe(400)
    const cleared = await call('br-owner', 'PUT', `${BASE}/agent-browser/overrides/br-member`, { mode: null })
    expect(cleared.json.data.overrides).toEqual([])
    expect((await policyOf('br-member')).browser).toEqual({ ...on, source: 'company' })
  })

  it('an override from before a member left neither shows nor applies when they come back', async () => {
    await call('br-owner', 'PUT', `${BASE}/agent-browser`, { ...on, mode: 'off' })
    await call('br-owner', 'PUT', `${BASE}/agent-browser/overrides/br-leaver`, { mode: 'on' })
    expect((await policyOf('br-leaver')).browser.source).toBe('member')
    // They leave …
    db.prepare('DELETE FROM memberships WHERE company_id = ? AND user_id = ?').run(CO, 'br-leaver')
    expect((await call('br-owner', 'GET', `${BASE}/agent-browser`)).json.data.overrides).toEqual([])
    expect((await call('br-leaver', 'GET', `${BASE}/me/agent-policy`)).status).toBe(404)
    // … and are invited back later.
    await new Promise(resolve => setTimeout(resolve, 5))
    const later = ts()
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-br-leaver-2', 'br-leaver', CO, 'member', later, later)
    expect((await policyOf('br-leaver')).browser).toEqual({ ...on, mode: 'off', source: 'company' })
    expect((await call('br-owner', 'GET', `${BASE}/agent-browser`)).json.data.overrides).toEqual([])
    // 「会社と同じ」 for them removes the old row and records nothing (nothing changed for anyone).
    const historyBefore = (await call('br-owner', 'GET', `${BASE}/agent-browser`)).json.data.history.length
    const cleared = await call('br-owner', 'PUT', `${BASE}/agent-browser/overrides/br-leaver`, { mode: null })
    expect(cleared.status).toBe(200)
    expect(cleared.json.data.history).toHaveLength(historyBefore)
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_browser_overrides WHERE company_id = ? AND user_id = ?').get(CO, 'br-leaver')).toEqual({ n: 0 })
    // A mode set for them now is theirs, and recorded.
    const set = await call('br-owner', 'PUT', `${BASE}/agent-browser/overrides/br-leaver`, { mode: 'on' })
    expect(set.json.data.history).toHaveLength(historyBefore + 1)
    expect((await policyOf('br-leaver')).browser).toMatchObject({ mode: 'on', source: 'member' })
  })

  it('a change of the setting or of an override is announced on the push channel with the new version', async () => {
    const got: Array<{ kind: string; version: string }> = []
    const sub = services.push.open(CO, 'br-member2', { send: e => got.push(e as { kind: string; version: string }) })
    if (!sub.ok) throw new Error('push channel refused')
    try {
      await call('br-owner', 'PUT', `${BASE}/agent-browser`, { ...on, sites: [] })
      await vi.waitFor(() => expect(got).toHaveLength(1))
      expect(got[0]).toEqual({ kind: 'policy', version: (await policyOf('br-member2')).version })
      await call('br-owner', 'PUT', `${BASE}/agent-browser/overrides/br-member2`, { mode: 'off' })
      await vi.waitFor(() => expect(got).toHaveLength(2))
      expect(got[1]).toEqual({ kind: 'policy', version: (await policyOf('br-member2')).version })
      expect(got[1].version).not.toBe(got[0].version)
    } finally {
      sub.close()
    }
  })

  it('a stored setting that no longer validates is read as off', async () => {
    db.prepare('UPDATE agent_browser_settings SET settings = ? WHERE company_id = ?').run(JSON.stringify({ mode: 'on', sites: [{ host: '*', level: 'write', assetHosts: [] }] }), CO)
    expect((await policyOf('br-admin')).browser).toEqual({ mode: 'off', sites: [], source: 'company' })
  })
})
