/**
 * Business roles end to end (plan C3 「役割」, `.claude/rules/plugin-roles.md`):
 * a contract-2 business plugin declares `sales_manager`; the company assigns
 * it (owner / admin), a まとまり (the deal) may override it; the approver,
 * the delegate and the engine's `who` all resolve it through the one service.
 *
 * Guards (each mutation-checked):
 * - an approval whose rule is the role goes to its holder; a department
 *   manager who does not hold it cannot approve; nobody assigned → an owner /
 *   admin is asked;
 * - a まとまり's override wins over the company's for that deal only; only an
 *   owner / admin or the まとまり's department manager may set it;
 * - an absent holder's delegate approves on their behalf;
 * - a type's action `who: [role:…]` is met by the holder only;
 * - assignments name only this company's members; members cannot assign.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeHubSpot, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'
import { enableSampleSales, putSampleHub } from '../helpers/plugin-packages'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const KEY = 'pat-fake-NOT-REAL-roles-0123456789'
const CO = 'ro-co'
const OTHER = 'ro-co2'
const ts = () => new Date().toISOString()
const MAPPING = `
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
  fields:
    title:      { from: dealname, write: false }
    confidence: { from: juchu_kakudo, write: true, values: { high: a, medium: b, low: c } }
    next_step:  { from: hs_next_step, write: true }
    amount:     { from: amount, write: true }
    assignee:   { from: hubspot_owner_id, write: false, people: owners }
people:
  owners:
    "75123001": ro-member
approval_by:
  amount: role:sales_manager
`
const ACK = ['confidence', 'next_step']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let fake: FakeHubSpot
let server: ServerType
let kekDir: string, shelfDir: string
const owner = { companyId: CO, userId: 'ro-owner', role: 'owner' }
const m = (userId: string) => ({ companyId: CO, userId, role: 'member' })

async function call(opts: { user?: string; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res: Response = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const P = `/api/companies/${CO}/plugins/sample-sales/roles`
const approve = (user: string, a: Json, reason = '確認しました') => call({ user, method: 'POST', path: `/api/companies/${CO}/approvals/${a.id}/approve`, body: { hash: a.hash, reason } })

async function tokenFor(user: string): Promise<string> {
  const r = await call({ user, method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId: 'conv-ro', agent: 'claude-code', scope: 'act' } })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}
const recordOf = (externalId: string) => (db.prepare("SELECT record_id FROM plugin_external_links WHERE company_id = ? AND external_id = ? AND object = 'deal'").get(CO, externalId) as Json).record_id as string
const versionOf = (recordId: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, recordId) as Json).version as number

/** The member's AI asks to change a deal's amount: an approval request (202). */
async function aiAsksAmount(externalId: string, amount: number) {
  const id = recordOf(externalId)
  await call({ user: 'ro-member', method: 'POST', path: `/api/companies/${CO}/plugins/sample-sales/records/${id}/operations/refresh_deal`, body: {} })
  const r = await call({
    token: await tokenFor('ro-member'), method: 'POST', path: `/api/records-ai/plugins/sample-sales/records/${id}/operations/update_deal`,
    body: { expectedVersion: versionOf(id), fields: { amount }, note: '先方の依頼（議事録）' },
  })
  expect(r.status).toBe(202)
  return r.body.data.approval as Json
}

