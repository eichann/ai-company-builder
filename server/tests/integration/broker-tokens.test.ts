/**
 * Integration Test: the key broker's short-lived tokens (K3) on the real
 * routes, database and vault with a temporary KEK.
 *
 * - A member gets a token only for the services they can use now (the
 *   service's rule, who may use the company key, their own key); the token is
 *   unguessable and only its hash is stored — the value is in no table and
 *   no log line.
 * - The relay's validation (`brokerTokens.validate`) re-decides on every call:
 *   expired, revoked, another service, a disabled key, a member removed from
 *   the company — each stops the token at once.
 * - Lifetime: the server's default within 15–60 minutes; a member revokes only
 *   their own tokens.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

const currentUser = vi.hoisted(() => ({ id: 'bt-owner' as string | null }))

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

const FAKE_COMPANY = 'fake-test-key-NOT-REAL-bt-company-0123456789'
const FAKE_OWN = 'fake-test-key-NOT-REAL-bt-own-9876543210'

const CO = 'bt-co'
const BASE = `/api/companies/${CO}`
const ROLE: Record<string, string> = { 'bt-owner': 'owner', 'bt-sales': 'member', 'bt-dev': 'member', 'bt-leaver': 'member' }
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, db: any, services: any
let kekDir: string
const seen: string[] = []
const logs: string[] = []
const owner = { companyId: CO, userId: 'bt-owner', role: 'owner' }

async function call(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  seen.push(text)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json }
}

const issue = (user: string, body: Record<string, unknown> = {}) => call(user, 'POST', `${BASE}/me/broker-tokens`, { conversationId: 'conv-1', department: '営業部', ...body })

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-bt-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  process.env.BROKER_TOKEN_TTL_MINUTES = '20'

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
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'bt-owner', ts(), ts())
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('bt-other', 'o', 'bt-other', 'x', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-bt-stranger', 'bt-stranger', 'bt-other', 'owner', ts(), ts())
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  const store = await import('../../src/lib/permission-store')
  store.ensureCompanyScope(db, CO)
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('bt-d-sales', CO, '営業部', '営業部', ts(), ts())
  store.ensureDepartmentScope(db, CO, 'bt-d-sales', '営業部')
  const scope = db.prepare('SELECT id FROM scopes WHERE company_id = ? AND path = ?').get(CO, '営業部').id
  for (const u of ['bt-sales', 'bt-leaver']) {
    db.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)').run(`r-${u}`, scope, 'user', u, ts())
  }

  const { Hono } = await import('hono')
  const { keyBrokerRoute } = await import('../../src/routes/key-broker')
  services = (await import('../../src/composition')).services
  app = new Hono()
  app.route('/api/companies/:companyId', keyBrokerRoute)

  // A company Gemini key for 営業部 …
  const created = await services.keyBroker.create(owner, {
    service: 'gemini', displayName: '営業 Gemini', secret: FAKE_COMPANY,
    audience: { everyone: false, departmentIds: ['bt-d-sales'], addUserIds: [], removeUserIds: [] },
  })
  expect(created.ok).toBe(true)
  // … and bt-dev's own OpenAI key (members register own keys in K8; stored the same way here).
  const sealed = await services.brokerVault.seal(CO, 'own-1', FAKE_OWN)
  db.prepare(`INSERT INTO broker_keys (id, company_id, scope, owner_user_id, service, display_name, last4, cipher_scheme, ciphertext, nonce, tag,
    wrapped_key, kek_id, destinations, audience, caps, allow_private_content, status, created_at, created_by, updated_at, updated_by, secret_updated_at)
    VALUES (?, ?, 'user', ?, 'openai', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 0, 'active', ?, ?, ?, ?, ?)`)
    .run('own-1', CO, 'bt-dev', '自分の OpenAI', FAKE_OWN.slice(-4), sealed.scheme, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.wrappedKey, sealed.kekId,
      JSON.stringify({ hosts: ['api.openai.com'], pathPrefixes: [], models: [] }), JSON.stringify({ everyone: false, departmentIds: [], addUserIds: [], removeUserIds: [] }),
      ts(), 'bt-dev', ts(), 'bt-dev', ts())
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
  delete process.env.BROKER_TOKEN_TTL_MINUTES
})

describe('broker tokens', () => {
  it('needs a session and a membership', async () => {
    expect((await issue(null as unknown as string)).status).toBe(401)
    expect((await call('bt-stranger', 'POST', `${BASE}/me/broker-tokens`, { conversationId: 'c' })).status).toBe(404)
    expect((await call('bt-sales', 'POST', `${BASE}/me/broker-tokens`, {})).status).toBe(400)
    expect((await call('bt-sales', 'POST', `${BASE}/me/broker-tokens`, { conversationId: 'c', services: ['Not A Name'] })).status).toBe(400)
  })

  it('a member gets a token for what they can use now; only its hash is stored', async () => {
    const r = await issue('bt-sales', { services: ['gemini', 'openai', 'nothing-here'] })
    expect(r.status).toBe(200)
    const d = r.json.data
    expect(d.token).toMatch(/^acb_tok_[0-9a-f]{64}$/)
    expect(d.services).toEqual([{ service: 'gemini', source: 'company' }])
    expect(d.unavailable).toEqual([{ service: 'openai', reason: 'no-key' }, { service: 'nothing-here', reason: 'unknown-service' }])
    const row = db.prepare('SELECT * FROM broker_tokens WHERE id = ?').get(d.tokenId)
    expect(row).toMatchObject({ user_id: 'bt-sales', company_id: CO, conversation_id: 'conv-1', department: '営業部', services: '["gemini"]' })
    expect(JSON.stringify(row)).not.toContain(d.token.slice(8))
    // Lifetime: the server's 20 minutes.
    expect(Date.parse(d.expiresAt) - Date.now()).toBeGreaterThan(19 * 60_000)
    expect(Date.parse(d.expiresAt) - Date.now()).toBeLessThanOrEqual(20 * 60_000)

    const v = services.brokerTokens.validate(d.token, 'gemini')
    expect(v).toMatchObject({ ok: true, grant: { userId: 'bt-sales', companyId: CO, service: 'gemini', source: 'company', conversationId: 'conv-1',
      destinations: { hosts: ['generativelanguage.googleapis.com'] } } })
    expect(await services.brokerVault.reveal(v.grant.companyId, v.grant.keyId)).toBe(FAKE_COMPANY)
    expect(services.brokerTokens.validate(d.token, 'openai')).toEqual({ ok: false, reason: 'service-not-granted' })
  })

  it('who may use the company key decides: a member outside 営業部 gets no Gemini token', async () => {
    const r = await issue('bt-dev', { services: ['gemini'] })
    expect(r.json.data).toMatchObject({ enabled: true, token: null, services: [], unavailable: [{ service: 'gemini', reason: 'no-key' }] })
  })

  it('the service rule decides between the company key and the member\'s own key', async () => {
    // OpenAI defaults to 会社の鍵だけ: bt-dev's own key is not used.
    expect((await issue('bt-dev', { services: ['openai'] })).json.data.token).toBeNull()
    // 会社優先 with own-key hosts allowed: falls back to the own key.
    expect((await services.keyBroker.setService(owner, 'openai', { category: 'tool', rule: 'company-first', ownKeyHosts: ['api.openai.com'] })).ok).toBe(true)
    const r = await issue('bt-dev', { services: ['openai'] })
    expect(r.json.data.services).toEqual([{ service: 'openai', source: 'user' }])
    const v = services.brokerTokens.validate(r.json.data.token, 'openai')
    expect(await services.brokerVault.reveal(CO, v.grant.keyId)).toBe(FAKE_OWN)
    // The own key's host no longer allowed → no key; members' own keys switched off → no key.
    await services.keyBroker.setService(owner, 'openai', { category: 'tool', rule: 'company-first', ownKeyHosts: [] })
    expect(services.brokerTokens.validate(r.json.data.token, 'openai')).toEqual({ ok: false, reason: 'no-key' })
    await services.keyBroker.setService(owner, 'openai', { category: 'tool', rule: 'company-first', ownKeyHosts: ['api.openai.com'] })
    await services.keyBroker.setSettings(owner, { memberKeysAllowed: false })
    expect(services.brokerTokens.validate(r.json.data.token, 'openai')).toEqual({ ok: false, reason: 'no-key' })
    await services.keyBroker.setSettings(owner, { memberKeysAllowed: true })
    expect(services.brokerTokens.validate(r.json.data.token, 'openai').ok).toBe(true)
  })

  it('validation stops a token at once: expired, revoked, key disabled, member removed, malformed', async () => {
    const token = (await issue('bt-sales', { services: ['gemini'] })).json.data
    expect(services.brokerTokens.validate(token.token, 'gemini').ok).toBe(true)

    // Key disabled → no key; enabled again → valid.
    const keyId = services.brokerTokens.validate(token.token, 'gemini').grant.keyId
    services.keyBroker.update(owner, keyId, { status: 'disabled' })
    expect(services.brokerTokens.validate(token.token, 'gemini')).toEqual({ ok: false, reason: 'no-key' })
    services.keyBroker.update(owner, keyId, { status: 'active' })

    // Expired.
    db.prepare('UPDATE broker_tokens SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), token.tokenId)
    expect(services.brokerTokens.validate(token.token, 'gemini')).toEqual({ ok: false, reason: 'expired' })

    // Revoked: only by its member.
    const second = (await issue('bt-sales', { services: ['gemini'] })).json.data
    expect((await call('bt-owner', 'DELETE', `${BASE}/me/broker-tokens/${second.tokenId}`)).status).toBe(404)
    expect((await call('bt-sales', 'DELETE', `${BASE}/me/broker-tokens/${second.tokenId}`)).status).toBe(200)
    expect(services.brokerTokens.validate(second.token, 'gemini')).toEqual({ ok: false, reason: 'revoked' })

    // Member removed from the company.
    const leaver = (await issue('bt-leaver', { services: ['gemini'] })).json.data
    expect(services.brokerTokens.validate(leaver.token, 'gemini').ok).toBe(true)
    db.prepare('DELETE FROM memberships WHERE company_id = ? AND user_id = ?').run(CO, 'bt-leaver')
    expect(services.brokerTokens.validate(leaver.token, 'gemini')).toEqual({ ok: false, reason: 'not-member' })

    // The emergency stop (M2): every live token of a member.
    const third = (await issue('bt-sales', { services: ['gemini'] })).json.data
    expect(services.brokerTokens.revokeAll(CO, 'bt-sales')).toBeGreaterThanOrEqual(1)
    expect(services.brokerTokens.validate(third.token, 'gemini')).toEqual({ ok: false, reason: 'revoked' })

    for (const bad of ['', 'acb_tok_', `acb_tok_${'g'.repeat(64)}`, FAKE_COMPANY, `acb_tok_${'0'.repeat(64)}`]) {
      expect(services.brokerTokens.validate(bad, 'gemini').ok).toBe(false)
    }
    expect(services.brokerTokens.validate(`acb_tok_${'0'.repeat(64)}`, 'gemini')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('a lifetime asked by the app is kept within 15 minutes and the server\'s maximum', async () => {
    const short = (await issue('bt-sales', { ttlMinutes: 1 })).json.data
    expect(Date.parse(short.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000)
    const long = (await issue('bt-sales', { ttlMinutes: 600 })).json.data
    expect(Date.parse(long.expiresAt) - Date.now()).toBeLessThanOrEqual(20 * 60_000)
  })

  it('a member holds a bounded number of live tokens', async () => {
    db.prepare('UPDATE broker_tokens SET revoked_at = ? WHERE user_id = ?').run(ts(), 'bt-sales')
    let last = 0
    for (let i = 0; i < 51; i++) last = (await issue('bt-sales', { services: ['gemini'] })).status
    expect(last).toBe(429)
  })

  it('no token value or key value in any log line or table', async () => {
    const tokens = seen.flatMap(t => [...t.matchAll(/acb_tok_[0-9a-f]{64}/g)].map(m => m[0]))
    expect(tokens.length).toBeGreaterThan(5)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    const dump = tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
    const allLogs = logs.join('\n')
    for (const t of tokens) {
      expect(dump).not.toContain(t.slice(8))
      expect(allLogs).not.toContain(t.slice(8))
    }
    for (const v of [FAKE_COMPANY, FAKE_OWN, 'NOT-REAL']) {
      expect(dump).not.toContain(v)
      expect(allLogs).not.toContain(v)
      expect(seen.join('\n')).not.toContain(v)
    }
  })
})

describe('broker tokens without a key-encryption key', () => {
  it('the app gets "off" and no token, not an error', async () => {
    const { createServices } = await import('../../src/composition')
    const off = createServices(db, { enabled: false, reason: 'not-configured', detail: 'unset' })
    const r = off.brokerTokens.issue({ companyId: CO, userId: 'bt-sales', role: 'member' }, { conversationId: 'c' })
    expect(r).toEqual({ ok: true, value: { enabled: false, token: null, tokenId: null, expiresAt: null, services: [], unavailable: [] } })
    expect(off.brokerTokens.validate(`acb_tok_${'0'.repeat(64)}`, 'gemini')).toEqual({ ok: false, reason: 'broker-off' })
  })
})
