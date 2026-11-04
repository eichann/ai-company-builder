/**
 * Integration Test: meetings found from Google on the server clock and seen by their attendees only
 * (owner decision 2026-11-04, `.claude/rules/minutes.md` "Meetings for their attendees"), end to end
 * against the fake Google with real routes, services, database and Google permissions.
 *
 * What it protects (each mutation-checked):
 * - the clock finds meetings without any app: one members-only record per conference (two members
 *   finding it make one), `arrived` (nobody's turn), no folder, no assignee; each attendee told once;
 * - attendees are matched only by the address Google verified for a member (their grant), never by
 *   the self-chosen ACB email (a member registered with a colleague's address is not added); an
 *   organizer who is not on the attendee list is not one of its people;
 * - only attending members see it — not a member who declined, not one who was not invited, not the
 *   company's owner or an admin — on every route (the item, the list, 「議事録が届きました」, notices);
 * - an attendee the calendar adds later joins (and is told); one removed stays; another event on
 *   the same Meet (a copied event, a reused link) never widens the list;
 * - an event marked private — in anyone's copy — is never recorded, and its Meet record is never
 *   looked up; one that turns private after it was recorded gets no one added or told;
 * - Google calls: a known event is not looked up again, a meeting not ended is not looked up, minutes
 *   not there yet are looked for again only after a wait, a run stops at its budget and at a rate
 *   limit, and the newest meetings come first;
 * - ［AI に読ませる］ only by an attendee; one whose Google is not shared the minutes hears so and
 *   another attendee may press instead; the presser becomes the assignee and it is their AI's turn;
 * - ［読まない］ by any attendee ends it and says who; it can still be read later;
 * - 「この定例は次から自動で読む」 is the member's own and asks the AI to read the next meeting of
 *   the series that their discovery finds;
 * - 「届きました」 shows meetings of the last 3 days; older ones stay openable and readable;
 * - Drive opening the minutes but refusing their text (Gemini's notes): the press says what happened,
 *   by Google's reason, before any AI turn, and the reason is in the log; the other document and
 *   Meet's own record of what was said are still read;
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
  // Registered in ACB with Tanaka's address (sign-up does not verify it); has no Google grant.
  'ma-mallory': { email: GOOGLE_SEED.colleague, name: 'なりすまし' },
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
const EV = { weekly: 'fakeweekly0001', weeklyNext: 'fakeweekly0002', hr: 'fakehr0001', retro: 'fakeretro0001', talk: 'faketalk0001', copy: 'fakecopy0001' }
const YAMADA = 'yamada@div.example'
const DOC = { weekly: 'fake-doc-weekly-0001', weeklyNext: 'fake-doc-weekly-0002', hr: 'fake-doc-hr-0001', retro: 'fake-doc-retro-0001', retroTranscript: 'fake-doc-retro-transcript-01', talk: 'fake-doc-talk-0001' }
/** Lines of the minutes that must never be kept anywhere. */
const SECRET_LINES = ['来期の採用は2名に絞ることで合意した', '評価面談で本人から退職の相談があった', 'ふりかえりで出た改善点は3つ', '打ち合わせの結論は保留', 'ふりかえりの文字起こしの一文', '最後に話した振り返りの結論']

