/**
 * Integration Test: a key is checked once when it is saved (「鍵を確かめる」,
 * .claude/rules/key-broker.md) — company keys and own keys, on the real
 * services, database and vault, with a fake upstream.
 *
 * - The check is one GET without a body to the service's fixed host only
 *   (built-in: its host, and only when the key may go there; generic: its one
 *   host + base path + the admin's check path), the key in the service's own
 *   header and nowhere else.
 * - A key the service refuses (401 / Gemini 400·403 / generic 401·403) is not
 *   saved, and a replaced key stays the old one; a network failure or an
 *   unclear answer saves it with that result.
 * - No key value in any answer, log line or table.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { UpstreamClient, UpstreamFailure, UpstreamRequest } from '../../src/ports/upstream'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const FAKE_GOOD = 'fake-test-key-NOT-REAL-check-good-0123456789'
const FAKE_BAD = 'fake-test-key-NOT-REAL-check-bad-9876543210'
const FAKE_NEW = 'fake-test-key-NOT-REAL-check-new-5555555555'
const CO = 'kc-co'
const ts = () => new Date().toISOString()
const owner = { companyId: CO, userId: 'kc-owner', role: 'owner' }
const alice = { companyId: CO, userId: 'kc-alice', role: 'member' }
const everyone = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any, services: any, off: any
let kekDir: string
const logs: string[] = []
const answers: string[] = []
const sent: Array<Omit<UpstreamRequest, 'signal' | 'body'> & { hasBody: boolean }> = []
/** What the fake provider answers: a status per key value, or a network failure. */
let reply: (req: UpstreamRequest) => number | UpstreamFailure = () => 200

const fakeUpstream: UpstreamClient = {
  async send(req) {
    sent.push({ host: req.host, method: req.method, path: req.path, headers: req.headers, allowPrivateHosts: req.allowPrivateHosts, headersTimeoutMs: req.headersTimeoutMs, hasBody: req.body !== null })
    const r = reply(req)
    if (typeof r === 'string') return { ok: false, reason: r }
    return {
      ok: true,
      // A provider that echoes the key in its body: the check never reads it.
      response: { status: r, headers: [], body: (async function* () { yield new TextEncoder().encode(JSON.stringify(req.headers)) })(), viaPrivateAddress: false },
    }
  },
}
const keyIn = (req: UpstreamRequest) => Object.values(req.headers).join(' ')
const byKey = (statusForBad: number) => (req: UpstreamRequest) => (keyIn(req).includes(FAKE_BAD) ? statusForBad : 200)

