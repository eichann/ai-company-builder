/**
 * Integration Test: the Google relay with the member's own permission (「本人の許可で中継する」,
 * owner decision 2026-11-04, `.claude/rules/google-connector.md` "The relay"), end to end: a
 * script's `ACB_GOOGLE_*` call → the key broker's relay → the one Google client with the member's
 * own grant → the fake Google's Sheets (practice redirect).
 *
 * What it protects:
 * - a deletion (values clear / batchClear, a batchUpdate with any delete or clear request) and a
 *   request kind not on the allow-list are refused before anything leaves ACB, and the sheet is
 *   untouched;
 * - a member without the sheets permission, with it turned off, with the company's service off,
 *   stopped (company-wide or this member) or over the daily cap is refused before anything leaves;
 * - the token's member is the only identity: another member's token acts with that member's own
 *   permission (Google refuses what they cannot edit), another company never reaches a grant here;
 * - one record per call (who, which spreadsheet and range, the result) visible to admins and to the
 *   member themself (their own lines only) — never a cell's content, a token or a Google token;
 * - the relay is asked only when the member chooses it (never in the one consent), offered only once
 *   the company turned it on; the name `google` cannot hold a key.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeGoogle, type FakeGoogle } from '../fakes/google/fake-google'
import { GOOGLE_SEED } from '../fakes/google/seed'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const EMAILS: Record<string, string> = {
  'r-owner': 'owner@div.example',
  'r-sato': GOOGLE_SEED.member,
  'r-tanaka': GOOGLE_SEED.colleague,
  'r-other-owner': 'boss@other.example',
  'r-other-member': GOOGLE_SEED.member,
}
const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@x`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.filter(id => EMAILS[id]).map(id => [id, { email: EMAILS[id], name: `Name ${id}` }]))),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const CO = 'gr-co'
const OTHER = 'gr-other'
const PUBLIC = 'http://localhost:13002'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-relayclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-relay-0123456789'
const OTHER_CLIENT_ID = '210987654321-relayother.apps.googleusercontent.com'
const OTHER_SECRET = 'fake-google-secret-NOT-REAL-relayother-987654'
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const PRACTICE = GOOGLE_SEED.practiceSheet
const READ_ONLY = GOOGLE_SEED.readOnlySheet
/** A cell value the relay writes: it must never show up in a record, a table or a log line. */
const CELL = 'RELAY-CELL-CONTENT-一意の値-7d1f'
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let fake: FakeGoogle
let server: ServerType
let kekDir: string, shelfDir: string
const logLines: string[] = []
const answers: string[] = []
const tokens: string[] = []

