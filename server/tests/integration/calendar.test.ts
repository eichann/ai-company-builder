/**
 * Integration Test: 「今日の予定」 (stage 2 S7a, `.claude/rules/calendar.md`), end to end against
 * the fake Google the way staging runs it (the practice redirect: ACB_ALLOW_FAKE_UPSTREAMS=1 +
 * ACB_FAKE_GOOGLE_URL), with the real route, services, database, key broker and Google permissions.
 *
 * What it protects (each mutation-checked):
 * - a member reads only their own calendar, with their own permission: a colleague's meeting never
 *   shows, and a member without a permission gets nothing even though colleagues have one;
 * - a permission is the company's: the same person in another company (no Google there) reads
 *   nothing; a non-member gets 404;
 * - "today" is the company's day (Japan time), not the server's UTC day;
 * - no permission / Google off / Google failing → 200, an empty list and a reason;
 * - nothing is kept: no title in any table or log line; `Cache-Control: no-store`;
 * - the answer has counts and flags only, never an attendee's address.
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

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const EMAILS: Record<string, { email: string; name: string }> = {
  'cal-owner': { email: 'owner@div.example', name: '阿部 部長' },
  'cal-sato': { email: GOOGLE_SEED.member, name: '佐藤 健' },
  'cal-tanaka': { email: GOOGLE_SEED.colleague, name: '田中 誠' },
  'cal-yamada': { email: 'yamada@div.example', name: '山田 葵' },
  'cal-other-owner': { email: 'boss@other.example', name: '他社 社長' },
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
const CLIENT_ID = '123456789012-calendar.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-calendar-0123456789'
const ts = () => new Date().toISOString()
const SALES_TITLE = '研修導入のご相談（株式会社サンプル）'
const INTERNAL_TITLE = '営業定例（社内）'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let google: FakeGoogle
let googleServer: ServerType
let kekDir: string
let CO: string
const OTHER = 'cal-other'
const logLines: string[] = []

async function call(user: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json; text: string; headers: Headers }> {
  currentUser.id = user
  const res: Response = await app.request(`${PUBLIC}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body: json, text, headers: res.headers }
}
const C = (co = CO) => `/api/companies/${co}`
const today = (user: string, co = CO) => call(user, 'GET', `${C(co)}/me/calendar/today`)
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

function listen(fetchFn: (req: Request) => Response | Promise<Response>): Promise<ServerType> {
  return new Promise(resolve => {
    const s = serve({ fetch: fetchFn, port: 0, hostname: '127.0.0.1' }, () => resolve(s))
  })
}

/** Every text cell of every table of the app database. */
function everyStoredText(): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  return tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n')
}

