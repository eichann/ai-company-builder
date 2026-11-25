/**
 * Integration Test: 「ブラウザ操作」 plans over HTTP (routes/browser-plans.ts, the real composition and the
 * real approved combination; agent-browser.md "Plans, executions, permits and locks"). The state rules
 * are tests/unit/browser-plans.test.ts; here: the whole way through the routes with a person's session,
 * the secret only in a header and only once (not cached), the report with the secret alone (also after
 * the member left the company, through the real member removal), and who manages the grants.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'bp-owner' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `Name ${id}` }]))),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// A new Lステップ row is written `pending` (design memo §33.5: approved by a reviewed edit with the
// first app build carrying everything it needs); this test runs the real file with such a row approved.
vi.mock('../../src/adapters/browser-connector-catalog', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/adapters/browser-connector-catalog')>()
  return {
    ...real,
    fileBrowserConnectorCatalog: (file?: string) => {
      const rows = real.fileBrowserConnectorCatalog(file).combinations().map(r => (r.status === 'pending' ? { ...r, status: 'approved' } : r))
      return { combinations: () => rows }
    },
  }
})

import { Hono } from 'hono'
import { createHash } from 'crypto'
import { db, initDatabase } from '../../src/db'
import { browserPlansRoute, browserReportRoute } from '../../src/routes/browser-plans'
import { companiesRoute } from '../../src/routes/companies'
import { agentBrowserRoute } from '../../src/routes/agent-browser'
import { browserDevicesRoute } from '../../src/routes/browser-devices'
import { browserLinesRoute } from '../../src/routes/browser-lines'
import { fileBrowserConnectorCatalog } from '../../src/adapters/browser-connector-catalog'
import { randomBytes } from 'crypto'

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', agentBrowserRoute)
app.route('/api/companies/:companyId', browserPlansRoute)
app.route('/api', browserReportRoute)
app.route('/api/companies/:companyId', browserDevicesRoute)
app.route('/api/companies/:companyId', browserLinesRoute)

const CO = 'bp-co'
const BASE = `/api/companies/${CO}`
const ROLE: Record<string, string> = { 'bp-owner': 'owner', 'bp-admin': 'admin', 'bp-alice': 'member', 'bp-bob': 'member' }
const APPROVED = fileBrowserConnectorCatalog().combinations().find(r => r.status === 'approved')!
const OP = 'reminder_step_add_template'
const SECRET_HEADER = 'X-ACB-Browser-Execution'
const DEVICE_HEADER = 'X-ACB-Browser-Device'
const ts = (ms = Date.now()) => new Date(ms).toISOString()
const newKey = () => `v1.${randomBytes(32).toString('base64url')}`
/** Each member's PC (registered and enabled in beforeAll; agent-browser.md "This PC's registration"). The owner has none: the transition exception. */
const PC: Record<string, string> = { 'bp-alice': newKey(), 'bp-bob': newKey() }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
async function call(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    // The app's build as every app request carries it: the approved row's own minimum (a build at least it), and the
    // member's PC key as an app with a registered PC sends it.
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(APPROVED.minAppVersion ? { 'X-ACB-Client-Version': APPROVED.minAppVersion } : {}),
      ...(user && PC[user] ? { [DEVICE_HEADER]: PC[user] } : {}), ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json: Json = await res.json().catch(() => null)
  return { status: res.status, json, headers: res.headers }
}

const fact = (value: unknown) => ({ status: 'known', value, complete: true, readAt: ts(), source: '/line/episode/show/11' })
const candidate = (step: string) => ({
  connector: { id: 'lstep', version: APPROVED.version }, operation: OP, declarationHash: APPROVED.declarationHash, checkerHash: APPROVED.checkerHash,
  factsVersion: APPROVED.factsVersion, target: { reminder: '11', step }, change: { template: '7' },
  facts: {
    account: fact({ id: 'acc1' }), step_parent: fact({ reminder: '11' }), state: fact({ templates: [] }), names: fact({ reminder: 'R', step: 'S' }),
    templates: fact({ 7: { name: 'T', kind: 'text', body: '本文' } }), schedule: fact({ timing: '当日 09:00' }), shared_with: fact({ count: 0, items: [] }),
  },
})