async function call(user: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json; text: string }> {
  currentUser.id = user
  const res: Response = await app.request(`${PUBLIC}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  answers.push(text)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body: json, text }
}
const C = (co = CO) => `/api/companies/${co}`

/** A script's call through the relay: `$ACB_GOOGLE_BASE_URL/sheets/…` with `Authorization: Bearer $ACB_GOOGLE_API_KEY`. */
async function script(token: string, method: string, sheetsPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  currentUser.id = null
  const res: Response = await app.request(`${PUBLIC}/api/broker/google/sheets${sheetsPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  answers.push(text)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* empty */ }
  return { status: res.status, body: json }
}
const values = (id: string, range: string, suffix = '') => `/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}${suffix}`

async function tokenFor(user: string, co = CO): Promise<{ token: string | null; services: string[] }> {
  const r = await call(user, 'POST', `${C(co)}/me/broker-tokens`, { conversationId: `conv-${user}` })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  if (r.body.data.token) tokens.push(r.body.data.token)
  return { token: r.body.data.token, services: r.body.data.services.map((s: Json) => s.service) }
}

/** 「Google で許可」 all the way for these features, signing in at the fake as `email`. */
async function allow(user: string, features: string[], email: string, co = CO) {
  fake.signIn({ email })
  const r = await call(user, 'POST', `${C(co)}/me/google/connect`, { features })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  const url = new URL(r.body.data.authorizeUrl)
  const res = await fetch(url, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  const page = await call(null, 'GET', `/api/oauth/google/callback${back.search}`)
  expect(page.status).toBe(200)
  return url
}

const sent = () => fake.requests.length
const rows = (id = PRACTICE, sheet = 0) => fake.spreadsheet(id)!.sheets[sheet].rows

beforeAll(async () => {
  fake = createFakeGoogle()
  fake.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  fake.addClient({ clientId: OTHER_CLIENT_ID, clientSecret: OTHER_SECRET, redirectUris: [REDIRECT] })
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-gr-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-gr-shelf-'))
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, PUBLIC_URL: PUBLIC,
    ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${port}`,
  })
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logLines.push(args.map(String).join(' ')) })
  }
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  const { requestLog } = await import('../../src/lib/request-log')
  const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
  app = new Hono()
  app.use('*', requestLog())
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/key-broker')).keyBrokerRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)
  app.route('/api/broker', brokerRelayRoutes(services.brokerRelay))

  for (const [co, owner] of [[CO, 'r-owner'], [OTHER, 'r-other-owner']]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, owner, ts(), ts())
  }
  for (const [u, co, role] of [['r-owner', CO, 'owner'], ['r-sato', CO, 'member'], ['r-tanaka', CO, 'member'],
    ['r-other-owner', OTHER, 'owner'], ['r-other-member', OTHER, 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, co, role, ts(), ts())
  }
  expect((await call('r-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
})

afterAll(async () => {
  fake.close()
  await new Promise(r => server.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL']) delete process.env[k]
})

describe('Google relay: who turns it on and who allows it', () => {
  it('is off until an owner/admin turns スプレッドシート on; members cannot; the name google holds no key', async () => {
    const view = await call('r-owner', 'GET', `${C()}/google/relay`)
    expect(view.body.data).toMatchObject({ available: true, services: [{ service: 'sheets', on: false }], capPerMemberPerDay: 500, stopped: false, members: [] })
    expect((await call('r-sato', 'GET', `${C()}/google/relay`)).status).toBe(403)
    expect((await call('r-sato', 'PUT', `${C()}/google/relay`, { services: { sheets: true } })).status).toBe(403)
    expect((await call('r-owner', 'PUT', `${C()}/google/relay`, { services: { drive: true } })).status).toBe(400)
    expect((await call('r-owner', 'PUT', `${C()}/google/relay`, { capPerMemberPerDay: 0 })).status).toBe(400)
    // Not offered yet: no ACB_GOOGLE_* for scripts, and the member cannot ask for it.
    expect((await tokenFor('r-sato')).services).not.toContain('google')
    expect((await call('r-sato', 'POST', `${C()}/me/google/connect`, { features: ['sheets'] })).body.code).toBe('GOOGLE_FEATURE_COMPANY_OFF')
    // A key for "google" would shadow the person relay: refused.
    const key = await call('r-owner', 'POST', `${C()}/broker/keys`, { service: 'google', displayName: 'x', secret: 'fake-test-key-NOT-REAL-0000' })
    expect(key.status).toBe(400)
    expect(key.body.code).toBe('SERVICE_RESERVED')

    const on = await call('r-owner', 'PUT', `${C()}/google/relay`, { services: { sheets: true } })
    expect(on.body.data.services).toEqual([{ service: 'sheets', on: true }])
  })

  it('is asked only when the member chooses it: never in the one consent, by name only', async () => {
    const all = await call('r-sato', 'POST', `${C()}/me/google/connect`, { all: true })
    expect(all.body.data.authorizeUrl).not.toContain('spreadsheets')
    expect((await call('r-sato', 'GET', `${C()}/me/google`)).body.data.companyFeatures).not.toContain('sheets')
    const url = await allow('r-sato', ['sheets'], GOOGLE_SEED.member)
    expect(url.searchParams.get('scope')).toContain(SHEETS_SCOPE)
    const mine = (await call('r-sato', 'GET', `${C()}/me/google/relay`)).body.data
    expect(mine).toMatchObject({ available: true, services: [{ service: 'sheets', offered: true, allowed: true, turnedOff: false }], stopped: null, capPerDay: 500 })
  })
})

describe('Google relay: a script reads and writes with the member\'s own permission', () => {
  it('reads and appends a row on a sheet the member edits; the token covers google once offered', async () => {
    const { token, services: covered } = await tokenFor('r-sato')
    expect(covered).toContain('google')
    const read = await script(token!, 'GET', values(PRACTICE, "'案件'!A1:E3"))
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.values[1]).toEqual(['A-0001', '株式会社サンプル', '佐藤', 'B', '0.5'])
    const meta = await script(token!, 'GET', `/v4/spreadsheets/${PRACTICE}?fields=sheets.properties`)
    expect(meta.status).toBe(200)
    expect(meta.body.sheets.map((s: Json) => s.properties.title)).toEqual(['案件', '係数'])
    const before = rows().length
    const append = await script(token!, 'POST', `${values(PRACTICE, '案件!A:E', ':append')}?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: [['A-0099', CELL, '佐藤', 'C', '0.2']] })
    expect(append.status, JSON.stringify(append.body)).toBe(200)
    expect(rows().length).toBe(before + 1)
    expect(rows().at(-1)).toEqual(['A-0099', CELL, '佐藤', 'C', '0.2'])
    const batch = await script(token!, 'POST', `/v4/spreadsheets/${PRACTICE}:batchUpdate`, { requests: [{ insertDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, inheritFromBefore: false } }] })
    expect(batch.status, JSON.stringify(batch.body)).toBe(200)
  })

  it('Google refuses a sheet the member may only read; the answer says Google refused', async () => {
    const { token } = await tokenFor('r-sato')
    expect((await script(token!, 'GET', values(READ_ONLY, '予算!A1:B2'))).status).toBe(200)
    const write = await script(token!, 'PUT', `${values(READ_ONLY, '予算!B2')}?valueInputOption=RAW`, { values: [['999']] })
    expect(write.status).toBe(403)
    expect(write.body.error.message).toContain('Google が断りました')
    expect(rows(READ_ONLY)[1]).toEqual(['営業部', '1000'])
  })
})

