/**
 * Integration Test: which company key a service uses (「このサービスは、この鍵を使う」,
 * owner decision 2026-11-01, `.claude/rules/key-broker.md` "Which company key").
 * Staging had two active HubSpot company keys and the relay took the first
 * registered; outside a plugin's connection, the admin now chooses.
 *
 * - Only owners / admins choose (`PUT …/broker/services/:service/default-key`);
 *   only an active company key of this company and service can be chosen.
 * - Several company keys the member may use and none chosen → no key
 *   (`key-not-chosen`, the relay asks for the admin), never the first registered.
 * - The chosen key is the one sent upstream; a chosen key stopped or deleted is
 *   no longer chosen — another key is never picked silently.
 * - One company's choice does nothing to another company.
 * - No answer or table holds a key value.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const CO = 'kc-co'
const OTHER = 'kc-other'
const SECRET_A = 'fake-test-key-NOT-REAL-choice-AAAA-0123456789'
const SECRET_B = 'fake-test-key-NOT-REAL-choice-BBBB-0123456789'
const SECRET_O1 = 'fake-test-key-NOT-REAL-choice-other1-012345'
const SECRET_O2 = 'fake-test-key-NOT-REAL-choice-other2-012345'
const ts = () => new Date().toISOString()
const everyone = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any, services: any, app: any, relayApp: any
let kekDir: string
let keyA: string, keyB: string, otherKey1: string, otherKey2: string
const owner = { companyId: CO, userId: 'kc-owner', role: 'owner' }
const member = { companyId: CO, userId: 'kc-member', role: 'member' }
const otherOwner = { companyId: OTHER, userId: 'kc-other-owner', role: 'owner' }
const otherMember = { companyId: OTHER, userId: 'kc-other-member', role: 'member' }
const seen: string[] = []
/** The key each upstream call carried. */
const sent: string[] = []
const fakeUpstream = {
  async send(req: { headers: Record<string, string>; body: AsyncIterable<Uint8Array> | null }) {
    if (req.body) for await (const chunk of req.body) void chunk
    sent.push(req.headers['x-goog-api-key'])
    return { ok: true as const, response: { status: 200, headers: [['content-type', 'application/json']] as Array<[string, string]>, body: (async function* () { yield new TextEncoder().encode('{}') })(), viaPrivateAddress: false } }
  },
}

async function choose(user: string, companyId: string, keyId: string | null, service = 'gemini') {
  currentUser.id = user
  const res = await app.request(`/api/companies/${companyId}/broker/services/${service}/default-key`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyId }),
  })
  const text = await res.text()
  seen.push(text)
  return { status: res.status, json: JSON.parse(text) as Json }
}

const tokenOf = (m: typeof member) => services.brokerTokens.issue(m, { conversationId: 'c-1', services: ['gemini'] }).value.token as string
const chosenIn = (companyId: string) => services.keyBroker.get({ companyId, userId: 'x', role: 'owner' }).value.services.find((s: Json) => s.service === 'gemini').defaultKeyId

