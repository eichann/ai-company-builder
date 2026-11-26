/**
 * Streaming a picked Drive video (google-drive.md "Streaming a picked video"; the model: model/drive-view/) end to end
 * against the fake Google, which serves `alt=media` with Range from seeded bytes and reports how each answer ended.
 *
 * What it protects (each mutation-checked, see the PR):
 * - the session route only, and only for the member's own live view pick under the account their grant has, with every
 *   switch on — else refused with Google not asked, and no file name in any refusal;
 * - the Range forms: 206 with exact headers, an open or long range cut at the per-answer ceiling, a start past the end
 *   416, any other form 416 before anything is counted, no Range only for a file within the ceiling;
 * - the type sent is ACB's fixed list's, matched exactly against Google's;
 * - the bytes go under the grant the check saw (a re-consent meanwhile sends nothing);
 * - the caps: bytes per member and per company per day (a range cut to what is left), answers at once per member
 *   (released on finish, abort, error and exception), requests per minute — over one, 429 and Google not asked;
 * - the viewer leaving aborts the call to Google (the request's signal, the body cancelled, a real connection closed);
 * - one AI-action-log line per viewing session with the bytes served, none per range; no file id or name in any log.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeGoogle, type FakeGoogle } from '../fakes/google/fake-google'
import { defaultGoogleSeed, GOOGLE_SEED } from '../fakes/google/seed'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const EMAILS: Record<string, string> = { 'm-owner': 'owner@div.example', 'm-sato': GOOGLE_SEED.member, 'm-tanaka': GOOGLE_SEED.colleague }
const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@x`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.filter(id => EMAILS[id]).map(id => [id, { email: EMAILS[id], name: id }]))),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const CO = 'drive-stream-co'
const PUBLIC = 'http://localhost:13007'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-drivestreamclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-drivestream-0123456789'
const PICKER_KEY = 'fake-picker-key-NOT-REAL-stream0123456789'
const APP_ID = '123456789012'
const VIDEO = 'fake-video-stream-0001'
const OTHER_VIDEO = 'fake-video-stream-0002'
const VIDEO_NAME = '研修動画ストリーム.mp4'
const SIZE = 3000
const BYTES = randomBytes(SIZE)
const USAGE_KEY = 'drive-view:bytes'
const ts = () => new Date().toISOString()

const LIMITS: Record<string, string> = {
  ACB_DRIVE_VIEW_CHUNK_BYTES: '1000',
  ACB_DRIVE_VIEW_MEMBER_DAY_BYTES: '1000000',
  ACB_DRIVE_VIEW_COMPANY_DAY_BYTES: '10000000',
  ACB_DRIVE_VIEW_MEMBER_STREAMS: '4',
  ACB_DRIVE_VIEW_MEMBER_PER_MINUTE: '10000',
  // Every request its own session unless a test says otherwise (metadata read each time).
  ACB_DRIVE_VIEW_SESSION_IDLE_MS: '1',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, db: any, services: any
let google: FakeGoogle
let googleServer: ServerType
let kekDir: string
const logged: string[] = []

async function call(opts: { user?: string | null; method: string; path: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers }
  const res: Response = await app.request(`${PUBLIC}${opts.path}`, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}), ...(opts.signal ? { signal: opts.signal } : {}) })
  return res
}
async function json(res: Response) {
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) as Json, text } } catch { return { status: res.status, body: null, text } }
}
const C = `/api/companies/${CO}`
const person = async (user: string, method: string, path: string, body?: unknown) => json(await call({ user, method, path: `${C}${path}`, body }))
/** GET the view route (the raw Response: its body is the stream). */
const view = async (user: string, fileId: string, range?: string, signal?: AbortSignal) => {
  // A few ms first: with the 1 ms session idle, each request is its own session (its metadata read again).
  await new Promise(r => setTimeout(r, 3))
  return call({ user, method: 'GET', path: `${C}/me/google/drive/view/${fileId}`, ...(range !== undefined ? { headers: { Range: range } } : {}), ...(signal ? { signal } : {}) })
}
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer())
const usage = (userId?: string) => (db.prepare(`SELECT COALESCE(SUM(tokens), 0) AS n FROM broker_usage WHERE company_id = ? AND key_id = ?${userId ? ' AND user_id = ?' : ''}`)
  .get(...[CO, USAGE_KEY, ...(userId ? [userId] : [])]) as Json).n as number
