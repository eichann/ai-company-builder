/**
 * Integration Test: the key broker's relay (K4) on the real route, tokens,
 * vault and rules, with a fake upstream in place of the providers.
 *
 * - The token goes in any of the SDKs' forms (Bearer, x-api-key,
 *   x-goog-api-key, ?key=); the real key goes upstream only in the service's
 *   one header, and our token never does.
 * - **No plaintext key in any answer, error, log line or table** — also when
 *   the provider echoes it in an error or a header.
 * - A real-looking key from the client is refused, never forwarded.
 * - Only the key's destinations (path prefixes, models); bad paths refused;
 *   redirects and Gemini upload URLs come back through the relay, foreign
 *   ones are refused or dropped; uploads continue under the token that
 *   started them.
 * - Size limit; streaming passthrough; plain-Japanese refusals.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { UpstreamClient, UpstreamRequest } from '../../src/ports/upstream'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const FAKE_GEMINI = 'fake-test-key-NOT-REAL-relay-gemini-0123456789'
const FAKE_OPENAI = 'fake-test-key-NOT-REAL-relay-openai-9876543210'
const FAKE_ANTHROPIC = 'fake-test-key-NOT-REAL-relay-anthropic-55555'
const CO = 'rl-co'
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, db: any, services: any
let kekDir: string
const logs: string[] = []
const seen: string[] = []
const owner = { companyId: CO, userId: 'rl-owner', role: 'owner' }
const member = { companyId: CO, userId: 'rl-member', role: 'member' }

/** What the fake provider received, and what it answers next. */
const received: Array<UpstreamRequest & { bodyText: string }> = []
let reply: (req: UpstreamRequest) => { status: number; headers?: Array<[string, string]>; body?: string | string[] } = () => ({ status: 200, body: '{"ok":true}' })
let failWith: 'private-address' | null = null

const fakeUpstream: UpstreamClient = {
  async send(req) {
    const chunks: Uint8Array[] = []
    try {
      if (req.body) for await (const c of req.body) chunks.push(c)
    } catch {
      return { ok: false, reason: 'aborted' }
    }
    received.push({ ...req, bodyText: Buffer.concat(chunks).toString('utf8') })
    if (failWith) return { ok: false, reason: failWith }
    const r = reply(req)
    const parts = Array.isArray(r.body) ? r.body : [r.body ?? '']
    return {
      ok: true,
      response: {
        status: r.status,
        headers: r.headers ?? [['content-type', 'application/json']],
        body: (async function* () { for (const p of parts) yield new TextEncoder().encode(p) })(),
        viaPrivateAddress: false,
      },
    }
  },
}

async function call(method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  const res = await app.request(`http://acb.test/api/broker${path}`, { method, headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}) })
  const text = await res.text()
  seen.push(text, JSON.stringify([...res.headers.entries()]))
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers }
}

const tokenFor = (services_: string[], department: string | null = null) =>
  services.brokerTokens.issue(member, { conversationId: 'conv-relay', services: services_, department }).value.token as string

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-rl-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  process.env.BROKER_MAX_REQUEST_MB = '1'

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
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'rl-owner', ts(), ts())
  for (const [u, r] of [['rl-owner', 'owner'], ['rl-member', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }

  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { upstream: fakeUpstream })
  const { Hono } = await import('hono')
  const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
  app = new Hono().route('/api/broker', brokerRelayRoutes(services.brokerRelay))

  const everyone = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  for (const [service, secret, extra] of [
    ['gemini', FAKE_GEMINI, {}],
    ['openai', FAKE_OPENAI, { destinations: { hosts: ['api.openai.com'], pathPrefixes: ['/v1/chat/', '/v1/models'], models: ['gpt-5-mini'] } }],
    ['anthropic', FAKE_ANTHROPIC, {}],
  ] as const) {
    const r = await services.keyBroker.create(owner, { service, displayName: service, secret, audience: everyone, ...extra })
    expect(r.ok).toBe(true)
  }
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
  delete process.env.BROKER_MAX_REQUEST_MB
})

