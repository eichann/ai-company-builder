/**
 * A contract-3 connector's reads, end to end against the fake portal behind the
 * practice redirect (`.claude/rules/plugins.md` "Contract 3").
 *
 * Guards (each mutation-checked):
 * - a field nobody declared is never handed on, it is counted;
 * - a role is required for reads and for the AI: the AI passes only if its member
 *   holds it, and a call without `ai` is a person's; a refusal asks nothing outside;
 * - every read names its actor, on GET too; an address only from the member's own
 *   active Google grant; the key only in its header;
 * - one line in the access log per read, holding plain ids only: never an answer, a
 *   search word or a key; append-only, kept a year;
 * - outside text is wrapped on the server and flagged;
 * - the relay is closed for the service, reads too, and it gets no read scope;
 * - a business plugin of calls alone runs without a mapping.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakePortal, PORTAL_SCOPES, type FakePortal } from '../fakes/portal/fake-portal'
import { PORTAL_SEED } from '../fakes/portal/seed'
import { PLUGIN_FIXTURES } from '../helpers/plugin-packages'
import { citeLink } from '../../../shared/core/plugins'
import { createPluginConnector } from '../../src/services/plugin-connector'

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
const KEY = 'pat-fake-NOT-REAL-portal-calls-0123456789'
const CO = 'pc-co'
const HOST = 'portal.sample.example'
const ts = () => new Date().toISOString()
const owner = { companyId: CO, userId: 'pc-owner', role: 'owner' }
const holder = { companyId: CO, userId: 'pc-holder', role: 'member' }
const plain = { companyId: CO, userId: 'pc-plain', role: 'member' }
const HUMAN = { kind: 'human' as const }
const AI = { kind: 'ai' as const, source: 'claude-code', conversationId: 'conv-pc', runId: null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any, companyData: any
let fake: FakePortal
let server: ServerType
let kekDir: string, shelfDir: string

const read = (member: Json, actor: Json, call: string, body: Json = {}) => services.pluginCalls.read(member, actor, 'sample-portal-care', call, body)
const diagnose = (member: Json = holder, actor: Json = HUMAN, id: string = PORTAL_SEED.member) => read(member, actor, 'diagnose', { input: { id } })
const logRows = () => db.prepare('SELECT * FROM plugin_access_log WHERE company_id = ? ORDER BY rowid').all(CO) as Json[]
const asked = () => fake.requests().filter(r => !r.path.endsWith('/account'))
async function call(opts: { user?: string; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res: Response = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}

beforeAll(async () => {
  fake = createFakePortal({ environment: 'staging', accountId: 'sample-account' })
  fake.addKey(KEY, Object.values(PORTAL_SCOPES))
  server = serve({ fetch: fake.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-pc-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-pc-shelf-'))
  cpSync(join(PLUGIN_FIXTURES, 'sample-portal'), join(shelfDir, 'sample-portal@1.0.0'), { recursive: true })
  cpSync(join(PLUGIN_FIXTURES, 'sample-portal-care'), join(shelfDir, 'sample-portal-care@0.1.0'), { recursive: true })
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, ACB_ALLOW_FAKE_UPSTREAMS: '1',
    ACB_FAKE_PORTAL_URL: `http://127.0.0.1:${port}`, ACB_FAKE_PORTAL_HOST: HOST, ACB_FAKE_PORTAL_SERVICE: 'sample-portal',
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  companyData = (await import('../../src/adapters/sqlite/company-data')).sqliteCompanyData(db)
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/plugins')).pluginsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/records-ai', (await import('../../src/routes/records-ai')).recordsAiRoute)
  const loaded = await services.pluginShelf.load()
  expect(loaded.loaded, JSON.stringify(loaded.refused)).toContain('sample-portal@1.0.0')

  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'pc-owner', ts(), ts())
  ensureCompanyScope(db, CO)
  for (const [u, r] of [['pc-owner', 'owner'], ['pc-holder', 'member'], ['pc-plain', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(CO, ts(), 'x')
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const created = await services.keyBroker.create(owner, { service: 'sample-portal', displayName: 'ポータル', secret: KEY, audience, destinations: { hosts: [HOST], pathPrefixes: [], models: [] } })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const installed = await services.plugins.install(owner, 'sample-portal', { version: '1.0.0', keyId: created.value.keys[0].id })
  expect(installed.ok, JSON.stringify(installed)).toBe(true)
  expect((await services.plugins.install(owner, 'sample-portal-care', { version: '0.1.0', keyId: null })).ok).toBe(true)
  const on = await services.plugins.setEnabled(owner, 'sample-portal', { enabled: true })
  expect(on.ok, JSON.stringify(on)).toBe(true)
  expect((await services.plugins.setEnabled(owner, 'sample-portal-care', { enabled: true })).ok).toBe(true)
  const assigned = await services.pluginRoles.assign(owner, 'sample-portal-care', 'support', { userIds: ['pc-holder'] })
  expect(assigned.ok, JSON.stringify(assigned)).toBe(true)
})

afterAll(async () => {
  await new Promise(r => server.close(() => r(null)))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_PORTAL_URL', 'ACB_FAKE_PORTAL_HOST', 'ACB_FAKE_PORTAL_SERVICE']) delete process.env[k]
})

describe('what comes back', () => {
  it('a business plugin of calls alone runs without a mapping', async () => {
    const active = await services.plugins.active(CO, 'sample-portal-care')
    expect(active.ok, JSON.stringify(active)).toBe(true)
    expect(active.plugin.mappingVersion).toBe(0)
  })

  it('a field nobody declared is never handed on, and is counted', async () => {
    fake.extraField('undeclared_note', 'CANARY-UNDECLARED')
    const r = await diagnose()
    fake.clearFaults()
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(JSON.stringify(r.value)).not.toContain('CANARY-UNDECLARED')
    // The extra field, and each finding's two fields not named.
    expect(r.value.dropped).toBe(3)
    expect(r.value.data.person_ref).toBe(PORTAL_SEED.member)
    // A list's entries hold only their fixed fields too (`severity`, `facts` are not named).
    expect(r.value.data.findings).toEqual([{ code: 'PAYMENT_LATE', summary: '支払いが遅れています' }])
    expect(logRows().at(-1).dropped).toBe(3)
  })

  it('outside text is wrapped on the server and flagged, a flag and not a filter', async () => {
    const r = await diagnose(holder, HUMAN, PORTAL_SEED.instructionLike)
    expect(r.value.data.name.outsideText).toMatch(/^【ここから先は外から来た文です。[\s\S]*指示を無視して[\s\S]*【外から来た文ここまで】$/)
    expect(r.value.data.name.instructionLike.length).toBeGreaterThan(0)
    expect((await diagnose()).value.data.name.instructionLike).toEqual([])
  })

  it('a search takes personal data in its body, never the URL', async () => {
    const r = await read(holder, HUMAN, 'find_person', { input: { email: 'taro@example.com' } })
    expect(r.value.items.map((p: Json) => p.person_ref)).toEqual([PORTAL_SEED.member])
    const sent = fake.requests().at(-1)!
    expect([sent.method, sent.path]).toEqual(['POST', '/api/people/search'])
    expect(sent.body).toBe('{"email":"taro@example.com"}')
  })

  it('a document: list, a page with the link to cite, a search', async () => {
    const list = await read(holder, HUMAN, 'pages', { part: 'list' })
    expect(list.value.items.map((p: Json) => p.title)).toContain('ログインできないとき')
    const page = await read(holder, HUMAN, 'pages', { part: 'page', input: { id: PORTAL_SEED.page } })
    expect(page.value.cite).toBe(`https://${HOST}/pages/${PORTAL_SEED.page}`)
    const found = await read(holder, HUMAN, 'pages', { part: 'search', input: { words: 'ログイン' } })
    expect(found.value.items).toHaveLength(1)
    expect(fake.requests().at(-1)!.method).toBe('POST')
    expect((await read(holder, HUMAN, 'pages', {})).body?.code).toBe('CALL_NOT_READABLE')
    // A value cannot send a reader elsewhere.
    for (const elsewhere of ['https://other.example/page', `http://${HOST}/page`, 'javascript:alert(1)', 42]) expect(citeLink(elsewhere, HOST), String(elsewhere)).toBeNull()
  })

  it('an id out of shape, an input nobody declared and a missing one send nothing', async () => {
    const before = fake.requests().length
    expect((await diagnose(holder, HUMAN, '../admin')).body.code).toBe('CALL_INPUT_INVALID')
    expect((await diagnose(holder, HUMAN, 'a:b')).body.code).toBe('CALL_INPUT_INVALID')
    expect((await read(holder, HUMAN, 'diagnose', { input: {} })).body.code).toBe('CALL_INPUT_INVALID')
    expect((await read(holder, HUMAN, 'diagnose', { input: { id: PORTAL_SEED.member, extra: 'x' } })).body.code).toBe('CALL_INPUT_INVALID')
    expect(fake.requests().length).toBe(before)
  })

  it('an act is not read here', async () => {
    const before = fake.requests().length
    expect((await read(holder, HUMAN, 'resend', { input: { person_ref: 'x' } })).body.code).toBe('CALL_NOT_READABLE')
    expect(fake.requests().length).toBe(before)
  })

  it('a failure says its core class, from the declared table first, and shows nothing', async () => {
    const r = await read(holder, HUMAN, 'mail', { input: { id: 'person-9999' } })
    expect(r.value).toMatchObject({ outcome: 'failed', failure: 'bad-input', code: 'NOT_FOUND', data: null })
    fake.addKey(KEY, [PORTAL_SCOPES.read])
    const scoped = await read(holder, HUMAN, 'mail', { input: { id: PORTAL_SEED.member, include_body: 1 } })
    fake.addKey(KEY, Object.values(PORTAL_SCOPES))
    expect(scoped.value).toMatchObject({ outcome: 'failed', failure: 'permission', code: 'SCOPE_REQUIRED' })
    // The table beats the status: a 409 alone would read as bad input.
    fake.failNext({ status: 409, code: 'STATE_CHANGED' })
    expect((await diagnose()).value).toMatchObject({ outcome: 'failed', failure: 'unknown-result', code: 'STATE_CHANGED' })
  })

  it('a 429 is waited out: the read is asked again and logged once', async () => {
    const rows = logRows().length
    fake.failNext({ status: 429, retryAfter: 0 })
    expect((await diagnose()).value.outcome).toBe('ok')
    expect(logRows().length).toBe(rows + 1)
  })
})

describe('who may read', () => {
  it('a role is required, for a person and for their AI; a refusal asks nothing outside', async () => {
    const before = fake.requests().length
    for (const actor of [HUMAN, AI]) expect((await diagnose(plain, actor)).body?.code, actor.kind).toBe('NOT_ALLOWED')
    // An owner is no holder: `who` names the role only.
    expect((await diagnose(owner, HUMAN)).body?.code).toBe('NOT_ALLOWED')
    expect(fake.requests().length).toBe(before)
    expect((await diagnose(holder, AI)).ok).toBe(true)
  })

  it('a call without `ai` is a person\'s, whoever holds the role', async () => {
    const before = fake.requests().length
    expect((await read(holder, AI, 'mail', { input: { id: PORTAL_SEED.member } })).body?.code).toBe('NOT_ALLOWED')
    expect(fake.requests().length).toBe(before)
    const r = await read(holder, HUMAN, 'mail', { input: { id: PORTAL_SEED.member, include_body: 1 } })
    expect(r.value.data.mails[0].body.outsideText).toContain('様')
  })

  it('the AI stop, the company switch and the operator stop each end it from the next read', async () => {
    const before = fake.requests().length
    const stop = vi.spyOn(services.agentStops, 'companyStopped').mockReturnValue(true)
    expect((await diagnose(holder, AI)).body?.code).toBe('ACB_STOPPED')
    stop.mockRestore()
    await services.plugins.setEnabled(owner, 'sample-portal-care', { enabled: false })
    expect((await diagnose()).body?.code).toBe('PLUGIN_NOT_ACTIVE')
    await services.plugins.setEnabled(owner, 'sample-portal-care', { enabled: true })
    writeFileSync(join(shelfDir, 'stopped'), 'sample-portal\n')
    expect((await diagnose()).body).toMatchObject({ code: 'PLUGIN_NOT_ACTIVE', problem: 'connector-stopped' })
    rmSync(join(shelfDir, 'stopped'))
    expect(fake.requests().length).toBe(before)
  })

  it("a step's run: only with plugin_operations, and only its own plugin's", async () => {
    const at = ts()
    const insert = (id: string, step: string) => companyData.forCompany(CO).aiRuns.insert({
      id, recordId: 'task-none', step, userId: holder.userId, state: 'running', generation: 1, deviceId: 'device-pc-0001', conversationId: `conv-${id}`,
      claimExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), failureClass: null, failureCode: null, retryAt: null, attempts: 0, pluginVersion: null, stepsVersion: null, procedure: null, createdAt: at, updatedAt: at, closedAt: null,
    })
    db.pragma('foreign_keys = OFF')
    insert('pc-run-other', 'sample-other__work')
    insert('pc-run-core', 'minutes-reading')
    db.pragma('foreign_keys = ON')
    const before = fake.requests().length
    expect((await diagnose(holder, { ...AI, runId: 'pc-run-other' })).body?.code).toBe('NOT_IN_STEP')
    expect((await diagnose(holder, { ...AI, runId: 'pc-run-none' })).body?.code).toBe('NOT_IN_STEP')
    expect(fake.requests().length).toBe(before)
    expect((await diagnose(holder, { ...AI, runId: 'pc-run-core' })).ok).toBe(true)
  })
})

describe('what the service is told', () => {
  it('every read names its actor, GET too, as acb_member_<id>; the account is asked as system', async () => {
    await diagnose()
    expect(asked().at(-1)).toMatchObject({ method: 'GET', path: `/api/people/${PORTAL_SEED.member}/diagnosis`, actor: 'acb_member_pc-holder' })
    expect(fake.requests().filter(r => r.path.endsWith('/account')).every(r => r.actor === 'system')).toBe(true)
  })

  it('binds the account and its environment on first sight, and refuses another', async () => {
    const repo = companyData.forCompany(CO).plugins
    expect(repo.install('sample-portal').accountId).toBe('sample-account.staging')
    const connectionId = repo.install('sample-portal').connectionId
    db.prepare("UPDATE plugin_installs SET account_id = 'other.production' WHERE company_id = ? AND plugin_id = 'sample-portal'").run(CO)
    // Within the five minutes a check stands, then past them.
    expect((await diagnose()).ok).toBe(true)
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 })
    const checkedAgain = await diagnose()
    vi.useRealTimers()
    expect(checkedAgain.body?.code).toBe('ACCOUNT_CHANGED')
    db.prepare("UPDATE plugin_installs SET account_id = 'sample-account.staging' WHERE company_id = ? AND plugin_id = 'sample-portal'").run(CO)
    expect(connectionId).toBe(repo.install('sample-portal').connectionId)
  })

  it('an address only from the member\'s own active Google grant', async () => {
    await diagnose()
    expect(asked().at(-1)!.email).toBeNull()
    const at = ts()
    db.pragma('foreign_keys = OFF')
    db.prepare("INSERT INTO connector_grants (company_id, user_id, provider, grant_id, account_email, scopes, status, created_at, updated_at) VALUES (?, ?, 'google', 'g1', 'holder@example.com', '[]', 'active', ?, ?)").run(CO, holder.userId, at, at)
    db.pragma('foreign_keys = ON')
    await diagnose()
    expect(asked().at(-1)!.email).toBe('holder@example.com')
    db.prepare("UPDATE connector_grants SET status = 'revoked' WHERE company_id = ? AND user_id = ?").run(CO, holder.userId)
    await diagnose()
    expect(asked().at(-1)!.email).toBeNull()
  })

  it('the key goes only in its header, and is nowhere else', async () => {
    await diagnose()
    const sent = fake.requests().at(-1)!
    expect(sent.authorization).toBe(`Bearer ${KEY}`)
    expect(`${sent.path}${sent.body}${sent.actor}${sent.email}`).not.toContain(KEY)
    expect(JSON.stringify(logRows())).not.toContain(KEY)
    expect(JSON.stringify((await diagnose()).value)).not.toContain(KEY)
  })
})

describe('the access log', () => {
  it('one line per read: who, which ids, how it went; never an answer or a search word', async () => {
    const rows = logRows().length
    await diagnose(holder, AI)
    await read(holder, HUMAN, 'find_person', { input: { email: 'taro@example.com' } })
    const [ai, human] = logRows().slice(rows)
    expect(logRows().length).toBe(rows + 2)
    expect(ai).toMatchObject({ call: 'diagnose', user_id: 'pc-holder', actor_kind: 'ai', conversation_id: 'conv-pc', status: 'ok', refs: JSON.stringify({ id: PORTAL_SEED.member }) })
    expect(human).toMatchObject({ call: 'find_person', actor_kind: 'human', refs: '{}' })
    const everything = JSON.stringify(logRows())
    for (const secret of ['taro@example.com', '見本 太郎', '支払いが遅れています']) expect(everything).not.toContain(secret)
  })

  it('a refused read is no read: no line', async () => {
    const rows = logRows().length
    await diagnose(plain)
    expect(logRows().length).toBe(rows)
  })

  it('nothing of an answer reaches a record, a ledger or an operation row', async () => {
    await diagnose()
    for (const table of ['plugin_operations', 'record_ledger']) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      if (exists) expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain('見本 太郎')
    }
  })

  it('is append-only, and rows go after a year', async () => {
    expect(() => db.prepare("UPDATE plugin_access_log SET status = 'x'").run()).toThrow(/append-only/)
    const old = new Date(Date.now() - 366 * 86_400_000).toISOString()
    db.prepare("INSERT INTO plugin_access_log (id, company_id, plugin_id, call, user_id, actor_kind, refs, status, at) VALUES ('old-row', ?, 'sample-portal-care', 'diagnose', 'x', 'human', '{}', 'ok', ?)").run(CO, old)
    const kept = new Date(Date.now() - 300 * 86_400_000).toISOString()
    db.prepare("INSERT INTO plugin_access_log (id, company_id, plugin_id, call, user_id, actor_kind, refs, status, at) VALUES ('kept-row', ?, 'sample-portal-care', 'diagnose', 'x', 'human', '{}', 'ok', ?)").run(CO, kept)
    await diagnose()
    const ids = logRows().map(r => r.id)
    expect(ids).not.toContain('old-row')
    expect(ids).toContain('kept-row')
  })

  it('an AI\'s read also goes to the AI action log', async () => {
    const spy = vi.spyOn(services.agentEvents, 'recordServerEvent')
    await diagnose(holder, AI)
    await diagnose(holder, HUMAN)
    expect(spy.mock.calls.filter(c => String((c[2] as Json).tool).startsWith('plugin-call:'))).toHaveLength(1)
    spy.mockRestore()
  })

  it('owners and admins read it; members do not', async () => {
    const r = await call({ user: 'pc-owner', method: 'GET', path: `/api/companies/${CO}/plugins/sample-portal-care/access-log` })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.entries[0]).toMatchObject({ userId: expect.any(String), call: expect.any(String), status: expect.any(String) })
    expect((await call({ user: 'pc-holder', method: 'GET', path: `/api/companies/${CO}/plugins/sample-portal-care/access-log` })).status).toBe(403)
  })
})

describe('the relay', () => {
  it('is closed for the service, reads too, whoever asks, even for someone named in a read scope', async () => {
    const repo = companyData.forCompany(CO).plugins
    const connectionId = repo.install('sample-portal').connectionId
    repo.setReadScope('sample-portal', connectionId, [{ type: 'user', id: 'pc-holder' }], ts(), 'pc-owner', { id: 'h-scope', pluginId: 'sample-portal', action: 'read-scope', at: ts(), by: 'pc-owner', change: '{}' })
    for (const u of ['pc-owner', 'pc-holder']) expect(services.plugins.relayPolicy(CO, u, 'sample-portal')).toMatchObject({ mayRead: false, searchPaths: [] })
    repo.setReadScope('sample-portal', connectionId, [], ts(), 'pc-owner', { id: 'h-scope-2', pluginId: 'sample-portal', action: 'read-scope', at: ts(), by: 'pc-owner', change: '{}' })
  })

  it('no read scope is seeded and none was needed to turn it on', () => {
    const repo = companyData.forCompany(CO).plugins
    expect(repo.readScope('sample-portal', repo.install('sample-portal').connectionId)).toEqual([])
  })

  it('the service cannot be registered as a generic relay service (K9)', () => {
    const r = services.keyBroker.setRelayService(owner, 'sample-portal', { label: 'x', baseUrl: `https://${HOST}/api`, header: 'authorization', format: 'Bearer {key}' })
    expect(r).toMatchObject({ ok: false, body: { code: 'SERVICE_CLOSED_TO_RELAY' } })
  })
})

describe('over HTTP', () => {
  it('the AI route: a read token is enough, the tools list the calls with `ai`', async () => {
    currentUser.id = holder.userId
    const t = await call({ user: holder.userId, method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId: 'conv-http', agent: 'codex', scope: 'read' } })
    expect(t.status, JSON.stringify(t.body)).toBe(201)
    const token = t.body.data.token
    const tools = await call({ token, method: 'GET', path: '/api/records-ai/plugins' })
    const calls = tools.body.data.plugins[0].calls
    expect(calls.map((c: Json) => c.part ? `${c.name}.${c.part}` : c.name).sort()).toEqual(['diagnose', 'find_person', 'pages.list', 'pages.page', 'pages.search'])
    expect(tools.body.data.plugins[0].operations).toEqual([])
    const r = await call({ token, method: 'POST', path: '/api/records-ai/plugins/sample-portal-care/calls/diagnose', body: { input: { id: PORTAL_SEED.member } } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.outcome).toBe('ok')
  })

  it('the tools list only what this member\'s AI may call', async () => {
    const tools = async (user: string) => {
      const t = await call({ user, method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId: `conv-${user}`, agent: 'codex', scope: 'read' } })
      return (await call({ token: t.body.data.token, method: 'GET', path: '/api/records-ai/plugins' })).body.data.plugins
    }
    // No role: nothing to list. An admin: only `pages`, which names `admin`.
    expect(await tools('pc-plain')).toEqual([])
    expect((await tools('pc-owner'))[0].calls.map((c: Json) => c.name)).toEqual(['pages', 'pages', 'pages'])
  })

  it('the session route: `who` decides', async () => {
    const path = `/api/companies/${CO}/plugins/sample-portal-care/calls/diagnose`
    expect((await call({ user: 'pc-holder', method: 'POST', path, body: { input: { id: PORTAL_SEED.member } } })).status).toBe(200)
    expect((await call({ user: 'pc-plain', method: 'POST', path, body: { input: { id: PORTAL_SEED.member } } })).status).toBe(403)
  })
})

describe('the connector\'s own checks, whatever its caller did', () => {
  const plugin: Json = {
    connectorId: 'c', connectionId: 'n', keyId: 'k',
    manifest: { baseUrl: { host: HOST, basePath: '/api' }, calling: { auth: { header: 'Authorization', format: 'bearer' }, actor: { memberHeader: 'X-ACB-Actor', emailHeader: null }, limits: { perMinute: 1 } } },
  }
  const world = () => {
    const sent: Json[] = []
    let now = 1_000_000
    const connector = createPluginConnector({
      upstream: { send: async (r: Json) => { sent.push(r); return { ok: true, response: { status: 200, headers: [], viaPrivateAddress: false, body: (async function* () { yield new TextEncoder().encode('{}') })() } } } } as Json,
      reveal: async () => KEY, credential: () => null, sleep: async (ms: number) => { now += ms }, nowMs: () => now,
    })
    return { connector, sent }
  }
  const go = async () => null
  const actor = { member: 'acb_member_1', email: null }

  it('fills {id} only with a plain id, and sends nothing else', async () => {
    const { connector, sent } = world()
    for (const id of ['../x', 'a:b', 'a/b', undefined]) {
      expect(await connector.callDeclared('c', plugin, { method: 'GET', path: '/p/{id}', ...(id ? { id } : {}), actor }, go), String(id)).toMatchObject({ ok: false, reason: 'undeclared-call' })
    }
    expect(await connector.callDeclared('c', plugin, { method: 'GET', path: '/p', id: 'x', actor }, go)).toMatchObject({ ok: false, reason: 'undeclared-call' })
    expect(await connector.callDeclared('c', plugin, { method: 'GET', path: '/p', actor: { member: 'a b', email: null } }, go)).toMatchObject({ ok: false, reason: 'bad-actor' })
    expect(sent).toEqual([])
  })

  it('keeps to the declared pace: a wait longer than a read may is not sent', async () => {
    const { connector, sent } = world()
    expect((await connector.callDeclared('c', plugin, { method: 'GET', path: '/p', actor }, go)).ok).toBe(true)
    expect(await connector.callDeclared('c', plugin, { method: 'GET', path: '/p', actor }, go)).toMatchObject({ ok: false, kind: 'rate-limited' })
    expect(sent).toHaveLength(1)
    expect(sent[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(Object.entries(sent[0].headers).filter(([, v]) => String(v).includes(KEY)).map(([k]) => k)).toEqual(['authorization'])
  })
})
