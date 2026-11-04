/**
 * Integration Test: meetings found from Google on the server clock and seen by their attendees only
 * (owner decision 2026-11-04, `.claude/rules/minutes.md` "Meetings for their attendees"), end to end
 * against the fake Google with real routes, services, database and Google permissions.
 *
 * What it protects (each mutation-checked):
 * - the clock finds meetings without any app: one members-only record per conference (two members
 *   finding it make one), `arrived` (nobody's turn), no folder, no assignee; each attendee told once;
 * - only attending members see it — not a member who declined, not one who was not invited, not the
 *   company's owner or an admin — on every route (the item, the list, 「議事録が届きました」, notices);
 * - an attendee the calendar adds later joins (and is told); one removed stays;
 * - an event marked private is never recorded, and its Meet record is never looked up;
 * - ［AI に読ませる］ only by an attendee; one whose Google is not shared the minutes hears so and
 *   another attendee may press instead; the presser becomes the assignee and it is their AI's turn;
 * - ［読まない］ by any attendee ends it and says who; it can still be read later;
 * - 「この定例は次から自動で読む」 is the member's own and asks the AI to read the next meeting of
 *   the series that their discovery finds;
 * - 「届きました」 shows meetings of the last 3 days; older ones stay openable and readable;
 * - nothing of the minutes' text is stored; the older app's check and the folder setting stay harmless.
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

const EMAILS: Record<string, { email: string; name: string }> = {
  'ma-owner': { email: 'owner@div.example', name: '阿部 部長' },
  'ma-admin': { email: 'admin@div.example', name: '管理 太郎' },
  'ma-sato': { email: GOOGLE_SEED.member, name: '佐藤 健' },
  'ma-tanaka': { email: GOOGLE_SEED.colleague, name: '田中 誠' },
  'ma-yamada': { email: 'yamada@div.example', name: '山田 葵' },
  'ma-kato': { email: 'kato@div.example', name: '加藤 涼' },
  'ma-other-owner': { email: 'boss@other.example', name: '他社 社長' },
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
const PUBLIC = 'http://localhost:13003'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-attendees.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-attendees-0123456789'
const ts = () => new Date().toISOString()

const S = GOOGLE_SEED
const SERIES = 'fakeseries0001'
const EV = { weekly: 'fakeweekly0001', weeklyNext: 'fakeweekly0002', hr: 'fakehr0001', retro: 'fakeretro0001', talk: 'faketalk0001' }
const DOC = { weekly: 'fake-doc-weekly-0001', weeklyNext: 'fake-doc-weekly-0002', hr: 'fake-doc-hr-0001', retro: 'fake-doc-retro-0001', talk: 'fake-doc-talk-0001' }
/** Lines of the minutes that must never be kept anywhere. */
const SECRET_LINES = ['来期の採用は2名に絞ることで合意した', '評価面談で本人から退職の相談があった', 'ふりかえりで出た改善点は3つ', '打ち合わせの結論は保留']

