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
 *   another attendee sees whose AI will read it.
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
  'ar-owner': { email: 'owner@div.example', name: '阿部 部長' },
  'ar-sato': { email: GOOGLE_SEED.member, name: '佐藤 健' },
  'ar-tanaka': { email: GOOGLE_SEED.colleague, name: '田中 誠' },
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
  const doc = (id: string) => ({ id, name: id, owner: S.member, readers: [S.member, S.colleague], createdByMeet: true, text: '会議メモ\n話したこと\n', version: 3, modifiedTime: '2026-11-24T04:00:00.000Z' })
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
  ]
  return {
    ...base,
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

async function call(user: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json; text: string }> {
  currentUser.id = user
  const res: Response = await app.request(`${PUBLIC}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body: json, text }
}
const C = () => `/api/companies/${CO}`
const at = (iso: string) => vi.setSystemTime(new Date(iso))
const poll = () => services.minutes.pollCompany(CO) as Promise<number>
const meetingIds = () => (db.prepare("SELECT id FROM records WHERE company_id = ? AND type = 'meeting'").all(CO) as Json[]).map(r => r.id as string)
const titleOf = (id: string) => withRecordText(db, CO, db.prepare('SELECT id, title FROM records WHERE company_id = ? AND id = ?').all(CO, id) as Json[])[0]?.title
const idOf = (title: string) => meetingIds().find(id => titleOf(id) === title) as string
const fieldsOf = (id: string) => JSON.parse((db.prepare('SELECT fields FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).fields)
const stateOf = (id: string) => (db.prepare('SELECT state FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).state as string
/** The reading requests in the meeting's history (notes are kept in the content store, read through the route). */
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
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)

  const company = await services.companies.create('ar-owner', 'AutoRead', 'auto-read-co')
  CO = company.id
  // They join after the setting exists: no row, the starting value 「社外の人がいる会議だけ」.
  for (const u of ['ar-sato', 'ar-tanaka']) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, 'member', ts(), ts())
  }
  expect((await call('ar-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: S.internalDomain })).status).toBe(200)
  await allow('ar-sato', S.member)
  await allow('ar-tanaka', S.colleague)
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
})
