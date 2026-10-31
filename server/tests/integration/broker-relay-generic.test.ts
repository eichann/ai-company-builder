/**
 * Integration Test: the key broker's generic relay (K9) — a header-type API
 * an owner/admin registers (`PUT …/broker/relay-services/:service`) passes
 * the relay without code. Real admin routes, tokens, vault and relay; a fake
 * upstream in place of the provider.
 *
 * Guards:
 * - Only owners/admins register, change or remove a service; bad definitions
 *   (http, other ports, IPs, internal names, forbidden headers, a format
 *   without `{key}`) are refused.
 * - The host is fixed by the definition: keys cannot name another host, the
 *   relay sends nowhere else, its base path is put before every path, and a
 *   redirect to another host is refused.
 * - The real key goes only in the configured header, in its format; the
 *   client's copy of that header, our token (in any header or query value),
 *   hop-by-hop headers and cookies are never forwarded; a real-looking key in
 *   the configured header is refused unforwarded.
 * - Records (`broker:<service>`), stop-all and daily caps apply as for the
 *   built-in services; the host cannot change while keys exist.
 * - **No key value in any answer, log line or table; no token in any log line.**
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { UpstreamClient, UpstreamRequest } from '../../src/ports/upstream'

const currentUser = vi.hoisted(() => ({ id: 'gr-owner' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id
      ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true }
      : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const FAKE_CRM = 'fake-test-key-NOT-REAL-generic-crm-0123456789'
const FAKE_OWN = 'fake-test-key-NOT-REAL-generic-own-9876543210'
const CO = 'gr-co'
const BASE = `/api/companies/${CO}`
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let admin: any, relayApp: any, db: any, relayServices: any
let kekDir: string
const logs: string[] = []
const seen: string[] = []
const member = { companyId: CO, userId: 'gr-member', role: 'member' }

const received: Array<UpstreamRequest & { bodyText: string }> = []
let reply: (req: UpstreamRequest) => { status: number; headers?: Array<[string, string]>; body?: string } = () => ({ status: 200, body: '{"ok":true}' })

const fakeUpstream: UpstreamClient = {
  async send(req) {
    const chunks: Uint8Array[] = []
    if (req.body) for await (const c of req.body) chunks.push(c)
    received.push({ ...req, bodyText: Buffer.concat(chunks).toString('utf8') })
    const r = reply(req)
    return {
      ok: true,
      response: {
        status: r.status,
        headers: r.headers ?? [['content-type', 'application/json']],
        body: (async function* () { yield new TextEncoder().encode(r.body ?? '') })(),
        viaPrivateAddress: false,
      },
    }
  },
}

async function adminCall(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await admin.request(`${BASE}${path}`, {
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

async function relay(method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  const res = await relayApp.request(`http://acb.test/api/broker${path}`, { method, headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}) })
  const text = await res.text()
  seen.push(text, JSON.stringify([...res.headers.entries()]))
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers }
}

const tokenFor = (services_: string[]) =>
  relayServices.brokerTokens.issue(member, { conversationId: 'conv-generic', services: services_ }).value.token as string

const CRM = { label: '顧客管理', baseUrl: 'https://api.crm.example.com/v2/', header: 'Authorization', format: 'Token token={key}' }
const everyone = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-gr-kek-'))
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
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'gr-owner', ts(), ts())
  for (const [u, r] of [['gr-owner', 'owner'], ['gr-admin', 'admin'], ['gr-member', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }

  const { Hono } = await import('hono')
  const { keyBrokerRoute } = await import('../../src/routes/key-broker')
  admin = new Hono().route('/api/companies/:companyId', keyBrokerRoute)
  const { createServices } = await import('../../src/composition')
  relayServices = createServices(db, undefined, { upstream: fakeUpstream })
  const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
  relayApp = new Hono().route('/api/broker', brokerRelayRoutes(relayServices.brokerRelay))
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('generic relay services (K9)', () => {
  it('only owners and admins register a service; members and strangers cannot', async () => {
    expect((await adminCall(null, 'PUT', '/broker/relay-services/crm', CRM)).status).toBe(401)
    expect((await adminCall('gr-member', 'PUT', '/broker/relay-services/crm', CRM)).status).toBe(403)
    expect((await adminCall('gr-member', 'DELETE', '/broker/relay-services/crm')).status).toBe(403)
    expect(db.prepare('SELECT COUNT(*) AS n FROM broker_services WHERE company_id = ?').get(CO).n).toBe(0)

    const r = await adminCall('gr-admin', 'PUT', '/broker/relay-services/crm', CRM)
    expect(r.status).toBe(200)
    const view = r.json.data.services.find((s: Json) => s.service === 'crm')
    expect(view).toMatchObject({
      label: '顧客管理', builtin: false, category: 'tool', rule: 'company-only', defaultHosts: ['api.crm.example.com'],
      relay: { label: '顧客管理', host: 'api.crm.example.com', basePath: '/v2', header: 'authorization', format: 'Token token={key}' },
    })
    expect(r.json.data.history[0].change).toMatchObject({ action: 'relay-service', service: 'crm', before: null })
  })

  it('refuses definitions that would open the relay: http, other ports, IPs, internal names, users, forbidden headers, no {key}', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['crm', { ...CRM, baseUrl: 'http://api.crm.example.com' }],
      ['crm', { ...CRM, baseUrl: 'https://api.crm.example.com:8443' }],
      ['crm', { ...CRM, baseUrl: 'https://10.0.0.5/v2' }],
      ['crm', { ...CRM, baseUrl: 'https://[::1]/' }],
      ['crm', { ...CRM, baseUrl: 'https://localhost/' }],
      ['crm', { ...CRM, baseUrl: 'https://crm.internal/' }],
      ['crm', { ...CRM, baseUrl: 'https://user:pw@api.crm.example.com/' }],
      ['crm', { ...CRM, baseUrl: 'https://api.crm.example.com/v2?x=1' }],
      ['crm', { ...CRM, baseUrl: 'https://api.crm.example.com/../admin' }],
      ['crm', { ...CRM, baseUrl: 'https://*.crm.example.com/' }],
      ['crm', { ...CRM, header: 'Host' }],
      ['crm', { ...CRM, header: 'Cookie' }],
      ['crm', { ...CRM, header: 'X-Forwarded-For' }],
      ['crm', { ...CRM, header: 'Content-Length' }],
      ['crm', { ...CRM, header: 'X-Bad\r\nInjected' }],
      ['crm', { ...CRM, format: 'Token token=' }],
      ['crm', { ...CRM, format: '{key}{key}' }],
      ['crm', { ...CRM, format: 'Bearer {key}\r\nX-Evil: 1' }],
      ['gemini', CRM],
      ['crm_master', CRM],
      ['CRM', CRM],
    ]
    for (const [service, body] of bad) {
      const r = await adminCall('gr-owner', 'PUT', `/broker/relay-services/${encodeURIComponent(service)}`, body)
      expect(r.status, `${service} ${JSON.stringify(body)}`).toBe(400)
    }
    const view = (await adminCall('gr-owner', 'GET', '/broker')).json.data
    expect(view.services.find((s: Json) => s.service === 'crm').relay.host).toBe('api.crm.example.com')
  })

  it('keys for the service go to its host only (company keys and own-key hosts)', async () => {
    const other = await adminCall('gr-owner', 'POST', '/broker/keys', {
      service: 'crm', displayName: 'CRM', secret: FAKE_CRM, audience: everyone, destinations: { hosts: ['evil.example.com'] },
    })
    expect(other.status).toBe(400)
    expect((await adminCall('gr-owner', 'PUT', '/broker/services/crm', { category: 'tool', rule: 'company-first', ownKeyHosts: ['evil.example.com'] })).status).toBe(400)
    const created = await adminCall('gr-owner', 'POST', '/broker/keys', { service: 'crm', displayName: 'CRM', secret: FAKE_CRM, audience: everyone })
    expect(created.status).toBe(200)
    const key = created.json.data.keys.find((k: Json) => k.service === 'crm')
    expect(key.destinations.hosts).toEqual(['api.crm.example.com'])
    expect((await adminCall('gr-owner', 'PATCH', `/broker/keys/${key.id}`, { destinations: { hosts: ['evil.example.com'] } })).status).toBe(400)
  })

  it('the real key goes only in the configured header, in its format; the host and base path are the definition\'s', async () => {
    const token = tokenFor(['crm'])
    expect(token).toMatch(/^acb_tok_/)
    reply = () => ({ status: 200, body: '{"contacts":[]}' })
    const r = await relay('POST', `/crm/contacts/search?limit=5&echo=${token}`, {
      headers: {
        authorization: `Token token=${token}`, 'content-type': 'application/json', cookie: 'session=abc', 'x-forwarded-for': '1.2.3.4',
        connection: 'keep-alive', 'proxy-authorization': 'Basic Zm9v', 'x-acb-session': 'secret-session', 'x-note': `see ${token}`,
      },
      body: '{"q":"山田"}',
    })
    expect(r.status).toBe(200)
    const sent = received.at(-1)!
    expect(sent).toMatchObject({ host: 'api.crm.example.com', method: 'POST', path: '/v2/contacts/search?limit=5' })
    expect(sent.headers.authorization).toBe(`Token token=${FAKE_CRM}`)
    for (const h of ['cookie', 'x-forwarded-for', 'connection', 'proxy-authorization', 'x-acb-session', 'x-note']) expect(sent.headers[h], h).toBeUndefined()
    expect(sent.bodyText).toBe('{"q":"山田"}')
    expect(JSON.stringify(sent)).not.toContain(token)
    // The token in the standard forms works too (x-api-key, Bearer), and still only the configured header carries the key.
    await relay('GET', '/crm/contacts', { headers: { 'x-api-key': token } })
    expect(received.at(-1)!.headers).toMatchObject({ authorization: `Token token=${FAKE_CRM}` })
    expect(received.at(-1)!.headers['x-api-key']).toBeUndefined()
  })

  it('a real-looking key in the configured header (or anywhere a key goes) is refused and never forwarded', async () => {
    const token = tokenFor(['crm'])
    const before = received.length
    for (const headers of [
      { authorization: 'Token token=crm-NOT-REAL-but-looks-real' },
      { authorization: 'Token token=crm-NOT-REAL-but-looks-real', 'x-api-key': token },
      { 'x-api-key': 'NOT-REAL-looks-real-1234' },
    ]) {
      const r = await relay('GET', '/crm/contacts', { headers })
      expect([r.status, r.json.error.code], JSON.stringify(headers)).toEqual([401, 'ACB_REAL_KEY_REFUSED'])
    }
    // No token at all: nothing goes anywhere either.
    expect((await relay('GET', '/crm/contacts', { headers: { 'x-custom': 'whatever' } })).json.error.code).toBe('ACB_NO_TOKEN')
    expect(received.length).toBe(before)
  })

  it('bad paths, other hosts in redirects, and unregistered services are refused', async () => {
    const token = tokenFor(['crm'])
    const h = { authorization: `Token token=${token}` }
    const before = received.length
    for (const bad of ['/crm/a/..%2Fadmin', '/crm//x', '/crm/%5c', '/crm/%00']) {
      expect((await relay('GET', bad, { headers: h })).status, bad).toBe(400)
    }
    expect(received.length).toBe(before)

    reply = () => ({ status: 302, headers: [['location', 'https://evil.example.com/steal']], body: '' })
    expect((await relay('GET', '/crm/contacts', { headers: h })).json.error.code).toBe('ACB_REDIRECT_REFUSED')
    // Same host but outside the base path: not reachable through this service either.
    reply = () => ({ status: 302, headers: [['location', 'https://api.crm.example.com/admin/x']], body: '' })
    expect((await relay('GET', '/crm/contacts', { headers: h })).json.error.code).toBe('ACB_REDIRECT_REFUSED')
    reply = () => ({ status: 302, headers: [['location', 'https://api.crm.example.com/v2/contacts?page=2']], body: '' })
    const r = await relay('GET', '/crm/contacts', { headers: h })
    expect([r.status, r.headers.get('location')]).toEqual([302, 'http://acb.test/api/broker/crm/contacts?page=2'])

    expect((await relay('GET', '/nothing-here/x', { headers: h })).status).toBe(404)
  })

  it('a provider echoing the key or the token never shows it to the caller', async () => {
    const token = tokenFor(['crm'])
    reply = () => ({ status: 401, headers: [['content-type', 'application/json'], ['x-debug', `auth=${FAKE_CRM}`], ['x-echo', token]], body: `{"error":"bad key ${FAKE_CRM} (${token})"}` })
    const r = await relay('GET', '/crm/contacts', { headers: { authorization: `Token token=${token}` } })
    expect(r.status).toBe(401)
    expect(r.text).toContain('[hidden]')
    expect(r.text).not.toContain(FAKE_CRM)
    expect(r.text).not.toContain(token)
    expect(r.headers.get('x-debug')).toBeNull()
    expect(r.headers.get('x-echo')).toBeNull()
  })

  it('the company\'s internal-host exception is what the way out is given (private addresses refused otherwise)', async () => {
    const token = tokenFor(['crm'])
    reply = () => ({ status: 200, body: '{}' })
    await relay('GET', '/crm/contacts', { headers: { authorization: `Token token=${token}` } })
    expect(received.at(-1)!.allowPrivateHosts).toEqual([])
    expect((await adminCall('gr-owner', 'PUT', '/broker/settings', { internalHosts: ['api.crm.example.com'] })).status).toBe(200)
    await relay('GET', '/crm/contacts', { headers: { authorization: `Token token=${token}` } })
    expect(received.at(-1)!.allowPrivateHosts).toEqual(['api.crm.example.com'])
    await adminCall('gr-owner', 'PUT', '/broker/settings', { internalHosts: [] })
  })

  it('each call is recorded as broker:<service> without key or token; stop-all and caps apply', async () => {
    const token = tokenFor(['crm'])
    reply = () => ({ status: 200, body: '{"usage":{"input_tokens":987654321}}' })
    await relay('GET', '/crm/deals', { headers: { authorization: `Token token=${token}` } })
    const row = db.prepare("SELECT * FROM agent_events WHERE company_id = ? AND tool = 'broker:crm' ORDER BY rowid DESC LIMIT 1").get(CO)
    expect(row).toBeTruthy()
    expect(row.user_id).toBe('gr-member')
    const text = JSON.stringify(row)
    expect(text).toContain('api.crm.example.com')
    expect(text).toContain('/deals')
    expect(text).not.toContain(FAKE_CRM)
    expect(text).not.toContain(token)
    // A generic service's body is not read for AI token counts.
    expect(text).not.toContain('987654321')

    expect((await adminCall('gr-owner', 'POST', '/broker/stop-all')).status).toBe(200)
    const stopped = await relay('GET', '/crm/deals', { headers: { authorization: `Token token=${token}` } })
    expect([stopped.status, stopped.json.error.code]).toEqual([403, 'ACB_STOPPED'])
    expect(stopped.json.error.message).toContain('顧客管理')
    const keyId = (await adminCall('gr-owner', 'GET', '/broker')).json.data.keys.find((k: Json) => k.service === 'crm').id
    await adminCall('gr-owner', 'PATCH', `/broker/keys/${keyId}`, { status: 'active', caps: { requestsPerMemberPerDay: 1 } })
    const capped = await relay('GET', '/crm/deals', { headers: { authorization: `Token token=${token}` } })
    expect([capped.status, capped.json.error.code]).toEqual([429, 'ACB_OVER_CAP'])
    await adminCall('gr-owner', 'PATCH', `/broker/keys/${keyId}`, { caps: { requestsPerMemberPerDay: null } })
  })

  it('a member\'s own key for the service goes to the service\'s host, in the same header', async () => {
    expect((await adminCall('gr-owner', 'PUT', '/broker/services/crm', { category: 'tool', rule: 'user-only', ownKeyHosts: ['api.crm.example.com'] })).status).toBe(200)
    const saved = await relayServices.ownBrokerKeys.save(member, 'crm', { secret: FAKE_OWN })
    expect(saved.ok).toBe(true)
    expect(saved.value.services.find((s: Json) => s.service === 'crm').label).toBe('顧客管理')
    const token = tokenFor(['crm'])
    reply = () => ({ status: 200, body: '{}' })
    await relay('GET', '/crm/me', { headers: { authorization: `Token token=${token}` } })
    expect(received.at(-1)!).toMatchObject({ host: 'api.crm.example.com', path: '/v2/me' })
    expect(received.at(-1)!.headers.authorization).toBe(`Token token=${FAKE_OWN}`)
    await adminCall('gr-owner', 'PUT', '/broker/services/crm', { category: 'tool', rule: 'company-only', ownKeyHosts: [] })
  })

  it('the host cannot change, and the service cannot be removed, while keys exist; then it can', async () => {
    const moved = await adminCall('gr-owner', 'PUT', '/broker/relay-services/crm', { ...CRM, baseUrl: 'https://api.other.example.com' })
    expect([moved.status, moved.json.code]).toEqual([409, 'SERVICE_HAS_KEYS'])
    expect((await adminCall('gr-owner', 'DELETE', '/broker/relay-services/crm')).json.code).toBe('SERVICE_HAS_KEYS')
    // The label, header and format may change in place.
    const relabel = await adminCall('gr-owner', 'PUT', '/broker/relay-services/crm', { ...CRM, label: 'CRM（営業）', header: 'x-crm-key', format: '{key}' })
    expect(relabel.status).toBe(200)
    const token = tokenFor(['crm'])
    reply = () => ({ status: 200, body: '{}' })
    // The token in the new header form; the key now goes there, and Authorization carries nothing of ours.
    await relay('GET', '/crm/contacts', { headers: { 'x-crm-key': token } })
    expect(received.at(-1)!.headers['x-crm-key']).toBe(FAKE_CRM)
    expect(received.at(-1)!.headers.authorization).toBeUndefined()
    // A real-looking key in the service's own header, next to a valid token elsewhere: refused, not forwarded.
    const before = received.length
    const mixed = await relay('GET', '/crm/contacts', { headers: { 'x-crm-key': 'crm-NOT-REAL-hardcoded', 'x-api-key': token } })
    expect([mixed.status, mixed.json.error.code]).toEqual([401, 'ACB_REAL_KEY_REFUSED'])
    expect(received.length).toBe(before)

    for (const k of (await adminCall('gr-owner', 'GET', '/broker')).json.data.keys.filter((k: Json) => k.service === 'crm')) {
      expect((await adminCall('gr-owner', 'DELETE', `/broker/keys/${k.id}`)).status).toBe(200)
    }
    const gone = await adminCall('gr-owner', 'DELETE', '/broker/relay-services/crm')
    expect(gone.status).toBe(200)
    expect(gone.json.data.services.find((s: Json) => s.service === 'crm')).toBeUndefined()
    expect(gone.json.data.history[0].change).toMatchObject({ action: 'relay-service', service: 'crm', after: null })
    expect((await relay('GET', '/crm/contacts', { headers: { 'x-crm-key': token } })).status).toBe(404)
  })

  it('an existing database gains the definition column (additive migration, rows kept)', async () => {
    const Database = (await import('better-sqlite3')).default
    const old = new Database(':memory:')
    old.exec(`CREATE TABLE broker_services (company_id TEXT NOT NULL, service TEXT NOT NULL, category TEXT NOT NULL, rule TEXT NOT NULL,
      own_key_hosts TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (company_id, service))`)
    old.prepare('INSERT INTO broker_services VALUES (?, ?, ?, ?, ?, ?, ?)').run('c', 'gemini', 'tool', 'company-only', '[]', ts(), 'u')
    const { initDatabase } = await import('../../src/db')
    initDatabase(old)
    expect(old.prepare('SELECT service, relay FROM broker_services').all()).toEqual([{ service: 'gemini', relay: null }])
    old.close()
  })

  it('no key value in any answer, log line or table; no token in any log line', async () => {
    expect(seen.length).toBeGreaterThan(20)
    const keys = [FAKE_CRM, FAKE_OWN, 'NOT-REAL-generic']
    expect(seen.filter(t => keys.some(k => t.includes(k)))).toEqual([])
    expect(logs.filter(t => keys.some(k => t.includes(k)) || /acb_tok_[0-9a-f]{64}/.test(t))).toEqual([])
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    const dump = tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
    expect(keys.filter(k => dump.includes(k))).toEqual([])
  })
})