function seed(): GoogleSeed {
  const base = defaultGoogleSeed()
  const accepted = (email: string) => ({ email, responseStatus: 'accepted' as const })
  const ev = (id: string, summary: string, start: string, end: string, code: string, attendees: GoogleSeed['events'][number]['attendees'], extra: Partial<GoogleSeed['events'][number]> = {}) =>
    ({ id, summary, start, end, organizer: S.member, attendees, meetingCode: code, ...extra })
  const conf = (id: string, code: string, startTime: string, participants: string[], doc: string) => ({
    id, meetingCode: code, space: `spaces/${id}`, startTime, endTime: startTime, participants,
    smartNotes: [{ id: `note-${id}`, state: 'FILE_GENERATED' as const, docId: doc }], transcripts: [],
  })
  const doc = (id: string, text: string, readers: string[]) => ({ id, name: id, owner: S.member, readers, createdByMeet: true, text, version: 3, modifiedTime: '2026-11-04T04:00:00.000Z' })
  return {
    ...base,
    events: [
      // A weekly meeting: Sato, Tanaka; Kato declined. Its minutes are shared with Sato only.
      ev(EV.weekly, '定例ミーティング', '2026-11-04T12:00:00+09:00', '2026-11-04T12:45:00+09:00', 'aaa-bbbb-ccc',
        [accepted(S.member), accepted(S.colleague), { email: 'kato@div.example', responseStatus: 'declined' }], { recurringEventId: SERIES }),
      // Marked private in the calendar: never recorded.
      ev(EV.hr, '評価面談', '2026-11-04T10:00:00+09:00', '2026-11-04T10:30:00+09:00', 'hhh-iiii-jjj', [accepted(S.member), accepted(S.colleague)], { visibility: 'private' }),
      ev(EV.retro, 'ふりかえり', '2026-11-04T15:00:00+09:00', '2026-11-04T15:30:00+09:00', 'rrr-ssss-ttt', [accepted(S.member), accepted(S.colleague)]),
      ev(EV.talk, '打ち合わせ', '2026-11-04T16:00:00+09:00', '2026-11-04T16:30:00+09:00', 'kkk-llll-mmm', [accepted(S.member), accepted(S.colleague)]),
      // Next week's instance of the weekly meeting.
      ev(EV.weeklyNext, '定例ミーティング', '2026-11-11T12:00:00+09:00', '2026-11-11T12:45:00+09:00', 'aaa-bbbb-ddd',
        [accepted(S.member), accepted(S.colleague)], { recurringEventId: SERIES }),
    ],
    conferences: [
      conf('fake-conf-weekly-0001', 'aaa-bbbb-ccc', '2026-11-04T03:00:10.000Z', [S.member, S.colleague], DOC.weekly),
      conf('fake-conf-hr-0001', 'hhh-iiii-jjj', '2026-11-04T01:00:10.000Z', [S.member, S.colleague], DOC.hr),
      conf('fake-conf-retro-0001', 'rrr-ssss-ttt', '2026-11-04T06:00:10.000Z', [S.member, S.colleague], DOC.retro),
      conf('fake-conf-talk-0001', 'kkk-llll-mmm', '2026-11-04T07:00:10.000Z', [S.member, S.colleague], DOC.talk),
      conf('fake-conf-weekly-0002', 'aaa-bbbb-ddd', '2026-11-11T03:00:10.000Z', [S.member, S.colleague], DOC.weeklyNext),
    ],
    docs: [
      doc(DOC.weekly, `会議メモ\n${SECRET_LINES[0]}\n`, [S.member]),
      doc(DOC.hr, `会議メモ\n${SECRET_LINES[1]}\n`, [S.member, S.colleague]),
      doc(DOC.retro, `会議メモ\n${SECRET_LINES[2]}\n`, [S.member, S.colleague]),
      doc(DOC.talk, `会議メモ\n${SECRET_LINES[3]}\n`, [S.member, S.colleague]),
      doc(DOC.weeklyNext, `会議メモ\n${SECRET_LINES[0]}（2回目）\n`, [S.member]),
    ],
    mails: [],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let google: FakeGoogle
let googleServer: ServerType
let kekDir: string
let CO: string
const OTHER = 'ma-other'
const logLines: string[] = []
const answers: string[] = []

async function call(user: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json; text: string }> {
  currentUser.id = user
  const res: Response = await app.request(`${PUBLIC}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  if (!/\/minutes\/(item\/)?[^/]+\/text$/.test(path)) answers.push(text)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body: json, text }
}
const C = (co = CO) => `/api/companies/${co}`
const at = (iso: string) => vi.setSystemTime(new Date(iso))
const poll = () => services.minutes.pollCompany(CO) as Promise<number>
const meetings = () => db.prepare("SELECT r.id, r.folder, r.personal_owner, s.state, s.fields FROM records r JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id WHERE r.company_id = ? AND r.type = 'meeting' ORDER BY r.created_at, r.id").all(CO) as Json[]
const listOf = (id: string) => (db.prepare('SELECT user_id FROM record_viewers WHERE company_id = ? AND record_id = ? ORDER BY user_id').all(CO, id) as Json[]).map(r => r.user_id)
const fieldsOf = (id: string) => JSON.parse((db.prepare('SELECT fields FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).fields)
const stateOf = (id: string) => (db.prepare('SELECT state, version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json)
const titleOf = (id: string) => withRecordText(db, CO, db.prepare('SELECT id, title FROM records WHERE company_id = ? AND id = ?').all(CO, id) as Json[])[0]?.title
const idByTitle = (title: string, day: string) => meetings().find(m => titleOf(m.id) === title && fieldsOf(m.id).meeting_at.startsWith(day))?.id as string
const notices = (user: string) => db.prepare("SELECT kind, record_id FROM notifications WHERE company_id = ? AND user_id = ? AND kind = 'minutes_arrived'").all(CO, user) as Json[]
const arrivals = async (user: string) => (await call(user, 'GET', `${C()}/me/minutes/arrivals`)).body.data.items as Json[]

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

function listen(fetchFn: (req: Request) => Response | Promise<Response>): Promise<ServerType> {
  return new Promise(resolve => {
    const s = serve({ fetch: fetchFn, port: 0, hostname: '127.0.0.1' }, () => resolve(s))
  })
}

beforeAll(async () => {
  google = createFakeGoogle({ seed: seed() })
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  googleServer = await listen(google.app.fetch)
  kekDir = mkdtempSync(join(tmpdir(), 'acb-ma-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
  })
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logLines.push(args.map(String).join(' ')) })
  }
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/minutes')).minutesRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/notifications')).notificationsRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)

  const company = await services.companies.create('ma-owner', 'Attendees', 'attendees-co')
  CO = company.id
  for (const [u, role] of [['ma-admin', 'admin'], ['ma-sato', 'member'], ['ma-tanaka', 'member'], ['ma-yamada', 'member'], ['ma-kato', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, role, ts(), ts())
  }
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(OTHER, OTHER, OTHER, 'ma-other-owner', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-ma-other', 'ma-other-owner', OTHER, 'owner', ts(), ts())
  expect((await call('ma-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: S.internalDomain })).status).toBe(200)
  await allow('ma-sato', S.member)
  await allow('ma-tanaka', S.colleague)
  expect((await call('ma-owner', 'PUT', `${C()}/records/settings`, { enabled: true })).status).toBe(200)
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterAll(async () => {
  vi.useRealTimers()
  google.close()
  await new Promise(r => googleServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL']) delete process.env[k]
})

let weekly: string, retro: string, talk: string

describe('found on the server clock', () => {
  it('one members-only record per conference for its attending members, arrived; a private event is never recorded', async () => {
    at('2026-11-04T17:30:00+09:00')
    google.requests.length = 0
    // Both Sato's and Tanaka's calendars show the meetings: one record each, made once.
    const run = await services.serverClock.runOnce()
    expect(run.ran).toBe(true)
    expect(run.meetingsFound).toBe(3)
    const rows = meetings()
    expect(rows).toHaveLength(3)
    weekly = idByTitle('定例ミーティング', '2026-11-04')
    retro = idByTitle('ふりかえり', '2026-11-04')
    talk = idByTitle('打ち合わせ', '2026-11-04')
    for (const r of rows) {
      expect(r).toMatchObject({ state: 'arrived', folder: null, personal_owner: '@members' })
      expect(fieldsOf(r.id).assignee ?? null).toBeNull()
    }
    // Kato declined: not on the list; Yamada was not invited.
    expect(listOf(weekly)).toEqual(['ma-sato', 'ma-tanaka'])
    expect(JSON.parse(fieldsOf(weekly).attendees).sort()).toEqual(['ma-sato', 'ma-tanaka'])
    // The private event: no record, and its Meet code never left ACB.
    expect(meetings().some(m => titleOf(m.id) === '評価面談')).toBe(false)
    expect(google.requests.some(q => q.path === '/v2/conferenceRecords' && JSON.stringify(q).includes('hhh-iiii-jjj'))).toBe(false)
    // Each attendee told once per meeting; a second run makes nothing new.
    expect(notices('ma-sato').map(n => n.record_id).sort()).toEqual([weekly, retro, talk].sort())
    expect(notices('ma-tanaka')).toHaveLength(3)
    expect(await poll()).toBe(0)
    expect(meetings()).toHaveLength(3)
    expect(notices('ma-sato')).toHaveLength(3)
    // Told again about the same arrival (a retried notify): still once.
    const created = db.prepare("SELECT * FROM record_ledger WHERE company_id = ? AND record_id = ? AND action = 'create'").get(CO, weekly) as Json
    services.notifications.recordChange(CO, ['ma-sato'], {
      type: 'meeting', fields: fieldsOf(weekly),
      entry: { recordId: weekly, version: created.version, action: 'create', fromState: null, toState: 'arrived', actorId: 'google', actorKind: 'external', actorSource: 'google', at: created.at, note: '', changes: [], attachments: [], decision: null, isDecision: false, typeVersion: 5, reversesVersion: null },
    })
    expect(notices('ma-sato')).toHaveLength(3)
    const bell = await call('ma-tanaka', 'GET', `${C()}/me/notifications`)
    expect(bell.body.data.items.map((i: Json) => i.text)).toContain('議事録が届きました：「定例ミーティング」')
  })

  it('only the attending members see it: not a member who declined or was not invited, not the owner or an admin, not another company', async () => {
    for (const u of ['ma-sato', 'ma-tanaka']) expect((await call(u, 'GET', `${C()}/records/item/${weekly}`)).status).toBe(200)
    const missing = await call('ma-sato', 'GET', `${C()}/records/item/meeting-000000000000000000000000`)
    for (const u of ['ma-kato', 'ma-yamada', 'ma-owner', 'ma-admin']) {
      const r = await call(u, 'GET', `${C()}/records/item/${weekly}`)
      expect([r.status, r.body]).toEqual([404, missing.body])
      expect(await arrivals(u)).toEqual([])
      expect(notices(u)).toEqual([])
      const q = await call(u, 'POST', `${C()}/records/query`, { type: 'meeting' })
      expect(q.body.data.total).toBe(0)
      // Not an attendee: the buttons answer as for a missing record.
      expect((await call(u, 'POST', `${C()}/me/minutes/item/${weekly}/read-request`, {})).status).toBe(404)
      expect((await call(u, 'POST', `${C()}/me/minutes/item/${weekly}/skip`, {})).status).toBe(404)
    }
    expect((await call('ma-other-owner', 'GET', `${C(OTHER)}/records/item/${weekly}`)).status).toBe(404)
    expect((await call('ma-other-owner', 'POST', `${C(OTHER)}/me/minutes/item/${weekly}/read-request`, {})).status).toBe(404)
    const mine = await arrivals('ma-tanaka')
    expect(mine.map(i => i.title)).toEqual(['打ち合わせ', 'ふりかえり', '定例ミーティング'])
    expect(mine.find(i => i.recordId === weekly)).toMatchObject({ status: 'arrived', attendeeCount: 2, by: null, series: true, autoSeries: false })
  })

  it('an attendee the calendar adds later joins and is told; one removed stays', async () => {
    google.changeEvent(EV.weekly, { addAttendee: 'yamada@div.example', removeAttendee: S.colleague })
    await poll()
    expect(listOf(weekly)).toEqual(['ma-sato', 'ma-tanaka', 'ma-yamada'])
    expect(notices('ma-yamada').map(n => n.record_id)).toEqual([weekly])
    expect((await call('ma-yamada', 'GET', `${C()}/records/item/${weekly}`)).status).toBe(200)
    expect((await call('ma-tanaka', 'GET', `${C()}/records/item/${weekly}`)).status).toBe(200)
    // Still nobody's turn, and the joining is in its 経緯 as the calendar's doing.
    expect(stateOf(weekly).state).toBe('arrived')
    const entry = db.prepare("SELECT actor_id FROM record_ledger WHERE company_id = ? AND record_id = ? AND action = 'attendees_joined'").get(CO, weekly) as Json
    expect(entry.actor_id).toBe('google')
    await poll()
    expect(notices('ma-yamada')).toHaveLength(1)
  })
})

describe('［AI に読ませる］ and ［読まない］', () => {
  it('an attendee whose Google is not shared the minutes hears so; another presses and becomes the reader, the AI\'s turn on their PC', async () => {
    const refused = await call('ma-tanaka', 'POST', `${C()}/me/minutes/item/${weekly}/read-request`, {})
    expect([refused.status, refused.body.code]).toEqual([403, 'MINUTES_NO_ACCESS'])
    expect(refused.body.error).toContain('ほかの出席者が［AI に読ませる］を押す')
    expect(stateOf(weekly).state).toBe('arrived')
    const r = await call('ma-sato', 'POST', `${C()}/me/minutes/item/${weekly}/read-request`, {})
    expect(r.status, r.text).toBe(200)
    expect(r.body.data.state).toBe('received')
    expect(fieldsOf(weekly).assignee).toBe('ma-sato')
    const satoTurn = await call('ma-sato', 'GET', `${C()}/records/ai-turn`)
    expect(satoTurn.body.data.records.map((x: Json) => x.id)).toContain(weekly)
    const tanakaTurn = await call('ma-tanaka', 'GET', `${C()}/records/ai-turn`)
    expect(tanakaTurn.body.data.records.map((x: Json) => x.id)).not.toContain(weekly)
    // Pressed again by the reader: nothing more; by someone else now: it is already asked.
    const again = await call('ma-sato', 'POST', `${C()}/me/minutes/item/${weekly}/read-request`, {})
    expect([again.status, again.body.data.version]).toEqual([200, r.body.data.version])
    expect((await call('ma-yamada', 'POST', `${C()}/me/minutes/item/${weekly}/read-request`, {})).body.code).toBe('MEETING_NOT_WAITING')
    // The reader's text: read now with their own Google.
    const t = await call('ma-sato', 'GET', `${C()}/me/minutes/item/${weekly}/text`)
    expect(t.status, t.text).toBe(200)
    expect(t.body.data.folder).toBeNull()
    expect((await arrivals('ma-tanaka')).find(i => i.recordId === weekly)).toMatchObject({ status: 'asked', by: { memberId: 'ma-sato', displayName: '佐藤 健' }, byYou: false })
  })

  it('［読まない］ by any attendee ends it for everyone and says who; it can still be read later', async () => {
    const r = await call('ma-tanaka', 'POST', `${C()}/me/minutes/item/${talk}/skip`, {})
    expect(r.status, r.text).toBe(200)
    expect(stateOf(talk).state).toBe('skipped')
    expect((await arrivals('ma-sato')).find(i => i.recordId === talk)).toMatchObject({ status: 'skipped', by: { memberId: 'ma-tanaka' }, byYou: false })
    expect((await call('ma-tanaka', 'POST', `${C()}/me/minutes/item/${talk}/skip`, {})).status).toBe(200)
    // The reader's 「今回だけ読まない」 only: an attendee cannot take back someone else's request.
    expect((await call('ma-tanaka', 'POST', `${C()}/me/minutes/item/${weekly}/skip`, {})).body.code).toBe('MEETING_NOT_WAITING')
    const later = await call('ma-sato', 'POST', `${C()}/me/minutes/item/${talk}/read-request`, {})
    expect(later.status, later.text).toBe(200)
    expect(fieldsOf(talk).assignee).toBe('ma-sato')
  })
})

describe('「この定例は次から自動で読む」', () => {
  it('is the member\'s own; the next meeting of the series their discovery finds is the AI\'s turn for them', async () => {
    expect((await call('ma-sato', 'PUT', `${C()}/me/minutes/item/${retro}/auto-series`, { auto: true })).body.code).toBe('MEETING_NOT_SERIES')
    expect((await call('ma-sato', 'PUT', `${C()}/me/minutes/item/${weekly}/auto-series`, { auto: 'yes' })).status).toBe(400)
    expect((await call('ma-kato', 'PUT', `${C()}/me/minutes/item/${weekly}/auto-series`, { auto: true })).status).toBe(404)
    const r = await call('ma-sato', 'PUT', `${C()}/me/minutes/item/${weekly}/auto-series`, { auto: true })
    expect(r.status, r.text).toBe(200)
    expect((await arrivals('ma-sato')).find(i => i.recordId === weekly)?.autoSeries).toBe(true)
    expect((await arrivals('ma-tanaka')).find(i => i.recordId === weekly)?.autoSeries).toBe(false)

    at('2026-11-11T17:30:00+09:00')
    await poll()
    const next = idByTitle('定例ミーティング', '2026-11-11')
    expect(next).toBeTruthy()
    expect(stateOf(next).state).toBe('received')
    expect(fieldsOf(next).assignee).toBe('ma-sato')
    const entry = db.prepare("SELECT actor_id, note FROM record_ledger WHERE company_id = ? AND record_id = ? AND action = 'request_reading'").get(CO, next) as Json
    expect(entry.actor_id).toBe('acb:clock')
    // A reading stuck for over 30 minutes goes back to the AI's turn on the clock, without any app.
    db.prepare("UPDATE record_state SET state = 'reading', updated_at = '2026-11-11T07:00:00.000Z' WHERE company_id = ? AND record_id = ?").run(CO, next)
    await poll()
    expect(stateOf(next).state).toBe('received')
    const back = db.prepare("SELECT actor_id FROM record_ledger WHERE company_id = ? AND record_id = ? AND action = 'retry'").get(CO, next) as Json
    expect(back.actor_id).toBe('acb:clock')
  })
})

describe('the 3-day window', () => {
  it('「届きました」 lists meetings of the last 3 days; an older one stays openable and readable', async () => {
    at('2026-11-08T13:30:00+09:00')
    expect((await arrivals('ma-tanaka')).map(i => i.recordId)).not.toContain(retro)
    expect((await call('ma-tanaka', 'GET', `${C()}/records/item/${retro}`)).status).toBe(200)
    const r = await call('ma-tanaka', 'POST', `${C()}/me/minutes/item/${retro}/read-request`, {})
    expect(r.status, r.text).toBe(200)
    expect(fieldsOf(retro).assignee).toBe('ma-tanaka')
  })
})

describe('older apps and what is kept', () => {
  it('the app\'s check runs the same discovery for its member; the folder setting is answered and changes nothing', async () => {
    const r = await call('ma-sato', 'POST', `${C()}/me/minutes/check`, {})
    expect(r.status, r.text).toBe(200)
    expect(r.body.data).toMatchObject({ checked: true })
    expect(r.body.data.reason).toBeUndefined()
    const got = await call('ma-owner', 'GET', `${C()}/google/minutes-folder`)
    expect(got.status).toBe(200)
    expect((await call('ma-sato', 'PUT', `${C()}/google/minutes-folder`, { folder: null })).status).toBe(403)
  })

  it('nothing of the minutes\' text is in any table, log line or other answer', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Json[]).map(t => t.name as string)
    for (const table of tables) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all())
      for (const line of SECRET_LINES) expect(dump, table).not.toContain(line)
    }
    for (const line of SECRET_LINES) {
      expect(logLines.join('\n')).not.toContain(line)
      expect(answers.join('\n')).not.toContain(line)
    }
  })
})
