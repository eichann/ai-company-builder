/**
 * Integration Test: 「届いた議事録を AI が自動で読む」 — each member's own setting (社外の人がいる会議だけ /
 * 自分が出た会議全部 / 自動では読まない) and a series' three choices (読む / 読まない / none), applied by the
 * server clock's discovery (`.claude/rules/minutes.md` "Automatic reading by the member's setting"; 4b-4
 * design memo 1.1), end to end against the fake Google with real routes, services and database.
 *
 * What it protects (each mutation-checked):
 * - a member who joined after the setting was made starts at 「社外の人がいる会議だけ」: a meeting with someone
 *   from outside (the stored count) is asked for them by the clock, an internal one is not;
 * - the reading is asked only for a meeting whose list names the member — never one they organised but are
 *   not on, so nobody's AI reads another member's meeting;
 * - one reader per meeting, also when two attendees want it, and a second run writes nothing;
 * - a mode the member chose applies to meetings recorded from then on (no backlog read at once);
 * - a series' 読まない is stronger than 「全部」, kept apart from the 読む table an older build reads;
 *   none (null) leaves it to the setting;
 * - `PUT …/auto-read` sets the caller's own setting only, validates its body, and stops while 会議と議事録 is off;
 * - 「議事録が届きました」 says which readings the server asked and the caller's series choice;
 *   another attendee sees whose AI will read it, and whether that is the organiser;
 * - a newcomer who never chose reads only meetings held after they joined (no backlog);
 * - the organiser first (owner decisions 2026-11-25): within 15 minutes of a meeting arriving another
 *   attendee's automatic reading waits when the organiser's would read it; after that anyone may; a
 *   reading the clock asked for the organiser that has not started is taken over once 15 minutes old —
 *   never while the organiser's app holds the run, never after the reading started, never a person's own
 *   press, never by someone not attending; the organiser's later start then does nothing;
 * - a person's own press takes a meeting only the clock asked for someone else, at once — never a reading
 *   started or claimed, never another person's press.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeGoogle, type FakeGoogle } from '../fakes/google/fake-google'
import { defaultGoogleSeed, GOOGLE_SEED, type GoogleSeed } from '../fakes/google/seed'
import { withRecordText } from '../helpers/record-text'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 })

/** A third member, on one meeting only (12/9): someone who is neither the organiser nor the reader. */
const YAMADA = vi.hoisted(() => 'yamada@div.example')
const EMAILS: Record<string, { email: string; name: string }> = {
  'ar-owner': { email: 'owner@div.example', name: '阿部 部長' },
  'ar-sato': { email: GOOGLE_SEED.member, name: '佐藤 健' },
  'ar-tanaka': { email: GOOGLE_SEED.colleague, name: '田中 誠' },
  'ar-yamada': { email: YAMADA, name: '山田 花子' },
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
const PUBLIC = 'http://localhost:13004'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-autoread.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-autoread-0123456789'
const ts = () => new Date().toISOString()
/** When both members joined: before every seeded meeting (a newcomer reads only meetings held after joining). */
const JOINED = '2026-11-20T00:00:00.000Z'
const S = GOOGLE_SEED
const GUEST = 'guest@a-corp.example'
const SERIES = 'fakeautoseries01'

function seed(): GoogleSeed {
  const base = defaultGoogleSeed()
  const accepted = (email: string) => ({ email, responseStatus: 'accepted' as const })
  const ev = (id: string, summary: string, day: string, code: string, attendees: string[], extra: Partial<GoogleSeed['events'][number]> = {}) =>
    ({ id, summary, start: `${day}T10:00:00+09:00`, end: `${day}T10:30:00+09:00`, organizer: S.member, attendees: attendees.map(accepted), meetingCode: code, ...extra })
  const conf = (id: string, code: string, day: string, doc: string) => ({
    id, meetingCode: code, space: `spaces/${id}`, startTime: `${day}T01:00:10.000Z`, endTime: `${day}T01:00:10.000Z`, participants: [S.member, S.colleague],
    smartNotes: [{ id: `note-${id}`, state: 'FILE_GENERATED' as const, docId: doc }], transcripts: [],
  })
  const doc = (id: string) => ({ id, name: id, owner: S.member, readers: [S.member, S.colleague, YAMADA], createdByMeet: true, text: '会議メモ\n話したこと\n', version: 3, modifiedTime: '2026-11-24T04:00:00.000Z' })
  const m = [
    // 11/24: a meeting with a customer, an internal one, a weekly meeting.
    { ev: ev('fakear-sales', '商談', '2026-11-24', 'aaa-aaaa-aaa', [S.member, S.colleague, GUEST]), day: '2026-11-24' },
    { ev: ev('fakear-internal', '社内会議', '2026-11-24', 'bbb-bbbb-bbb', [S.member, S.colleague]), day: '2026-11-24' },
    { ev: ev('fakear-weekly1', '週次', '2026-11-24', 'ccc-cccc-ccc', [S.member, S.colleague], { recurringEventId: SERIES }), day: '2026-11-24' },
    // 11/25: Tanaka's interview with a guest that Sato organised but is not on; an internal meeting; the weekly again.
    { ev: ev('fakear-tanaka', '田中さんの面談', '2026-11-25', 'ddd-dddd-ddd', [S.colleague, GUEST]), day: '2026-11-25' },
    { ev: ev('fakear-internal2', '社内会議2', '2026-11-25', 'eee-eeee-eee', [S.member, S.colleague]), day: '2026-11-25' },
    { ev: ev('fakear-weekly2', '週次', '2026-11-25', 'fff-ffff-fff', [S.member, S.colleague], { recurringEventId: SERIES }), day: '2026-11-25' },
    // 11/26: another customer meeting both members want read.
    { ev: ev('fakear-sales2', '商談2', '2026-11-26', 'ggg-gggg-ggg', [S.member, S.colleague, GUEST]), day: '2026-11-26' },
    // 11/27: one whose text Google refuses at first; 11/28: one whose reader turns the setting off mid-way.
    { ev: ev('fakear-sales3', '商談3', '2026-11-27', 'hhh-hhhh-hhh', [S.member, S.colleague, GUEST]), day: '2026-11-27' },
    { ev: ev('fakear-sales4', '商談4', '2026-11-28', 'iii-iiii-iii', [S.member, S.colleague, GUEST]), day: '2026-11-28' },
    // 11/29: Sato's alone, recorded by a run whose budget is spent before the try of its text.
    { ev: ev('fakear-sales5', '商談5', '2026-11-29', 'jjj-jjjj-jjj', [S.member, GUEST]), day: '2026-11-29' },
    // 11/30 – 12/8: the organiser first. Sato organises each; Tanaka attends (12/5: declined; 12/6: Sato not on it).
    { ev: ev('fakear-org1', '主催1', '2026-11-30', 'kkk-kkkk-kkk', [S.member, S.colleague, GUEST]), day: '2026-11-30' },
    { ev: ev('fakear-org2', '主催2', '2026-12-01', 'lll-llll-lll', [S.member, S.colleague, GUEST]), day: '2026-12-01' },
    { ev: ev('fakear-org3', '主催3', '2026-12-02', 'mmm-mmmm-mmm', [S.member, S.colleague, GUEST]), day: '2026-12-02' },
    { ev: ev('fakear-org4', '主催4', '2026-12-03', 'nnn-nnnn-nnn', [S.member, S.colleague, GUEST]), day: '2026-12-03' },
    { ev: ev('fakear-org5', '主催5', '2026-12-04', 'ooo-oooo-ooo', [S.member, S.colleague, GUEST]), day: '2026-12-04' },
    { ev: { ...ev('fakear-org6', '主催6', '2026-12-05', 'ppp-pppp-ppp', []), attendees: [accepted(S.member), { email: S.colleague, responseStatus: 'declined' as const }, accepted(GUEST)] }, day: '2026-12-05' },
    { ev: ev('fakear-org7', '主催7', '2026-12-06', 'qqq-qqqq-qqq', [S.colleague, GUEST]), day: '2026-12-06' },
    { ev: ev('fakear-org8', '主催8', '2026-12-07', 'rrr-rrrr-rrr', [S.member, S.colleague, GUEST]), day: '2026-12-07' },
    { ev: ev('fakear-org9', '主催9', '2026-12-08', 'sss-ssss-sss', [S.member, S.colleague, GUEST]), day: '2026-12-08' },
    { ev: ev('fakear-org10', '主催10', '2026-12-09', 'ttt-tttt-ttt', [S.member, S.colleague, YAMADA, GUEST]), day: '2026-12-09' },
    { ev: ev('fakear-org11', '主催11', '2026-12-10', 'uuu-uuuu-uuu', [S.member, S.colleague, GUEST]), day: '2026-12-10' },
    { ev: ev('fakear-org12', '主催12', '2026-12-11', 'vvv-vvvv-vvv', [S.member, S.colleague, GUEST]), day: '2026-12-11' },
    { ev: ev('fakear-org13', '主催13', '2026-12-12', 'www-wwww-www', [S.member, S.colleague, GUEST]), day: '2026-12-12' },
    { ev: ev('fakear-org14', '主催14', '2026-12-13', 'xxx-xxxx-xxx', [S.member, S.colleague, GUEST]), day: '2026-12-13' },
    { ev: ev('fakear-org15', '主催15', '2026-12-14', 'yyy-yyyy-yyy', [S.member, S.colleague, GUEST]), day: '2026-12-14' },
  ]
  return {
    ...base,
    users: [...base.users, { email: YAMADA, sub: '110000000000000000009', name: '山田 花子', givenName: '花子', familyName: '山田', hd: S.internalDomain }],
    events: m.map(x => x.ev),
    conferences: m.map((x, n) => conf(`fake-conf-ar-${n}`, x.ev.meetingCode, x.day, `fake-doc-ar-${n}`)),
    docs: m.map((_, n) => doc(`fake-doc-ar-${n}`)),
    mails: [],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let google: FakeGoogle
let googleServer: ServerType
let kekDir: string
let CO: string

async function call(user: string | null, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: Json; text: string }> {
  currentUser.id = user
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  const res: Response = await app.request(`${PUBLIC}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body: json, text }
}
const C = () => `/api/companies/${CO}`
const at = (iso: string) => vi.setSystemTime(new Date(iso))
const poll = () => services.minutes.pollCompany(CO) as Promise<number>
/** One member's discovery alone (the app's check): who looks first is the test's choice. */
const check = async (user: string) => {
  const r = await call(user, 'POST', `${C()}/me/minutes/check`, {})
  expect(r.status, r.text).toBe(200)
  return r
}
const press = (user: string, id: string) => call(user, 'POST', `${C()}/me/minutes/item/${id}/read-request`, {})
const versionOf = async (id: string) => (await call('ar-sato', 'GET', `${C()}/records/item/${id}`)).body.data.record.version as number
const meetingIds = () => (db.prepare("SELECT id FROM records WHERE company_id = ? AND type = 'meeting'").all(CO) as Json[]).map(r => r.id as string)
const titleOf = (id: string) => withRecordText(db, CO, db.prepare('SELECT id, title FROM records WHERE company_id = ? AND id = ?').all(CO, id) as Json[])[0]?.title
const idOf = (title: string) => meetingIds().find(id => titleOf(id) === title) as string
const fieldsOf = (id: string) => JSON.parse((db.prepare('SELECT fields FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).fields)
const stateOf = (id: string) => (db.prepare('SELECT state FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).state as string
/** The reading requests in the meeting's history (notes are kept in the content store, read through the route). */
async function tokenFor(user: string, conversationId = 'conv-auto-read'): Promise<string> {
  const r = await call(user, 'POST', `${C()}/me/record-tokens`, { conversationId, agent: 'claude-code', scope: 'act' })
  expect(r.status, r.text).toBe(201)
  return r.body.data.token
}
const requests = async (id: string, user = 'ar-sato') => ((await call(user, 'GET', `${C()}/records/item/${id}/history`)).body.data.entries as Json[])
  .filter(e => e.action === 'request_reading').map(e => ({ actor_id: e.actorId, note: e.note }))
const ledgerCount = () => (db.prepare('SELECT COUNT(*) AS n FROM record_ledger WHERE company_id = ?').get(CO) as Json).n as number
const arrivals = async (user: string) => (await call(user, 'GET', `${C()}/me/minutes/arrivals`)).body.data.items as Json[]
const setMode = async (user: string, mode: string) => {
  const r = await call(user, 'PUT', `${C()}/me/minutes/auto-read`, { mode })
  expect(r.status, r.text).toBe(200)
}

async function allow(user: string, email: string) {
  google.signIn({ email })
  const r = await call(user, 'POST', `${C()}/me/google/connect`, { features: ['minutes'] })
  expect(r.status, r.text).toBe(200)
  const res = await fetch(r.body.data.authorizeUrl, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  expect((await call(null, 'GET', `/api/oauth/google/callback${back.search}`)).status).toBe(200)
}

beforeAll(async () => {
  google = createFakeGoogle({ seed: seed() })
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  googleServer = await new Promise<ServerType>(resolve => { const s = serve({ fetch: google.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s)) })
  kekDir = mkdtempSync(join(tmpdir(), 'acb-ar-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
  })
  for (const level of ['log', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/minutes')).minutesRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/task-settings')).taskSettingsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/ai-runs')).aiRunsRoute)
  app.route('/api/records-ai', (await import('../../src/routes/records-ai')).recordsAiRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)

  const company = await services.companies.create('ar-owner', 'AutoRead', 'auto-read-co')
  CO = company.id
  // They join after the setting exists (before the seeded meetings): no row, the starting value 「社外の人がいる会議だけ」.
  for (const u of ['ar-sato', 'ar-tanaka', 'ar-yamada']) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, 'member', JOINED, ts())
  }
  expect((await call('ar-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: S.internalDomain })).status).toBe(200)
  await allow('ar-sato', S.member)
  await allow('ar-tanaka', S.colleague)
  await allow('ar-yamada', YAMADA)
  expect((await call('ar-owner', 'PUT', `${C()}/records/settings`, { enabled: true })).status).toBe(200)
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterAll(async () => {
  vi.useRealTimers()
  google.close()
  await new Promise(r => googleServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL']) delete process.env[k]
})

describe('the member\'s setting', () => {
  it('a newcomer who never chose reads only meetings held after they joined, never the last days\' backlog', async () => {
    at('2026-11-24T18:00:00+09:00')
    const joined = (iso: string) => db.prepare('UPDATE memberships SET created_at = ? WHERE company_id = ? AND user_id = ?').run(iso, CO, 'ar-sato')
    // Joined at 10:30, the customer meeting was at 10:00: recorded, not read.
    joined('2026-11-24T01:30:00.000Z')
    await check('ar-sato')
    const sales = idOf('商談')
    expect(stateOf(sales)).toBe('arrived')
    expect(await requests(sales)).toEqual([])
    // Joined at 9:30: held after they joined, read.
    joined('2026-11-24T00:30:00.000Z')
    await check('ar-sato')
    expect(stateOf(sales)).toBe('received')
    expect(fieldsOf(sales).assignee).toBe('ar-sato')
    joined(JOINED)
  })

  it('starts at 「社外の人がいる会議だけ」 for a member who joined after it was made: a meeting with a guest is asked for them, an internal one is not; once', async () => {
    at('2026-11-24T18:00:00+09:00')
    expect((await call('ar-sato', 'GET', `${C()}/me/minutes/auto-read`)).body.data).toEqual({ mode: 'outside', chosen: false })
    // Tanaka reads by a press only: Sato is the one whose setting applies here.
    await setMode('ar-tanaka', 'off')
    expect((await call('ar-tanaka', 'GET', `${C()}/me/minutes/auto-read`)).body.data).toEqual({ mode: 'off', chosen: true })
    await poll()
    const sales = idOf('商談')
    const internal = idOf('社内会議')
    expect(fieldsOf(sales).external_count).toBe(1)
    expect(stateOf(sales)).toBe('received')
    expect(fieldsOf(sales).assignee).toBe('ar-sato')
    expect(await requests(sales)).toEqual([{ actor_id: 'acb:clock', note: '自動で読む設定のため、AI に読ませました' }])
    expect(stateOf(internal)).toBe('arrived')
    expect(stateOf(idOf('週次'))).toBe('arrived')
    // The reader's own row says the server asked; another attendee sees whose AI will read it.
    expect((await arrivals('ar-sato')).find(i => i.recordId === sales)).toMatchObject({ status: 'asked', byYou: true, askedAutomatically: true })
    expect((await arrivals('ar-tanaka')).find(i => i.recordId === sales)).toMatchObject({ status: 'asked', byYou: false, by: { memberId: 'ar-sato' }, askedAutomatically: true })
    // Run twice: nothing more is written.
    const before = ledgerCount()
    await poll()
    expect(ledgerCount()).toBe(before)
  })

  it('a press is not 「asked automatically」', async () => {
    const internal = idOf('社内会議')
    expect((await call('ar-tanaka', 'POST', `${C()}/me/minutes/item/${internal}/read-request`, {})).status).toBe(200)
    expect((await arrivals('ar-tanaka')).find(i => i.recordId === internal)).toMatchObject({ status: 'asked', byYou: true, askedAutomatically: false })
  })

  it('PUT sets the caller\'s own setting only and checks its body; it stops while 会議と議事録 is off', async () => {
    expect((await call('ar-sato', 'PUT', `${C()}/me/minutes/auto-read`, { mode: 'sometimes' })).status).toBe(400)
    expect((await call('ar-sato', 'PUT', `${C()}/me/minutes/auto-read`, { mode: 'all', userId: 'ar-tanaka' })).status).toBe(400)
    expect((await call('ar-sato', 'PUT', `${C()}/me/minutes/auto-read`, null)).status).toBe(400)
    expect((await call('ar-sato', 'GET', `${C()}/me/minutes/auto-read`)).body.data).toEqual({ mode: 'outside', chosen: false })
    expect((await call('ar-tanaka', 'GET', `${C()}/me/minutes/auto-read`)).body.data).toEqual({ mode: 'off', chosen: true })
    expect((await call('ar-owner', 'PUT', `${C()}/features`, { feature: 'meetings', on: false })).status).toBe(200)
    const off = await call('ar-sato', 'PUT', `${C()}/me/minutes/auto-read`, { mode: 'all' })
    expect([off.status, off.body.code]).toEqual([409, 'FEATURE_OFF'])
    expect((await call('ar-owner', 'PUT', `${C()}/features`, { feature: 'meetings', on: true })).status).toBe(200)
  })

  it('「全部」 applies to meetings recorded from then on; a series\' 読まない is stronger, never kept where an older build reads 読む', async () => {
    at('2026-11-24T18:10:00+09:00')
    await setMode('ar-sato', 'all')
    const weekly = idOf('週次')
    const r = await call('ar-sato', 'PUT', `${C()}/me/minutes/item/${weekly}/auto-series`, { auto: false })
    expect(r.status, r.text).toBe(200)
    expect(r.body.data).toEqual({ recordId: weekly, autoSeries: false, seriesChoice: 'off' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_auto_series WHERE company_id = ?').get(CO).n).toBe(0)
    expect((await arrivals('ar-sato')).find(i => i.recordId === weekly)).toMatchObject({ autoSeries: false, seriesChoice: 'off' })
    expect((await arrivals('ar-tanaka')).find(i => i.recordId === weekly)).toMatchObject({ seriesChoice: null })
    // Recorded before the choice: not read now (no backlog of the last days at once).
    await poll()
    expect(stateOf(weekly)).toBe('arrived')

    at('2026-11-25T18:00:00+09:00')
    await poll()
    expect(stateOf(idOf('社内会議2'))).toBe('received')
    expect(fieldsOf(idOf('社内会議2')).assignee).toBe('ar-sato')
    const weekly2 = meetingIds().find(id => titleOf(id) === '週次' && id !== weekly) as string
    expect(stateOf(weekly2)).toBe('arrived')
    // Sato organised Tanaka's interview but is not on it: never read for Sato (Tanaka reads by a press).
    const tanakas = idOf('田中さんの面談')
    expect(stateOf(tanakas)).toBe('arrived')
    expect(fieldsOf(tanakas).assignee ?? null).toBeNull()
    expect(await requests(tanakas, 'ar-tanaka')).toEqual([])
    // Nor tried: its text was never read with anyone's Google (the try before a reading).
    const doc = `fake-doc-ar-3`
    expect(google.requests.filter(q => q.path.includes(doc) && (q.path.includes('/export') || q.path.startsWith('/v1/documents')))).toEqual([])

    // None for the series: the setting (全部) decides again.
    const back = await call('ar-sato', 'PUT', `${C()}/me/minutes/item/${weekly}/auto-series`, { auto: null })
    expect(back.body.data).toEqual({ recordId: weekly, autoSeries: false, seriesChoice: null })
    await poll()
    expect(stateOf(weekly2)).toBe('received')
    expect(await requests(weekly2)).toEqual([{ actor_id: 'acb:clock', note: '自動で読む設定のため、AI に読ませました' }])
    // 読む for the series reads it whatever the setting says, and says so.
    await setMode('ar-sato', 'off')
    expect((await call('ar-sato', 'PUT', `${C()}/me/minutes/item/${weekly}/auto-series`, { auto: true })).body.data.seriesChoice).toBe('auto')
    await poll()
    expect(stateOf(weekly)).toBe('received')
    expect((await requests(weekly))[0].note).toBe('この定例は自動で読む設定のため、AI に読ませました')
  })

  it('two attendees who both want it: one reader, and nothing more on the next run', async () => {
    at('2026-11-26T09:00:00+09:00')
    await setMode('ar-sato', 'outside')
    await setMode('ar-tanaka', 'outside')
    at('2026-11-26T18:00:00+09:00')
    await poll()
    const sales2 = idOf('商談2')
    expect(stateOf(sales2)).toBe('received')
    expect(await requests(sales2)).toHaveLength(1)
    const reader = fieldsOf(sales2).assignee
    expect(['ar-sato', 'ar-tanaka']).toContain(reader)
    await poll()
    expect(await requests(sales2)).toHaveLength(1)
    expect(fieldsOf(sales2).assignee).toBe(reader)
  })

  it('a try of the text Google refused is not made again for an hour; Google asking to wait is tried on the next run', async () => {
    at('2026-11-27T09:00:00+09:00')
    await setMode('ar-tanaka', 'off')
    const doc = 'fake-doc-ar-7'
    const textReads = () => google.requests.filter(q => q.path.includes(doc) && (q.path.includes('/export') || q.path.startsWith('/v1/documents'))).length
    google.faults.refuseDocs(doc)
    google.faults.refuseExport(doc, 'cannotExportFile')
    at('2026-11-27T18:00:00+09:00')
    await poll()
    const sales3 = idOf('商談3')
    expect(stateOf(sales3)).toBe('arrived')
    const tried = textReads()
    expect(tried).toBeGreaterThan(0)
    at('2026-11-27T18:30:00+09:00')
    await poll()
    expect(textReads()).toBe(tried)
    // Google asking to wait: not remembered as a refusal.
    google.faults.reset()
    google.faults.refuseDocs(doc)
    google.faults.refuseExport(doc, 'userRateLimitExceeded')
    at('2026-11-27T19:05:00+09:00')
    await poll()
    const busy = textReads()
    expect(busy).toBeGreaterThan(tried)
    await poll()
    expect(textReads()).toBeGreaterThan(busy)
    expect(stateOf(sales3)).toBe('arrived')
    google.faults.reset()
    at('2026-11-27T19:10:00+09:00')
    await poll()
    expect(stateOf(sales3)).toBe('received')
    expect(fieldsOf(sales3).assignee).toBe('ar-sato')
  })

  it('the member\'s choice is read again after the try of the text: turned off meanwhile, nothing is asked', async () => {
    at('2026-11-28T18:00:00+09:00')
    const doc = 'fake-doc-ar-8'
    const docCalls = () => google.requests.filter(q => q.path.includes(doc)).map(q => q.path)
    google.faults.delayMs = 300
    const run = poll()
    // Wait until discovery has recorded it and the try of the text has begun (a text read is on its way).
    for (let i = 0; i < 400 && !docCalls().some(p => p.includes('/export') || p.startsWith('/v1/documents')) && docCalls().length < 2; i++) await new Promise(r => setTimeout(r, 10))
    expect(docCalls().length).toBeGreaterThanOrEqual(2)
    await setMode('ar-sato', 'off')
    await run
    google.faults.reset()
    const sales4 = idOf('商談4')
    expect(stateOf(sales4)).toBe('arrived')
    expect(await requests(sales4)).toEqual([])
  })

  it('the try of the text counts against the run\'s Google budget: a spent run leaves it to the next', async () => {
    at('2026-11-29T09:00:00+09:00')
    await setMode('ar-sato', 'outside')
    at('2026-11-29T18:00:00+09:00')
    const doc = 'fake-doc-ar-9'
    const textReads = () => google.requests.filter(q => q.path.includes(doc) && (q.path.includes('/export') || q.path.startsWith('/v1/documents'))).length
    // Two calendars (2) and the meeting's discovery (4): one call left, a try needs two.
    await services.minutes.pollCompany(CO, async () => {}, 7)
    const sales5 = idOf('商談5')
    expect(stateOf(sales5)).toBe('arrived')
    expect(textReads()).toBe(0)
    await poll()
    expect(stateOf(sales5)).toBe('received')
    expect(fieldsOf(sales5).assignee).toBe('ar-sato')
  })
})

describe('the organiser first (owner decisions 2026-11-25)', () => {
  const TAKEN = '主催者の AI が読み始めなかったため、自動で読む設定のほかの参加者の AI に読ませました'
  const AUTO = '自動で読む設定のため、AI に読ませました'

  it('within 15 minutes of arriving another attendee waits for the organiser, who reads it; arrivals say the reader is the organiser', async () => {
    at('2026-11-30T09:00:00+09:00')
    await setMode('ar-sato', 'outside')
    await setMode('ar-tanaka', 'outside')
    at('2026-11-30T18:00:00+09:00')
    await check('ar-tanaka')
    const m = idOf('主催1')
    expect(stateOf(m)).toBe('arrived')
    at('2026-11-30T18:05:00+09:00')
    await check('ar-tanaka')
    expect(stateOf(m)).toBe('arrived')
    await check('ar-sato')
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-sato'])
    expect(await requests(m)).toEqual([{ actor_id: 'acb:clock', note: AUTO }])
    expect((await arrivals('ar-tanaka')).find(i => i.recordId === m)).toMatchObject({ status: 'asked', by: { memberId: 'ar-sato' }, byOrganiser: true })
  })

  it('after the window another attendee reads it when the organiser\'s clock has not asked (not the organiser: no 「主催」)', async () => {
    at('2026-12-01T18:00:00+09:00')
    await check('ar-tanaka')
    const m = idOf('主催2')
    expect(stateOf(m)).toBe('arrived')
    at('2026-12-01T18:15:00+09:00')
    await check('ar-tanaka')
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-tanaka'])
    expect((await arrivals('ar-sato')).find(i => i.recordId === m)).toMatchObject({ by: { memberId: 'ar-tanaka' }, byOrganiser: false })
    // The organiser's run afterwards does nothing: the first ask won.
    const before = ledgerCount()
    await check('ar-sato')
    expect(ledgerCount()).toBe(before)
  })

  it('a reading asked for the organiser that has not started is taken over once 15 minutes old, once; the organiser\'s start then does nothing', async () => {
    at('2026-12-02T18:00:00+09:00')
    await check('ar-tanaka')
    const m = idOf('主催3')
    expect(stateOf(m)).toBe('arrived')
    // The organiser's clock asks five minutes after the meeting arrived.
    at('2026-12-02T18:05:00+09:00')
    await check('ar-sato')
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-sato'])
    const asked = await versionOf(m)
    // The window since arriving is over, but the ask is not 15 minutes old yet.
    at('2026-12-02T18:19:00+09:00')
    await check('ar-tanaka')
    expect(fieldsOf(m).assignee).toBe('ar-sato')
    at('2026-12-02T18:20:00+09:00')
    // The organiser never takes it from themself.
    const mine = ledgerCount()
    await check('ar-sato')
    expect(ledgerCount()).toBe(mine)
    await check('ar-tanaka')
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-tanaka'])
    expect(await requests(m)).toEqual([{ actor_id: 'acb:clock', note: AUTO }, { actor_id: 'acb:clock', note: TAKEN }])
    // The organiser's PC opens later: its start at the version it read is refused, nothing changes.
    const token = await tokenFor('ar-sato')
    const late = await call(null, 'POST', `/api/records-ai/item/${m}/actions/start_reading`, { expectedVersion: asked }, token)
    expect([403, 409]).toContain(late.status)
    // Nor at the version now, nor by claiming the reading's run: it is no longer the organiser's AI's turn.
    const now = await call(null, 'POST', `/api/records-ai/item/${m}/actions/start_reading`, { expectedVersion: await versionOf(m) }, token)
    expect(now.status, now.text).toBe(403)
    const claim = await call('ar-sato', 'POST', `${C()}/ai-run-claims`, { recordId: m, step: 'minutes-reading', deviceId: 'app-device-sato', conversationId: 'conv-org3' })
    expect([claim.status, claim.body.code]).toEqual([409, 'NOT_AI_TURN'])
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-tanaka'])
    // Once: nobody's later run moves it again.
    at('2026-12-02T18:45:00+09:00')
    const before = ledgerCount()
    await check('ar-tanaka')
    await check('ar-sato')
    expect(ledgerCount()).toBe(before)
  })

  it('never while the organiser\'s app holds the reading\'s run — automatically or by a press; a run whose lease ran out holds nothing', async () => {
    at('2026-12-03T18:00:00+09:00')
    await check('ar-sato')
    const m = idOf('主催4')
    at('2026-12-03T18:14:00+09:00')
    const claimed = await call('ar-sato', 'POST', `${C()}/ai-run-claims`, { recordId: m, step: 'minutes-reading', deviceId: 'app-device-sato', conversationId: 'conv-org4' })
    expect(claimed.status, claimed.text).toBeLessThan(300)
    at('2026-12-03T18:16:00+09:00')
    await check('ar-tanaka')
    expect(fieldsOf(m).assignee).toBe('ar-sato')
    const pressed = await press('ar-tanaka', m)
    expect([pressed.status, pressed.body.code]).toEqual([409, 'MEETING_NOT_WAITING'])
    expect(fieldsOf(m).assignee).toBe('ar-sato')
    // Never renewed: five minutes after the claim nobody holds it.
    at('2026-12-03T18:20:00+09:00')
    await check('ar-tanaka')
    expect(fieldsOf(m).assignee).toBe('ar-tanaka')
  })

  it('never after the organiser\'s reading started, also once it was put back — automatically or by a press', async () => {
    at('2026-12-07T18:00:00+09:00')
    await check('ar-sato')
    const m = idOf('主催8')
    const token = await tokenFor('ar-sato', 'conv-org8')
    expect((await call(null, 'POST', `/api/records-ai/item/${m}/actions/start_reading`, { expectedVersion: await versionOf(m) }, token)).status).toBe(200)
    expect((await press('ar-tanaka', m)).status).toBe(409)
    // Stuck for over 30 minutes: the server puts it back for the organiser.
    at('2026-12-07T18:31:00+09:00')
    await check('ar-sato')
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-sato'])
    await check('ar-tanaka')
    expect(fieldsOf(m).assignee).toBe('ar-sato')
    const pressed = await press('ar-tanaka', m)
    expect([pressed.status, pressed.body.code]).toEqual([409, 'MEETING_NOT_WAITING'])
    expect(fieldsOf(m).assignee).toBe('ar-sato')
  })

  it('never a person\'s own press — neither by the clock nor by another person\'s press', async () => {
    at('2026-12-04T09:00:00+09:00')
    await setMode('ar-sato', 'off')
    at('2026-12-04T18:00:00+09:00')
    await check('ar-sato')
    const m = idOf('主催5')
    expect(stateOf(m)).toBe('arrived')
    expect((await press('ar-sato', m)).status).toBe(200)
    at('2026-12-04T18:30:00+09:00')
    await check('ar-tanaka')
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-sato'])
    const pressed = await press('ar-tanaka', m)
    expect([pressed.status, pressed.body.code]).toEqual([409, 'MEETING_NOT_WAITING'])
    expect(fieldsOf(m).assignee).toBe('ar-sato')
  })

  it('never by someone who is not attending; an organiser not on the list is not waited for', async () => {
    at('2026-12-05T09:00:00+09:00')
    await setMode('ar-sato', 'outside')
    at('2026-12-05T18:00:00+09:00')
    await check('ar-sato')
    const declined = idOf('主催6')
    expect(fieldsOf(declined).assignee).toBe('ar-sato')
    at('2026-12-05T18:30:00+09:00')
    await check('ar-tanaka')
    expect(fieldsOf(declined).assignee).toBe('ar-sato')

    at('2026-12-06T18:00:00+09:00')
    await check('ar-sato')
    await check('ar-tanaka')
    const notOn = idOf('主催7')
    expect([stateOf(notOn), fieldsOf(notOn).assignee]).toEqual(['received', 'ar-tanaka'])
  })

  it('a person\'s own press takes a meeting the clock asked for someone else at once; that reader\'s start then does nothing', async () => {
    at('2026-12-08T18:00:00+09:00')
    await check('ar-sato')
    const m = idOf('主催9')
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-sato'])
    const asked = await versionOf(m)
    at('2026-12-08T18:01:00+09:00')
    const pressed = await press('ar-tanaka', m)
    expect(pressed.status, pressed.text).toBe(200)
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-tanaka'])
    expect((await requests(m)).map(r => r.actor_id)).toEqual(['acb:clock', 'ar-tanaka'])
    const token = await tokenFor('ar-sato', 'conv-org9')
    expect([403, 409]).toContain((await call(null, 'POST', `/api/records-ai/item/${m}/actions/start_reading`, { expectedVersion: asked }, token)).status)
    expect(fieldsOf(m).assignee).toBe('ar-tanaka')
    // The organiser pressing back is another person's press: refused.
    const back = await press('ar-sato', m)
    expect([back.status, back.body.code]).toEqual([409, 'MEETING_NOT_WAITING'])
  })

  it('an organiser who would not read it is not waited for; a reading the clock asked for someone else than the organiser is never taken over automatically', async () => {
    at('2026-12-09T09:00:00+09:00')
    await setMode('ar-sato', 'off')
    await setMode('ar-yamada', 'outside')
    at('2026-12-09T18:00:00+09:00')
    await check('ar-tanaka')
    const m = idOf('主催10')
    expect([stateOf(m), fieldsOf(m).assignee]).toEqual(['received', 'ar-tanaka'])
    at('2026-12-09T18:30:00+09:00')
    const before = ledgerCount()
    await check('ar-yamada')
    expect(ledgerCount()).toBe(before)
    expect(fieldsOf(m).assignee).toBe('ar-tanaka')
    // A press is a person reading it themself: allowed whoever the clock asked it for.
    expect((await press('ar-yamada', m)).status).toBe(200)
    expect(fieldsOf(m).assignee).toBe('ar-yamada')
  })

  it('an attendee whose automatic reading is off never takes it over (a press still does)', async () => {
    at('2026-12-10T09:00:00+09:00')
    await setMode('ar-sato', 'outside')
    await setMode('ar-tanaka', 'off')
    at('2026-12-10T18:00:00+09:00')
    await check('ar-sato')
    const m = idOf('主催11')
    expect(fieldsOf(m).assignee).toBe('ar-sato')
    at('2026-12-10T18:30:00+09:00')
    const before = ledgerCount()
    await check('ar-tanaka')
    expect(ledgerCount()).toBe(before)
    expect(fieldsOf(m).assignee).toBe('ar-sato')
  })

  it('a press whose reading the organiser\'s app claims while its try of the text is on its way writes nothing', async () => {
    at('2026-12-11T09:00:00+09:00')
    await setMode('ar-tanaka', 'outside')
    at('2026-12-11T18:00:00+09:00')
    await check('ar-sato')
    const m = idOf('主催12')
    expect(fieldsOf(m).assignee).toBe('ar-sato')
    const doc = 'fake-doc-ar-21'
    // Any Google call about its document: the try of the text has begun (each call is held 300 ms).
    const textReads = () => google.requests.filter(q => q.path.includes(doc)).length
    const seen = textReads()
    google.faults.delayMs = 300
    const pressing = press('ar-tanaka', m)
    for (let i = 0; i < 400 && textReads() === seen; i++) await new Promise(r => setTimeout(r, 10))
    expect(textReads()).toBeGreaterThan(seen)
    const claimed = await call('ar-sato', 'POST', `${C()}/ai-run-claims`, { recordId: m, step: 'minutes-reading', deviceId: 'app-device-sato', conversationId: 'conv-org12' })
    expect(claimed.status, claimed.text).toBeLessThan(300)
    const pressed = await pressing
    google.faults.reset()
    expect([pressed.status, pressed.body.code]).toEqual([409, 'MEETING_NOT_WAITING'])
    expect(fieldsOf(m).assignee).toBe('ar-sato')
  })

  it('the organiser who chose 読まない is not 「the reader」: no 「（主催）」', async () => {
    at('2026-12-12T09:00:00+09:00')
    await setMode('ar-sato', 'off')
    await setMode('ar-tanaka', 'off')
    at('2026-12-12T18:00:00+09:00')
    await check('ar-sato')
    const m = idOf('主催13')
    expect((await call('ar-sato', 'POST', `${C()}/me/minutes/item/${m}/skip`, {})).status).toBe(200)
    expect((await arrivals('ar-tanaka')).find(i => i.recordId === m)).toMatchObject({ status: 'skipped', by: { memberId: 'ar-sato' }, byOrganiser: false })
  })

  it('the reader\'s own press on a meeting the clock asked for them makes it theirs: never taken over afterwards', async () => {
    at('2026-12-13T09:00:00+09:00')
    await setMode('ar-sato', 'outside')
    await setMode('ar-tanaka', 'outside')
    at('2026-12-13T18:00:00+09:00')
    await check('ar-sato')
    const m = idOf('主催14')
    expect(fieldsOf(m).assignee).toBe('ar-sato')
    expect((await press('ar-sato', m)).status).toBe(200)
    expect((await requests(m)).map(r => r.actor_id)).toEqual(['acb:clock', 'ar-sato'])
    // A second press writes nothing more.
    const once = ledgerCount()
    expect((await press('ar-sato', m)).status).toBe(200)
    expect(ledgerCount()).toBe(once)
    const pressed = await press('ar-tanaka', m)
    expect([pressed.status, pressed.body.code]).toEqual([409, 'MEETING_NOT_WAITING'])
    at('2026-12-13T18:30:00+09:00')
    await check('ar-tanaka')
    expect(fieldsOf(m).assignee).toBe('ar-sato')
  })

  it('an automatic takeover whose reading the organiser\'s app claims while its try of the text is on its way writes nothing', async () => {
    at('2026-12-14T18:00:00+09:00')
    await check('ar-sato')
    const m = idOf('主催15')
    expect(fieldsOf(m).assignee).toBe('ar-sato')
    at('2026-12-14T18:20:00+09:00')
    const doc = 'fake-doc-ar-24'
    const calls = () => google.requests.filter(q => q.path.includes(doc)).length
    const seen = calls()
    google.faults.delayMs = 300
    const taking = check('ar-tanaka')
    for (let i = 0; i < 400 && calls() === seen; i++) await new Promise(r => setTimeout(r, 10))
    expect(calls()).toBeGreaterThan(seen)
    const claimed = await call('ar-sato', 'POST', `${C()}/ai-run-claims`, { recordId: m, step: 'minutes-reading', deviceId: 'app-device-sato', conversationId: 'conv-org15' })
    expect(claimed.status, claimed.text).toBeLessThan(300)
    await taking
    google.faults.reset()
    expect(fieldsOf(m).assignee).toBe('ar-sato')
    expect((await requests(m)).map(r => r.actor_id)).toEqual(['acb:clock'])
  })
})