describe('the relay', () => {
  it('without a token: 401, nothing sent upstream', async () => {
    const before = received.length
    const r = await call('POST', '/gemini/v1beta/models/gemini-2.5-flash:generateContent', { body: '{}', headers: { 'content-type': 'application/json' } })
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe('ACB_NO_TOKEN')
    expect(received.length).toBe(before)
  })

  it('Gemini: the token in x-goog-api-key or ?key=; the real key goes only in x-goog-api-key; the answer streams back', async () => {
    const token = tokenFor(['gemini'])
    reply = () => ({ status: 200, headers: [['content-type', 'text/event-stream']], body: ['data: {"a":1}\n\n', 'data: {"b":2}\n\n'] })
    const r = await call('POST', '/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', {
      headers: { 'x-goog-api-key': token, 'content-type': 'application/json', cookie: 'session=abc', 'x-forwarded-for': '1.2.3.4' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'こんにちは' }] }] }),
    })
    expect(r.status).toBe(200)
    expect(r.text).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n')
    const sent = received.at(-1)!
    expect(sent).toMatchObject({ host: 'generativelanguage.googleapis.com', method: 'POST', path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse' })
    expect(sent.headers['x-goog-api-key']).toBe(FAKE_GEMINI)
    expect(sent.headers.authorization).toBeUndefined()
    expect(sent.headers.cookie).toBeUndefined()
    expect(sent.headers['x-forwarded-for']).toBeUndefined()
    expect(sent.bodyText).toContain('こんにちは')
    expect(JSON.stringify(sent)).not.toContain(token)

    reply = () => ({ status: 200, body: '{"models":[]}' })
    const q = await call('GET', `/gemini/v1beta/models?key=${token}&pageSize=5`)
    expect(q.status).toBe(200)
    expect(received.at(-1)!.path).toBe('/v1beta/models?pageSize=5')
  })

  it('OpenAI (Bearer) and Anthropic (x-api-key or Bearer): each real key in its own header only', async () => {
    const token = tokenFor(['openai', 'anthropic'])
    reply = () => ({ status: 200, body: '{"id":"x"}' })
    const o = await call('POST', '/openai/v1/chat/completions', { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5-mini', messages: [] }) })
    expect(o.status).toBe(200)
    expect(received.at(-1)!.headers.authorization).toBe(`Bearer ${FAKE_OPENAI}`)
    expect(received.at(-1)!.host).toBe('api.openai.com')
    for (const headers of [{ 'x-api-key': token }, { authorization: `Bearer ${token}` }]) {
      const a = await call('POST', '/anthropic/v1/messages', { headers: { ...headers, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: '{"model":"claude-x","messages":[]}' })
      expect(a.status).toBe(200)
      const sent = received.at(-1)!
      expect(sent.headers['x-api-key']).toBe(FAKE_ANTHROPIC)
      expect(sent.headers.authorization).toBeUndefined()
      expect(sent.headers['anthropic-version']).toBe('2023-06-01')
    }
  })

  it('a real-looking key from the client is refused and never forwarded', async () => {
    const before = received.length
    const token = tokenFor(['openai'])
    for (const headers of [{ authorization: 'Bearer sk-proj-NOT-REAL-but-looks-real' }, { 'x-goog-api-key': 'AIzaNOTREALbutlookslikeone', authorization: `Bearer ${token}` }]) {
      const r = await call('POST', '/openai/v1/chat/completions', { headers: { ...headers, 'content-type': 'application/json' }, body: '{"model":"gpt-5-mini"}' })
      expect([r.status, r.json.error.code]).toEqual([401, 'ACB_REAL_KEY_REFUSED'])
    }
    expect(received.length).toBe(before)
  })

  it('only the key\'s destinations: path prefixes, models, clean paths', async () => {
    const token = tokenFor(['openai'])
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const before = received.length
    expect((await call('POST', '/openai/v1/embeddings', { headers: h, body: '{"model":"gpt-5-mini"}' })).status).toBe(403)
    expect((await call('POST', '/openai/v1/chat/completions', { headers: h, body: '{"model":"gpt-5"}' })).json.error.code).toBe('ACB_DESTINATION_NOT_ALLOWED')
    for (const bad of ['/openai/v1/chat/..%2Ffiles', '/openai/v1/chat//x', '/openai/v1/chat/%5c', '/openai/v1/chat/%00']) {
      expect((await call('POST', bad, { headers: h, body: '{"model":"gpt-5-mini"}' })).status, bad).toBe(400)
    }
    // A dot-dot the URL parser resolves first lands outside the allowed prefixes.
    expect((await call('POST', '/openai/v1/chat/%2e%2e/files', { headers: h, body: '{"model":"gpt-5-mini"}' })).status).toBe(403)
    expect(received.length).toBe(before)
    expect((await call('GET', '/openai/v1/models', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
  })

  it('no key for the service (or the service not in the token): the plain-Japanese refusal', async () => {
    const token = tokenFor(['gemini'])
    const r = await call('POST', '/openai/v1/chat/completions', { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"model":"gpt-5-mini"}' })
    expect(r.status).toBe(403)
    expect(r.json.error.message).toBe('この作業には OpenAI の鍵が必要です。管理者に頼むか、設定の『自分の鍵』から登録してください。')
    expect((await call('GET', '/nope/v1/x', { headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
    // The app's placeholder (keys exist, none for this member): the same sentence, nothing sent upstream.
    const before = received.length
    const p = await call('POST', '/gemini/v1beta/models/x:generateContent', { headers: { 'x-goog-api-key': 'acb_tok_none' }, body: '{}' })
    expect([p.status, p.json.error.message]).toEqual([403, 'この作業には Google Gemini の鍵が必要です。管理者に頼むか、設定の『自分の鍵』から登録してください。'])
    expect(received.length).toBe(before)
  })

  it('Gemini resumable upload: the upload URL comes back through the relay and continues under the starting token', async () => {
    const token = tokenFor(['gemini'])
    reply = (req) => req.path.startsWith('/upload/v1beta/files?')
      && req.path.includes('upload_id')
      ? { status: 200, body: '{"file":{"name":"files/abc"}}' }
      : { status: 200, headers: [['x-goog-upload-url', `https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=UP123&upload_protocol=resumable&key=${FAKE_GEMINI}`], ['x-goog-upload-status', 'active']], body: '' }
    const start = await call('POST', '/gemini/upload/v1beta/files', { headers: { 'x-goog-api-key': token, 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start' } })
    expect(start.status).toBe(200)
    const url = start.headers.get('x-goog-upload-url')!
    expect(url).toBe('http://acb.test/api/broker/gemini/upload/v1beta/files?upload_id=UP123&upload_protocol=resumable')
    // The chunk without any key header (as some SDK versions send it).
    const chunk = await call('POST', url.replace('http://acb.test/api/broker', ''), { headers: { 'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0' }, body: 'bytes' })
    expect(chunk.status).toBe(200)
    expect(received.at(-1)!.headers['x-goog-api-key']).toBe(FAKE_GEMINI)
    // Another upload id is not let through.
    expect((await call('POST', '/gemini/upload/v1beta/files?upload_id=OTHER', { body: 'x' })).status).toBe(401)
  })

  it('redirects: to an allowed host through the relay, elsewhere refused', async () => {
    const token = tokenFor(['gemini'])
    reply = () => ({ status: 302, headers: [['location', 'https://evil.example.com/steal']], body: '' })
    expect((await call('GET', '/gemini/v1beta/models', { headers: { 'x-goog-api-key': token } })).json.error.code).toBe('ACB_REDIRECT_REFUSED')
    reply = () => ({ status: 302, headers: [['location', 'https://generativelanguage.googleapis.com/v1beta/models?page=2']], body: '' })
    const r = await call('GET', '/gemini/v1beta/models', { headers: { 'x-goog-api-key': token } })
    expect([r.status, r.headers.get('location')]).toEqual([302, 'http://acb.test/api/broker/gemini/v1beta/models?page=2'])
  })

  it('a provider that echoes the key (error body or header) never shows it to the caller', async () => {
    const token = tokenFor(['gemini'])
    reply = () => ({ status: 400, headers: [['content-type', 'application/json'], ['x-debug', `key=${FAKE_GEMINI}`]], body: `{"error":{"message":"API key ${FAKE_GEMINI} not valid; token ${token}"}}` })
    const r = await call('POST', '/gemini/v1beta/models/x:generateContent', { headers: { 'x-goog-api-key': token, 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(400)
    expect(r.text).toContain('[hidden]')
    expect(r.text).not.toContain(FAKE_GEMINI)
    expect(r.text).not.toContain(token)
    expect(r.headers.get('x-debug')).toBeNull()
  })

  it('an internal destination is refused with its own message; a request over the size limit is refused', async () => {
    const token = tokenFor(['gemini'])
    failWith = 'private-address'
    const r = await call('POST', '/gemini/v1beta/models/x:generateContent', { headers: { 'x-goog-api-key': token, 'content-type': 'application/json' }, body: '{}' })
    expect([r.status, r.json.error.code]).toEqual([403, 'ACB_PRIVATE_ADDRESS'])
    failWith = null
    const big = 'x'.repeat(1024 * 1024 + 10)
    expect((await call('POST', '/gemini/upload/v1beta/files', { headers: { 'x-goog-api-key': token, 'content-length': String(big.length) }, body: big })).status).toBe(413)
    expect((await call('POST', '/gemini/v1beta/models/x:generateContent', { headers: { 'x-goog-api-key': token, 'content-type': 'application/json' }, body: `"${big}"` })).status).toBe(413)
  })

  it('a revoked or expired token stops at once', async () => {
    const issued = services.brokerTokens.issue(member, { conversationId: 'c2', services: ['gemini'] }).value
    services.brokerTokens.revokeAll(CO, 'rl-member')
    const r = await call('GET', '/gemini/v1beta/models', { headers: { 'x-goog-api-key': issued.token } })
    expect([r.status, r.json.error.code]).toEqual([401, 'ACB_TOKEN_INVALID'])
  })

  it('no key value in any answer, log line or table; no token in any log line', async () => {
    expect(seen.length).toBeGreaterThan(20)
    const keys = [FAKE_GEMINI, FAKE_OPENAI, FAKE_ANTHROPIC, 'NOT-REAL-relay']
    expect(seen.filter(t => keys.some(k => t.includes(k)))).toEqual([])
    expect(logs.filter(t => keys.some(k => t.includes(k)) || /acb_tok_[0-9a-f]{64}/.test(t))).toEqual([])
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    const dump = tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
    expect(keys.filter(k => dump.includes(k))).toEqual([])
  })
})