beforeAll(async () => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'bp-owner', ts(), ts())
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(Date.now() - 60_000), ts(Date.now() - 60_000))
  }
  const on = { mode: 'on', sites: [{ host: 'manager.linestep.net', level: 'write', assetHosts: ['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net'] }] }
  expect((await call('bp-owner', 'PUT', `${BASE}/agent-browser`, on)).status).toBe(200)
  // Everyone 変えてよい on the site (「使える人」, agent-browser.md "Who may use a site"): this path asks it after the type grant.
  for (const u of Object.keys(ROLE)) {
    expect((await call('bp-owner', 'PUT', `${BASE}/browser-site-grants/${u}`, { host: 'manager.linestep.net', level: 'write' })).status).toBe(200)
  }
  for (const user of Object.keys(PC)) {
    const asked = await call(user, 'POST', `${BASE}/browser-devices`, { label: `${user} の Mac` })
    expect(asked.status, JSON.stringify(asked.json)).toBe(201)
    expect((await call('bp-owner', 'POST', `${BASE}/browser-devices/${asked.json.data.id}/enable`)).status).toBe(200)
  }
})

async function plan(user: string, step: string) {
  const r = await call(user, 'POST', `${BASE}/browser-plans`, candidate(step))
  expect(r.status, JSON.stringify(r.json)).toBe(201)
  const a = await call(user, 'POST', `${BASE}/browser-plans/${r.json.data.id}/approve`, { contentHash: r.json.data.contentHash })
  expect(a.status).toBe(200)
  const c = await call(user, 'POST', `${BASE}/browser-plans/${r.json.data.id}/claim`)
  expect(c.status).toBe(200)
  return { planId: r.json.data.id as string, claim: c.json.data, claimHeaders: c.headers }
}