async function relay(token: string) {
  const before = sent.length
  const res = await relayApp.request('http://acb.test/api/broker/gemini/v1beta/models', { headers: { 'x-goog-api-key': token } })
  const json = await res.json().catch(() => null)
  return { status: res.status, code: json?.error?.code as string | undefined, message: json?.error?.message as string | undefined, key: sent.length > before ? sent.at(-1) : null }
}

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-kc-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  for (const co of [CO, OTHER]) db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'x', ts(), ts())
  for (const m of [owner, member, otherOwner, otherMember, { companyId: CO, userId: 'kc-admin', role: 'admin' }]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${m.userId}`, m.userId, m.companyId, m.role, ts(), ts())
  }

  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { upstream: fakeUpstream })
  const { Hono } = await import('hono')
  // The admin route runs on the app's own composition (same database).
  const { keyBrokerRoute } = await import('../../src/routes/key-broker')
  app = new Hono().route('/api/companies/:companyId', keyBrokerRoute)
  const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
  relayApp = new Hono().route('/api/broker', brokerRelayRoutes(services.brokerRelay))

  keyA = (await services.keyBroker.create(owner, { service: 'gemini', displayName: 'Gemini A', secret: SECRET_A, audience: everyone })).value.keys[0].id
  keyB = (await services.keyBroker.create(owner, { service: 'gemini', displayName: 'Gemini B', secret: SECRET_B, audience: everyone })).value.keys
    .find((k: Json) => k.id !== keyA).id
  otherKey1 = (await services.keyBroker.create(otherOwner, { service: 'gemini', displayName: 'Other 1', secret: SECRET_O1, audience: everyone })).value.keys[0].id
  otherKey2 = (await services.keyBroker.create(otherOwner, { service: 'gemini', displayName: 'Other 2', secret: SECRET_O2, audience: everyone })).value.keys
    .find((k: Json) => k.id !== otherKey1).id
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('which company key a service uses', () => {
  it('only owners and admins choose; a member cannot', async () => {
    expect((await choose('kc-member', CO, keyB)).status).toBe(403)
    expect(chosenIn(CO)).toBeNull()
    expect((await choose('kc-admin', CO, keyB)).status).toBe(200)
    expect((await choose('kc-owner', CO, null)).json.data.services.find((s: Json) => s.service === 'gemini').defaultKeyId).toBeNull()
  })

  it('only an active company key of this company and this service can be chosen', async () => {
    // Another company's key: the same 404 as a key that does not exist.
    expect((await choose('kc-owner', CO, otherKey1)).status).toBe(404)
    expect((await choose('kc-owner', CO, 'no-such-key')).status).toBe(404)
    // This company's key, but for another service.
    expect((await choose('kc-owner', CO, keyA, 'openai')).status).toBe(404)
    // A stopped key.
    services.keyBroker.update(owner, keyA, { status: 'disabled' })
    expect((await choose('kc-owner', CO, keyA)).json).toMatchObject({ code: 'KEY_STOPPED' })
    services.keyBroker.update(owner, keyA, { status: 'active' })
    expect((await choose('kc-owner', CO, { id: keyA } as unknown as string)).status).toBe(400)
    expect(chosenIn(CO)).toBeNull()
  })

  it('with several keys and none chosen, no key is used and the AI is told to ask the admin — never the first registered', async () => {
    const token = tokenOf(member)
    expect(services.brokerTokens.validate(token, 'gemini')).toMatchObject({ ok: false, reason: 'key-not-chosen' })
    const answer = await relay(token)
    expect(answer).toMatchObject({ status: 403, code: 'ACB_KEY_NOT_CHOSEN', key: null })
    expect(answer.message).toContain('管理者')
    expect(answer.message).not.toContain('[ACB_NO_KEY:')
  })

  it('the chosen key is the one sent upstream', async () => {
    const token = tokenOf(member)
    await choose('kc-owner', CO, keyB)
    expect(await relay(token)).toMatchObject({ status: 200, key: SECRET_B })
    await choose('kc-owner', CO, keyA)
    expect(await relay(token)).toMatchObject({ status: 200, key: SECRET_A })
  })

  it('a stopped or deleted chosen key is no longer chosen: the admin is asked again, no other key is picked', async () => {
    const token = tokenOf(member)
    await choose('kc-owner', CO, keyA)
    services.keyBroker.update(owner, keyA, { status: 'disabled' })
    expect(chosenIn(CO)).toBeNull()
    expect(await relay(token)).toMatchObject({ status: 403, code: 'ACB_KEY_NOT_CHOSEN', key: null })
    // Resuming does not bring the choice back by itself.
    services.keyBroker.update(owner, keyA, { status: 'active' })
    expect(chosenIn(CO)).toBeNull()
    expect(await relay(token)).toMatchObject({ code: 'ACB_KEY_NOT_CHOSEN', key: null })
    const history = services.keyBroker.get(owner).value.history
    expect(history.find((h: Json) => h.change.action === 'default-key' && h.change.because === 'stopped').change)
      .toMatchObject({ service: 'gemini', before: { keyId: keyA, displayName: 'Gemini A' }, after: null })

    // Every key stopped (the emergency stop): "stopped", not "not chosen".
    await choose('kc-owner', CO, keyB)
    services.keyBroker.stopAll(owner)
    expect(chosenIn(CO)).toBeNull()
    expect(await relay(token)).toMatchObject({ status: 403, code: 'ACB_STOPPED', key: null })
    services.keyBroker.update(owner, keyA, { status: 'active' })
    services.keyBroker.update(owner, keyB, { status: 'active' })

    // Deleted: one key left, nothing to choose between — that one.
    await choose('kc-owner', CO, keyB)
    services.keyBroker.delete(owner, keyB)
    expect(chosenIn(CO)).toBeNull()
    expect(await relay(token)).toMatchObject({ status: 200, key: SECRET_A })
  })

  it('one company\'s choice does nothing to another company', async () => {
    const token = tokenOf(otherMember)
    expect(await relay(token)).toMatchObject({ code: 'ACB_KEY_NOT_CHOSEN', key: null })
    // The other company's owner cannot choose this company's key for theirs either.
    expect((await choose('kc-other-owner', OTHER, keyA)).status).toBe(404)
    // Nor reach this company's setting.
    expect((await choose('kc-other-owner', CO, keyA)).status).toBe(404)
    expect((await choose('kc-other-owner', OTHER, otherKey2)).status).toBe(200)
    expect(await relay(token)).toMatchObject({ status: 200, key: SECRET_O2 })
    expect(chosenIn(CO)).toBeNull()
  })

  it('no answer or table holds a key value', () => {
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(t => t.name)
    const dump = tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
    for (const secret of [SECRET_A, SECRET_B, SECRET_O1, SECRET_O2]) {
      expect(seen.join('\n')).not.toContain(secret)
      expect(dump).not.toContain(secret)
    }
  })
})
