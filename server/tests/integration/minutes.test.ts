/**
 * Integration Test: the minutes intake (milestone 4 G7, `.claude/rules/minutes.md`), end to end
 * against the fake Google and the fake HubSpot the way staging runs them (the practice redirect:
 * ACB_ALLOW_FAKE_UPSTREAMS=1 + ACB_FAKE_GOOGLE_URL / ACB_FAKE_HUBSPOT_URL), with real routes,
 * services, database, key broker, Google permissions and an imported HubSpot.
 *
 * What it protects (each mutation-checked):
 * - an internal-only meeting is never read: no record, not even its Meet record is looked up;
 * - the same conference found by two members is one record, and the organizer is its assignee;
 * - the minutes' text is in no table, log line or answer except the text route itself;
 * - the text route answers only the assignee or an attendee, and another company's record is the
 *   same 404 as a missing one;
 * - the minutes folder: owner/admin only; a private folder (or one inside it) is refused with the
 *   same words as any other wrong place, never naming it;
 * - exactly one open deal candidate is linked; two are not (a person / the AI chooses);
 * - Google stopped (the company switch) or no permission → nothing is read; records off → 404.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeGoogle, type FakeGoogle } from '../fakes/google/fake-google'
import { defaultGoogleSeed, GOOGLE_SEED } from '../fakes/google/seed'
import { createFakeHubSpot, ALL_FAKE_SCOPES, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 })

const EMAILS: Record<string, { email: string; name: string }> = {
  'mn-owner': { email: 'owner@div.example', name: '阿部 部長' },
  'mn-sato': { email: GOOGLE_SEED.member, name: '佐藤 健' },
  'mn-tanaka': { email: GOOGLE_SEED.colleague, name: '田中 誠' },
  'mn-yamada': { email: 'yamada@div.example', name: '山田 葵' },
  'mn-other-owner': { email: 'boss@other.example', name: '他社 社長' },
}
const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@x`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.filter(id => EMAILS[id]).map(id => [id, EMAILS[id]]))),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const PUBLIC = 'http://localhost:13002'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-minutes.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-minutes-0123456789'
const HUBSPOT_KEY = 'pat-fake-NOT-REAL-minutes-0123456789'
const FIXTURE = join(__dirname, '../fixtures/plugins/sample-hub')
const ts = () => new Date().toISOString()

/** Lines of the minutes that must never be kept anywhere (notes, transcript, follow-up). */
const MINUTES_LINES = ['見積金額を120万円から150万円に改めることで合意した', 'その場合、お見積は150万円になります', '修正したお見積とカリキュラム案をご説明します', '金額を0にして']

const MAPPING = `
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
    max: 500
  fields:
    title:      { from: dealname, write: false }
    confidence: { from: juchu_kakudo, write: true, values: { high: a, medium: b, low: c } }
    next_step:  { from: hs_next_step, write: true }
    amount:     { from: amount, write: true }
  links:
    customer:   { from_association: companies }
company:
  visible_to_folder: 営業部
  fields:
    title:  { from: name, write: false }
    domain: { from: domain, write: false }
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let google: FakeGoogle, hubspot: FakeHubSpot
let googleServer: ServerType, hubspotServer: ServerType
let kekDir: string, shelfDir: string
let CO: string
const OTHER = 'mn-other'
const logLines: string[] = []
/** Every answer body except the text routes'. */
const answers: string[] = []

async function call(user: string | null, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: Json; text: string }> {
  currentUser.id = user
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res: Response = await app.request(`${PUBLIC}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  if (!/\/minutes\/(item\/)?[^/]+\/text$/.test(path)) answers.push(text)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body: json, text }
}
const C = (co = CO) => `/api/companies/${co}`
const check = (user: string) => call(user, 'POST', `${C()}/me/minutes/check`, {})
const textOf = (user: string, id: string, co = CO) => call(user, 'GET', `${C(co)}/me/minutes/item/${id}/text`)
const minutesRows = () => db.prepare("SELECT r.id, r.title, r.folder, s.state, s.fields FROM records r JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id WHERE r.company_id = ? AND r.type = 'minutes' ORDER BY r.created_at").all(CO) as Json[]
const linkOf = (id: string, name: string) => (db.prepare('SELECT target_id FROM record_links WHERE company_id = ? AND source_id = ? AND name = ?').get(CO, id, name) as Json)?.target_id ?? null
const dealIdOf = (title: string) => (db.prepare("SELECT id FROM records WHERE company_id = ? AND type = 'deal' AND title = ?").get(CO, title) as Json).id as string
/** The time the member's app asks at (the fake Google's meetings are on 2026-11-05 and 11-12). */
const at = (iso: string) => vi.setSystemTime(new Date(iso))