const sessionLines = () => db.prepare("SELECT * FROM agent_events WHERE company_id = ? AND tool = 'google:drive.view' ORDER BY seq").all(CO) as Json[]
const media = () => google.mediaAnswers.filter(a => a.id === VIDEO || a.id === OTHER_VIDEO)
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function allow(user: string, features: string[]) {
  google.signIn({ email: EMAILS[user] })
  const r = await person(user, 'POST', '/me/google/connect', { features })
  expect(r.status, r.text).toBe(200)
  const res = await fetch(r.body.data.authorizeUrl, { redirect: 'manual' })
  if (!res.headers.get('location')) throw new Error(`${user} ${res.status} ${await res.text()}`)
  const back = new URL(res.headers.get('location')!)
  expect((await json(await call({ method: 'GET', path: `/api/oauth/google/callback${back.search}` }))).status).toBe(200)
}

/** A view pick through a ticket, as the Picker page makes it. */
async function pickToView(user: string, fileId: string) {
  const t = await person(user, 'POST', '/me/google/drive/pick-tickets', { mode: 'files', purpose: 'view', fileIds: [fileId] })
  expect(t.status, t.text).toBe(200)
  expect((await json(await call({ method: 'POST', path: '/api/google-picker/config', body: { ticket: t.body.data.ticket } }))).status).toBe(200)
  const r = await json(await call({ method: 'POST', path: '/api/google-picker/result', body: { ticket: t.body.data.ticket, mode: 'files', action: 'picked', ids: [fileId] } }))
  expect(r.body.data.kept, r.text).toBe(1)
  await person(user, 'DELETE', `/me/google/drive/pick-tickets/${t.body.data.ticketId}`)
}