async function keep<T>(p: Promise<T> | T): Promise<T> {
  const v = await p
  answers.push(JSON.stringify(v))
  return v
}

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-kc-kek-'))
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
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'kc-owner', ts(), ts())
  for (const [u, r] of [['kc-owner', 'owner'], ['kc-alice', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { upstream: fakeUpstream, keyCheck: true })
  off = createServices(db, undefined, { upstream: fakeUpstream, keyCheck: false })
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('checking a key when it is saved', () => {
  it('Gemini: one GET /v1beta/models to the built-in host, no body, the key only in x-goog-api-key; valid → saved', async () => {
    reply = () => 200
    sent.length = 0
    const r = await keep(services.keyBroker.create(owner, { service: 'gemini', displayName: 'G', secret: FAKE_GOOD, audience: everyone }))
    expect(r.ok).toBe(true)
    expect(r.value.check).toEqual({ service: 'gemini', result: 'valid' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ host: 'generativelanguage.googleapis.com', method: 'GET', path: '/v1beta/models', hasBody: false })
    expect(Object.entries(sent[0].headers).filter(([, v]) => v.includes(FAKE_GOOD))).toEqual([['x-goog-api-key', FAKE_GOOD]])
    expect(r.value.history[0]).toMatchObject({ change: { action: 'create', check: 'valid' } })
  })

  it('a key the service refuses is not saved; a replaced key stays the old one', async () => {
    reply = byKey(400) // Gemini's answer to an invalid key
    const before = db.prepare('SELECT COUNT(*) AS n FROM broker_keys').get().n
    const bad = await keep(services.keyBroker.create(owner, { service: 'gemini', displayName: 'G2', secret: FAKE_BAD, audience: everyone }))
    expect(bad).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'KEY_REJECTED' } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM broker_keys').get().n).toBe(before)

    const id = db.prepare("SELECT id FROM broker_keys WHERE display_name = 'G'").get().id
    const historyBefore = db.prepare('SELECT COUNT(*) AS n FROM broker_history').get().n
    expect(await keep(services.keyBroker.replaceSecret(owner, id, { secret: FAKE_BAD }))).toMatchObject({ ok: false, body: { code: 'KEY_REJECTED' } })
    expect(await services.brokerVault.reveal(CO, id)).toBe(FAKE_GOOD)
    expect(db.prepare('SELECT COUNT(*) AS n FROM broker_history').get().n).toBe(historyBefore)
  })

  it('a network failure or an unclear answer saves the key with that result', async () => {
    const id = db.prepare("SELECT id FROM broker_keys WHERE display_name = 'G'").get().id
    reply = () => 'timeout'
    const r = await keep(services.keyBroker.replaceSecret(owner, id, { secret: FAKE_NEW }))
    expect(r.value.check).toEqual({ service: 'gemini', result: 'unreachable' })
    expect(await services.brokerVault.reveal(CO, id)).toBe(FAKE_NEW)
    // OpenAI 403 (a restricted key may not list models): saved, "could not tell".
    reply = () => 403
    const o = await keep(services.keyBroker.create(owner, { service: 'openai', displayName: 'O', secret: FAKE_GOOD, audience: everyone }))
    expect(o.value.check).toEqual({ service: 'openai', result: 'unconfirmed' })
    expect(sent.at(-1)).toMatchObject({ host: 'api.openai.com', path: '/v1/models' })
    expect(sent.at(-1)!.headers.authorization).toBe(`Bearer ${FAKE_GOOD}`)
  })

  it('HubSpot: GET the dated deals list on api.hubapi.com, Bearer only; 401 not saved, 403 (missing scopes) saved as "limited"', async () => {
    reply = byKey(401)
    const before = db.prepare("SELECT COUNT(*) AS n FROM broker_keys WHERE service = 'hubspot'").get().n
    expect(await keep(services.keyBroker.create(owner, { service: 'hubspot', displayName: 'H', secret: FAKE_BAD, audience: everyone })))
      .toMatchObject({ ok: false, body: { code: 'KEY_REJECTED' } })
    expect(db.prepare("SELECT COUNT(*) AS n FROM broker_keys WHERE service = 'hubspot'").get().n).toBe(before)
    expect(sent.at(-1)).toMatchObject({ host: 'api.hubapi.com', method: 'GET', path: '/crm/objects/2026-03/deals', hasBody: false })
    expect(Object.entries(sent.at(-1)!.headers).filter(([, v]) => v.includes(FAKE_BAD))).toEqual([['authorization', `Bearer ${FAKE_BAD}`]])

    reply = () => 403
    const limited = await keep(services.keyBroker.create(owner, { service: 'hubspot', displayName: 'H', secret: FAKE_GOOD, audience: everyone }))
    expect(limited.value.check).toEqual({ service: 'hubspot', result: 'limited' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM broker_keys WHERE service = 'hubspot'").get().n).toBe(before + 1)
  })

  it('a key that may not go to the built-in host is not sent there: refused on create, not checkable when an older one is replaced', async () => {
    reply = () => 200
    const before = sent.length
    const r = await keep(services.keyBroker.create(owner, {
      service: 'openai', displayName: 'O-proxy', secret: FAKE_GOOD, audience: everyone,
      destinations: { hosts: ['openai-proxy.example.com'], pathPrefixes: [], models: [] },
    }))
    expect(r).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'HOSTS_NOT_FOR_SERVICE' } })
    expect(sent.length).toBe(before)
    // A key saved before the server refused other hosts: replacing its value sends nothing there.
    const saved = await keep(services.keyBroker.create(owner, { service: 'openai', displayName: 'O-old', secret: FAKE_GOOD, audience: everyone }))
    expect(saved.ok).toBe(true)
    const id = db.prepare("SELECT id FROM broker_keys WHERE display_name = 'O-old'").get().id
    db.prepare('UPDATE broker_keys SET destinations = ? WHERE id = ?').run(JSON.stringify({ hosts: ['openai-proxy.example.com'], pathPrefixes: [], models: [] }), id)
    const sentBefore = sent.length
    const replaced = await keep(services.keyBroker.replaceSecret(owner, id, { secret: FAKE_GOOD }))
    expect(replaced.value.check).toEqual({ service: 'openai', result: 'not-checkable' })
    expect(sent.length).toBe(sentBefore)
  })

  it('own keys: Anthropic GET /v1/models with anthropic-version; a refused key is not registered', async () => {
    services.keyBroker.setOwnKeys(owner, 'anthropic', { allowed: true })
    reply = byKey(401)
    const bad = await keep(services.ownBrokerKeys.save(alice, 'anthropic', { secret: FAKE_BAD }))
    expect(bad).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'KEY_REJECTED' } })
    expect(db.prepare("SELECT COUNT(*) AS n FROM broker_keys WHERE owner_user_id = 'kc-alice'").get().n).toBe(0)
    const good = await keep(services.ownBrokerKeys.save(alice, 'anthropic', { secret: FAKE_GOOD }))
    expect(good.value.check).toEqual({ service: 'anthropic', result: 'valid' })
    expect(sent.at(-1)).toMatchObject({ host: 'api.anthropic.com', method: 'GET', path: '/v1/models', hasBody: false })
    expect(sent.at(-1)!.headers).toMatchObject({ 'x-api-key': FAKE_GOOD, 'anthropic-version': '2023-06-01' })
  })

  it('generic services: without a check path nothing is sent; with one, GET under the fixed host and base path, key in its header', async () => {
    reply = byKey(403)
    expect(services.keyBroker.setRelayService(owner, 'crm', { label: 'CRM', baseUrl: 'https://crm.example.com/v2', header: 'authorization', format: 'Token token={key}' }).ok).toBe(true)
    const before = sent.length
    const none = await keep(services.keyBroker.create(owner, { service: 'crm', displayName: 'C', secret: FAKE_GOOD, audience: everyone }))
    expect(none.value.check).toEqual({ service: 'crm', result: 'not-checkable' })
    expect(sent.length).toBe(before)

    expect(services.keyBroker.setRelayService(owner, 'crm', { label: 'CRM', baseUrl: 'https://crm.example.com/v2', header: 'authorization', format: 'Token token={key}', checkPath: '/me' }).ok).toBe(true)
    const ok = await keep(services.keyBroker.create(owner, { service: 'crm', displayName: 'C2', secret: FAKE_GOOD, audience: everyone }))
    expect(ok.value.check).toEqual({ service: 'crm', result: 'valid' })
    expect(sent.at(-1)).toMatchObject({ host: 'crm.example.com', method: 'GET', path: '/v2/me', hasBody: false })
    expect(sent.at(-1)!.headers.authorization).toBe(`Token token=${FAKE_GOOD}`)
    expect(await keep(services.keyBroker.create(owner, { service: 'crm', displayName: 'C3', secret: FAKE_BAD, audience: everyone })))
      .toMatchObject({ ok: false, body: { code: 'KEY_REJECTED' } })
    // A check path that would leave the base path or carry a query is refused.
    for (const checkPath of ['/me?x=1', '/../admin', 'me', '/a//b', '/%2e%2e']) {
      expect(services.keyBroker.setRelayService(owner, 'crm', { label: 'CRM', baseUrl: 'https://crm.example.com/v2', header: 'authorization', format: 'Token token={key}', checkPath }).ok, checkPath).toBe(false)
    }
  })

  it('with checking off (BROKER_KEY_CHECK=off) nothing is sent and the answer says nothing about validity', async () => {
    const before = sent.length
    const r = await keep(off.keyBroker.create(owner, { service: 'gemini', displayName: 'G-off', secret: FAKE_GOOD, audience: everyone }))
    expect(r.ok).toBe(true)
    expect(r.value.check).toBeUndefined()
    expect(sent.length).toBe(before)
  })

  it('no key value in any answer, log line or table', async () => {
    expect(answers.length).toBeGreaterThan(10)
    const leaks = (texts: string[]) => texts.filter(t => [FAKE_GOOD, FAKE_BAD, FAKE_NEW, 'NOT-REAL'].some(v => t.includes(v)))
    expect(leaks(answers)).toEqual([])
    expect(leaks(logs)).toEqual([])
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    expect(leaks(tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())))).toEqual([])
    expect(logs.some(l => l.includes('[broker] key check gemini: timeout'))).toBe(true)
  })
})

describe('the "needs a key" marker', () => {
  it('names only a valid service, and the app finds each service once', async () => {
    const { brokerNoKeyMessage, findBrokerNoKeyServices } = await import('../../shared/core/key-broker')
    const m = brokerNoKeyMessage('Google Gemini', 'gemini')
    expect(m).toContain('[ACB_NO_KEY:gemini]')
    expect(brokerNoKeyMessage('x', 'Bad Name]')).not.toContain('ACB_NO_KEY')
    const printed = `Error code: 403 - {'error': {'message': '${m}'}}\n${m}\n${brokerNoKeyMessage('CRM', 'crm')}`
    expect(findBrokerNoKeyServices(printed)).toEqual(['gemini', 'crm'])
    expect(findBrokerNoKeyServices('[ACB_NO_KEY:Gemini] [ACB_NO_KEY:] ACB_NO_KEY:gemini')).toEqual([])
  })
})