async function allow(user: string, email: string) {
  google.signIn({ email })
  const r = await call(user, 'POST', `${C()}/me/google/connect`, { features: ['minutes'] })
  expect(r.status, r.text).toBe(200)
  const res = await fetch(r.body.data.authorizeUrl, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const back = new URL(res.headers.get('location')!)
  const page = await call(null, 'GET', `/api/oauth/google/callback${back.search}`)
  expect(page.status, page.text).toBe(200)
}

async function tokenFor(user: string): Promise<string> {
  const r = await call(user, 'POST', `${C()}/me/record-tokens`, { conversationId: 'conv-minutes', agent: 'claude-code', scope: 'act' })
  expect(r.status, r.text).toBe(201)
  return r.body.data.token
}

function listen(fetchFn: (req: Request) => Response | Promise<Response>): Promise<ServerType> {
  return new Promise(resolve => {
    const s = serve({ fetch: fetchFn, port: 0, hostname: '127.0.0.1' }, () => resolve(s))
  })
}

beforeAll(async () => {
  // Tanaka is invited to the sales meeting too (the organizer is Sato), and may open its documents.
  const seed = defaultGoogleSeed()
  const sales = seed.events.find(e => e.id === GOOGLE_SEED.salesEvent)!
  sales.attendees.push({ email: GOOGLE_SEED.colleague, responseStatus: 'accepted' })
  seed.conferences.find(c => c.id === GOOGLE_SEED.salesConference)!.participants.push(GOOGLE_SEED.colleague)
  for (const d of seed.docs) if (d.id === GOOGLE_SEED.salesNotesDoc || d.id === GOOGLE_SEED.salesTranscriptDoc) d.readers.push(GOOGLE_SEED.colleague)
  google = createFakeGoogle({ seed })
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  hubspot = createFakeHubSpot()
  hubspot.addKey(HUBSPOT_KEY, ALL_FAKE_SCOPES)
  googleServer = await listen(google.app.fetch)
  hubspotServer = await listen(hubspot.app.fetch)

  kekDir = mkdtempSync(join(tmpdir(), 'acb-mn-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-mn-shelf-'))
  cpSync(FIXTURE, join(shelfDir, 'sample-hub@0.1.0'), { recursive: true })
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
    ACB_FAKE_HUBSPOT_URL: `http://127.0.0.1:${(hubspotServer.address() as AddressInfo).port}`,
  })
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logLines.push(args.map(String).join(' ')) })
  }
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  await services.pluginShelf.load()
  const { Hono } = await import('hono')
  const { requestLog } = await import('../../src/lib/request-log')
  app = new Hono()
  app.use('*', requestLog())
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/minutes')).minutesRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)
  app.route('/api/records-ai', (await import('../../src/routes/records-ai')).recordsAiRoute)

  const company = await services.companies.create('mn-owner', 'Minutes', 'minutes-co')
  CO = company.id
  for (const u of ['mn-sato', 'mn-tanaka', 'mn-yamada']) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, 'member', ts(), ts())
  }
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(OTHER, OTHER, OTHER, 'mn-other-owner', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-other', 'mn-other-owner', OTHER, 'owner', ts(), ts())

  const owner = { companyId: CO, userId: 'mn-owner', role: 'owner' }
  expect((await call('mn-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
  await allow('mn-sato', GOOGLE_SEED.member)
  await allow('mn-tanaka', GOOGLE_SEED.colleague)

  // HubSpot: deals and customers (with their domain) imported into the company map.
  expect((await call('mn-owner', 'PUT', `${C()}/records/settings`, { enabled: true })).status).toBe(200)
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: HUBSPOT_KEY, audience })).value.keys[0].id
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
  const saved = await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING, acknowledgeAuto: ['confidence', 'next_step'] })
  expect(saved.ok, JSON.stringify(saved)).toBe(true)
  const readers = await services.plugins.setReadScope(owner, 'sample-hub', { userIds: ['mn-sato', 'mn-tanaka', 'mn-yamada'] })
  expect(readers.ok, JSON.stringify(readers)).toBe(true)
  const enabled = await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })
  expect(enabled.ok, JSON.stringify(enabled)).toBe(true)
  const imported = await services.pluginImport.run(owner, 'sample-hub')
  expect(imported.ok, JSON.stringify(imported)).toBe(true)
  // The customer's domain came in with the import (the fixture's customer type v2, mapping `domain`).
  const customer = db.prepare("SELECT s.fields FROM records r JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id WHERE r.company_id = ? AND r.type = 'customer' AND r.title = '株式会社サンプル'").get(CO) as Json
  expect(JSON.parse(customer.fields).domain).toBe('a-corp.example')

  vi.useFakeTimers({ toFake: ['Date'] })
})

