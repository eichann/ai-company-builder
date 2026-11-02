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
 * - exactly one open まとまり candidate (a deal) is linked with its 相手; two are not (a person / the AI chooses);
 * - which meetings are read is the company's setting (owner/admin): by default only those with
 *   someone from outside; `all` reads internal ones too;
 * - Google stopped (the company switch) or no permission → nothing is read; records off → 404.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeGoogle, type FakeGoogle } from '../fakes/google/fake-google'
import { defaultGoogleSeed, GOOGLE_SEED } from '../fakes/google/seed'
import { createFakeHubSpot, ALL_FAKE_SCOPES, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'
import { enableSampleSales, putSampleHub } from '../helpers/plugin-packages'
import { withRecordText } from '../helpers/record-text'

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
const minutesRows = () => withRecordText(db, CO, db.prepare("SELECT r.id, r.title, r.folder, s.state, s.fields FROM records r JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id WHERE r.company_id = ? AND r.type = 'meeting' ORDER BY r.created_at").all(CO) as Json[])
const linkOf = (id: string, name: string) => (db.prepare('SELECT target_id FROM record_links WHERE company_id = ? AND source_id = ? AND name = ?').get(CO, id, name) as Json)?.target_id ?? null
const dealIdOf = (title: string) => (withRecordText(db, CO, db.prepare("SELECT id, title FROM records WHERE company_id = ? AND type = 'deal'").all(CO) as Json[]).find(r => r.title === title) as Json).id as string
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
  putSampleHub(shelfDir)
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
  app.route('/api/companies/:companyId', (await import('../../src/routes/ai-runs')).aiRunsRoute)
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
  await enableSampleSales(services.plugins, owner)
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
  const saved = await services.plugins.saveMapping(owner, 'sample-sales', { text: MAPPING, acknowledgeAuto: ['confidence', 'next_step'] })
  expect(saved.ok, JSON.stringify(saved)).toBe(true)
  const readers = await services.plugins.setReadScope(owner, 'sample-hub', { userIds: ['mn-sato', 'mn-tanaka', 'mn-yamada'] })
  expect(readers.ok, JSON.stringify(readers)).toBe(true)
  const enabled = await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })
  expect(enabled.ok, JSON.stringify(enabled)).toBe(true)
  const imported = await services.pluginImport.run(owner, 'sample-sales')
  expect(imported.ok, JSON.stringify(imported)).toBe(true)
  // The customer's domain came in with the import (the fixture's customer type v2, mapping `domain`).
  const customer = withRecordText(db, CO, db.prepare("SELECT r.id, r.title, s.fields FROM records r JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id WHERE r.company_id = ? AND r.type = 'customer'").all(CO) as Json[]).find(r => r.title === '株式会社サンプル') as Json
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
    // The 顧客 says it is a company (名寄せ matches a company by its domain, identity.md).
    db.prepare("UPDATE record_state SET fields = json_set(fields, '$.counterpart_kind', 'company') WHERE company_id = ? AND record_id IN (SELECT id FROM records WHERE company_id = ? AND type = 'customer')").run(CO, CO)
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
    // The common outside time (records.md "Outside time"): when the meeting happened, apart from when ACB learned of it.
    expect(typeof f.occurred_at === 'string' && f.occurred_at.length > 0).toBe(true)
    expect(f.occurred_at).toBe(f.meeting_at)
    const learned = db.prepare("SELECT at FROM record_ledger WHERE company_id = ? AND record_id = ? AND action = 'create'").get(CO, rows[0].id) as { at: string }
    expect(learned.at).not.toBe(f.occurred_at)
  })

  it('two open deal candidates: nothing is linked; the text names both and a person chooses', async () => {
    expect(linkOf(salesId, 'bundle')).toBeNull()
    // 名寄せ: the outside participants' company is the meeting's 相手 even without a まとまり (never a まとまり without a click).
    const customer = (db.prepare("SELECT id FROM records WHERE company_id = ? AND type = 'customer'").get(CO) as Json).id as string
    expect(linkOf(salesId, 'counterpart')).toBe(customer)
    const t = await textOf('mn-sato', salesId)
    expect(t.status, t.text).toBe(200)
    expect(t.body.data.bundle).toBeNull()
    expect(t.body.data.candidates.map((c: Json) => c.title).sort()).toEqual(['生成AI研修 2期（株式会社サンプル）', '研修導入（株式会社サンプル）'])
    expect(t.body.data.candidates.map((c: Json) => c.typeLabel)).toEqual(['案件', '案件'])
    // Only the assignee or an admin chooses; only a まとまり (not the 顧客, a 相手).
    const deal = dealIdOf('研修導入（株式会社サンプル）')
    expect((await call('mn-tanaka', 'POST', `${C()}/me/minutes/item/${salesId}/bundle`, { bundleId: deal })).status).toBe(403)
    const customerId = (db.prepare("SELECT id FROM records WHERE company_id = ? AND type = 'customer'").get(CO) as Json).id as string
    const notBundle = await call('mn-sato', 'POST', `${C()}/me/minutes/item/${salesId}/bundle`, { bundleId: customerId })
    expect([notBundle.status, notBundle.body.code]).toEqual([400, 'BAD_LINK'])
    const linked = await call('mn-sato', 'POST', `${C()}/me/minutes/item/${salesId}/bundle`, { bundleId: deal })
    expect(linked.status, linked.text).toBe(200)
    expect(linkOf(salesId, 'bundle')).toBe(deal)
    expect(linkOf(salesId, 'counterpart')).toBeTruthy()
    const t2 = await textOf('mn-sato', salesId)
    expect(t2.body.data.bundle).toMatchObject({ id: deal, type: 'deal', typeLabel: '案件', title: '研修導入（株式会社サンプル）', fields: { amount: 1200000 } })
    expect(t2.body.data.candidates).toEqual([])
  })

  it('exactly one open deal candidate is linked (with its 相手, the customer)', async () => {
    // The follow-up meeting is renamed so its title names one of the two deals.
    google.changeEvent(GOOGLE_SEED.followUpEvent, { summary: '研修導入（株式会社サンプル） 2回目' })
    at('2026-11-13T09:00:00+09:00')
    const r = await check('mn-sato')
    expect(r.status, r.text).toBe(200)
    expect(r.body.data.created).toHaveLength(1)
    const id = r.body.data.created[0]
    expect(linkOf(id, 'bundle')).toBe(dealIdOf('研修導入（株式会社サンプル）'))
    expect(linkOf(id, 'counterpart')).toBeTruthy()
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
    // The meeting's version now: an unattended run (no records_get) finishes with it.
    const record = await call('mn-sato', 'GET', `${C()}/records/item/${followUp.id}`)
    expect(ai.body.data.version).toBe(record.body.data.record.version)
  })

  it('refuses a member who is neither assignee nor attendee, and another company\'s record is the same 404 as a missing one', async () => {
    const yamada = await textOf('mn-yamada', salesId)
    expect([yamada.status, yamada.body.code]).toEqual([403, 'MINUTES_NOT_YOURS'])
    expect(yamada.text).not.toContain('見積')
    // Another company's minutes record, asked for in this company's URL.
    db.prepare('INSERT INTO records (company_id, id, type, path, folder, title, summary, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)')
      .run(OTHER, 'meeting-other0000001', 'meeting', '他社の会議', '', ts(), ts())
    const other = await textOf('mn-sato', 'meeting-other0000001')
    const missing = await textOf('mn-sato', 'meeting-nosuch000001')
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
    // Put back by the server itself: the ledger says the clock did it, not the member.
    expect(minutesRows().find(r => r.id === salesId).state).toBe('received')
    const entries = (await call('mn-sato', 'GET', `${C()}/records/item/${salesId}/history`)).body.data.entries as Json[]
    const last = entries.reduce((a: Json, b: Json) => (b.version > a.version ? b : a))
    expect([last.action, last.toState, last.cause]).toEqual(['retry', 'received', 'system'])
  })

  it('an automatic run that ends unfinished puts the meeting back at once, as the run\'s doing', async () => {
    const version = (await call('mn-sato', 'GET', `${C()}/records/item/${salesId}`)).body.data.record.version
    const claimed = await call('mn-sato', 'POST', `${C()}/ai-run-claims`, { recordId: salesId, step: 'minutes-reading', deviceId: 'app-device-a', conversationId: 'conv-run-a' })
    expect(claimed.status, claimed.text).toBeLessThan(300)
    const run = claimed.body.data.run
    const tokenRes = await call('mn-sato', 'POST', `${C()}/me/record-tokens`, { conversationId: 'conv-run-a', agent: 'claude-code', scope: 'act', run: { id: run.id, generation: run.generation } })
    expect(tokenRes.status, tokenRes.text).toBe(201)
    const start = await call(null, 'POST', `/api/records-ai/item/${salesId}/actions/start_reading`, { expectedVersion: version }, tokenRes.body.data.token)
    expect(start.status, start.text).toBe(200)
    const finished = await call('mn-sato', 'POST', `${C()}/ai-runs/${run.id}/finish`, { generation: run.generation, outcome: 'failed', failure: { class: 'temporary', code: 'UNFINISHED' } })
    expect(finished.status, finished.text).toBe(200)
    expect(minutesRows().find(r => r.id === salesId).state).toBe('received')
    const entries = (await call('mn-sato', 'GET', `${C()}/records/item/${salesId}/history`)).body.data.entries as Json[]
    const last = entries.reduce((a: Json, b: Json) => (b.version > a.version ? b : a))
    expect([last.action, last.cause, last.runId]).toEqual(['retry', 'run', run.id])
  })

  it('read without a まとまり, one chosen afterwards: the まとまり\'s part waits for the AI once (its own step), and choosing again moves nothing', async () => {
    // The reading happened while no まとまり was linked (the AI left the deal's fields and the meeting log).
    db.prepare("DELETE FROM record_links WHERE company_id = ? AND source_id = ? AND name IN ('bundle', 'counterpart')").run(CO, salesId)
    const versionOf = async () => (await call('mn-sato', 'GET', `${C()}/records/item/${salesId}`)).body.data.record.version as number
    const token = await tokenFor('mn-sato')
    expect((await call(null, 'POST', `/api/records-ai/item/${salesId}/actions/start_reading`, { expectedVersion: await versionOf() }, token)).status).toBe(200)
    const read = await call(null, 'POST', `/api/records-ai/item/${salesId}/actions/finish_reading`, { expectedVersion: await versionOf(), args: { summary_text: '要約' } }, token)
    expect(read.status, read.text).toBe(200)
    expect(minutesRows().find(r => r.id === salesId).state).toBe('read')
    // Not the AI's turn while read: no run can be claimed.
    expect((await call('mn-sato', 'POST', `${C()}/ai-run-claims`, { recordId: salesId, step: 'minutes-bundle', deviceId: 'app-device-b', conversationId: 'conv-bundle' })).body.code).toBe('NOT_AI_TURN')

    const deal = dealIdOf('研修導入（株式会社サンプル）')
    const linked = await call('mn-sato', 'POST', `${C()}/me/minutes/item/${salesId}/bundle`, { bundleId: deal })
    expect(linked.status, linked.text).toBe(200)
    expect(minutesRows().find(r => r.id === salesId).state).toBe('bundle_waiting')
    const claimed = await call('mn-sato', 'POST', `${C()}/ai-run-claims`, { recordId: salesId, step: 'minutes-bundle', deviceId: 'app-device-b', conversationId: 'conv-bundle' })
    expect(claimed.status, claimed.text).toBeLessThan(300)
    const run = claimed.body.data.run
    const runToken = (await call('mn-sato', 'POST', `${C()}/me/record-tokens`, { conversationId: 'conv-bundle', agent: 'claude-code', scope: 'act', run: { id: run.id, generation: run.generation } })).body.data.token
    expect((await call(null, 'POST', `/api/records-ai/item/${salesId}/actions/start_bundle_work`, { expectedVersion: await versionOf() }, runToken)).status).toBe(200)
    expect((await call(null, 'POST', `/api/records-ai/item/${salesId}/actions/finish_bundle_work`, { expectedVersion: await versionOf() }, runToken)).status).toBe(200)
    expect((await call('mn-sato', 'POST', `${C()}/ai-runs/${run.id}/finish`, { generation: run.generation, outcome: 'done' })).status).toBe(200)
    expect(minutesRows().find(r => r.id === salesId).state).toBe('read')

    // A まとまり was there when it was chosen again: nothing goes back to the AI (no second deal update or log).
    const other = dealIdOf('生成AI研修 2期（株式会社サンプル）')
    expect((await call('mn-sato', 'POST', `${C()}/me/minutes/item/${salesId}/bundle`, { bundleId: other })).status).toBe(200)
    expect(minutesRows().find(r => r.id === salesId).state).toBe('read')
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

describe('which meetings are read (a company setting)', () => {
  it('only owners/admins change it; the default reads only meetings with someone from outside; `all` reads internal ones too', async () => {
    const got = await call('mn-owner', 'GET', `${C()}/google/minutes-folder`)
    expect(got.body.data.meetings).toBe('external')
    expect((await call('mn-sato', 'PUT', `${C()}/google/minutes-folder`, { meetings: 'all' })).status).toBe(403)
    expect((await call('mn-owner', 'PUT', `${C()}/google/minutes-folder`, { meetings: 'some' })).status).toBe(400)
    // Still the default: the internal meeting is not read (not even its Meet record).
    at('2026-11-06T09:00:00+09:00')
    google.requests.length = 0
    const before = await check('mn-tanaka')
    expect(before.body.data).toMatchObject({ internalOnly: 1, created: [] })
    expect(google.requests.filter(q => q.path === '/v2/conferenceRecords')).toHaveLength(1)

    const set = await call('mn-owner', 'PUT', `${C()}/google/minutes-folder`, { meetings: 'all' })
    expect(set.status, set.text).toBe(200)
    // Changing which meetings are read leaves the folder as it was.
    expect(set.body.data).toMatchObject({ meetings: 'all', folder: '営業部' })
    const after = await check('mn-tanaka')
    expect(after.status, after.text).toBe(200)
    expect(after.body.data).toMatchObject({ internalOnly: 0, meetings: 2 })
    expect(after.body.data.created).toHaveLength(1)
    const internal = minutesRows().find(r => r.id === after.body.data.created[0]) as Json
    expect(JSON.parse(internal.fields).external_count).toBe(0)
    expect((await call('mn-owner', 'PUT', `${C()}/google/minutes-folder`, { meetings: 'external' })).status).toBe(200)
  })
})

describe('「どのまとまりの会議ですか？」 (the server decides what asks)', () => {
  const questions = async (user: string) => {
    const r = await call(user, 'GET', `${C()}/me/minutes/bundle-questions`)
    expect(r.status, r.text).toBe(200)
    return r.body.data as { days: number; questions: Json[] }
  }
  const versionOf = async (id: string) => (await call('mn-owner', 'GET', `${C()}/records/item/${id}`)).body.data.record.version as number
  async function readWithoutBundle(id: string, user: string) {
    db.prepare("DELETE FROM record_links WHERE company_id = ? AND source_id = ? AND name IN ('bundle', 'counterpart')").run(CO, id)
    const state = minutesRows().find(r => r.id === id).state
    if (state === 'read') return
    const token = await tokenFor(user)
    if (state === 'received') expect((await call(null, 'POST', `/api/records-ai/item/${id}/actions/start_reading`, { expectedVersion: await versionOf(id) }, token)).status).toBe(200)
    const read = await call(null, 'POST', `/api/records-ai/item/${id}/actions/finish_reading`, { expectedVersion: await versionOf(id), args: { summary_text: '要約' } }, token)
    expect(read.status, read.text).toBe(200)
  }
  let followUpId: string
  let internalId: string

  it('asks the assignee only for read meetings with someone from outside and no まとまり; the same 相手 is one group', async () => {
    at('2026-11-14T09:00:00+09:00')
    const rows = minutesRows()
    followUpId = rows.find(r => r.title.includes('2回目')).id
    internalId = rows.find(r => JSON.parse(r.fields).external_count === 0).id
    const internalAssignee = JSON.parse(rows.find(r => r.id === internalId).fields).assignee as string
    await readWithoutBundle(salesId, 'mn-sato')
    await readWithoutBundle(followUpId, 'mn-sato')
    await readWithoutBundle(internalId, internalAssignee)

    const mine = await questions('mn-sato')
    expect(mine.days).toBe(7)
    expect(mine.questions.map(q => q.recordId).sort()).toEqual([salesId, followUpId].sort())
    // An internal meeting never asks, whoever is its assignee.
    expect((await questions(internalAssignee)).questions.map(q => q.recordId)).not.toContain(internalId)
    // Tanaka attended but is not the assignee: not his question.
    expect((await questions('mn-tanaka')).questions.map(q => q.recordId)).not.toContain(salesId)
    // Different titles, no 相手: two groups. The same 相手: one group, named after it; no calendar id in the answer.
    const [a, b] = mine.questions
    expect(a.group.key).not.toBe(b.group.key)
    const customerId = (db.prepare("SELECT id FROM records WHERE company_id = ? AND type = 'customer'").get(CO) as Json).id as string
    for (const id of [salesId, followUpId]) {
      db.prepare("INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path) VALUES (?, ?, 'counterpart', 0, ?, NULL)").run(CO, id, customerId)
    }
    const grouped = await questions('mn-sato')
    expect(new Set(grouped.questions.map(q => q.group.key)).size).toBe(1)
    expect(grouped.questions[0].group.label).toBe('株式会社サンプル')
    expect(JSON.stringify(grouped)).not.toContain(GOOGLE_SEED.salesEvent)
    expect(JSON.stringify(grouped)).not.toContain(GOOGLE_SEED.followUpEvent)
  })

  it('leaves あなたの番 after the company\'s days (owner/admin setting); the card can still choose', async () => {
    expect((await call('mn-sato', 'PUT', `${C()}/google/minutes-folder`, { bundleQuestionDays: 14 })).status).toBe(403)
    for (const bad of [0, 31, 2.5, '7']) expect((await call('mn-owner', 'PUT', `${C()}/google/minutes-folder`, { bundleQuestionDays: bad })).status).toBe(400)
    at('2026-11-24T09:00:00+09:00')
    expect((await questions('mn-sato')).questions).toEqual([])
    const card = await call('mn-sato', 'GET', `${C()}/me/minutes/item/${salesId}/bundle-question`)
    expect(card.status, card.text).toBe(200)
    expect(card.body.data).toMatchObject({ recordId: salesId, canChoose: true, noBundle: false })
    expect((await call('mn-tanaka', 'GET', `${C()}/me/minutes/item/${salesId}/bundle-question`)).body.data.canChoose).toBe(false)
    const set = await call('mn-owner', 'PUT', `${C()}/google/minutes-folder`, { bundleQuestionDays: 30 })
    expect(set.status, set.text).toBe(200)
    expect(set.body.data).toMatchObject({ bundleQuestionDays: 30, folder: '営業部' })
    expect((await questions('mn-sato')).questions.map(q => q.recordId).sort()).toEqual([salesId, followUpId].sort())
  })

  it('「まとまりはない」 closes the question for good: the person\'s choice in the ledger, no state change, no AI turn', async () => {
    expect((await call('mn-tanaka', 'POST', `${C()}/me/minutes/item/${followUpId}/no-bundle`, {})).status).toBe(403)
    expect((await call('mn-sato', 'POST', `${C()}/me/minutes/item/${followUpId}/no-bundle`, { extra: 1 })).status).toBe(400)
    const before = await versionOf(followUpId)
    const r = await call('mn-sato', 'POST', `${C()}/me/minutes/item/${followUpId}/no-bundle`, { expectedVersion: before })
    expect(r.status, r.text).toBe(200)
    expect(r.body.data.version).toBe(before + 1)
    expect((await questions('mn-sato')).questions.map(q => q.recordId)).toEqual([salesId])
    expect(minutesRows().find(row => row.id === followUpId).state).toBe('read')
    const entries = (await call('mn-sato', 'GET', `${C()}/records/item/${followUpId}/history`)).body.data.entries as Json[]
    const last = entries.reduce((x: Json, y: Json) => (y.version > x.version ? y : x))
    expect([last.action, last.actorId, last.fromState, last.toState]).toEqual(['no_bundle', 'mn-sato', 'read', 'read'])
    expect((await call('mn-sato', 'POST', `${C()}/ai-run-claims`, { recordId: followUpId, step: 'minutes-bundle', deviceId: 'app-device-c', conversationId: 'conv-nb' })).body.code).toBe('NOT_AI_TURN')
    // Asked again (a second window): nothing more is written. The text tells the AI not to ask.
    expect((await call('mn-sato', 'POST', `${C()}/me/minutes/item/${followUpId}/no-bundle`, {})).body.data.version).toBe(before + 1)
    expect((await textOf('mn-sato', followUpId)).body.data.noBundle).toBe(true)
    expect((await textOf('mn-sato', salesId)).body.data.noBundle).toBe(false)
    // A まとまり can still be chosen from the card; then 「まとまりはない」 is refused.
    expect((await call('mn-sato', 'GET', `${C()}/me/minutes/item/${followUpId}/bundle-question`)).body.data).toMatchObject({ canChoose: true, noBundle: true })
    const deal = dealIdOf('研修導入（株式会社サンプル）')
    expect((await call('mn-sato', 'POST', `${C()}/me/minutes/item/${followUpId}/bundle`, { bundleId: deal })).status).toBe(200)
    const again = await call('mn-sato', 'POST', `${C()}/me/minutes/item/${followUpId}/no-bundle`, {})
    expect([again.status, again.body.code]).toEqual([409, 'MINUTES_HAS_BUNDLE'])
  })

  it('「『…』の会議ですか？」: the 相手\'s one open まとまり the member reads is suggested, never linked until はい', async () => {
    const suggestedOf = async (user: string) => (await questions(user)).questions.find(q => q.recordId === salesId)?.suggested
    // Two open deals of the 相手: the plain question.
    expect(await suggestedOf('mn-sato')).toBeNull()
    const other = dealIdOf('生成AI研修 2期（株式会社サンプル）')
    const deal = dealIdOf('研修導入（株式会社サンプル）')
    db.prepare("UPDATE record_state SET state = 'lost' WHERE company_id = ? AND record_id = ?").run(CO, other)
    expect(await suggestedOf('mn-sato')).toEqual({ id: deal, title: '研修導入（株式会社サンプル）', typeLabel: '案件' })
    expect((await call('mn-sato', 'GET', `${C()}/me/minutes/item/${salesId}/bundle-question`)).body.data.suggested).toMatchObject({ id: deal })
    // Not the assignee: nothing to choose, nothing suggested.
    expect((await call('mn-tanaka', 'GET', `${C()}/me/minutes/item/${salesId}/bundle-question`)).body.data.suggested).toBeNull()
    // Suggesting changed nothing: no まとまり, still read.
    expect(linkOf(salesId, 'bundle')).toBeNull()
    expect(minutesRows().find(r => r.id === salesId).state).toBe('read')
    // A まとまり the member does not read is never suggested (nor named).
    db.prepare('UPDATE records SET personal_owner = ? WHERE company_id = ? AND id = ?').run('mn-tanaka', CO, deal)
    const hidden = await call('mn-sato', 'GET', `${C()}/me/minutes/bundle-questions`)
    expect(hidden.text, hidden.text).not.toContain(deal)
    expect(hidden.text).not.toContain('研修導入（株式会社サンプル）')
    expect((await questions('mn-sato')).questions.find(q => q.recordId === salesId)?.suggested).toBeNull()
    db.prepare('UPDATE records SET personal_owner = NULL WHERE company_id = ? AND id = ?').run(CO, deal)
    // はい: the same link as choosing by hand, and the まとまり's part goes to the AI.
    expect((await call('mn-sato', 'POST', `${C()}/me/minutes/item/${salesId}/bundle`, { bundleId: deal })).status).toBe(200)
    expect(linkOf(salesId, 'bundle')).toBe(deal)
    expect(minutesRows().find(r => r.id === salesId).state).toBe('bundle_waiting')
    db.prepare("UPDATE record_state SET state = 'open' WHERE company_id = ? AND record_id = ?").run(CO, other)
  })
})

describe('what a meeting\'s reading makes is made once (FB 29)', () => {
  const TITLE = '修正見積（150万円）を鈴木様へ送付'
  let followUpId: string
  let first: string
  const task = (token: string, meetingId: string, title: string, key?: string) => call(null, 'POST', '/api/records-ai/item', {
    type: 'task', title, fields: { assignee: 'mn-sato' }, links: { meeting: meetingId }, ...(key ? { key } : {}),
  }, token)
  const tasksOf = (meetingId: string) => (db.prepare("SELECT source_id FROM record_links WHERE company_id = ? AND name = 'meeting' AND target_id = ?").all(CO, meetingId) as Json[])
    .map(r => r.source_id as string).filter(id => id.startsWith('task-'))

  it('a second reading reuses the task (same key, or the same title written differently); a different item is still made', async () => {
    followUpId = minutesRows().find(r => r.title.includes('2回目')).id
    const token = await tokenFor('mn-sato')
    const made = await task(token, salesId, TITLE, 'task:1')
    expect(made.status, made.text).toBe(201)
    first = made.body.data.record.id
    // The reading run again: the same key (its title reworded), and no key but the same title in other spacing.
    const again = await task(await tokenFor('mn-sato'), salesId, '修正見積を鈴木様へ', 'task:1')
    expect([again.status, again.body.data.record.id, again.body.data.reused]).toEqual([200, first, true])
    expect(again.body.data.note).toContain('すでに作られていた')
    const reworded = await task(token, salesId, '修正見積 (１５０万円) を 鈴木様へ送付。')
    expect([reworded.status, reworded.body.data.record.id]).toEqual([200, first])
    const other = await task(token, salesId, 'カリキュラム案を送る', 'task:2')
    expect(other.status, other.text).toBe(201)
    expect(tasksOf(salesId).sort()).toEqual([first, other.body.data.record.id].sort())
    // A key needs its meeting.
    const loose = await call(null, 'POST', '/api/records-ai/item', { type: 'task', title: 'x', key: 'task:9' }, token)
    expect([loose.status, loose.body.code]).toEqual([400, 'KEY_NEEDS_MEETING'])
  })

  it('another meeting is never matched: the same title and key there make its own task', async () => {
    const token = await tokenFor('mn-sato')
    const there = await task(token, followUpId, TITLE, 'task:1')
    expect(there.status, there.text).toBe(201)
    expect(there.body.data.record.id).not.toBe(first)
    expect(tasksOf(followUpId)).toEqual([there.body.data.record.id])
  })

  it('decisions: the same title or key of one meeting once; another meeting\'s `1` is its own', async () => {
    const token = await tokenFor('mn-sato')
    const decide = (meetingId: string, title: string, key?: string) => call(null, 'POST', '/api/records-ai/decisions', {
      folder: '営業部', title, why: '先方と合意した', source: '見積金額を120万円から150万円に改めることで合意した', links: { meeting: meetingId }, ...(key ? { key } : {}),
    }, token)
    const a = await decide(salesId, '見積は150万円にする', '1')
    expect(a.status, a.text).toBe(201)
    const sameKey = await decide(salesId, '見積を150万円に改める', '1')
    expect([sameKey.status, sameKey.body.data.record.id, sameKey.body.data.reused]).toEqual([200, a.body.data.record.id, true])
    const sameTitle = await decide(salesId, '見積は 150万円 にする')
    expect([sameTitle.status, sameTitle.body.data.record.id]).toEqual([200, a.body.data.record.id])
    const elsewhere = await decide(followUpId, '見積は150万円にする', '1')
    expect(elsewhere.status, elsewhere.text).toBe(201)
    expect(elsewhere.body.data.record.id).not.toBe(a.body.data.record.id)
  })

  it('duplicates made before the rule: owner/admin list them by meeting and title, and merge cancels the extras with a note (nothing deleted)', async () => {
    // Two more copies made before the rule (later than the first): created without the link, then linked by hand.
    at('2026-12-02T09:00:00+09:00')
    const engine = services.recordEngine
    const sato = { companyId: CO, userId: 'mn-sato', role: 'member' }
    const copies: string[] = []
    for (let i = 0; i < 2; i++) {
      const r = engine.create(sato, { kind: 'ai', source: 'claude-code' }, { type: 'task', title: TITLE, fields: { assignee: 'mn-sato' } })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      const id = (r as Json).value.record.id as string
      db.prepare("INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path) VALUES (?, ?, 'meeting', 0, ?, NULL)").run(CO, id, salesId)
      copies.push(id)
    }
    expect((await call('mn-sato', 'GET', `${C()}/records/meeting-duplicates`)).status).toBe(403)
    const listed = await call('mn-owner', 'GET', `${C()}/records/meeting-duplicates`)
    expect(listed.status, listed.text).toBe(200)
    const group = (listed.body.data.groups as Json[]).find(g => g.meetingId === salesId && g.type === 'task')
    expect(group.keep.id).toBe(first)
    expect(group.duplicates.map((d: Json) => d.id).sort()).toEqual([...copies].sort())
    expect(group.mergeable).toBe(true)
    // Another meeting's task of the same title is not a duplicate of this one.
    expect((listed.body.data.groups as Json[]).some(g => g.meetingId === followUpId)).toBe(false)

    expect((await call('mn-sato', 'POST', `${C()}/records/meeting-duplicates/merge`, { keepId: first, duplicateIds: copies })).status).toBe(403)
    const otherTask = tasksOf(salesId).find(id => id !== first && !copies.includes(id)) as string
    const wrong = await call('mn-owner', 'POST', `${C()}/records/meeting-duplicates/merge`, { keepId: first, duplicateIds: [otherTask] })
    expect([wrong.status, wrong.body.code]).toEqual([400, 'NOT_DUPLICATES'])
    const merged = await call('mn-owner', 'POST', `${C()}/records/meeting-duplicates/merge`, { keepId: first, duplicateIds: copies })
    expect(merged.status, merged.text).toBe(200)
    expect(merged.body.data).toMatchObject({ keptId: first, failed: [] })
    for (const id of copies) {
      const item = await call('mn-owner', 'GET', `${C()}/records/item/${id}`)
      expect(item.body.data.record.state).toBe('cancelled')
      const entries = (await call('mn-owner', 'GET', `${C()}/records/item/${id}/history`)).body.data.entries as Json[]
      const last = entries.reduce((x: Json, y: Json) => (y.version > x.version ? y : x))
      expect([last.action, last.actorId]).toEqual(['cancel', 'mn-owner'])
      expect(last.note).toContain(first)
    }
    expect((await call('mn-owner', 'GET', `${C()}/records/item/${first}`)).body.data.record.state).not.toBe('cancelled')
    const after = await call('mn-owner', 'GET', `${C()}/records/meeting-duplicates`)
    expect((after.body.data.groups as Json[]).some(g => g.meetingId === salesId && g.type === 'task')).toBe(false)
  })
})