function seed(): GoogleSeed {
  const base = defaultGoogleSeed()
  const accepted = (email: string) => ({ email, responseStatus: 'accepted' as const })
  const ev = (id: string, summary: string, start: string, end: string, code: string, attendees: GoogleSeed['events'][number]['attendees'], extra: Partial<GoogleSeed['events'][number]> = {}) =>
    ({ id, summary, start, end, organizer: S.member, attendees, meetingCode: code, ...extra })
  const conf = (id: string, code: string, startTime: string, participants: string[], doc: string, state: 'FILE_GENERATED' | 'STARTED' = 'FILE_GENERATED') => ({
    id, meetingCode: code, space: `spaces/${id}`, startTime, endTime: startTime, participants,
    smartNotes: [{ id: `note-${id}`, state, docId: doc }], transcripts: [],
  })
  const doc = (id: string, text: string, readers: string[]) => ({ id, name: id, owner: S.member, readers, createdByMeet: true, text, version: 3, modifiedTime: '2026-11-04T04:00:00.000Z' })
  // Fifty meetings of 11/19 with no Meet record, and the newest one of 11/20 (Sato's only).
  const code = (n: number) => { const l = (k: number) => String.fromCharCode(97 + (Math.floor(n / 26 ** k) % 26)); return `${l(0)}${l(1)}z-zzzz-${l(0)}zz` }
  const fillers = Array.from({ length: 50 }, (_, n) => ev(`fakefiller${String(n).padStart(4, '0')}`, `予定 ${n}`, '2026-11-19T10:00:00+09:00', '2026-11-19T10:30:00+09:00', code(n), [accepted(S.member)]))
  return {
    ...base,
    users: [...base.users, { email: YAMADA, sub: '110000000000000000009', name: '山田 葵', givenName: '葵', familyName: '山田', hd: S.internalDomain }],
    events: [
      // A weekly meeting: Sato, Tanaka; Kato declined. Its minutes are shared with Sato only.
      ev(EV.weekly, '定例ミーティング', '2026-11-04T12:00:00+09:00', '2026-11-04T12:45:00+09:00', 'aaa-bbbb-ccc',
        [accepted(S.member), accepted(S.colleague), { email: 'kato@div.example', responseStatus: 'declined' }], { recurringEventId: SERIES }),
      // Yamada's own event on the same Meet link at the same time (a copied event): not that meeting.
      { id: EV.copy, summary: '別の予定', start: '2026-11-04T12:00:00+09:00', end: '2026-11-04T12:45:00+09:00', organizer: YAMADA, attendees: [accepted(YAMADA)], meetingCode: 'aaa-bbbb-ccc' },
      // Right after it, on the same personal Meet link: not that meeting (its record stays the weekly's).
      ev('fakeb2b0001', '続けての打ち合わせ', '2026-11-04T12:45:00+09:00', '2026-11-04T13:30:00+09:00', 'aaa-bbbb-ccc', [accepted(S.member)]),
      // Marked private in the calendar: never recorded.
      ev(EV.hr, '評価面談', '2026-11-04T10:00:00+09:00', '2026-11-04T10:30:00+09:00', 'hhh-iiii-jjj', [accepted(S.member), accepted(S.colleague)], { visibility: 'private' }),
      // Private in Tanaka's copy only: still never recorded (Sato's copy is not).
      ev('fakemixed0001', '個別の相談', '2026-11-04T11:00:00+09:00', '2026-11-04T11:30:00+09:00', 'mmm-nnnn-ooo', [accepted(S.member), accepted(S.colleague)], { privateFor: [S.colleague] }),
      ev(EV.retro, 'ふりかえり', '2026-11-04T15:00:00+09:00', '2026-11-04T15:30:00+09:00', 'rrr-ssss-ttt', [accepted(S.member), accepted(S.colleague)]),
      ev(EV.talk, '打ち合わせ', '2026-11-04T16:00:00+09:00', '2026-11-04T16:30:00+09:00', 'kkk-llll-mmm', [accepted(S.member), accepted(S.colleague), { email: YAMADA, responseStatus: 'declined' }]),
      // Sato organizes but is not on the attendee list.
      ev('fakeorganized01', '田中さんの面談', '2026-11-04T13:00:00+09:00', '2026-11-04T13:30:00+09:00', 'ooo-pppp-qqq', [accepted(S.colleague)]),
      // Notes not generated yet; and a meeting not over yet.
      ev('fakepending0001', '準備会', '2026-11-04T14:00:00+09:00', '2026-11-04T14:30:00+09:00', 'ppp-qqqq-rrr', [accepted(S.member), accepted(S.colleague)]),
      ev('fakefuture0001', '夕会', '2026-11-04T17:00:00+09:00', '2026-11-04T18:00:00+09:00', 'fff-gggg-hhh', [accepted(S.member), accepted(S.colleague)]),
      // Next week's instance of the weekly meeting.
      ev(EV.weeklyNext, '定例ミーティング', '2026-11-11T12:00:00+09:00', '2026-11-11T12:45:00+09:00', 'aaa-bbbb-ddd',
        [accepted(S.member), accepted(S.colleague)], { recurringEventId: SERIES }),
      ...fillers,
      ev('fakenewest0001', 'いちばん新しい会議', '2026-11-20T09:00:00+09:00', '2026-11-20T09:30:00+09:00', 'nnn-wwww-sss', [accepted(S.member)]),
    ],
    conferences: [
      conf('fake-conf-weekly-0001', 'aaa-bbbb-ccc', '2026-11-04T03:00:10.000Z', [S.member, S.colleague, YAMADA], DOC.weekly),
      conf('fake-conf-hr-0001', 'hhh-iiii-jjj', '2026-11-04T01:00:10.000Z', [S.member, S.colleague], DOC.hr),
      conf('fake-conf-mixed-0001', 'mmm-nnnn-ooo', '2026-11-04T02:00:10.000Z', [S.member, S.colleague], DOC.hr),
      {
        ...conf('fake-conf-retro-0001', 'rrr-ssss-ttt', '2026-11-04T06:00:10.000Z', [S.member, S.colleague], DOC.retro),
        // More entries than one page of Meet's answer.
        transcripts: [{ id: 'transcript-retro', state: 'FILE_GENERATED' as const, docId: DOC.retroTranscript, entries: [
          ...Array.from({ length: 120 }, (_, n) => ({ speaker: '田中 誠', text: `相づち${n}` })),
          { speaker: '佐藤 健', text: SECRET_LINES[5] },
        ] }],
      },
      conf('fake-conf-talk-0001', 'kkk-llll-mmm', '2026-11-04T07:00:10.000Z', [S.member, S.colleague], DOC.talk),
      conf('fake-conf-organized-01', 'ooo-pppp-qqq', '2026-11-04T04:00:10.000Z', [S.member, S.colleague], DOC.talk),
      conf('fake-conf-pending-0001', 'ppp-qqqq-rrr', '2026-11-04T05:00:10.000Z', [S.member, S.colleague], DOC.talk, 'STARTED'),
      conf('fake-conf-future-0001', 'fff-gggg-hhh', '2026-11-04T08:00:10.000Z', [S.member, S.colleague], DOC.talk),
      conf('fake-conf-weekly-0002', 'aaa-bbbb-ddd', '2026-11-11T03:00:10.000Z', [S.member, S.colleague], DOC.weeklyNext),
      conf('fake-conf-newest-0001', 'nnn-wwww-sss', '2026-11-20T00:00:10.000Z', [S.member], DOC.weeklyNext),
    ],
    docs: [
      doc(DOC.weekly, `会議メモ\n${SECRET_LINES[0]}\n`, [S.member]),
      doc(DOC.hr, `会議メモ\n${SECRET_LINES[1]}\n`, [S.member, S.colleague]),
      doc(DOC.retro, `会議メモ\n${SECRET_LINES[2]}\n`, [S.member, S.colleague]),
      doc(DOC.retroTranscript, `文字起こし\n${SECRET_LINES[4]}\n`, [S.member, S.colleague]),
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
  for (const [u, role] of [['ma-admin', 'admin'], ['ma-sato', 'member'], ['ma-tanaka', 'member'], ['ma-yamada', 'member'], ['ma-kato', 'member'], ['ma-mallory', 'member']]) {
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

let weekly: string, retro: string, talk: string, organized: string
const lookups = (code?: string) => google.requests.filter(q => q.path.startsWith('/v2/conferenceRecords') && (!code || JSON.stringify(q).includes(code))).length

describe('found on the server clock', () => {
  it('one members-only record per conference for its attending members, arrived; private events (in anyone\'s copy) are never recorded', async () => {
    at('2026-11-04T17:30:00+09:00')
    google.requests.length = 0
    // Both Sato's and Tanaka's calendars show the meetings: one record each, made once.
    const run = await services.serverClock.runOnce()
    expect(run.ran).toBe(true)
    expect(run.meetingsFound).toBe(4)
    const rows = meetings()
    expect(rows).toHaveLength(4)
    weekly = idByTitle('定例ミーティング', '2026-11-04')
    retro = idByTitle('ふりかえり', '2026-11-04')
    talk = idByTitle('打ち合わせ', '2026-11-04')
    organized = idByTitle('田中さんの面談', '2026-11-04')
    for (const r of rows) {
      expect(r).toMatchObject({ state: 'arrived', folder: null, personal_owner: '@members' })
      expect(fieldsOf(r.id).assignee ?? null).toBeNull()
    }
    // Kato declined; Yamada was not invited; Mallory registered with Tanaka's address but Google never verified it.
    expect(listOf(weekly)).toEqual(['ma-sato', 'ma-tanaka'])
    expect(JSON.parse(fieldsOf(weekly).attendees).sort()).toEqual(['ma-sato', 'ma-tanaka'])
    for (const r of rows) expect(listOf(r.id)).not.toContain('ma-mallory')
    // The organizer who is not on the attendee list is not one of its people.
    expect(listOf(organized)).toEqual(['ma-tanaka'])
    // The ledger names no one's calendar.
    const history = (await call('ma-sato', 'GET', `${C()}/records/item/${weekly}/history`)).body.data.entries as Json[]
    const note = history.find(e => e.action === 'create').note as string
    expect(note).toBe('カレンダーの予定から見つけました')
    expect(meetings().some(m => titleOf(m.id) === '続けての打ち合わせ')).toBe(false)
    // Private events: no record, and their Meet codes never left ACB — also the one private in Tanaka's copy only.
    expect(meetings().some(m => ['評価面談', '個別の相談'].includes(titleOf(m.id)))).toBe(false)
    expect(lookups('hhh-iiii-jjj')).toBe(0)
    expect(lookups('mmm-nnnn-ooo')).toBe(0)
    // A meeting not over yet is not looked up.
    expect(lookups('fff-gggg-hhh')).toBe(0)
    // Each attendee told once per meeting; a second run makes nothing new.
    expect(notices('ma-sato').map(n => n.record_id).sort()).toEqual([weekly, retro, talk].sort())
    expect(notices('ma-tanaka')).toHaveLength(4)
    expect(await poll()).toBe(0)
    expect(meetings()).toHaveLength(4)
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

  it('Google calls: known events are not looked up again; minutes not there yet are looked for again only after a wait', async () => {
    const pendingBefore = lookups('ppp-qqqq-rrr')
    expect(pendingBefore).toBeGreaterThan(0)
    google.requests.length = 0
    await poll()
    // Recorded meetings, the pending one (waiting) and the one not over: no Meet call at all.
    expect(lookups()).toBe(0)
    at('2026-11-04T17:36:00+09:00')
    await poll()
    expect(lookups('ppp-qqqq-rrr')).toBeGreaterThan(0)
    expect(lookups('rrr-ssss-ttt')).toBe(0)
  })

  it('only the attending members see it: not a member who declined or was not invited, not the owner or an admin, not another company', async () => {
    for (const u of ['ma-sato', 'ma-tanaka']) expect((await call(u, 'GET', `${C()}/records/item/${weekly}`)).status).toBe(200)
    const missing = await call('ma-sato', 'GET', `${C()}/records/item/meeting-000000000000000000000000`)
    for (const u of ['ma-kato', 'ma-yamada', 'ma-owner', 'ma-admin', 'ma-mallory']) {
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
    expect(mine.map(i => i.title)).toEqual(['打ち合わせ', 'ふりかえり', '田中さんの面談', '定例ミーティング'])
    expect(mine.find(i => i.recordId === weekly)).toMatchObject({ status: 'arrived', attendeeCount: 2, by: null, series: true, autoSeries: false })
  })

  it('another event on the same Meet (a copied event) never widens the list or renames it; who declined never joins', async () => {
    await allow('ma-yamada', YAMADA)
    await poll()
    expect(listOf(weekly)).toEqual(['ma-sato', 'ma-tanaka'])
    expect(titleOf(weekly)).toBe('定例ミーティング')
    expect(notices('ma-yamada')).toEqual([])
    expect(listOf(talk)).not.toContain('ma-yamada')
  })

  it('an attendee the calendar adds later joins and is told; one removed stays', async () => {
    google.changeEvent(EV.weekly, { addAttendee: YAMADA, removeAttendee: S.colleague })
    // While Yamada's Google grant is stopped, Google's word for that address does not count.
    const sealed = (db.prepare("SELECT refresh_token_sealed FROM connector_grants WHERE company_id = ? AND user_id = 'ma-yamada'").get(CO) as Json).refresh_token_sealed
    db.prepare("UPDATE connector_grants SET status = 'stopped', refresh_token_sealed = NULL WHERE company_id = ? AND user_id = 'ma-yamada'").run(CO)
    await poll()
    expect(listOf(weekly)).toEqual(['ma-sato', 'ma-tanaka'])
    db.prepare("UPDATE connector_grants SET status = 'active', refresh_token_sealed = ? WHERE company_id = ? AND user_id = 'ma-yamada'").run(sealed, CO)
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

  it('a meeting that turns private after it was recorded is kept, and no one is added to it or told any more', async () => {
    google.changeEvent(EV.retro, { visibility: 'private', addAttendee: YAMADA })
    await poll()
    expect(listOf(retro)).toEqual(['ma-sato', 'ma-tanaka'])
    expect(notices('ma-yamada').map(n => n.record_id)).not.toContain(retro)
    expect((await call('ma-sato', 'GET', `${C()}/records/item/${retro}`)).status).toBe(200)
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

describe('the meeting\'s people', () => {
  it('anyone on its list chooses 「まとまりはない」 on an arrived meeting, and an invited member may ask for the text (Google decides)', async () => {
    const nb = await call('ma-tanaka', 'POST', `${C()}/me/minutes/item/${organized}/no-bundle`, {})
    expect(nb.status, nb.text).toBe(200)
    const v = stateOf(organized).version
    const invited = await call('ma-tanaka', 'POST', `${C()}/records/item/${organized}/members`, { add: ['ma-yamada'], expectedVersion: v })
    expect(invited.status, invited.text).toBe(200)
    const t = await call('ma-yamada', 'GET', `${C()}/me/minutes/item/${organized}/text`)
    // On the list, so not refused as someone else's; the minutes are not shared with Yamada in Google.
    expect([t.status, t.body.code]).toEqual([403, 'MINUTES_NO_ACCESS'])
  })
})

describe('Drive opens the minutes but refuses their text (Gemini\'s notes in production)', () => {
  const press = (id: string) => call('ma-tanaka', 'POST', `${C()}/me/minutes/item/${id}/read-request`, {})
  const textOf = (id: string) => call('ma-tanaka', 'GET', `${C()}/me/minutes/item/${id}/text`)

  it('the press says what happened, by Google\'s reason, and nothing changes: it was tried, not left to a failed AI turn', async () => {
    const before = stateOf(organized)
    for (const [reason, status, code, words] of [
      ['appNotAuthorizedToFile', 403, 'MINUTES_TEXT_REFUSED', 'いま ACB に許可している範囲'],
      ['insufficientPermissions', 403, 'MINUTES_TEXT_REFUSED', 'いま ACB に許可している範囲'],
      ['cannotExportFile', 403, 'MINUTES_TEXT_REFUSED', 'ファイルの持ち主がコピーやダウンロードを止めている'],
      ['exportSizeLimitExceeded', 403, 'MINUTES_TOO_LARGE', '大きすぎて'],
      ['someNewReason', 403, 'MINUTES_TEXT_REFUSED', 'Google が文章の取り出しを断りました'],
      ['userRateLimitExceeded', 503, 'GOOGLE_UNAVAILABLE', '少し待って'],
      ['accessNotConfigured', 403, 'GOOGLE_STOPPED', 'Google の管理者'],
    ] as const) {
      google.faults.reset()
      google.faults.refuseExport(DOC.talk, reason)
      const r = await press(organized)
      expect([r.status, r.body.code], reason).toEqual([status, code])
      expect(r.body.error, reason).toContain(words)
      // It is shared: never the sentence that sends another attendee to press instead.
      expect(r.body.error, reason).not.toContain('共有されていません')
      expect(stateOf(organized), reason).toEqual(before)
      expect(fieldsOf(organized).assignee ?? null, reason).toBeNull()
    }
    google.faults.reset()
  })

  it('Google\'s short reason and the operation are in the server log, without Google\'s message', async () => {
    google.faults.refuseExport(DOC.talk, 'appNotAuthorizedToFile')
    logLines.length = 0
    await textOf(organized)
    google.faults.reset()
    const line = logLines.find(l => l.includes('[google] call refused'))
    expect(line).toContain('operation=drive.files.export status=403 reason=appNotAuthorizedToFile')
    expect(logLines.join('\n')).not.toContain('has not granted')
  })

  it('notes refused: the transcript document is still read, and the AI is told the notes were not', async () => {
    google.faults.refuseExport(DOC.retro)
    google.requests.length = 0
    const t = await textOf(retro)
    google.faults.reset()
    expect(t.status, t.text).toBe(200)
    expect(t.body.data.text).toContain(SECRET_LINES[4])
    expect(t.body.data.text).toContain('■ 会議メモ\n（Google が文章の取り出しを断ったため')
    expect(t.body.data.text).not.toContain(SECRET_LINES[2])
    expect(google.requests.some(q => q.path.endsWith('/entries'))).toBe(false)
  })

  it('both refused: what was said comes from Meet\'s own record, with who said it, every page; the press goes through', async () => {
    google.faults.refuseExport(DOC.retro)
    google.faults.refuseExport(DOC.retroTranscript)
    const t = await textOf(retro)
    expect(t.status, t.text).toBe(200)
    expect(t.body.data.text).toContain('■ 文字起こし（Google Meet の記録から）\n田中 誠: 相づち0\n')
    expect(t.body.data.text).toContain(`佐藤 健: ${SECRET_LINES[5]}`)
    expect(t.body.data.text).not.toContain('■ 文字起こし\n')
    const r = await press(retro)
    google.faults.reset()
    expect(r.status, r.text).toBe(200)
    expect(stateOf(retro).state).toBe('received')
    // Back where the 3-day window's test expects it.
    expect((await call('ma-tanaka', 'POST', `${C()}/me/minutes/item/${retro}/skip`, {})).status).toBe(200)
  })

  it('copying blocked by the file\'s owner: Meet\'s record is no way around it, also when only one document says so', async () => {
    for (const [notes, transcript] of [['cannotExportFile', 'cannotExportFile'], ['cannotDownloadFile', 'cannotDownload'], ['appNotAuthorizedToFile', 'cannotExportFile'], ['cannotExportFile', 'appNotAuthorizedToFile']]) {
      google.faults.reset()
      google.faults.refuseExport(DOC.retro, notes)
      google.faults.refuseExport(DOC.retroTranscript, transcript)
      google.requests.length = 0
      const before = stateOf(retro)
      const t = await textOf(retro)
      const r = await press(retro)
      for (const answer of [t, r]) {
        expect([answer.status, answer.body.code], `${notes}/${transcript}`).toEqual([403, 'MINUTES_TEXT_REFUSED'])
        expect(answer.body.error).toContain('ファイルの持ち主がコピーやダウンロードを止めている')
      }
      expect(JSON.stringify(t.body)).not.toContain(SECRET_LINES[5])
      expect(google.requests.some(q => q.path.includes('/transcripts'))).toBe(false)
      expect(stateOf(retro)).toEqual(before)
    }
    google.faults.reset()
  })

  it('Meet\'s record stands in only for what ACB is not allowed: any other refusal stops', async () => {
    for (const reason of ['appNotAuthorizedToFile', 'insufficientPermissions', 'insufficientScopes', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']) {
      google.faults.reset()
      google.faults.refuseExport(DOC.retro, reason)
      google.faults.refuseExport(DOC.retroTranscript, reason)
      const t = await textOf(retro)
      expect(t.status, reason).toBe(200)
      expect(t.body.data.text, reason).toContain('■ 文字起こし（Google Meet の記録から）')
    }
    google.faults.reset()
    google.faults.refuseExport(DOC.retro, 'someNewReason')
    google.faults.refuseExport(DOC.retroTranscript, 'someNewReason')
    google.requests.length = 0
    expect((await textOf(retro)).body.code).toBe('MINUTES_TEXT_REFUSED')
    expect(google.requests.some(q => q.path.includes('/transcripts'))).toBe(false)
    google.faults.reset()
  })

  it('a document Drive does not open stays 「共有されていません」: Meet\'s record is no way around the sharing', async () => {
    google.requests.length = 0
    const t = await call('ma-tanaka', 'GET', `${C()}/me/minutes/item/${weekly}/text`)
    expect([t.status, t.body.code]).toEqual([403, 'MINUTES_NO_ACCESS'])
    expect(google.requests.some(q => q.path.includes('/transcripts'))).toBe(false)
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
    // 「届きました」 holds only meetings whose list names the member: a meeting made before (a
    // department's, readable by all) is not one of them.
    db.prepare("UPDATE records SET personal_owner = NULL, folder = NULL WHERE company_id = ? AND id = ?").run(CO, next)
    db.prepare('DELETE FROM record_viewers WHERE company_id = ? AND record_id = ?').run(CO, next)
    expect((await call('ma-yamada', 'GET', `${C()}/records/item/${next}`)).status).toBe(200)
    expect((await arrivals('ma-yamada')).map(i => i.recordId)).not.toContain(next)
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

describe('a busy calendar', () => {
  it('Google asking to slow down stops that member\'s run until the next one; then the newest meeting comes first and a run stops at its budget', async () => {
    at('2026-11-20T12:00:00+09:00')
    google.requests.length = 0
    // Every Meet lookup refused with 429 (the client retries twice): Sato's run stops at the first.
    google.faults.failOn('/v2/conferenceRecords', 3, 429)
    await services.minutes.pollCompany(CO, async () => {}, 1000)
    expect(lookups()).toBe(3)
    expect(meetings().some(m => titleOf(m.id) === 'いちばん新しい会議')).toBe(false)
    // A small budget: the members' calendars, then the newest meeting only — the rest waits for the next run.
    google.requests.length = 0
    await services.minutes.pollCompany(CO, async () => {}, 9)
    expect(meetings().some(m => titleOf(m.id) === 'いちばん新しい会議')).toBe(true)
    expect(google.requests.filter(q => q.path === '/v2/conferenceRecords').length).toBe(1)
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