afterAll(async () => {
  vi.useRealTimers()
  google.close()
  hubspot.close()
  await new Promise(r => googleServer.close(r))
  await new Promise(r => hubspotServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL', 'ACB_FAKE_HUBSPOT_URL']) delete process.env[k]
})

describe('the minutes folder', () => {
  it('without a folder nothing is read, and the answer says why', async () => {
    at('2026-11-06T09:00:00+09:00')
    const before = google.requests.length
    const r = await check('mn-sato')
    expect(r.status, r.text).toBe(200)
    expect(r.body.data).toMatchObject({ checked: false, reason: 'no-folder', created: [] })
    expect(r.body.data.message).toContain('置き場所')
    expect(google.requests.length).toBe(before)
  })

  it('owner/admin only; a private folder or a place inside one is refused with the same words, never naming it', async () => {
    expect((await call('mn-sato', 'PUT', `${C()}/google/minutes-folder`, { folder: '営業部' })).status).toBe(403)
    // 人事部 becomes a private folder (its scope has its own repository); 営業部/極秘 is one inside 営業部.
    db.prepare("UPDATE scopes SET repo_id = 'mn-private-hr' WHERE company_id = ? AND path = '人事部'").run(CO)
    db.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('mn-s-secret', ?, '営業部/極秘', 'folder', 'mn-private-secret', ?)").run(CO, ts())
    const refusals = []
    for (const folder of ['人事部', '人事部/評価', '営業部/極秘', 'どこにもない部']) {
      const r = await call('mn-owner', 'PUT', `${C()}/google/minutes-folder`, { folder })
      expect(r.status).toBe(400)
      expect(r.text).not.toContain('人事部')
      expect(r.text).not.toContain('極秘')
      refusals.push(r.body)
    }
    expect(new Set(refusals.map(b => JSON.stringify(b))).size).toBe(1)
    expect(refusals[0].code).toBe('MINUTES_FOLDER_REFUSED')
    const got = await call('mn-owner', 'GET', `${C()}/google/minutes-folder`)
    expect(got.body.data.choices).toContain('営業部')
    expect(got.body.data.choices).not.toContain('人事部')
    expect(got.text).not.toContain('人事部')
    const set = await call('mn-owner', 'PUT', `${C()}/google/minutes-folder`, { folder: '営業部' })
    expect(set.status, set.text).toBe(200)
    expect(set.body.data.folder).toBe('営業部')
  })
})

let salesId: string

describe('discovery', () => {
  it('an internal-only meeting creates nothing and its Meet record is never looked up', async () => {
    at('2026-11-06T09:00:00+09:00')
    google.requests.length = 0
    const r = await check('mn-tanaka')
    expect(r.status, r.text).toBe(200)
    // Tanaka's calendar on 11/05: the internal 営業定例 and (invited) the sales meeting.
    expect(r.body.data).toMatchObject({ checked: true, internalOnly: 1, meetings: 1, existing: 0, waiting: 0 })
    expect(r.body.data.created).toHaveLength(1)
    salesId = r.body.data.created[0]
    const rows = minutesRows()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(GOOGLE_SEED.internalConference)
    expect(JSON.stringify(rows)).not.toContain(GOOGLE_SEED.internalNotesDoc)
    // Only one Meet search was made (the sales meeting's); the internal meeting's code never left ACB.
    expect(google.requests.filter(q => q.path === '/v2/conferenceRecords')).toHaveLength(1)
  })

  it('the same conference found by a second member is the same record; the organizer is its assignee', async () => {
    const r = await check('mn-sato')
    expect(r.status, r.text).toBe(200)
    expect(r.body.data).toMatchObject({ checked: true, internalOnly: 1, meetings: 1, existing: 1, created: [] })
    const rows = minutesRows()
    expect(rows).toHaveLength(1)
    const f = JSON.parse(rows[0].fields)
    // Tanaka found it first; Sato organized it.
    expect(f.assignee).toBe('mn-sato')
    expect(JSON.parse(f.attendees).sort()).toEqual(['mn-sato', 'mn-tanaka'])
    expect(f.external_count).toBe(2)
    expect(f.doc_version).toBe('notes:7,transcript:7')
    expect(rows[0]).toMatchObject({ state: 'received', folder: '営業部', title: '研修導入のご相談（株式会社サンプル）' })
  })

  it('two open deal candidates: nothing is linked; the text names both and a person chooses', async () => {
    expect(linkOf(salesId, 'deal')).toBeNull()
    const t = await textOf('mn-sato', salesId)
    expect(t.status, t.text).toBe(200)
    expect(t.body.data.deal).toBeNull()
    expect(t.body.data.candidates.map((c: Json) => c.title).sort()).toEqual(['生成AI研修 2期（株式会社サンプル）', '研修導入（株式会社サンプル）'])
    // Only the assignee or an admin chooses.
    const deal = dealIdOf('研修導入（株式会社サンプル）')
    expect((await call('mn-tanaka', 'POST', `${C()}/me/minutes/item/${salesId}/deal`, { dealId: deal })).status).toBe(403)
    const linked = await call('mn-sato', 'POST', `${C()}/me/minutes/item/${salesId}/deal`, { dealId: deal })
    expect(linked.status, linked.text).toBe(200)
    expect(linkOf(salesId, 'deal')).toBe(deal)
    expect(linkOf(salesId, 'customer')).toBeTruthy()
    const t2 = await textOf('mn-sato', salesId)
    expect(t2.body.data.deal).toMatchObject({ id: deal, title: '研修導入（株式会社サンプル）', fields: { amount: 1200000 } })
    expect(t2.body.data.candidates).toEqual([])
  })

  it('exactly one open deal candidate is linked (with its customer)', async () => {
    // The follow-up meeting is renamed so its title names one of the two deals.
    google.changeEvent(GOOGLE_SEED.followUpEvent, { summary: '研修導入（株式会社サンプル） 2回目' })
    at('2026-11-13T09:00:00+09:00')
    const r = await check('mn-sato')
    expect(r.status, r.text).toBe(200)
    expect(r.body.data.created).toHaveLength(1)
    const id = r.body.data.created[0]
    expect(linkOf(id, 'deal')).toBe(dealIdOf('研修導入（株式会社サンプル）'))
    expect(linkOf(id, 'customer')).toBeTruthy()
  })
})

describe('the text', () => {
  it('goes to the assignee and attendees, marked as outside text, with instruction-like lines flagged', async () => {
    const tanaka = await textOf('mn-tanaka', salesId)
    expect(tanaka.status, tanaka.text).toBe(200)
    const d = tanaka.body.data
    expect(d.header).toContain('外から来た文')
    expect(d.footer).toBe('【議事録ここまで】')
    // Where its decisions go: the minutes folder (a department folder, never a private one).
    expect(d.folder).toBe('営業部')
    expect(d.text.startsWith('■ 会議メモ\n会議メモ')).toBe(true)
    expect(d.text).not.toContain('\r')
    expect(d.text).not.toContain('\uFEFF')
    expect(d.text).toContain('■ 文字起こし')
    expect(d.attendees).toEqual(expect.arrayContaining([{ memberId: 'mn-sato', displayName: '佐藤 健' }]))
    expect(d.externalAttendees).toBe(2)
    expect(d.instructionLike).toEqual([])
    expect(tanaka.text).not.toContain(GOOGLE_SEED.customerSuzuki)

    // The AI reads it with its record token (tool minutes_read).
    const followUp = minutesRows().find(r => r.title.includes('2回目'))
    const token = await tokenFor('mn-sato')
    const ai = await call(null, 'GET', `/api/records-ai/minutes/${followUp.id}/text`, undefined, token)
    expect(ai.status, ai.text).toBe(200)
    expect(ai.body.data.instructionLike.map((f: Json) => f.label)).toContain('addressed-to-ai')
  })

  it('refuses a member who is neither assignee nor attendee, and another company\'s record is the same 404 as a missing one', async () => {
    const yamada = await textOf('mn-yamada', salesId)
    expect([yamada.status, yamada.body.code]).toEqual([403, 'MINUTES_NOT_YOURS'])
    expect(yamada.text).not.toContain('見積')
    // Another company's minutes record, asked for in this company's URL.
    db.prepare('INSERT INTO records (company_id, id, type, path, folder, title, summary, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)')
      .run(OTHER, 'minutes-other0000001', 'minutes', '他社の会議', '', ts(), ts())
    const other = await textOf('mn-sato', 'minutes-other0000001')
    const missing = await textOf('mn-sato', 'minutes-nosuch000001')
    expect(other.status).toBe(404)
    expect(other.body).toEqual(missing.body)
  })

  it('the minutes\' text is in no table, log line or other answer', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Json[]).map(t => t.name as string)
    const everything = JSON.stringify(tables.map(t => db.prepare(`SELECT * FROM "${t}"`).all()))
    const logs = logLines.join('\n')
    const said = answers.join('\n')
    for (const line of MINUTES_LINES) {
      expect(everything).not.toContain(line)
      expect(logs).not.toContain(line)
      expect(said).not.toContain(line)
    }
    // Meeting titles and attendees' addresses are not logged either.
    expect(logs).not.toContain('研修導入のご相談')
    expect(logs).not.toContain(GOOGLE_SEED.customerSuzuki)
  })
})

