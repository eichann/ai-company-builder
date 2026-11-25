/**
 * Integration Test: the member's own level per registered domain in their policy (`browserLevels`,
 * agent-browser.md "Keeping a login on disk") on the real routes and database. The app keeps a site's login on disk
 * only where this says the person may use the site, so: it says each person's own level (another member's change is
 * not theirs), 使わない reaches the app, it is absent while their browser part is off (a company not using it keeps
 * its answer), and a change of a level is announced on the push channel with the new version. Fictional hosts only.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'bl-owner' as string | null }))

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
import { browserLinesRoute } from '../../src/routes/browser-lines'
import { services } from '../../src/composition'

const app = new Hono()
app.route('/api/companies/:companyId', agentSandboxRoute)
app.route('/api/companies/:companyId', agentBrowserRoute)
app.route('/api/companies/:companyId', browserLinesRoute)

const CO = 'bl-co'
const BASE = `/api/companies/${CO}`
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
async function call(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json: Json = await res.json().catch(() => null)
  return { status: res.status, json }
}
const policyOf = async (user: string) => (await call(user, 'GET', `${BASE}/me/agent-policy`)).json.data

const SHOP = 'shop.example.com'
const DESK = 'desk.example.com'
const setting = (mode: 'on' | 'off') => ({ mode, sites: [{ host: SHOP, level: 'write', assetHosts: [] }, { host: DESK, level: 'read', assetHosts: [] }] })

beforeAll(async () => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'bl-owner', ts(), ts())
  for (const [u, r] of [['bl-owner', 'owner'], ['bl-member', 'member'], ['bl-member2', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, '2026-01-01T00:00:00.000Z', ts())
  }
})

describe('the member\'s own levels in their policy (agent-browser.md "Keeping a login on disk")', () => {
  it('is absent while the browser part is off, so a company not using it keeps its answer', async () => {
    expect((await policyOf('bl-member')).browserLevels).toBeUndefined()
    expect((await call('bl-owner', 'PUT', `${BASE}/agent-browser`, setting('off'))).status).toBe(200)
    expect((await policyOf('bl-member')).browserLevels).toBeUndefined()
  })

  it('says each listed site with the person\'s own level (見るだけ when nobody chose), 使わない included', async () => {
    expect((await call('bl-owner', 'PUT', `${BASE}/agent-browser`, setting('on'))).status).toBe(200)
    expect((await policyOf('bl-member')).browserLevels).toEqual([{ host: SHOP, level: 'read' }, { host: DESK, level: 'read' }])
    expect((await call('bl-owner', 'PUT', `${BASE}/browser-site-grants/bl-member`, { host: SHOP, level: 'none' })).status).toBe(200)
    expect((await policyOf('bl-member')).browserLevels).toEqual([{ host: SHOP, level: 'none' }, { host: DESK, level: 'read' }])
    expect((await policyOf('bl-member2')).browserLevels, 'another member\'s level is not this one\'s')
      .toEqual([{ host: SHOP, level: 'read' }, { host: DESK, level: 'read' }])
  })

  it('a change of a person\'s level is announced on the push channel with their new version', async () => {
    const got: Array<{ kind: string; version: string }> = []
    const sub = services.push.open(CO, 'bl-member', { send: e => got.push(e as { kind: string; version: string }) })
    if (!sub.ok) throw new Error('push channel refused')
    try {
      const before = (await policyOf('bl-member')).version
      expect((await call('bl-owner', 'PUT', `${BASE}/browser-site-grants/bl-member`, { host: SHOP, level: 'write' })).status).toBe(200)
      await vi.waitFor(() => expect(got).toHaveLength(1))
      const after = await policyOf('bl-member')
      expect(after.browserLevels).toContainEqual({ host: SHOP, level: 'write' })
      expect(got[0]).toEqual({ kind: 'policy', version: after.version })
      expect(after.version).not.toBe(before)
    } finally {
      sub.close()
    }
  })

  it('the member\'s own browser turned off by an override removes the levels', async () => {
    expect((await call('bl-owner', 'PUT', `${BASE}/agent-browser/overrides/bl-member`, { mode: 'off' })).status).toBe(200)
    expect((await policyOf('bl-member')).browserLevels).toBeUndefined()
  })
})