beforeAll(async () => {
  const seed = defaultGoogleSeed()
  const video = (id: string, name: string) => ({
    id, name, mimeType: 'video/mp4', owner: GOOGLE_SEED.member, readers: [GOOGLE_SEED.member, GOOGLE_SEED.colleague, EMAILS['m-owner']], content: 'x',
    permissions: [{ type: 'user' as const, role: 'owner', emailAddress: GOOGLE_SEED.member }],
  })
  seed.driveFiles = [...(seed.driveFiles ?? []), video(VIDEO, VIDEO_NAME), video(OTHER_VIDEO, '別の動画.mp4')]
  seed.users = [...seed.users, { email: EMAILS['m-owner'], sub: '110000000000000000099', name: '持ち主', givenName: '主', familyName: '持ち', hd: GOOGLE_SEED.internalDomain }]
  google = createFakeGoogle({ seed })
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  google.setDriveFileBytes(VIDEO, BYTES)
  google.setDriveFileBytes(OTHER_VIDEO, BYTES)
  googleServer = serve({ fetch: google.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  kekDir = mkdtempSync(join(tmpdir(), 'acb-drive-stream-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
  }, LIMITS)
  // Every console line of the run is kept: no file id or name may be in any of them.
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(a => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : String(a))).join(' ')) })
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
  const drive = await import('../../src/routes/google-drive')
  app.route('/api/companies/:companyId', drive.googleDriveRoute)
  app.route('/api/google-picker', drive.googlePickerPageRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)

  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'm-owner', ts(), ts())
  for (const [u, role] of [['m-owner', 'owner'], ['m-sato', 'member'], ['m-tanaka', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`ms-${u}`, u, CO, role, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  expect((await person('m-owner', 'PUT', '/google/client', { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
  expect((await person('m-owner', 'PUT', '/google/picker', { apiKey: PICKER_KEY, appId: APP_ID })).status).toBe(200)
  for (const u of ['m-sato', 'm-tanaka', 'm-owner']) await allow(u, ['drive'])
  // What each pressed 「選択」 on in Google's Picker (Google's own drive.file grant).
  google.pick(CLIENT_ID, GOOGLE_SEED.member, [VIDEO, OTHER_VIDEO])
  google.pick(CLIENT_ID, GOOGLE_SEED.colleague, [VIDEO])
  google.pick(CLIENT_ID, EMAILS['m-owner'], [VIDEO])
  await pickToView('m-sato', VIDEO)
  await pickToView('m-tanaka', VIDEO)
})

beforeEach(() => {
  Object.assign(process.env, LIMITS)
  google.paceMedia(0)
  db.prepare('DELETE FROM broker_usage WHERE key_id = ?').run(USAGE_KEY)
})

afterAll(async () => {
  google.close()
  await new Promise(r => googleServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL', ...Object.keys(LIMITS)]) delete process.env[k]
})

describe('Range', () => {
  it('one closed range: 206 with exactly those bytes and the fixed headers (no file name anywhere)', async () => {
    const res = await view('m-sato', VIDEO, 'bytes=100-599')
    expect(res.status).toBe(206)
    expect(Object.fromEntries(['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'x-content-type-options', 'content-disposition'].map(h => [h, res.headers.get(h)]))).toEqual({
      'content-type': 'video/mp4', 'content-length': '500', 'content-range': `bytes 100-599/${SIZE}`, 'accept-ranges': 'bytes',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline',
    })
    expect(Buffer.from(await bytesOf(res)).equals(BYTES.subarray(100, 600))).toBe(true)
    expect([...res.headers.values()].join(' ')).not.toContain(VIDEO_NAME)
    // Google was asked for exactly that range.
    expect(media().at(-1)).toMatchObject({ id: VIDEO, range: 'bytes=100-599', status: 206, state: 'finished' })
  })

  it('an open or longer range is cut at the per-answer ceiling (a shorter 206), and at the end of the file', async () => {
    const open = await view('m-sato', VIDEO, 'bytes=500-')
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe(`bytes 500-1499/${SIZE}`)
    expect(open.headers.get('content-length')).toBe('1000')
    expect(Buffer.from(await bytesOf(open)).equals(BYTES.subarray(500, 1500))).toBe(true)
    expect(media().at(-1)!.range).toBe('bytes=500-1499')
    const tail = await view('m-sato', VIDEO, 'bytes=2900-9999')
    expect(tail.headers.get('content-range')).toBe(`bytes 2900-2999/${SIZE}`)
    expect((await bytesOf(tail)).byteLength).toBe(100)
  })

  it('a start past the end: 416 with the size, nothing asked of Google for the bytes', async () => {
    const before = media().length
    const res = await view('m-sato', VIDEO, `bytes=${SIZE}-`)
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${SIZE}`)
    expect((await json(res)).body.code).toBe('DRIVE_VIEW_RANGE_OUTSIDE')
    expect(media().length).toBe(before)
  })

  it('any other form (several ranges, a suffix, another unit): 416 before Google is asked or anything counted', async () => {
    for (const range of ['bytes=0-1,5-6', 'bytes=-500', 'items=0-1', 'bytes=9-3', 'bytes=abc']) {
      const asked = google.requests.length
      const res = await view('m-sato', VIDEO, range)
      expect(res.status, range).toBe(416)
      expect(res.headers.get('content-range')).toBeNull()
      expect((await json(res)).body.code).toBe('DRIVE_VIEW_RANGE_UNSUPPORTED')
      expect(google.requests.length, range).toBe(asked)
    }
    expect(usage()).toBe(0)
  })

  it('no Range: the whole file (200) only when it fits one answer, else 416 asking for ranges', async () => {
    const big = await view('m-sato', VIDEO)
    expect(big.status).toBe(416)
    expect(big.headers.get('content-range')).toBe(`bytes */${SIZE}`)
    expect((await json(big)).body.code).toBe('DRIVE_VIEW_RANGE_NEEDED')
    process.env.ACB_DRIVE_VIEW_CHUNK_BYTES = String(SIZE)
    const whole = await view('m-sato', VIDEO)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-range')).toBeNull()
    expect(whole.headers.get('content-length')).toBe(String(SIZE))
    expect(Buffer.from(await bytesOf(whole)).equals(BYTES)).toBe(true)
  })
})

describe('Google\'s answer must be the range asked', () => {
  it('Google ignoring the Range (a 200 of the whole file) is refused, nothing passed on, the bytes given back', async () => {
    google.misanswerNextMedia('ignore-range')
    const r = await json(await view('m-sato', VIDEO, 'bytes=0-99'))
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('DRIVE_VIEW_UPSTREAM')
    expect(usage('m-sato')).toBe(0)
    expect(services.googleDriveView.openStreams(CO, 'm-sato')).toBe(0)
    await until(() => media().at(-1)!.state !== 'streaming')
  })

  it('an answer running past its range is cut at the range\'s length', async () => {
    google.misanswerNextMedia('too-long')
    const res = await view('m-sato', VIDEO, 'bytes=0-99')
    expect(res.status).toBe(206)
    expect(Buffer.from(await bytesOf(res)).equals(BYTES.subarray(0, 100))).toBe(true)
    expect(usage('m-sato')).toBe(100)
  })
})

describe('the type sent', () => {
  it('is the fixed list\'s entry matched exactly; any other type Google reports is refused before the bytes', async () => {
    try {
      for (const reported of ['text/html', 'VIDEO/MP4', 'video/mp4; codecs=avc1', 'video/x-unknown']) {
        google.setDriveFileBytes(VIDEO, BYTES, reported)
        const before = media().length
        const res = await view('m-sato', VIDEO, 'bytes=0-9')
        expect(res.status, reported).toBe(403)
        expect((await json(res)).body.code).toBe('DRIVE_VIEW_NOT_VIDEO')
        expect(media().length).toBe(before)
      }
      google.setDriveFileBytes(VIDEO, BYTES, 'video/quicktime')
      const mov = await view('m-sato', VIDEO, 'bytes=0-9')
      expect(mov.status).toBe(206)
      expect(mov.headers.get('content-type')).toBe('video/quicktime')
      await mov.arrayBuffer()
    } finally {
      google.setDriveFileBytes(VIDEO, BYTES, 'video/mp4')
    }
  })
})

describe('who may stream: refused with Google not asked, no name in the answer', () => {
  async function refused(user: string | null, fileId: string, status: number, code: string | null) {
    const asked = google.requests.length
    const res = user === null ? await call({ method: 'GET', path: `${C}/me/google/drive/view/${fileId}`, headers: { Range: 'bytes=0-9' } }) : await view(user, fileId, 'bytes=0-9')
    const r = await json(res)
    expect(r.status, r.text).toBe(status)
    if (code) expect(r.body.code).toBe(code)
    expect(r.text).not.toContain(VIDEO_NAME)
    expect(google.requests.length).toBe(asked)
    expect(usage()).toBe(0)
  }

  it('no session, a non-member, not picked, another member\'s pick', async () => {
    await refused(null, VIDEO, 401, null)
    await refused('m-outsider', VIDEO, 404, null)
    // Sato's Google grant opens OTHER_VIDEO (picked in Google's Picker for another purpose), but there is no view pick.
    await refused('m-sato', OTHER_VIDEO, 403, 'DRIVE_VIEW_NOT_PICKED')
    // The owner may open VIDEO in Google too: only Sato and Tanaka picked it to view.
    await refused('m-owner', VIDEO, 403, 'DRIVE_VIEW_NOT_PICKED')
  })

  it('a view pick expired, or made under another Google account', async () => {
    const restore = db.prepare('SELECT expires_at, account_email FROM google_drive_view_picks WHERE company_id = ? AND user_id = ?').get(CO, 'm-sato') as Json
    try {
      db.prepare('UPDATE google_drive_view_picks SET expires_at = ? WHERE company_id = ? AND user_id = ?').run(new Date(Date.now() - 1000).toISOString(), CO, 'm-sato')
      await refused('m-sato', VIDEO, 403, 'DRIVE_VIEW_NOT_PICKED')
      db.prepare('UPDATE google_drive_view_picks SET expires_at = ?, account_email = ? WHERE company_id = ? AND user_id = ?').run(restore.expires_at, 'someone-else@div.example', CO, 'm-sato')
      await refused('m-sato', VIDEO, 403, 'DRIVE_VIEW_NOT_PICKED')
    } finally {
      db.prepare('UPDATE google_drive_view_picks SET expires_at = ?, account_email = ? WHERE company_id = ? AND user_id = ?').run(restore.expires_at, restore.account_email, CO, 'm-sato')
    }
  })

  it('the company\'s Drive switch off, the member\'s Drive off, the company\'s Google off', async () => {
    expect((await person('m-owner', 'PUT', '/google/features', { feature: 'drive', on: false })).status).toBe(200)
    try { await refused('m-sato', VIDEO, 403, 'GOOGLE_STOPPED') } finally { expect((await person('m-owner', 'PUT', '/google/features', { feature: 'drive', on: true })).status).toBe(200) }
    expect((await person('m-sato', 'PUT', '/me/google/features', { feature: 'drive', on: false })).status).toBe(200)
    try { await refused('m-sato', VIDEO, 409, 'GOOGLE_FEATURE_OFF') } finally { expect((await person('m-sato', 'PUT', '/me/google/features', { feature: 'drive', on: true })).status).toBe(200) }
    expect((await person('m-owner', 'PUT', '/google/enabled', { enabled: false })).status).toBe(200)
    try { await refused('m-sato', VIDEO, 403, 'GOOGLE_STOPPED') } finally { expect((await person('m-owner', 'PUT', '/google/enabled', { enabled: true })).status).toBe(200) }
    // All back on: it plays.
    const res = await view('m-sato', VIDEO, 'bytes=0-9')
    expect(res.status).toBe(206)
    await res.arrayBuffer()
  })

  it('the grant revoked (an admin\'s stop) — and a re-consent between the check and the bytes sends nothing', async () => {
    expect((await person('m-owner', 'DELETE', '/google/grants/m-tanaka')).status).toBe(200)
    try {
      await refused('m-tanaka', VIDEO, 409, 'GOOGLE_CONSENT_NEEDED')
    } finally {
      await allow('m-tanaka', ['drive'])
    }
    // The check saw one grant; by the time the bytes are asked the member's grant is another one (a re-consent, maybe
    // with another Google account): the media call is not sent.
    const original = services.googleDrive.useViewPick
    const spy = vi.spyOn(services.googleDrive, 'useViewPick').mockImplementation(async (...args: unknown[]) => {
      const r = await original.apply(services.googleDrive, args)
      return r.ok ? { ...r, value: { ...r.value, grantId: 'grant-seen-before' } } : r
    })
    try {
      const before = media().length
      const r = await json(await view('m-tanaka', VIDEO, 'bytes=0-9'))
      expect(r.status, r.text).toBe(409)
      expect(r.body.code).toBe('GOOGLE_CONSENT_NEEDED')
      expect(media().length).toBe(before)
      expect(usage()).toBe(0)
      expect(services.googleDriveView.openStreams(CO, 'm-tanaka')).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('a record token (the AI) never reaches the route', async () => {
    const r = await json(await call({ method: 'GET', path: `${C}/me/google/drive/view/${VIDEO}`, headers: { Authorization: 'Bearer rt_fake_token_0000000000', Range: 'bytes=0-9' } }))
    expect(r.status).toBe(401)
  })
})

describe('caps (video only; nothing asked of Google when over one)', () => {
  it('bytes per member per day: a range is cut to what is left, then 429', async () => {
    process.env.ACB_DRIVE_VIEW_MEMBER_DAY_BYTES = '1500'
    const first = await view('m-sato', VIDEO, 'bytes=0-')
    expect(first.headers.get('content-range')).toBe(`bytes 0-999/${SIZE}`)
    await first.arrayBuffer()
    const cut = await view('m-sato', VIDEO, 'bytes=1000-')
    expect(cut.status).toBe(206)
    expect(cut.headers.get('content-range')).toBe(`bytes 1000-1499/${SIZE}`)
    expect((await bytesOf(cut)).byteLength).toBe(500)
    expect(usage('m-sato')).toBe(1500)
    const asked = google.requests.length
    const over = await view('m-sato', VIDEO, 'bytes=1500-')
    expect(over.status).toBe(429)
    expect(over.headers.get('retry-after')).not.toBeNull()
    expect((await json(over)).body.code).toBe('DRIVE_VIEW_MEMBER_DAY')
    expect(google.requests.length).toBe(asked)
    // Another member still plays (the cap is per member).
    const other = await view('m-tanaka', VIDEO, 'bytes=0-9')
    expect(other.status).toBe(206)
    await other.arrayBuffer()
  })

  it('bytes per company per day: the company total holds across members', async () => {
    process.env.ACB_DRIVE_VIEW_COMPANY_DAY_BYTES = '1200'
    await (await view('m-sato', VIDEO, 'bytes=0-')).arrayBuffer()
    const cut = await view('m-tanaka', VIDEO, 'bytes=0-')
    expect(cut.headers.get('content-range')).toBe(`bytes 0-199/${SIZE}`)
    await cut.arrayBuffer()
    const asked = google.requests.length
    const over = await json(await view('m-tanaka', VIDEO, 'bytes=200-'))
    expect(over.status).toBe(429)
    expect(over.body.code).toBe('DRIVE_VIEW_COMPANY_DAY')
    expect(google.requests.length).toBe(asked)
    expect(usage()).toBe(1200)
  })

  it('answers at once per member: 429 while one streams; the slot is released when the viewer leaves, and the unsent bytes given back', async () => {
    process.env.ACB_DRIVE_VIEW_MEMBER_STREAMS = '1'
    google.paceMedia(30, 100)
    const a = await view('m-sato', VIDEO, 'bytes=0-')
    expect(a.status).toBe(206)
    const reader = a.body!.getReader()
    await reader.read()
    expect(services.googleDriveView.openStreams(CO, 'm-sato')).toBe(1)
    const asked = google.requests.length
    const b = await json(await view('m-sato', VIDEO, 'bytes=0-'))
    expect(b.status).toBe(429)
    expect(b.body.code).toBe('DRIVE_VIEW_TOO_MANY_STREAMS')
    expect(google.requests.length).toBe(asked)
    await reader.cancel()
    expect(services.googleDriveView.openStreams(CO, 'm-sato')).toBe(0)
    // Only what reached the viewer counts (1000 were reserved).
    expect(usage('m-sato')).toBeLessThan(1000)
    expect(usage('m-sato')).toBeGreaterThan(0)
    await until(() => media().at(-1)!.state === 'aborted')
    google.paceMedia(0)
    const again = await view('m-sato', VIDEO, 'bytes=0-9')
    expect(again.status).toBe(206)
    await again.arrayBuffer()
    expect(services.googleDriveView.openStreams(CO, 'm-sato')).toBe(0)
  })

  it('the slot is released and the bytes given back when Google fails, and when the call throws', async () => {
    process.env.ACB_DRIVE_VIEW_MEMBER_STREAMS = '1'
    process.env.ACB_DRIVE_VIEW_SESSION_IDLE_MS = '60000'
    // The session's metadata is read once; then Google answers the bytes' call with a 500.
    await (await view('m-sato', VIDEO, 'bytes=0-9')).arrayBuffer()
    db.prepare('DELETE FROM broker_usage WHERE key_id = ?').run(USAGE_KEY)
    google.faults.failOn(`/drive/v3/files/${VIDEO}`, 1, 500)
    const failed = await json(await view('m-sato', VIDEO, 'bytes=10-19'))
    expect(failed.status).toBe(503)
    expect(failed.body.code).toBe('DRIVE_VIEW_UPSTREAM')
    expect(services.googleDriveView.openStreams(CO, 'm-sato')).toBe(0)
    expect(usage('m-sato')).toBe(0)
    // An exception on the way (the Google client throwing): released too.
    const spy = vi.spyOn(services.googleClient, 'streamMedia').mockRejectedValueOnce(new Error('boom'))
    try {
      await expect(services.googleDriveView.open({ companyId: CO, userId: 'm-sato', role: 'member' }, VIDEO, 'bytes=0-9', new AbortController().signal)).rejects.toThrow('boom')
    } finally {
      spy.mockRestore()
    }
    expect(services.googleDriveView.openStreams(CO, 'm-sato')).toBe(0)
    expect(usage('m-sato')).toBe(0)
    const ok = await view('m-sato', VIDEO, 'bytes=0-9')
    expect(ok.status).toBe(206)
    await ok.arrayBuffer()
  })

  it('requests per minute per member: then 429 with Retry-After, Google not asked', async () => {
    process.env.ACB_DRIVE_VIEW_MEMBER_PER_MINUTE = '3'
    // The owner's own view pick (its minute starts empty).
    await pickToView('m-owner', VIDEO)
    for (let i = 0; i < 3; i++) await (await view('m-owner', VIDEO, 'bytes=0-9')).arrayBuffer()
    const asked = google.requests.length
    const res = await view('m-owner', VIDEO, 'bytes=0-9')
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await json(res)).body.code).toBe('DRIVE_VIEW_TOO_FAST')
    expect(google.requests.length).toBe(asked)
  })
})

describe('the viewer leaving aborts the call to Google', () => {
  it('the request\'s signal aborted mid-answer: Google\'s answer is aborted, the slot released', async () => {
    google.paceMedia(30, 100)
    const controller = new AbortController()
    const res = await view('m-sato', VIDEO, 'bytes=0-', controller.signal)
    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()
    await until(() => media().at(-1)!.state === 'aborted')
    expect(media().at(-1)!.bytes).toBeLessThan(1000)
    await until(() => services.googleDriveView.openStreams(CO, 'm-sato') === 0)
  })

  it('a real connection closed by the player (through the HTTP server)', async () => {
    google.paceMedia(30, 100)
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise(r => setTimeout(r, 50))
    try {
      currentUser.id = 'm-sato'
      const controller = new AbortController()
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${C}/me/google/drive/view/${VIDEO}`, { headers: { Range: 'bytes=0-' }, signal: controller.signal })
      expect(res.status).toBe(206)
      const reader = res.body!.getReader()
      await reader.read()
      controller.abort()
      await until(() => media().at(-1)!.state === 'aborted')
      await until(() => services.googleDriveView.openStreams(CO, 'm-sato') === 0)
    } finally {
      await new Promise(r => server.close(r))
    }
  })
})

describe('the record: one line per viewing session, nothing of the file', () => {
  it('several ranges of one session file one line when it ends, with the bytes served; the metadata call files none', async () => {
    process.env.ACB_DRIVE_VIEW_SESSION_IDLE_MS = '1'
    services.googleDriveView.sweep(CO)
    const lines = sessionLines().length
    const googleLines = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE company_id = ? AND tool LIKE 'google:%' AND tool != 'google:drive.view'").get(CO) as Json).n
    const otherBefore = googleLines()
    process.env.ACB_DRIVE_VIEW_SESSION_IDLE_MS = '60000'
    const metaCalls = () => google.requests.filter(r => r.path === `/drive/v3/files/${VIDEO}` && !r.search.includes('alt=media')).length
    const metaBefore = metaCalls()
    for (const range of ['bytes=0-', 'bytes=1000-', 'bytes=2000-2499']) await (await view('m-sato', VIDEO, range)).arrayBuffer()
    // The metadata was read once for the session; no line yet (the session is still open).
    expect(metaCalls() - metaBefore).toBe(1)
    expect(sessionLines().length).toBe(lines)
    process.env.ACB_DRIVE_VIEW_SESSION_IDLE_MS = '1'
    await new Promise(r => setTimeout(r, 5))
    services.googleDriveView.sweep(CO)
    const added = sessionLines().slice(lines)
    expect(added).toHaveLength(1)
    const target = JSON.parse(added[0].target)
    expect(target).toMatchObject({ kind: 'broker', service: 'google', operation: 'drive.view', bytesOut: 2500, status: 206 })
    expect(added[0].user_id).toBe('m-sato')
    expect(JSON.stringify(added[0])).not.toContain(VIDEO)
    expect(JSON.stringify(added[0])).not.toContain(VIDEO_NAME)
    expect(googleLines()).toBe(otherBefore)
  })

  it('no file id or name in any log line of the whole run (the request log included)', () => {
    expect(logged.some(l => l.startsWith('[http]') && l.includes('/me/google/drive/view/:fileId'))).toBe(true)
    for (const line of logged) {
      expect(line).not.toContain(VIDEO)
      expect(line).not.toContain(OTHER_VIDEO)
      expect(line).not.toContain(VIDEO_NAME)
    }
  })
})
