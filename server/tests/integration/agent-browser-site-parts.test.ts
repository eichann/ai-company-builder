/**
 * Integration Test: a registered domain's 「詳しい設定」 (redesign step ②, agent-browser.md "A domain's parts and
 * login helpers") on the real routes and database: only owners / admins set it; a host that is not registered, not
 * in its exact spelling, or a domain the company operates is refused; it reaches the members' apps as a field of
 * its own (`browserParts`), never changing the `browser` part released apps validate; another company's settings
 * never reach this company's members. Fictional hosts only.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'sp-owner' as string | null }))

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

const app = new Hono()
app.route('/api/companies/:companyId', agentSandboxRoute)
app.route('/api/companies/:companyId', agentBrowserRoute)

const CO = 'sp-co'
const OTHER = 'sp-other'
const BASE = `/api/companies/${CO}`
const OTHER_BASE = `/api/companies/${OTHER}`
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
const policyOf = async (user: string, base = BASE) => (await call(user, 'GET', `${base}/me/agent-policy`)).json.data

const SHOP = 'shop.example.com'
const DESK = 'desk.example.com'
const setting = (sites: string[], mode = 'on') => ({ mode, sites: sites.map(host => ({ host, level: 'write', assetHosts: [] })) })
const parts = (over: Record<string, unknown> = {}) => ({
  host: SHOP,
  assetHosts: ['img.example.net', 'fonts.example.net'],
  loginHelpers: [{ host: 'check.example.org', pathPrefix: '/challenge/', frame: true, post: true }],
  ...over,
})
const put = (user: string, body: unknown, base = BASE) => call(user, 'PUT', `${base}/agent-browser/site-parts`, body)

beforeAll(async () => {
  initDatabase()
  for (const [id, owner] of [[CO, 'sp-owner'], [OTHER, 'sp-other-owner']]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, owner, ts(), ts())
  }
  const members: Array<[string, string, string]> = [
    ['sp-owner', CO, 'owner'], ['sp-admin', CO, 'admin'], ['sp-member', CO, 'member'],
    ['sp-other-owner', OTHER, 'owner'], ['sp-other-member', OTHER, 'member'],
  ]
  for (const [u, c, r] of members) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, c, r, ts(), ts())
  }
  expect((await call('sp-owner', 'PUT', `${BASE}/agent-browser`, setting([SHOP, DESK]))).status).toBe(200)
  expect((await call('sp-other-owner', 'PUT', `${OTHER_BASE}/agent-browser`, setting([DESK]))).status).toBe(200)
})

describe('a registered domain\'s 「詳しい設定」', () => {
  it('only owners and admins set it; a member\'s or a stranger\'s attempt saves nothing', async () => {
    expect((await put('sp-member', parts())).status).toBe(403)
    expect((await call(null, 'PUT', `${BASE}/agent-browser/site-parts`, parts())).status).toBe(401)
    expect((await put('sp-other-owner', parts())).status).toBe(404)
    expect((await policyOf('sp-member')).browserParts).toBeUndefined()
    expect((await call('sp-owner', 'GET', `${BASE}/agent-browser`)).json.data.siteParts).toEqual([])
  })

  it('refuses a domain not registered, a registered domain as a part or a login helper, and hosts not in their exact spelling', async () => {
    expect((await put('sp-admin', parts({ host: 'unknown.example.com' }))).status).toBe(404)
    // A domain the company operates can never be lent to another one: not as a part, not as a login helper, not itself.
    expect((await put('sp-admin', parts({ assetHosts: [DESK] }))).status).toBe(400)
    expect((await put('sp-admin', parts({ assetHosts: [SHOP] }))).status).toBe(400)
    expect((await put('sp-admin', parts({ loginHelpers: [{ host: DESK, pathPrefix: '/x/', frame: true, post: false }] }))).status).toBe(400)
    for (const bad of ['*.example.net', 'IMG.example.net', 'https://img.example.net', 'localhost', '10.0.0.1', 'img.example.net/x']) {
      expect((await put('sp-admin', parts({ assetHosts: [bad] }))).status, bad).toBe(400)
    }
    expect((await put('sp-admin', parts({ assetHosts: ['img.example.net', 'img.example.net'] }))).status).toBe(400)
    // One host, one rule: a login helper is never also a parts host.
    expect((await put('sp-admin', parts({ assetHosts: ['check.example.org'] }))).status).toBe(400)
    for (const pathPrefix of ['/', 'challenge/', '/challenge', '/../x/', '/a%2f/', '/a?b/']) {
      expect((await put('sp-admin', parts({ loginHelpers: [{ host: 'check.example.org', pathPrefix, frame: false, post: false }] }))).status, pathPrefix).toBe(400)
    }
    expect((await put('sp-admin', { ...parts(), extra: true })).status).toBe(400)
    expect((await put('sp-admin', parts({ loginHelpers: [{ host: 'check.example.org', pathPrefix: '/c/' }] }))).status).toBe(400)
    expect((await policyOf('sp-member')).browserParts).toBeUndefined()
  })

  it('a saved setting reaches the members as a field of its own; the browser part released apps read keeps its shape', async () => {
    const before = await policyOf('sp-member')
    expect(Object.keys(before).includes('browserParts')).toBe(false)
    const saved = await put('sp-admin', parts())
    expect(saved.status).toBe(200)
    expect(saved.json.data.siteParts).toEqual([parts()])
    expect(saved.json.data.history[0].change).toEqual({ target: 'site-parts', host: SHOP, before: null, after: parts() })
    const after = await policyOf('sp-member')
    expect(after.browserParts).toEqual([parts()])
    // The released apps' part is exactly what it was (its sites hold no parts or helpers of the new setting).
    expect(after.browser).toEqual(before.browser)
    expect(Object.keys(after.browser).sort()).toEqual(['mode', 'sites', 'source'])
    expect(Object.keys(after.browser.sites[0]).sort()).toEqual(['assetHosts', 'host', 'level'])
    expect(after.version).not.toBe(before.version)
    // Saving the same again records nothing.
    const again = await put('sp-owner', parts())
    expect(again.json.data.history[0].id).toBe(saved.json.data.history[0].id)
  })

  it('another company\'s settings never reach this company\'s members, nor this company\'s theirs', async () => {
    expect((await put('sp-other-owner', parts({ host: DESK, assetHosts: ['other.example.net'], loginHelpers: [] }), OTHER_BASE)).status).toBe(200)
    expect((await policyOf('sp-member')).browserParts).toEqual([parts()])
    expect((await policyOf('sp-other-member', OTHER_BASE)).browserParts).toEqual([{ host: DESK, assetHosts: ['other.example.net'], loginHelpers: [] }])
  })

  it('a domain registered later is taken out of a setting that lent it, and the domain keeps using the company\'s (never the app\'s fallback)', async () => {
    expect((await put('sp-owner', parts({ host: DESK, assetHosts: ['later.example.com', 'keep.example.net'], loginHelpers: [{ host: 'later.example.com', pathPrefix: '/x/', frame: false, post: false }] }))).status).toBe(400)
    expect((await put('sp-owner', parts({ host: DESK, assetHosts: ['later.example.com', 'keep.example.net'], loginHelpers: [] }))).status).toBe(200)
    expect((await policyOf('sp-member')).browserParts.map((p: Json) => p.host)).toEqual([DESK, SHOP])
    expect((await call('sp-owner', 'PUT', `${BASE}/agent-browser`, setting([SHOP, DESK, 'later.example.com']))).status).toBe(200)
    const lent = (await policyOf('sp-member')).browserParts
    expect(lent).toEqual([{ host: DESK, assetHosts: ['keep.example.net'], loginHelpers: [] }, parts()])
    expect((await call('sp-owner', 'GET', `${BASE}/agent-browser`)).json.data.siteParts).toEqual(lent)
    // Nothing left of it: still the company's (empty), so the app uses nothing for that domain, not its fallback.
    expect((await put('sp-owner', { host: DESK, assetHosts: ['later.example.com'], loginHelpers: [] })).status).toBe(400)
    db.prepare('UPDATE agent_browser_site_parts SET parts = ? WHERE company_id = ? AND host = ?')
      .run(JSON.stringify({ host: DESK, assetHosts: ['later.example.com'], loginHelpers: [] }), CO, DESK)
    expect((await policyOf('sp-member')).browserParts[0]).toEqual({ host: DESK, assetHosts: [], loginHelpers: [] })
    // A removed domain's setting is not handed out; registered again, it applies again.
    expect((await call('sp-owner', 'PUT', `${BASE}/agent-browser`, setting([SHOP]))).status).toBe(200)
    expect((await policyOf('sp-member')).browserParts).toEqual([parts()])
    expect((await call('sp-owner', 'PUT', `${BASE}/agent-browser`, setting([SHOP, DESK]))).status).toBe(200)
    expect((await policyOf('sp-member')).browserParts[0]).toEqual({ host: DESK, assetHosts: ['later.example.com'], loginHelpers: [] })
    expect((await put('sp-owner', { host: DESK, assetHosts: [], loginHelpers: [] })).status).toBe(200)
    expect((await policyOf('sp-member')).browserParts).toEqual([parts()])
  })

  it('nothing is handed out while the browser is off for the member; both lists empty removes the setting', async () => {
    expect((await call('sp-owner', 'PUT', `${BASE}/agent-browser/overrides/sp-member`, { mode: 'off' })).status).toBe(200)
    expect((await policyOf('sp-member')).browserParts).toBeUndefined()
    expect((await policyOf('sp-admin')).browserParts).toEqual([parts()])
    expect((await call('sp-owner', 'PUT', `${BASE}/agent-browser/overrides/sp-member`, { mode: null })).status).toBe(200)
    const cleared = await put('sp-owner', parts({ assetHosts: [], loginHelpers: [] }))
    expect(cleared.status).toBe(200)
    expect(cleared.json.data.siteParts).toEqual([])
    expect(cleared.json.data.history[0].change).toEqual({ target: 'site-parts', host: SHOP, before: parts(), after: null })
    expect((await policyOf('sp-member')).browserParts).toBeUndefined()
  })
})