describe('Google relay: never a deletion, never an unlisted call — refused before anything leaves ACB', () => {
  const cases: Array<[string, string, string, unknown?]> = [
    ['values:clear', 'POST', values(PRACTICE, '案件!A1:E5', ':clear'), {}],
    ['values:batchClear', 'POST', `/v4/spreadsheets/${PRACTICE}/values:batchClear`, { ranges: ['案件!A1:E5'] }],
    ['values:batchClearByDataFilter', 'POST', `/v4/spreadsheets/${PRACTICE}/values:batchClearByDataFilter`, { dataFilters: [] }],
    ['deleteSheet', 'POST', `/v4/spreadsheets/${PRACTICE}:batchUpdate`, { requests: [{ deleteSheet: { sheetId: 0 } }] }],
    ['a delete hidden after an allowed request', 'POST', `/v4/spreadsheets/${PRACTICE}:batchUpdate`, {
      requests: [{ insertDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: 1, endIndex: 2 } } }, { deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: 0, endIndex: 3 } } }],
    }],
    ['deleteRange', 'POST', `/v4/spreadsheets/${PRACTICE}:batchUpdate`, { requests: [{ deleteRange: { range: { sheetId: 0 }, shiftDimension: 'ROWS' } }] }],
    ['an unlisted kind (sortRange)', 'POST', `/v4/spreadsheets/${PRACTICE}:batchUpdate`, { requests: [{ sortRange: { range: { sheetId: 0 } } }] }],
    ['two kinds in one request', 'POST', `/v4/spreadsheets/${PRACTICE}:batchUpdate`, { requests: [{ insertDimension: {}, deleteSheet: { sheetId: 0 } }] }],
    ['a new spreadsheet', 'POST', '/v4/spreadsheets', { properties: { title: 'x' } }],
    ['another API', 'GET', '/v4/spreadsheets/../../drive/v3/files'],
  ]
  for (const [name, method, path, body] of cases) {
    it(`refuses ${name}`, async () => {
      const { token } = await tokenFor('r-sato')
      const before = sent()
      const sheet = JSON.stringify(fake.spreadsheet(PRACTICE))
      const r = await script(token!, method, path, body)
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.status).not.toBe(200)
      expect(sent()).toBe(before)
      expect(JSON.stringify(fake.spreadsheet(PRACTICE))).toBe(sheet)
    })
  }

  it('says a deletion is not passed, and files it as one', async () => {
    const { token } = await tokenFor('r-sato')
    const r = await script(token!, 'POST', `/v4/spreadsheets/${PRACTICE}:batchUpdate`, { requests: [{ deleteSheet: { sheetId: 0 } }] })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('ACB_DELETE_REFUSED')
    const latest = (await call('r-owner', 'GET', `${C()}/google/relay`)).body.data.records[0]
    expect(latest).toMatchObject({ userId: 'r-sato', operation: 'spreadsheets.batchUpdate', spreadsheetId: PRACTICE, result: 'refused', reason: 'deletion' })
  })

  it('refuses a query parameter it does not know (an access_token would act as someone else)', async () => {
    const { token } = await tokenFor('r-sato')
    const before = sent()
    const r = await script(token!, 'GET', `${values(PRACTICE, '案件!A1')}?access_token=ya29.fake-someone-else`)
    expect(r.status).toBe(400)
    expect(sent()).toBe(before)
  })
})