describe('stuck reading and the switches', () => {
  it('a record 「読んでいる」 for over 30 minutes is reported as stale to its assignee', async () => {
    const token = await tokenFor('mn-sato')
    const start = await call(null, 'POST', `/api/records-ai/item/${salesId}/actions/start_reading`, { expectedVersion: 2 }, token)
    expect(start.status, start.text).toBe(200)
    expect((await check('mn-sato')).body.data.stale).toEqual([])
    at('2026-11-13T09:31:00+09:00')
    expect((await check('mn-sato')).body.data.stale).toEqual([salesId])
    expect((await check('mn-tanaka')).body.data.stale).toEqual([])
  })

  it('Google stopped for the company: discovery and the text refuse from the next call; no permission → not connected', async () => {
    expect((await call('mn-owner', 'PUT', `${C()}/google/enabled`, { enabled: false })).status).toBe(200)
    const before = google.requests.length
    const c = await check('mn-sato')
    expect([c.status, c.body.code]).toEqual([403, 'GOOGLE_STOPPED'])
    const t = await textOf('mn-sato', salesId)
    expect([t.status, t.body.code]).toEqual([403, 'GOOGLE_STOPPED'])
    expect(google.requests.length).toBe(before)
    expect((await call('mn-owner', 'PUT', `${C()}/google/enabled`, { enabled: true })).status).toBe(200)
    // Yamada never allowed Google.
    const y = await check('mn-yamada')
    expect([y.status, y.body.code]).toEqual([409, 'GOOGLE_NOT_CONNECTED'])
  })

  it('the records switch off: 404 RECORDS_DISABLED', async () => {
    expect((await call('mn-owner', 'PUT', `${C()}/records/settings`, { enabled: false })).status).toBe(200)
    const c = await check('mn-sato')
    expect([c.status, c.body.code]).toEqual([404, 'RECORDS_DISABLED'])
    const t = await textOf('mn-sato', salesId)
    expect([t.status, t.body.code]).toEqual([404, 'RECORDS_DISABLED'])
    expect((await call('mn-owner', 'PUT', `${C()}/records/settings`, { enabled: true })).status).toBe(200)
  })
})

describe('for the thank-you mail (G8)', () => {
  it('meetingAttendees reads the attendees now from the calendar, outside ones marked', async () => {
    const r = await services.minutes.meetingAttendees(CO, 'mn-sato', 'member', salesId)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const external = r.value.filter((a: Json) => a.external).map((a: Json) => a.email).sort()
    expect(external).toEqual([GOOGLE_SEED.customerSuzuki, GOOGLE_SEED.customerYamaguchi])
    expect(r.value.find((a: Json) => a.email === GOOGLE_SEED.member)).toMatchObject({ organizer: true, external: false })
    expect((await services.minutes.meetingAttendees(CO, 'mn-yamada', 'member', salesId)).ok).toBe(false)
  })
})
