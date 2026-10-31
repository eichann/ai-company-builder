/**
 * Integration Test: the API key broker's admin API (routes/key-broker.ts) on
 * the real routes, database and envelope encryption with a temporary KEK.
 *
 * - No plaintext key ever leaves the vault: not in any answer (success or
 *   error), not in any log line, not in any table — only its last 4.
 * - Only owners/admins manage keys; strangers learn nothing.
 * - Who can use a company key: two dials — ① for which work (全社 / these
 *   departments) and ② by whom (全員 / listed people) ± per-person
 *   exceptions. Reading a department's folder decides nothing; an audience
 *   in the K2 form is converted.
 * - Every change is recorded; replacing a key changes the value the relay
 *   gets; a disabled or deleted key is marked so.
 * - Without a KEK nothing can be registered (503 BROKER_OFF), the rest works.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

const currentUser = vi.hoisted(() => ({ id: 'kb-owner' as string | null }))

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

/** Obviously fake key values; the test fails if any of them shows up outside the vault. */
const FAKE = 'fake-test-key-NOT-REAL-kb-0123456789abcdef'
const FAKE2 = 'fake-test-key-NOT-REAL-kb-replaced-9876543210'
const FAKE_BAD = 'fake NOT-REAL with spaces'
const LEAK_MARK = 'NOT-REAL'

const CO = 'kb-co'
const BASE = `/api/companies/${CO}`
const ROLE: Record<string, string> = { 'kb-owner': 'owner', 'kb-admin': 'admin', 'kb-sales': 'member', 'kb-dev': 'member' }
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let services: any
let kekDir: string
const seen: string[] = []
const logs: string[] = []

async function call(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  seen.push(`${method} ${path} ${res.status} ${text}`)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json }
}

const gemini = (over: Record<string, unknown> = {}) => ({
  service: 'gemini',
  displayName: '営業用 Gemini',
  secret: FAKE,
  audience: { allDepartments: false, departmentIds: ['kb-d-sales'], everyone: true, addUserIds: [], removeUserIds: [] },
  caps: { requestsPerDay: 1000 },
  ...over,
})