describe('Google relay: every switch refuses before anything leaves ACB', () => {
  it('a member without the sheets permission (none, or another feature only)', async () => {
    const { token } = await tokenFor('r-tanaka')
    const before = sent()
    const r = await script(token!, 'GET', values(PRACTICE, '案件!A1'))
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('ACB_GOOGLE_NOT_ALLOWED')
    expect(sent()).toBe(before)
  })

  it('the member turned it off (「やめる」), and on again', async () => {
    const { token } = await tokenFor('r-sato')
    expect((await call('r-sato', 'PUT', `${C()}/me/google/features`, { feature: 'sheets', on: false })).status).toBe(200)
    expect((await call('r-sato', 'GET', `${C()}/me/google/relay`)).body.data.services[0]).toMatchObject({ allowed: false, turnedOff: true })
    const before = sent()
    expect((await script(token!, 'GET', values(PRACTICE, '案件!A1'))).body.error.code).toBe('ACB_GOOGLE_NOT_ALLOWED')
    expect(sent()).toBe(before)
    expect((await call('r-sato', 'PUT', `${C()}/me/google/features`, { feature: 'sheets', on: true })).status).toBe(200)
    expect((await script(token!, 'GET', values(PRACTICE, '案件!A1'))).status).toBe(200)
  })

  it('the company turned スプレッドシート off: refused, and no longer in new tokens', async () => {
    const { token } = await tokenFor('r-sato')
    expect((await call('r-owner', 'PUT', `${C()}/google/relay`, { services: { sheets: false } })).status).toBe(200)
    const before = sent()
    expect((await script(token!, 'GET', values(PRACTICE, '案件!A1'))).body.error.code).toBe('ACB_GOOGLE_OFF')
    expect(sent()).toBe(before)
    expect((await tokenFor('r-sato')).services).not.toContain('google')
    expect((await call('r-owner', 'PUT', `${C()}/google/relay`, { services: { sheets: true } })).status).toBe(200)
    expect((await script(token!, 'GET', values(PRACTICE, '案件!A1'))).status).toBe(200)
  })

  it('the company\'s Google off', async () => {
    const { token } = await tokenFor('r-sato')
    expect((await call('r-owner', 'PUT', `${C()}/google/enabled`, { enabled: false })).status).toBe(200)
    const before = sent()
    expect((await script(token!, 'GET', values(PRACTICE, '案件!A1'))).status).toBe(403)
    expect(sent()).toBe(before)
    expect((await call('r-owner', 'PUT', `${C()}/google/enabled`, { enabled: true })).status).toBe(200)
  })

  it('the company-wide stop and one member\'s stop; resuming works', async () => {
    const { token } = await tokenFor('r-sato')
    expect((await call('r-owner', 'PUT', `${C()}/google/relay`, { stopped: true })).body.data.stopped).toBe(true)
    let before = sent()
    expect((await script(token!, 'GET', values(PRACTICE, '案件!A1'))).body.error.code).toBe('ACB_STOPPED')
    expect((await call('r-sato', 'GET', `${C()}/me/google/relay`)).body.data.stopped).toBe('company')
    expect(sent()).toBe(before)
    expect((await call('r-owner', 'PUT', `${C()}/google/relay`, { stopped: false })).status).toBe(200)

    const stopped = await call('r-owner', 'PUT', `${C()}/google/relay/members/r-sato`, { stopped: true })
    expect(stopped.body.data.members.find((m: Json) => m.userId === 'r-sato')).toMatchObject({ stopped: true, allowed: true })
    before = sent()
    expect((await script(token!, 'GET', values(PRACTICE, '案件!A1'))).body.error.code).toBe('ACB_STOPPED')
    expect((await call('r-sato', 'GET', `${C()}/me/google/relay`)).body.data.stopped).toBe('member')
    expect(sent()).toBe(before)
    expect((await call('r-sato', 'PUT', `${C()}/google/relay/members/r-sato`, { stopped: false })).status).toBe(403)
    expect((await call('r-owner', 'PUT', `${C()}/google/relay/members/r-sato`, { stopped: false })).status).toBe(200)
    expect((await script(token!, 'GET', values(PRACTICE, '案件!A1'))).status).toBe(200)
    // Another company's member answers exactly like an unknown one.
    const cross = await call('r-owner', 'PUT', `${C()}/google/relay/members/r-other-member`, { stopped: true })
    const unknown = await call('r-owner', 'PUT', `${C()}/google/relay/members/nobody`, { stopped: true })
    expect([cross.status, cross.body]).toEqual([unknown.status, unknown.body])
    expect(cross.status).toBe(404)
  })

  it('over the member\'s daily cap', async () => {
    const { token } = await tokenFor('r-sato')
    const used = (await call('r-sato', 'GET', `${C()}/me/google/relay`)).body.data.usedToday
    expect(used).toBeGreaterThan(0)
    expect((await call('r-owner', 'PUT', `${C()}/google/relay`, { capPerMemberPerDay: used + 1 })).status).toBe(200)
    expect((await script(token!, 'GET', values(PRACTICE, '案件!A1'))).status).toBe(200)
    const before = sent()
    const over = await script(token!, 'GET', values(PRACTICE, '案件!A1'))
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe('ACB_OVER_CAP')
    expect(sent()).toBe(before)
    expect((await call('r-owner', 'PUT', `${C()}/google/relay`, { capPerMemberPerDay: 500 })).status).toBe(200)
  })
})

