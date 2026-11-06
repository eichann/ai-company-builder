/**
 * Integration Test: the relay end to end over real HTTPS (adapters/
 * upstream-https.ts) against a local fake provider with its own certificate.
 *
 * - SSRF: a destination name that resolves to an internal address (here
 *   127.0.0.1) is refused before any connection — also when only one of its
 *   addresses is internal — unless the company named the host as an
 *   exception (then it works, and the use is logged).
 * - No DNS-rebinding window: the name is resolved once and the connection
 *   goes to the address that was checked.
 * - TLS is verified against the destination's name, not the address.
 * - Through the whole route: the provider receives the real key and never the
 *   token; the caller never sees the key.
 * - Every request names a client: ACB's user agent when the caller set none (a
 *   load balancer refused requests without one, staging 2026-11-06), the caller's
 *   own — a script's through the relay — kept as is.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'https'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const HOST = 'api.fake-upstream.test'
const FAKE_KEY = 'fake-test-key-NOT-REAL-https-0123456789'
const CO = 'rh-co'
const ts = () => new Date().toISOString()

let dir: string
let server: Server
let port: number
let ca: Buffer
const hits: Array<{ host?: string; key?: string; auth?: string; path?: string; userAgent?: string }> = []
const logs: string[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acb-rh-'))
  // A certificate for HOST only (the test's own CA = itself).
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`,
    '-addext', `subjectAltName=DNS:${HOST}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
  ca = readFileSync(join(dir, 'cert.pem'))
  server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, (req, res) => {
    hits.push({ host: req.headers.host, key: req.headers['x-goog-api-key'] as string | undefined, auth: req.headers.authorization, path: req.url, userAgent: req.headers['user-agent'] })
    req.resume()
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"candidates":[]}') })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port

  writeFileSync(join(dir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(dir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(dir, 'kek')
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); original(...args) })
  }
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

async function adapter(lookup: (host: string) => Promise<Array<{ address: string; family: number }>>) {
  const { httpsUpstream } = await import('../../src/adapters/upstream-https')
  return httpsUpstream({ lookup, port, ca })
}

const request = (host: string, allow: string[] = []) => ({
  host, method: 'GET', path: '/v1beta/models', headers: { 'x-goog-api-key': FAKE_KEY }, body: null,
  allowPrivateHosts: allow, signal: new AbortController().signal, headersTimeoutMs: 5000,
})

describe('the relay over HTTPS', () => {
  it('refuses a name that resolves to an internal address, before connecting; the exception lets it through', async () => {
    const up = await adapter(async () => [{ address: '127.0.0.1', family: 4 }])
    const before = hits.length
    expect(await up.send(request(HOST))).toEqual({ ok: false, reason: 'private-address' })
    expect(hits.length).toBe(before)
    const allowed = await up.send(request(HOST, [HOST]))
    expect(allowed.ok && allowed.response.status).toBe(200)
    expect(allowed.ok && allowed.response.viaPrivateAddress).toBe(true)
    expect(hits.at(-1)).toMatchObject({ host: HOST, key: FAKE_KEY })
  })

  it('one internal address among several is enough to refuse', async () => {
    const up = await adapter(async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }])
    expect(await up.send(request(HOST))).toEqual({ ok: false, reason: 'private-address' })
  })

  it('resolves once and connects to the checked address (no rebinding window)', async () => {
    let calls = 0
    const up = await adapter(async () => (++calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]))
    const r = await up.send(request(HOST, [HOST]))
    expect(r.ok).toBe(true)
    expect(calls).toBe(1)
  })

  it('verifies TLS against the destination name, not the address', async () => {
    const up = await adapter(async () => [{ address: '127.0.0.1', family: 4 }])
    expect(await up.send(request('other.fake-upstream.test', ['other.fake-upstream.test']))).toEqual({ ok: false, reason: 'tls' })
  })

  it('names ACB as the client when the caller did not, and keeps a caller\'s own', async () => {
    const { ACB_USER_AGENT } = await import('../../src/adapters/upstream-https')
    // The product and its version only: nothing of a company, member, key or host.
    expect(ACB_USER_AGENT).toMatch(/^AICompanyBuilder\/[0-9][0-9A-Za-z.+-]*$/)
    const up = await adapter(async () => [{ address: '127.0.0.1', family: 4 }])
    expect((await up.send(request(HOST, [HOST]))).ok).toBe(true)
    expect(hits.at(-1)!.userAgent).toBe(ACB_USER_AGENT)
    for (const name of ['user-agent', 'User-Agent']) {
      const own = { ...request(HOST, [HOST]), headers: { 'x-goog-api-key': FAKE_KEY, [name]: 'my-script/2.0' } }
      expect((await up.send(own)).ok).toBe(true)
      expect(hits.at(-1)!.userAgent, name).toBe('my-script/2.0')
    }
  })

  it('through the route: refused until the company allows the internal host; the provider gets the key, never the token', async () => {
    const dbModule = await import('../../src/db')
    dbModule.initDatabase()
    const db = dbModule.db
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'rh-owner', ts(), ts())
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-rh', 'rh-owner', CO, 'owner', ts(), ts())
    const { createServices } = await import('../../src/composition')
    const services = createServices(db, undefined, { upstream: await adapter(async () => [{ address: '127.0.0.1', family: 4 }]) })
    const owner = { companyId: CO, userId: 'rh-owner', role: 'owner' }
    // A built-in service's key goes only to its own host, so the local provider is a registered (generic) service.
    expect(services.keyBroker.setRelayService(owner, 'fake-ai', { label: 'Fake AI', baseUrl: `https://${HOST}`, header: 'x-goog-api-key', format: '{key}' }).ok).toBe(true)
    // A registered service only reads until the admin allows writes (audit B-M6); an AI gateway's calls are POSTs.
    expect(services.keyBroker.setReadOnly(owner, 'fake-ai', { readOnly: false }).ok).toBe(true)
    expect((await services.keyBroker.create(owner, {
      service: 'fake-ai', displayName: 'g', secret: FAKE_KEY,
      audience: { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] },
    })).ok).toBe(true)
    const issued = services.brokerTokens.issue(owner, { conversationId: 'c', services: ['fake-ai'] })
    const token = issued.ok ? issued.value.token! : ''
    const { Hono } = await import('hono')
    const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
    const app = new Hono().route('/api/broker', brokerRelayRoutes(services.brokerRelay))
    const call = () => app.request('http://acb.test/api/broker/fake-ai/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST', headers: { 'x-goog-api-key': token, 'content-type': 'application/json', 'user-agent': 'google-genai-sdk/1.0 node' }, body: '{"contents":[]}',
    })

    const before = hits.length
    const refused = await call()
    expect(refused.status).toBe(403)
    expect((await refused.json()).error.code).toBe('ACB_PRIVATE_ADDRESS')
    expect(hits.length).toBe(before)

    expect(services.keyBroker.setSettings(owner, { internalHosts: [HOST] }).ok).toBe(true)
    const res = await call()
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toBe('{"candidates":[]}')
    // The script's own user agent goes upstream as it was (the relay always forwarded it).
    expect(hits.at(-1)).toMatchObject({ key: FAKE_KEY, path: '/v1beta/models/gemini-2.5-flash:generateContent', userAgent: 'google-genai-sdk/1.0 node' })
    expect(JSON.stringify(hits)).not.toContain(token)
    expect(text).not.toContain(FAKE_KEY)
    expect(logs.join('\n')).not.toContain(FAKE_KEY)
    expect(logs.join('\n')).toContain('allowed by the company')
  })
})