beforeAll(async () => {
  fake = createFakeHubSpot()
  fake.addKey(KEY)
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-ro-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-ro-shelf-'))
  putSampleHub(shelfDir)
  // The business plugin as contract 2 with a declared role, and a deal action only the role (or the assignee) may do.
  const manifest = join(shelfDir, 'sample-sales@0.1.0', 'plugin.yaml')
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('contract: 1', 'contract: 2') + '\nroles:\n  sales_manager: { label: 営業の責任者 }\n')
  const deal = join(shelfDir, 'sample-sales@0.1.0', 'types', 'deal.md')
  writeFileSync(deal, readFileSync(deal, 'utf8').replace('final: [won, lost]\n', 'final: [won, lost]\nactions:\n  close_won: { label: 受注にする, from: [open], to: won, who: [role:sales_manager], note: optional }\n'))
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_FAKE_HUBSPOT_URL: `http://127.0.0.1:${port}`,
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/plugins')).pluginsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/approvals')).approvalsRoute)
  app.route('/api/records-ai', (await import('../../src/routes/records-ai')).recordsAiRoute)
  const loaded = await services.pluginShelf.load()
  expect(loaded.loaded).toContain('sample-sales@0.1.0')

  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, `${co}-x`, ts(), ts())
    ensureCompanyScope(db, co)
  }
  for (const [u, r] of [['ro-owner', 'owner'], ['ro-admin', 'admin'], ['ro-member', 'member'], ['ro-boss', 'member'], ['ro-lead', 'member'], ['ro-lead2', 'member'], ['ro-cover', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-ro-x', 'ro-x', OTHER, 'owner', ts(), ts())
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('ro-d-sales', CO, '営業部', '営業部', ts(), ts())
  db.prepare('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(CO, 'ro-d-sales', 'ro-boss', ts())
  db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('ro-s-sales', ?, '営業部', 'folder', ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'ro-r1', 'ro-s-sales', 'everyone', NULL, 0, 0, ?)`).run(CO, ts())
  for (const [i, u] of ['ro-member', 'ro-boss', 'ro-lead', 'ro-lead2', 'ro-cover'].entries()) {
    db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'ro-s-sales', 'user', ?, 1, 1, ?)`).run(CO, `ro-r${i + 2}`, u, ts())
  }
  for (const co of [CO, OTHER]) db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(co, ts(), 'x')
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: KEY, audience })).value.keys[0].id
  await enableSampleSales(services.plugins, owner)
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
  const saved = await services.plugins.saveMapping(owner, 'sample-sales', { text: MAPPING, acknowledgeAuto: ACK })
  expect(saved.ok, JSON.stringify(saved)).toBe(true)
  expect((await services.plugins.setReadScope(owner, 'sample-hub', { userIds: ['ro-member'] })).ok).toBe(true)
  expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
  expect((await services.pluginImport.run(owner, 'sample-sales')).ok).toBe(true)
})

afterAll(async () => {
  fake.close()
  await new Promise(r => server.close(() => r(null)))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_HUBSPOT_URL']) delete process.env[k]
})

describe('the company assigns a declared role (owner / admin)', () => {
  it('lists the declared role; only this company\'s members; members cannot assign; every change is in the history', async () => {
    const view = await call({ user: 'ro-admin', method: 'GET', path: P })
    expect(view.status).toBe(200)
    expect(view.body.data.roles).toEqual([{ name: 'sales_manager', label: '営業の責任者', description: null, userIds: [] }])
    expect((await call({ user: 'ro-member', method: 'PUT', path: `${P}/sales_manager`, body: { userIds: ['ro-member'] } })).status).toBe(403)
    expect((await call({ user: 'ro-admin', method: 'PUT', path: `${P}/sales_manager`, body: { userIds: ['ro-x'] } })).body.code).toBe('ROLE_HOLDERS_INVALID')
    expect((await call({ user: 'ro-admin', method: 'PUT', path: `${P}/no_such_role`, body: { userIds: [] } })).status).toBe(404)
    const set = await call({ user: 'ro-admin', method: 'PUT', path: `${P}/sales_manager`, body: { userIds: ['ro-lead'] } })
    expect(set.status).toBe(200)
    expect(set.body.data.roles[0].userIds).toEqual(['ro-lead'])
    expect(set.body.data.history[0]).toMatchObject({ role: 'sales_manager', bundleId: null, action: 'assign', userIds: ['ro-lead'], by: 'ro-admin' })
    // Another company sees no such plugin.
    expect((await call({ user: 'ro-x', method: 'GET', path: `/api/companies/${OTHER}/plugins/sample-sales/roles` })).status).toBe(404)
  })
})