describe('Google relay: the token\'s member is the only identity', () => {
  it('another member\'s token acts with that member\'s own permission (Google refuses what they cannot edit)', async () => {
    await allow('r-tanaka', ['sheets'], GOOGLE_SEED.colleague)
    const { token } = await tokenFor('r-tanaka')
    // Tanaka owns the budget: his own permission reads and writes it.
    expect((await script(token!, 'PUT', `${values(READ_ONLY, '予算!B2')}?valueInputOption=RAW`, { values: [['1200']] })).status).toBe(200)
    // Sato's coefficient table is not his: Google refuses, whatever the request claims.
    const r = await script(token!, 'POST', `${values(PRACTICE, '案件!A:E', ':append')}?valueInputOption=RAW`, { values: [['X']] }, { 'x-acb-user': 'r-sato', 'x-goog-user-project': 'r-sato' })
    expect(r.status).toBe(403)
    expect(rows().some(row => row[0] === 'X')).toBe(false)
  })

  it('another company never reaches a grant here', async () => {
    expect((await call('r-other-owner', 'PUT', `${C(OTHER)}/google/client`, { clientId: OTHER_CLIENT_ID, clientSecret: OTHER_SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
    expect((await call('r-other-owner', 'PUT', `${C(OTHER)}/google/relay`, { services: { sheets: true } })).status).toBe(200)
    // The other company's member has the same Google email as Sato, but no grant there.
    const { token } = await tokenFor('r-other-member', OTHER)
    const before = sent()
    const r = await script(token!, 'GET', values(PRACTICE, '案件!A1'))
    expect(r.body.error.code).toBe('ACB_GOOGLE_NOT_ALLOWED')
    expect(sent()).toBe(before)
    // Nothing of it in this company's records, nothing of this company's in theirs.
    expect((await call('r-owner', 'GET', `${C()}/google/relay`)).body.data.records.some((x: Json) => x.userId === 'r-other-member')).toBe(false)
    expect((await call('r-other-owner', 'GET', `${C(OTHER)}/google/relay`)).body.data.records.every((x: Json) => x.userId === 'r-other-member')).toBe(true)
  })
})

describe('Google relay: records', () => {
  it('admins see everyone\'s lines; a member sees only their own', async () => {
    const admin = (await call('r-owner', 'GET', `${C()}/google/relay`)).body.data
    expect(admin.members.map((m: Json) => m.userId).sort()).toEqual(['r-sato', 'r-tanaka'])
    expect(admin.members.find((m: Json) => m.userId === 'r-sato').usedToday).toBeGreaterThan(0)
    const append = admin.records.find((x: Json) => x.operation === 'values.append' && x.userId === 'r-sato')
    expect(append).toMatchObject({ spreadsheetId: PRACTICE, range: '案件!A:E', result: 'ok', status: 200, memberName: 'Name r-sato' })
    expect(admin.records.some((x: Json) => x.userId === 'r-tanaka')).toBe(true)
    expect(admin.records.some((x: Json) => x.result === 'google-refused')).toBe(true)
    const mine = (await call('r-tanaka', 'GET', `${C()}/me/google/relay`)).body.data.records
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((x: Json) => x.userId === 'r-tanaka')).toBe(true)
  })

  it('no cell content, broker token or Google token in any record, table, answer or log line', async () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    const dump = tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
    expect(dump).not.toContain(CELL)
    expect(dump).not.toContain('株式会社サンプル')
    expect(dump).not.toContain('ya29.fake-')
    const logs = logLines.join('\n')
    expect(logs).not.toContain(CELL)
    expect(logs).not.toContain('ya29.fake-')
    for (const t of tokens) {
      expect(dump).not.toContain(t)
      expect(logs).not.toContain(t)
    }
    expect(answers.filter(a => a.includes('ya29.fake-') || a.includes('1//fake-'))).toEqual([])
    const events = JSON.stringify(db.prepare("SELECT * FROM agent_events WHERE tool = 'broker:google'").all())
    expect(events).toContain('values.append')
    expect(events).not.toContain(CELL)
  })
})