describe('「ブラウザ操作」 plans over HTTP', () => {
  it('only owners and admins grant a type; a member without a grant cannot register', async () => {
    const grant = { connector: 'lstep', operation: OP, declarationHash: APPROVED.declarationHash, allowed: true }
    expect((await call('bp-alice', 'GET', `${BASE}/browser-type-grants`)).status).toBe(403)
    expect((await call('bp-alice', 'PUT', `${BASE}/browser-type-grants/bp-alice`, grant)).status).toBe(403)
    expect((await call('bp-alice', 'POST', `${BASE}/browser-plans`, candidate('1'))).json.code).toBe('BROWSER_TYPE_NOT_GRANTED')
    for (const u of ['bp-alice', 'bp-bob']) expect((await call('bp-admin', 'PUT', `${BASE}/browser-type-grants/${u}`, grant)).status).toBe(200)
    const view = await call('bp-owner', 'GET', `${BASE}/browser-type-grants`)
    expect(view.json.data.grants.map((g: Json) => g.userId).sort()).toEqual(['bp-alice', 'bp-bob'])
    expect(view.json.data.types[0]).toMatchObject({ connector: 'lstep', operation: OP, label: 'リマインダの段にテンプレートを足す' })
  })

  it('register → approve → claim → permit → report: the secret comes once, uncached, and works only in its header', async () => {
    const { planId, claim, claimHeaders } = await plan('bp-alice', '1')
    expect(claimHeaders.get('cache-control')).toBe('no-store')
    expect(claim.plan).toMatchObject({ planId, companyId: CO, connector: { id: 'lstep' }, operation: OP, account: 'acc1', before: { templates: [] } })
    // The fixed content as stored (6b-2): the app checks its hash against the one approved.
    expect(claim.fixed).toEqual(expect.objectContaining({ factsVersion: APPROVED.factsVersion }))
    expect(`sha256:${createHash('sha256').update(claim.fixed.content, 'utf8').digest('hex')}`).toBe(claim.fixed.contentHash)
    expect(claim.fixed.contentHash).toBe((db.prepare('SELECT content_hash FROM browser_plans WHERE id = ?').get(planId) as { content_hash: string }).content_hash)
    // Another member, a wrong secret, the secret elsewhere than its header: no permit.
    expect((await call('bp-bob', 'POST', `${BASE}/browser-executions/${claim.executionId}/send-permit`, undefined, { [SECRET_HEADER]: claim.secret })).status).toBe(404)
    expect((await call('bp-alice', 'POST', `${BASE}/browser-executions/${claim.executionId}/send-permit`, { secret: claim.secret })).status).toBe(404)
    const permit = await call('bp-alice', 'POST', `${BASE}/browser-executions/${claim.executionId}/send-permit`, undefined, { [SECRET_HEADER]: claim.secret })
    expect(permit.status).toBe(200)
    expect(permit.json.data.validMs).toBe(5000)
    expect((await call('bp-alice', 'POST', `${BASE}/browser-executions/${claim.executionId}/send-permit`, undefined, { [SECRET_HEADER]: claim.secret })).json.code).toBe('BROWSER_PERMIT_USED')
    // The report needs no session, only the secret.
    expect((await call(null, 'POST', '/api/browser-executions/report', { result: 'succeeded' })).status).toBe(401)
    const reported = await call(null, 'POST', '/api/browser-executions/report', { result: 'succeeded' }, { [SECRET_HEADER]: claim.secret })
    expect(reported.json).toEqual({ success: true, data: { state: 'succeeded', outcome: 'applied' } })
    expect((await call('bp-alice', 'GET', `${BASE}/browser-plans/${planId}`)).json.data).toMatchObject({ state: 'done', execution: { state: 'succeeded' } })
    // Bob does not see Alice's plan.
    expect((await call('bp-bob', 'GET', `${BASE}/browser-plans/${planId}`)).status).toBe(404)
  })

  it('the member\'s own open plans: uncached, theirs only', async () => {
    const mine = await call('bp-alice', 'POST', `${BASE}/browser-plans`, { ...candidate('9'), conversationId: 'conv-9' })
    expect(mine.status).toBe(201)
    const open = await call('bp-alice', 'GET', `${BASE}/browser-plans-open`)
    expect(open.status).toBe(200)
    expect(open.headers.get('cache-control')).toBe('no-store')
    expect(open.json.data.items.map((i: Json) => [i.planId, i.state, i.conversationId])).toEqual([[mine.json.data.id, 'draft', 'conv-9']])
    expect(open.json.data.more).toBe(false)
    expect((await call('bp-owner', 'GET', `${BASE}/browser-plans-open`)).json.data.items).toEqual([])
    expect((await call(null, 'GET', `${BASE}/browser-plans-open`)).status).toBe(401)
    expect((await call('bp-alice', 'POST', `${BASE}/browser-plans/${mine.json.data.id}/cancel`)).status).toBe(200)
  })

  it('a member removed while an execution may have been sent: it stays, the owner confirms it, the app\'s late report is still kept', async () => {
    const { claim } = await plan('bp-bob', '2')
    expect((await call('bp-bob', 'POST', `${BASE}/browser-executions/${claim.executionId}/send-permit`, undefined, { [SECRET_HEADER]: claim.secret })).status).toBe(200)
    const draft = await call('bp-bob', 'POST', `${BASE}/browser-plans`, candidate('3'))
    expect(draft.status).toBe(201)
    expect((await call('bp-owner', 'DELETE', `/api/companies/${CO}/members/bp-bob`)).status).toBe(200)
    // The draft closed, the grant went.
    expect((db.prepare('SELECT state, close_reason FROM browser_plans WHERE id = ?').get(draft.json.data.id))).toEqual({ state: 'closed', close_reason: 'left' })
    expect((await call('bp-owner', 'GET', `${BASE}/browser-type-grants`)).json.data.grants.map((g: Json) => g.userId)).toEqual(['bp-alice'])
    const waiting = await call('bp-owner', 'GET', `${BASE}/browser-executions-waiting`)
    expect(waiting.json.data.items.map((i: Json) => [i.executionId, i.state])).toEqual([[claim.executionId, 'permitted']])
    // Too early to say, even for the owner.
    expect((await call('bp-owner', 'POST', `${BASE}/browser-executions/${claim.executionId}/confirm`, { result: 'done' })).json.code).toBe('BROWSER_TOO_EARLY')
    // The app's report after they left: unknown is taken (records only), the state moves only as the table says.
    const late = await call(null, 'POST', '/api/browser-executions/report', { result: 'unknown' }, { [SECRET_HEADER]: claim.secret })
    expect(late.json.data).toEqual({ state: 'unknown', outcome: 'applied' })
    // Their PC was stopped by the same removal (agent-browser.md "This PC's registration").
    expect(db.prepare("SELECT state, revoke_reason FROM browser_devices WHERE company_id = ? AND user_id = 'bp-bob'").all(CO)).toEqual([{ state: 'revoked', revoke_reason: 'left' }])
  })
})