describe('the approver is the role\'s holder', () => {
  it('the request goes to the holder; the department manager who does not hold it cannot approve; the holder can', async () => {
    const a = await aiAsksAmount('1000000001', 1500000)
    expect(a).toMatchObject({ approver: 'ro-lead', approverRule: 'role', approverRole: 'sales_manager', approverRuleLabel: '営業の責任者' })
    expect((await approve('ro-boss', a)).status).toBe(404)
    const r = await approve('ro-lead', a)
    expect(r.status).toBe(200)
    expect(r.body.data.approval.state).toBe('approved')
  })

  it('a まとまり\'s override wins for that deal; only an owner / admin or its department manager sets it; null goes back', async () => {
    const deal = recordOf('1000000001')
    expect((await call({ user: 'ro-member', method: 'PUT', path: `${P}/sales_manager/bundles/${deal}`, body: { userIds: ['ro-member'] } })).status).toBe(403)
    const set = await call({ user: 'ro-boss', method: 'PUT', path: `${P}/sales_manager/bundles/${deal}`, body: { userIds: ['ro-lead2'] } })
    expect(set.status).toBe(200)
    expect(set.body.data.overrides).toEqual([{ role: 'sales_manager', bundleId: deal, title: expect.any(String), userIds: ['ro-lead2'] }])
    const a = await aiAsksAmount('1000000001', 1600000)
    expect(a.approver).toBe('ro-lead2')
    expect((await approve('ro-lead', a)).status).toBe(404)
    // Another deal keeps the company's holder.
    expect((await aiAsksAmount('1000000002', 900000)).approver).toBe('ro-lead')
    expect((await approve('ro-lead2', a)).status).toBe(200)
    // Cleared: the company's holder again.
    expect((await call({ user: 'ro-boss', method: 'PUT', path: `${P}/sales_manager/bundles/${deal}`, body: { userIds: null } })).status).toBe(200)
    expect((await aiAsksAmount('1000000001', 1700000)).approver).toBe('ro-lead')
  })

  it('an absent holder\'s delegate approves on their behalf (also a holder who was not the one asked)', async () => {
    // Two holders: the request goes to ro-lead; ro-lead2 holds the role too.
    expect((await call({ user: 'ro-owner', method: 'PUT', path: `${P}/sales_manager`, body: { userIds: ['ro-lead', 'ro-lead2'] } })).status).toBe(200)
    const today = services.absences.view(owner, 'ro-lead2').value.today as string
    const a = await aiAsksAmount('1000000001', 1800000)
    expect(a.approver).toBe('ro-lead')
    expect((await approve('ro-cover', a)).status).toBe(404)
    const absence = services.absences.create(owner, { userId: 'ro-lead2', from: today, until: today, delegateId: 'ro-cover' }).value.absence.id as string
    try {
      const r = await approve('ro-cover', a, '不在のため代わりに')
      expect(r.status).toBe(200)
      expect(r.body.data.approval.outcome).toMatchObject({ by: 'ro-cover', onBehalfOf: 'ro-lead2' })
    } finally {
      expect(services.absences.remove(owner, absence).ok).toBe(true)
      expect((await call({ user: 'ro-owner', method: 'PUT', path: `${P}/sales_manager`, body: { userIds: ['ro-lead'] } })).status).toBe(200)
    }
  })

  it('nobody holds the role: an owner / admin is asked', async () => {
    expect((await call({ user: 'ro-owner', method: 'PUT', path: `${P}/sales_manager`, body: { userIds: [] } })).status).toBe(200)
    const a = await aiAsksAmount('1000000002', 950000)
    expect(a.approver).toBe('ro-admin')
    expect((await approve('ro-boss', a)).status).toBe(404)
    expect((await call({ user: 'ro-owner', method: 'PUT', path: `${P}/sales_manager`, body: { userIds: ['ro-lead'] } })).status).toBe(200)
  })
})

describe('the engine\'s who: role:<name>', () => {
  it('a type\'s action for the role is done by its holder only (not the department manager, not the assignee alone)', async () => {
    const deal = recordOf('1000000002')
    const act = (userId: string) => services.recordEngine.act(m(userId), { kind: 'human' }, deal, 'close_won', { expectedVersion: versionOf(deal) })
    expect(await act('ro-boss')).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
    expect(await act('ro-member')).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
    const done = await act('ro-lead')
    expect(done.ok, JSON.stringify(done)).toBe(true)
    expect(done.value.record.state).toBe('won')
  })
})