beforeAll(async () => {
  google = createFakeGoogle({ seed: defaultGoogleSeed() })
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  googleServer = await listen(google.app.fetch)

  kekDir = mkdtempSync(join(tmpdir(), 'acb-cal-kek-'))
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
  const { requestLog } = await import('../../src/lib/request-log')
  app = new Hono()
  app.use('*', requestLog())
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/calendar')).calendarRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)

  const company = await services.companies.create('cal-owner', 'Calendar', 'calendar-co')
  CO = company.id
  for (const u of ['cal-sato', 'cal-tanaka', 'cal-yamada']) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, 'member', ts(), ts())
  }
  // Another company: its owner, and 佐藤 is a member there too (no Google set up there).
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(OTHER, OTHER, OTHER, 'cal-other-owner', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-cal-other', 'cal-other-owner', OTHER, 'owner', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-cal-sato-other', 'cal-sato', OTHER, 'member', ts(), ts())

  expect((await call('cal-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
  await allow('cal-sato', GOOGLE_SEED.member)
  await allow('cal-tanaka', GOOGLE_SEED.colleague)
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterAll(async () => {
  vi.useRealTimers()
  google.close()
  await new Promise(r => googleServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL']) delete process.env[k]
})

describe('GET /me/calendar/today', () => {
  it("the member's own meetings today: times, title, online, how many and whether outside people — no addresses", async () => {
    at('2026-11-05T09:00:00+09:00')
    const r = await today('cal-sato')
    expect(r.status, r.text).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.body.data).toEqual({
      date: '2026-11-05',
      timeZone: 'Asia/Tokyo',
      reason: null,
      events: [
        { id: GOOGLE_SEED.internalEvent, title: INTERNAL_TITLE, start: '2026-11-05T01:00:00.000Z', end: '2026-11-05T01:30:00.000Z', allDay: false, online: true, attendeeCount: 2, hasExternalAttendees: false },
        { id: GOOGLE_SEED.salesEvent, title: SALES_TITLE, start: '2026-11-05T05:00:00.000Z', end: '2026-11-05T06:00:00.000Z', allDay: false, online: true, attendeeCount: 3, hasExternalAttendees: true },
      ],
    })
    expect(r.text).not.toContain('@')
  })

  it("a member never reads a colleague's calendar: only meetings they are on, with their own permission", async () => {
    at('2026-11-05T09:00:00+09:00')
    const t = await today('cal-tanaka')
    expect(t.status, t.text).toBe(200)
    expect(t.body.data.events.map((e: Json) => e.title)).toEqual([INTERNAL_TITLE])
    expect(t.text).not.toContain(SALES_TITLE)
    // 山田 never allowed Google: nothing, although 佐藤 and 田中 have a permission in this company.
    const before = google.requests.length
    const y = await today('cal-yamada')
    expect(y.status, y.text).toBe(200)
    expect(y.body.data).toMatchObject({ events: [], reason: 'not-connected' })
    expect(google.requests.length).toBe(before)
  })

  it("today is the company's day (Japan time), not the server's UTC day", async () => {
    // 00:30 in Tokyo on 11-05 is still 11-04 in UTC.
    at('2026-11-05T00:30:00+09:00')
    const r = await today('cal-sato')
    expect(r.body.data.date).toBe('2026-11-05')
    expect(r.body.data.events.map((e: Json) => e.id)).toEqual([GOOGLE_SEED.internalEvent, GOOGLE_SEED.salesEvent])
    // 23:30 in Tokyo on 11-04: nothing yet.
    at('2026-11-04T23:30:00+09:00')
    const before = await today('cal-sato')
    expect(before.body.data).toMatchObject({ date: '2026-11-04', events: [], reason: null })
  })

  it('cross-company: a non-member gets 404; the same person in another company has no permission there', async () => {
    at('2026-11-05T09:00:00+09:00')
    expect((await today('cal-other-owner')).status).toBe(404)
    expect((await today('cal-sato', 'no-such-company')).status).toBe(404)
    const before = google.requests.length
    const other = await today('cal-sato', OTHER)
    expect(other.status, other.text).toBe(200)
    expect(other.body.data).toMatchObject({ events: [], reason: 'stopped' })
    expect(google.requests.length).toBe(before)
    expect((await call(null, 'GET', `${C()}/me/calendar/today`)).status).toBe(401)
  })

  it('Google off for the company → stopped; Google failing → unavailable; both an empty list, not an error', async () => {
    at('2026-11-05T09:00:00+09:00')
    expect((await call('cal-owner', 'PUT', `${C()}/google/enabled`, { enabled: false })).status).toBe(200)
    const before = google.requests.length
    const off = await today('cal-sato')
    expect([off.status, off.body.data.reason, off.body.data.events]).toEqual([200, 'stopped', []])
    expect(google.requests.length).toBe(before)
    expect((await call('cal-owner', 'PUT', `${C()}/google/enabled`, { enabled: true })).status).toBe(200)

    google.faults.failNext(5, 500)
    const failing = await today('cal-sato')
    google.faults.reset()
    expect([failing.status, failing.body.data.reason, failing.body.data.events]).toEqual([200, 'unavailable', []])
    expect((await today('cal-sato')).body.data.events).toHaveLength(2)
  })

  it('the permission ended (「許可をやめる」) → not-connected from the next call', async () => {
    at('2026-11-05T09:00:00+09:00')
    expect((await call('cal-tanaka', 'DELETE', `${C()}/me/google`)).status).toBe(200)
    const r = await today('cal-tanaka')
    expect(r.body.data).toMatchObject({ events: [], reason: 'not-connected' })
  })

  it('nothing is kept: no meeting title in any table or log line', () => {
    const stored = everyStoredText()
    const logs = logLines.join('\n')
    for (const title of [SALES_TITLE, INTERNAL_TITLE]) {
      expect(stored).not.toContain(title)
      expect(logs).not.toContain(title)
    }
  })
})