describe('this PC on the old path (agent-browser.md "This PC\'s registration")', () => {
  const grant = { connector: 'lstep', operation: OP, declarationHash: APPROVED.declarationHash, allowed: true }

  it('an admin without a registered PC is refused at every gated step; the owner without the header passes (the transition exception)', async () => {
    for (const u of ['bp-admin', 'bp-owner']) expect((await call('bp-owner', 'PUT', `${BASE}/browser-type-grants/${u}`, grant)).status).toBe(200)
    const refused = await call('bp-admin', 'POST', `${BASE}/browser-plans`, candidate('20'))
    expect([refused.status, refused.json.code]).toEqual([403, 'BROWSER_DEVICE_NOT_REGISTERED'])
    expect(refused.json.error).toContain('PC')
    const { claim } = await plan('bp-owner', '21')
    const permit = await call('bp-owner', 'POST', `${BASE}/browser-executions/${claim.executionId}/send-permit`, undefined, { [SECRET_HEADER]: claim.secret })
    expect(permit.status).toBe(200)
  })

  it('the plan is bound to the PC that made it; another PC of the same member only cancels; a stopped PC voids the claimed execution', async () => {
    // A second PC of Alice's, enabled too.
    const second = newKey()
    const asked = await call('bp-alice', 'POST', `${BASE}/browser-devices`, { label: '2台目' }, { [DEVICE_HEADER]: second })
    expect((await call('bp-admin', 'POST', `${BASE}/browser-devices/${asked.json.data.id}/enable`)).status).toBe(200)
    const made = await call('bp-alice', 'POST', `${BASE}/browser-plans`, candidate('30'))
    expect(made.status).toBe(201)
    const id = made.json.data.id
    const elsewhere = await call('bp-alice', 'POST', `${BASE}/browser-plans/${id}/approve`, { contentHash: made.json.data.contentHash }, { [DEVICE_HEADER]: second })
    expect([elsewhere.status, elsewhere.json.code]).toEqual([409, 'BROWSER_DEVICE_ELSEWHERE'])
    expect((await call('bp-alice', 'POST', `${BASE}/browser-plans/${id}/approve`, { contentHash: made.json.data.contentHash })).status).toBe(200)
    expect((await call('bp-alice', 'POST', `${BASE}/browser-plans/${id}/claim`, undefined, { [DEVICE_HEADER]: second })).json.code).toBe('BROWSER_DEVICE_ELSEWHERE')
    const claim = (await call('bp-alice', 'POST', `${BASE}/browser-plans/${id}/claim`)).json.data
    // The admin stops Alice's first PC: the next permit is refused and the execution is void for good.
    const list = await call('bp-admin', 'GET', `${BASE}/browser-devices`)
    expect(list.headers.get('cache-control')).toBe('no-store')
    const first = list.json.data.items.find((d: Json) => d.userId === 'bp-alice' && d.label === 'bp-alice の Mac')
    expect((await call('bp-admin', 'POST', `${BASE}/browser-devices/${first.id}/revoke`)).json.data).toMatchObject({ state: 'revoked', revokeReason: 'admin' })
    const permit = await call('bp-alice', 'POST', `${BASE}/browser-executions/${claim.executionId}/send-permit`, undefined, { [SECRET_HEADER]: claim.secret })
    expect([permit.status, permit.json.code]).toEqual([403, 'BROWSER_DEVICE_REVOKED'])
    expect(db.prepare('SELECT state, void_reason FROM browser_executions WHERE id = ?').get(claim.executionId)).toEqual({ state: 'void', void_reason: 'device' })
    // Another plan of the stopped PC: the second PC cancels it (cancel is never gated).
    const other = (await call('bp-alice', 'POST', `${BASE}/browser-plans`, candidate('31'), { [DEVICE_HEADER]: second })).json.data
    expect((await call('bp-alice', 'POST', `${BASE}/browser-plans/${other.id}/cancel`, undefined, { [DEVICE_HEADER]: PC['bp-alice'] })).status).toBe(200)
  })

  it('this PC\'s state for the app: uncached, only the member\'s own, never the key', async () => {
    const me = await call('bp-alice', 'GET', `${BASE}/browser-devices-me`)
    expect(me.headers.get('cache-control')).toBe('no-store')
    expect(me.json.data).toMatchObject({ state: 'revoked', revokeReason: 'admin', userId: 'bp-alice' })
    expect(JSON.stringify(me.json)).not.toContain(PC['bp-alice'].slice(3))
    expect((await call('bp-admin', 'GET', `${BASE}/browser-devices-me`, undefined, { [DEVICE_HEADER]: PC['bp-alice'] })).json.data).toEqual({ state: 'none' })
    expect((await call('bp-alice', 'GET', `${BASE}/browser-devices-me`, undefined, { [DEVICE_HEADER]: 'v1.x' })).status).toBe(400)
    expect((await call('bp-alice', 'GET', `${BASE}/browser-devices`)).status).toBe(403)
  })
})
