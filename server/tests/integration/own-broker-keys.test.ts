/**
 * Integration Test: a member's own API keys (K8, 「自分の鍵」) on the real
 * routes, database and vault with a temporary KEK.
 *
 * - A member registers, replaces and deletes only their own key, and only
 *   where the company allows own keys (switch, service rule, destinations);
 *   the key goes only to the destinations the admin allowed.
 * - The value never comes back: not in any answer (success or error), log
 *   line or table — the app sees its last four characters.
 * - A registered own key is what a token then uses (company-first / own only),
 *   and an admin's stop survives the member replacing the key.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

const currentUser = vi.hoisted(() => ({ id: 'ok-owner' as string | null }))

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

const FAKE_A = 'fake-test-key-NOT-REAL-own-aaaa-0123456789'
const FAKE_B = 'fake-test-key-NOT-REAL-own-bbbb-9876543210'
const FAKE_C = 'fake-test-key-NOT-REAL-own-cccc-5555555555'
const FAKE_COMPANY = 'fake-test-key-NOT-REAL-own-company-1111111'

const CO = 'ok-co'
const BASE = `/api/companies/${CO}`
const ROLE: Record<string, string> = { 'ok-owner': 'owner', 'ok-alice': 'member', 'ok-bob': 'member' }
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, db: any, services: any
let kekDir: string
const seen: string[] = []
const logs: string[] = []
const owner = { companyId: CO, userId: 'ok-owner', role: 'owner' }

async function call(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  seen.push(text)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json }
}

const save = (user: string, service: string, body: unknown) => call(user, 'PUT', `${BASE}/me/broker-keys/${service}`, body)
const svc = (data: Json, service: string) => data.services.find((s: Json) => s.service === service)

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-ok-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      original(...args)
    })
  }

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'ok-owner', ts(), ts())
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('ok-other', 'o', 'ok-other', 'x', ts(), ts())
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('ok-d-sales', CO, '営業部', '営業部', ts(), ts())

  const { Hono } = await import('hono')
  const { keyBrokerRoute } = await import('../../src/routes/key-broker')
  services = (await import('../../src/composition')).services
  app = new Hono()
  app.route('/api/companies/:companyId', keyBrokerRoute)

  // OpenAI: 会社優先 with own keys allowed to api.openai.com; a company key for 営業部's work, Alice only.
  expect((await services.keyBroker.setService(owner, 'openai', { category: 'tool', rule: 'company-first', ownKeyHosts: ['api.openai.com'] })).ok).toBe(true)
  expect((await services.keyBroker.create(owner, {
    service: 'openai', displayName: '営業の OpenAI', secret: FAKE_COMPANY,
    audience: { allDepartments: false, departmentIds: ['ok-d-sales'], everyone: false, addUserIds: ['ok-alice'], removeUserIds: [] },
  })).ok).toBe(true)
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('own keys (「自分の鍵」)', () => {
  it('needs a session and a membership; any member sees the services and what they may do', async () => {
    expect((await call(null, 'GET', `${BASE}/me/broker-keys`)).status).toBe(401)
    expect((await call('ok-stranger', 'GET', `${BASE}/me/broker-keys`)).status).toBe(404)
    const r = await call('ok-alice', 'GET', `${BASE}/me/broker-keys`)
    expect(r.status).toBe(200)
    expect(r.json.data.enabled).toBe(true)
    expect(svc(r.json.data, 'openai')).toMatchObject({
      rule: 'company-first', ownKey: { allowed: true, hosts: ['api.openai.com'] },
      companyKeys: [{ displayName: '営業の OpenAI', allDepartments: false, departments: ['営業部'] }], key: null,
    })
    // Gemini defaults to 会社の鍵だけ; Bob is not on the OpenAI company key.
    expect(svc(r.json.data, 'gemini').ownKey).toEqual({ allowed: false, reason: 'company-only' })
    expect(svc((await call('ok-bob', 'GET', `${BASE}/me/broker-keys`)).json.data, 'openai').companyKeys).toEqual([])
  })

  it('registers one\'s own key: last 4 only, the allowed destinations, recorded; a token then uses it', async () => {
    const r = await save('ok-bob', 'openai', { secret: FAKE_A })
    expect(r.status).toBe(200)
    expect(svc(r.json.data, 'openai').key).toMatchObject({ last4: FAKE_A.slice(-4), hosts: ['api.openai.com'], status: 'active' })
    const row = db.prepare("SELECT * FROM broker_keys WHERE scope = 'user' AND owner_user_id = 'ok-bob'").get()
    expect(row).toMatchObject({ service: 'openai', last4: FAKE_A.slice(-4) })
    expect(JSON.parse(row.destinations).hosts).toEqual(['api.openai.com'])
    expect(await services.brokerVault.reveal(CO, row.id)).toBe(FAKE_A)
    // The admin sees it (last 4) with the member as the one who registered it.
    const admin = services.keyBroker.get(owner).value
    expect(admin.keys.find((k: Json) => k.id === row.id)).toMatchObject({ scope: 'user', ownerUserId: 'ok-bob', last4: FAKE_A.slice(-4) })
    expect(admin.history[0]).toMatchObject({ changedBy: 'ok-bob', keyId: row.id, change: { action: 'create' } })
    // Bob has no company key, so 会社優先 falls back to his own.
    const token = services.brokerTokens.issue({ companyId: CO, userId: 'ok-bob', role: 'member' }, { conversationId: 'c', services: ['openai'] })
    expect(token.value.services).toEqual([{ service: 'openai', source: 'user' }])
  })

  it('replacing keeps one key per service, and an admin\'s stop stays in force', async () => {
    const id = db.prepare("SELECT id FROM broker_keys WHERE owner_user_id = 'ok-bob'").get().id
    services.keyBroker.update(owner, id, { status: 'disabled' })
    const r = await save('ok-bob', 'openai', { secret: FAKE_B, displayName: 'ボブの鍵' })
    expect(r.status).toBe(200)
    expect(svc(r.json.data, 'openai').key).toMatchObject({ id, displayName: 'ボブの鍵', last4: FAKE_B.slice(-4), status: 'disabled' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM broker_keys WHERE owner_user_id = 'ok-bob'").get().n).toBe(1)
    expect(await services.brokerVault.reveal(CO, id)).toBe(FAKE_B)
    services.keyBroker.update(owner, id, { status: 'active' })
  })

  it('refused where the company does not allow own keys, and for bad values', async () => {
    expect((await save('ok-alice', 'gemini', { secret: FAKE_C })).json).toMatchObject({ code: 'OWN_KEY_NOT_ALLOWED', reason: 'company-only' })
    await services.keyBroker.setService(owner, 'anthropic', { category: 'tool', rule: 'user-only', ownKeyHosts: [] })
    const noHosts = await save('ok-alice', 'anthropic', { secret: FAKE_C })
    expect([noHosts.status, noHosts.json.reason]).toEqual([403, 'no-destinations'])
    await services.keyBroker.setSettings(owner, { memberKeysAllowed: false })
    const off = await save('ok-alice', 'openai', { secret: FAKE_C })
    expect([off.status, off.json.reason]).toEqual([403, 'member-keys-off'])
    await services.keyBroker.setSettings(owner, { memberKeysAllowed: true })
    expect((await save('ok-alice', 'no-such-service', { secret: FAKE_C })).status).toBe(404)
    expect((await save('ok-alice', 'Bad Name', { secret: FAKE_C })).status).toBe(400)
    expect((await save('ok-alice', 'openai', { secret: 'short' })).status).toBe(400)
    expect((await save('ok-alice', 'openai', { secret: `acb_tok_${'a'.repeat(64)}` })).status).toBe(400)
    expect((await save('ok-alice', 'openai', 'not json')).status).toBe(400)
    expect(db.prepare("SELECT COUNT(*) AS n FROM broker_keys WHERE owner_user_id = 'ok-alice'").get().n).toBe(0)
  })

  it('a member deletes only their own key; another company\'s route reaches nothing', async () => {
    expect((await call('ok-alice', 'DELETE', `${BASE}/me/broker-keys/openai`)).status).toBe(404)
    expect((await call('ok-bob', 'DELETE', '/api/companies/ok-other/me/broker-keys/openai')).status).toBe(404)
    await services.keyBroker.setSettings(owner, { memberKeysAllowed: false })
    const r = await call('ok-bob', 'DELETE', `${BASE}/me/broker-keys/openai`)
    expect(r.status).toBe(200)
    expect(svc(r.json.data, 'openai').key).toBeNull()
    expect(db.prepare("SELECT COUNT(*) AS n FROM broker_keys WHERE owner_user_id = 'ok-bob'").get().n).toBe(0)
    await services.keyBroker.setSettings(owner, { memberKeysAllowed: true })
  })

  it('without a key-encryption key nothing can be registered (503), the list still loads', async () => {
    const { createServices } = await import('../../src/composition')
    const off = createServices(db, { enabled: false, reason: 'not-configured', detail: 'unset' })
    const bob = { companyId: CO, userId: 'ok-bob', role: 'member' }
    expect(off.ownBrokerKeys.list(bob)).toMatchObject({ ok: true, value: { enabled: false } })
    expect(await off.ownBrokerKeys.save(bob, 'openai', { secret: FAKE_C })).toMatchObject({ ok: false, kind: 'unavailable', body: { code: 'BROKER_OFF' } })
  })

  it('no key value in any answer, error, log line or table', async () => {
    await save('ok-alice', 'openai', { secret: FAKE_C }) // one left in place, so a live sealed value is checked
    expect(seen.length).toBeGreaterThan(15)
    const leaks = (texts: string[]) => texts.filter(t => [FAKE_A, FAKE_B, FAKE_C, FAKE_COMPANY, 'NOT-REAL'].some(v => t.includes(v)))
    expect(leaks(seen)).toEqual([])
    expect(leaks(logs)).toEqual([])
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(leaks(tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())))).toEqual([])
  })
})