beforeAll(async () => {
  // A KEK in a temp dir outside DATA_DIR, owner-only, before the composition root loads it.
  kekDir = mkdtempSync(join(tmpdir(), 'acb-kb-kek-'))
  const kekPath = join(kekDir, 'kek')
  writeFileSync(kekPath, randomBytes(32).toString('base64'))
  chmodSync(kekPath, 0o600)
  process.env.BROKER_KEK_FILE = kekPath

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
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'kb-owner', ts(), ts())
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('kb-other', 'other', 'kb-other', 'kb-stranger', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-kb-stranger', 'kb-stranger', 'kb-other', 'owner', ts(), ts())
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  // 営業部: only kb-sales (and owners/admins) can read it. 開発: open to everyone (company default).
  const store = await import('../../src/adapters/sqlite/permission-store')
  store.ensureCompanyScope(db, CO)
  for (const [id, folder] of [['kb-d-sales', '営業部'], ['kb-d-dev', '開発']]) {
    db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, CO, folder, folder, ts(), ts())
    store.ensureDepartmentScope(db, CO, id, folder)
  }
  const salesScope = db.prepare('SELECT id FROM scopes WHERE company_id = ? AND path = ?').get(CO, '営業部').id
  db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('kb-co', ?, ?, ?, ?, 1, 1, ?)`).run('r-kb-sales', salesScope, 'user', 'kb-sales', ts())

  const { Hono } = await import('hono')
  const { keyBrokerRoute } = await import('../../src/routes/key-broker')
  services = (await import('../../src/composition')).services
  app = new Hono()
  app.route('/api/companies/:companyId', keyBrokerRoute)
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('API keys (key broker admin)', () => {
  it('only owners and admins manage keys; strangers learn nothing', async () => {
    expect((await call(null, 'GET', `${BASE}/broker`)).status).toBe(401)
    expect((await call('kb-stranger', 'GET', `${BASE}/broker`)).status).toBe(404)
    expect((await call('kb-sales', 'GET', `${BASE}/broker`)).status).toBe(403)
    expect((await call('kb-sales', 'POST', `${BASE}/broker/keys`, gemini())).status).toBe(403)
    expect((await call('kb-sales', 'PUT', `${BASE}/broker/settings`, { memberKeysAllowed: false })).status).toBe(403)
    const view = await call('kb-admin', 'GET', `${BASE}/broker`)
    expect(view.status).toBe(200)
    expect(view.json.data.status).toEqual({ enabled: true, reason: null })
    expect(view.json.data.settings.memberKeysAllowed).toBe(true)
    expect(view.json.data.services.map((s: Json) => [s.service, s.rule])).toEqual([['gemini', 'company-only'], ['openai', 'company-only'], ['anthropic', 'company-only'], ['hubspot', 'company-only']])
  })

  it('registers a company key: last 4 only, built-in destinations, who can use it, recorded', async () => {
    const r = await call('kb-owner', 'POST', `${BASE}/broker/keys`, gemini())
    expect(r.status).toBe(200)
    const key = r.json.data.keys[0]
    expect(key).toMatchObject({
      scope: 'company', service: 'gemini', displayName: '営業用 Gemini', last4: FAKE.slice(-4), status: 'active',
      destinations: { hosts: ['generativelanguage.googleapis.com'], pathPrefixes: [], models: [] },
      caps: { requestsPerDay: 1000, tokensPerDay: null, requestsPerMemberPerDay: null, tokensPerMemberPerDay: null },
      allowPrivateContent: false,
    })
    // Dial ② 全員: every member — reading 営業部's folder (only kb-sales may) no longer decides who.
    expect(key.usableBy.map((u: Json) => u.userId).sort()).toEqual(['kb-admin', 'kb-dev', 'kb-owner', 'kb-sales'])
    expect(key.audience).toEqual({ allDepartments: false, departmentIds: ['kb-d-sales'], everyone: true, addUserIds: [], removeUserIds: [] })
    expect(r.json.data.history[0]).toMatchObject({ changedBy: 'kb-owner', keyId: key.id, change: { action: 'create', key: { last4: FAKE.slice(-4) } } })
    expect(await services.brokerVault.reveal(CO, key.id)).toBe(FAKE)
  })

  it('dial ②: listed people only, or 全員 minus the people removed by name', async () => {
    const id = (await call('kb-owner', 'GET', `${BASE}/broker`)).json.data.keys[0].id
    let r = await call('kb-admin', 'PATCH', `${BASE}/broker/keys/${id}`, {
      audience: { allDepartments: false, departmentIds: ['kb-d-sales'], everyone: false, addUserIds: ['kb-dev'], removeUserIds: [] },
    })
    expect(r.status).toBe(200)
    expect(r.json.data.keys[0].usableBy.map((u: Json) => [u.userId, u.via])).toEqual([['kb-dev', 'person']])
    r = await call('kb-admin', 'PATCH', `${BASE}/broker/keys/${id}`, {
      audience: { allDepartments: false, departmentIds: ['kb-d-sales'], everyone: true, addUserIds: [], removeUserIds: ['kb-sales'] },
    })
    const users = r.json.data.keys[0].usableBy.map((u: Json) => u.userId)
    expect(users).toContain('kb-dev')
    expect(users).not.toContain('kb-sales')
    expect(r.json.data.history[0].change).toMatchObject({ action: 'update', before: { audience: { removeUserIds: [] } }, after: { audience: { removeUserIds: ['kb-sales'] } } })
  })

  it('an audience in the K2 form (no allDepartments) is read as work in its departments, by everyone', async () => {
    const id = (await call('kb-owner', 'GET', `${BASE}/broker`)).json.data.keys[0].id
    const r = await call('kb-admin', 'PATCH', `${BASE}/broker/keys/${id}`, {
      audience: { everyone: false, departmentIds: ['kb-d-sales'], addUserIds: [], removeUserIds: ['kb-sales'] },
    })
    expect(r.status).toBe(200)
    expect(r.json.data.keys[0].audience).toEqual({ allDepartments: false, departmentIds: ['kb-d-sales'], everyone: true, addUserIds: [], removeUserIds: ['kb-sales'] })
    // A row stored in the K2 form reads the same way.
    db.prepare('UPDATE broker_keys SET audience = ? WHERE id = ?').run(JSON.stringify({ everyone: false, departmentIds: [], addUserIds: ['kb-dev'], removeUserIds: [] }), id)
    const view = (await call('kb-owner', 'GET', `${BASE}/broker`)).json.data
    expect(view.keys[0].audience).toEqual({ allDepartments: true, departmentIds: [], everyone: false, addUserIds: ['kb-dev'], removeUserIds: [] })
    expect(view.keys[0].usableBy.map((u: Json) => u.userId)).toEqual(['kb-dev'])
  })

  it('refuses destinations that are not exact hosts, strangers in the audience, bad values', async () => {
    for (const bad of [
      gemini({ destinations: { hosts: ['*.googleapis.com'] } }),
      gemini({ destinations: { hosts: ['127.0.0.1'] } }),
      gemini({ destinations: { hosts: ['localhost'] } }),
      gemini({ service: 'custom-crm' }), // no built-in hosts: destinations required
      gemini({ destinations: { hosts: ['api.example.com'], pathPrefixes: ['/../x'] } }),
      gemini({ audience: { allDepartments: false, departmentIds: ['nope'], everyone: true, addUserIds: [], removeUserIds: [] } }),
      gemini({ audience: { allDepartments: false, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] } }), // no work at all
      gemini({ audience: { allDepartments: 'yes', departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] } }),
      gemini({ audience: { allDepartments: true, departmentIds: [], everyone: false, addUserIds: ['kb-stranger'], removeUserIds: [] } }),
      gemini({ audience: { allDepartments: true, departmentIds: [], everyone: true, addUserIds: ['kb-dev'], removeUserIds: ['kb-dev'] } }),
      gemini({ caps: { requestsPerDay: 0 } }),
      gemini({ service: 'Gemini' }),
      gemini({ secret: 'short' }),
      gemini({ secret: FAKE_BAD }),
      gemini({ secret: `acb_tok_${'a'.repeat(64)}` }),
      'not json',
    ]) {
      expect((await call('kb-owner', 'POST', `${BASE}/broker/keys`, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await call('kb-owner', 'GET', `${BASE}/broker`)).json.data.keys).toHaveLength(1)
  })

  it('replacing a key changes what the relay gets; the record shows last 4 before → after', async () => {
    const id = (await call('kb-owner', 'GET', `${BASE}/broker`)).json.data.keys[0].id
    const r = await call('kb-owner', 'PUT', `${BASE}/broker/keys/${id}/secret`, { secret: FAKE2 })
    expect(r.status).toBe(200)
    expect(r.json.data.keys[0].last4).toBe(FAKE2.slice(-4))
    expect(r.json.data.history[0].change).toEqual({ action: 'replace', service: 'gemini', displayName: '営業用 Gemini', last4Before: FAKE.slice(-4), last4After: FAKE2.slice(-4) })
    expect(await services.brokerVault.reveal(CO, id)).toBe(FAKE2)
    expect((await call('kb-owner', 'PUT', `${BASE}/broker/keys/missing/secret`, { secret: FAKE2 })).status).toBe(404)
    expect((await call('kb-owner', 'PUT', `${BASE}/broker/keys/${id}/secret`, { secret: FAKE_BAD })).status).toBe(400)
  })

  it('a key of another company cannot be touched through this one', async () => {
    const id = (await call('kb-owner', 'GET', `${BASE}/broker`)).json.data.keys[0].id
    expect((await call('kb-stranger', 'PATCH', `/api/companies/kb-other/broker/keys/${id}`, { status: 'disabled' })).status).toBe(404)
    expect((await call('kb-stranger', 'DELETE', `/api/companies/kb-other/broker/keys/${id}`)).status).toBe(404)
  })

  it('per-service rule, own-key destinations and the members\' own-key switch are saved and recorded', async () => {
    const s = await call('kb-owner', 'PUT', `${BASE}/broker/services/gmail`, { category: 'person', rule: 'user-only', ownKeyHosts: ['gmail.googleapis.com'] })
    expect(s.status).toBe(200)
    expect(s.json.data.services.find((x: Json) => x.service === 'gmail')).toMatchObject({ builtin: false, category: 'person', rule: 'user-only', ownKeyHosts: ['gmail.googleapis.com'] })
    expect(s.json.data.history[0].change).toMatchObject({ action: 'service', service: 'gmail', before: null })
    expect((await call('kb-owner', 'PUT', `${BASE}/broker/services/gmail`, { category: 'person', rule: 'whatever' })).status).toBe(400)
    expect((await call('kb-owner', 'PUT', `${BASE}/broker/services/gmail`, { category: 'person', rule: 'user-only', ownKeyHosts: ['*.google.com'] })).status).toBe(400)
    const off = await call('kb-admin', 'PUT', `${BASE}/broker/settings`, { memberKeysAllowed: false })
    expect(off.json.data.settings).toMatchObject({ memberKeysAllowed: false, updatedBy: 'kb-admin' })
    expect(off.json.data.history[0].change).toEqual({ action: 'settings', before: { memberKeysAllowed: true }, after: { memberKeysAllowed: false } })
  })

  it('the relay\'s internal-host exception: exact names only, recorded, empty by default', async () => {
    expect((await call('kb-owner', 'GET', `${BASE}/broker`)).json.data.settings.internalHosts).toEqual([])
    for (const bad of [['10.0.0.5'], ['localhost'], ['*.corp.example.com'], ['crm.internal'], 'crm.example.com']) {
      expect((await call('kb-owner', 'PUT', `${BASE}/broker/settings`, { internalHosts: bad })).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await call('kb-sales', 'PUT', `${BASE}/broker/settings`, { internalHosts: ['crm.example.com'] })).status).toBe(403)
    const r = await call('kb-admin', 'PUT', `${BASE}/broker/settings`, { internalHosts: ['CRM.example.com'] })
    expect(r.json.data.settings).toMatchObject({ internalHosts: ['crm.example.com'], memberKeysAllowed: false })
    expect(r.json.data.history[0].change).toEqual({ action: 'settings', before: { memberKeysAllowed: false, internalHosts: [] }, after: { memberKeysAllowed: false, internalHosts: ['crm.example.com'] } })
    expect(services.keyBroker.internalHosts(CO)).toEqual(['crm.example.com'])
  })

  it('disable and delete are recorded', async () => {
    const id = (await call('kb-owner', 'GET', `${BASE}/broker`)).json.data.keys[0].id
    const d = await call('kb-owner', 'PATCH', `${BASE}/broker/keys/${id}`, { status: 'disabled' })
    expect(d.json.data.keys[0].status).toBe('disabled')
    expect((await call('kb-owner', 'PATCH', `${BASE}/broker/keys/${id}`, { status: 'paused' })).status).toBe(400)
    const del = await call('kb-owner', 'DELETE', `${BASE}/broker/keys/${id}`)
    expect(del.json.data.keys).toEqual([])
    expect(del.json.data.history[0].change).toMatchObject({ action: 'delete', key: { last4: FAKE2.slice(-4), status: 'disabled' } })
    expect(await services.brokerVault.reveal(CO, id)).toBeNull()
  })

  it('no plaintext key in any answer, error, log line or table', async () => {
    // One more key left in place, so the tables are checked with a live sealed value.
    await call('kb-owner', 'POST', `${BASE}/broker/keys`, gemini({ secret: FAKE }))
    expect(seen.length).toBeGreaterThan(30)
    const leaks = (texts: string[]) => texts.filter(t => [FAKE, FAKE2, FAKE_BAD, LEAK_MARK].some(v => t.includes(v)))
    expect(leaks(seen)).toEqual([])
    expect(leaks(logs)).toEqual([])
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(leaks(tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())))).toEqual([])
  })
})

describe('without a key-encryption key', () => {
  it('nothing can be registered or replaced (503 BROKER_OFF); the page still loads', async () => {
    const { createServices } = await import('../../src/composition')
    const off = createServices(db, { enabled: false, reason: 'not-configured', detail: 'BROKER_KEK_FILE is not set' })
    const owner = { companyId: CO, userId: 'kb-owner', role: 'owner' }
    const view = off.keyBroker.get(owner)
    expect(view.ok && view.value.status).toEqual({ enabled: false, reason: 'not-configured' })
    const created = await off.keyBroker.create(owner, gemini())
    expect(created).toMatchObject({ ok: false, kind: 'unavailable', body: { code: 'BROKER_OFF' } })
    const id = view.ok ? view.value.keys[0].id : ''
    expect(await off.keyBroker.replaceSecret(owner, id, { secret: FAKE2 })).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(off.keyBroker.update(owner, id, { status: 'disabled' }).ok).toBe(true)
  })
})
