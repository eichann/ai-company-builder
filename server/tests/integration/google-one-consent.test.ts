/**
 * Integration Test: 「仕事の道具をつなぐ」 — one Google consent for every feature the company
 * offers (owner decision 2026-11-02, `.claude/rules/google-connector.md` "One consent"),
 * end to end against the fake Google through the practice redirect.
 *
 * What it protects:
 * - 受信を読む is the company's switch (allowed by default) and each member's own (off until they
 *   turn it on, owner decision 2026-11-02, work-switches.ts): never offered to a member whose own
 *   switch is off;
 * - `{ all: true }` asks exactly the union of what the member is offered (the admin's switches,
 *   Drive only with the Picker registered, 受信を読む only when their own is on) — a feature the
 *   company turned off is never asked, not even one the member had allowed before;
 * - a feature the company turned off is refused at the next call before anything leaves ACB;
 * - a member who unticks some scopes on Google's page keeps what they allowed, sees what is
 *   missing, and the screen does not offer them again (no loop);
 * - 「あとで」 marks the offered features seen; a feature the company adds later is new.
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

/** The member's ACB account emails (Sato's in another case: the comparison ignores case). */
const EMAILS: Record<string, string> = {
  'g-owner': 'owner@div.example',
  'g-admin': 'admin@div.example',
  'g-sato': 'Sato@div.example',
  'g-tanaka': GOOGLE_SEED.colleague,
  'g-other-owner': 'boss@other.example',
  'g-other-member': GOOGLE_SEED.member,
}
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
const CO = 'g1-co'
const OTHER = 'g1-other'
const PUBLIC = 'http://localhost:13001'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-fakeclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-co-0123456789'
const OTHER_CLIENT_ID = '210987654321-otherclient.apps.googleusercontent.com'
const OTHER_SECRET = 'fake-google-secret-NOT-REAL-other-9876543210'
const DOMAIN = GOOGLE_SEED.internalDomain
const CAL = 'https://www.googleapis.com/auth/calendar.events.readonly'
const SEND = 'https://www.googleapis.com/auth/gmail.send'
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let fake: FakeGoogle
let server: ServerType
let kekDir: string, shelfDir: string
/** Every console line written while the tests ran. */
const logLines: string[] = []
/** Every HTTP answer body the app gave (and every authorize URL's text). */
const answers: string[] = []
/** Values that must never appear anywhere: verifiers (opened from the vault while pending). */
const secrets: string[] = [SECRET, OTHER_SECRET]

async function call(user: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json; text: string }> {
  currentUser.id = user
  const res: Response = await app.request(`${PUBLIC}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  answers.push(text)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* the callback's page */ }
  return { status: res.status, body: json, text }
}
const C = (co = CO) => `/api/companies/${co}`

/** POST connect → the browser at the fake's sign-in page → Google's redirect, not yet followed. */
async function start(user: string, features: string[] | 'all', co = CO): Promise<{ url: URL; back: URL }> {
  const r = await call(user, 'POST', `${C(co)}/me/google/connect`, features === 'all' ? { all: true } : { features })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  const url = new URL(r.body.data.authorizeUrl)
  // The verifier is sealed while pending: open it to know what must never show up.
  const hash = (await import('../../src/adapters/system')).sha256TokenDigest.digest(url.searchParams.get('state')!)
  const row = db.prepare('SELECT verifier_sealed FROM oauth_pending WHERE company_id = ? AND state_hash = ?').get(co, hash) as Json
  secrets.push(await services.brokerVault.openConnector({ purpose: 'acb-oauth-pending', companyId: co, id: hash }, JSON.parse(row.verifier_sealed)))
  const res = await fetch(url, { redirect: 'manual' })
  expect(res.status, await res.clone().text()).toBe(302)
  return { url, back: new URL(res.headers.get('location')!) }
}

/** Google's redirect, as the browser follows it, to the server's public callback. */
const callback = (back: URL) => call(null, 'GET', `/api/oauth/google/callback${back.search}`)

/** 「Google で許可」 all the way: the member signs in at the fake as `email`. */
async function allow(user: string, features: string[] | 'all', email: string, co = CO, withholdScopes?: string[]) {
  fake.signIn({ email, ...(withholdScopes ? { withholdScopes } : {}) })
  const { url, back } = await start(user, features, co)
  return { url, back, page: await callback(back) }
}

beforeAll(async () => {
  fake = createFakeGoogle()
  fake.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  fake.addClient({ clientId: OTHER_CLIENT_ID, clientSecret: OTHER_SECRET, redirectUris: [REDIRECT] })
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-g1-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-g1-shelf-'))
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
  app = new Hono()
  app.use('*', requestLog())
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/key-broker')).keyBrokerRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/core-connectors')).coreConnectorsRoute)

  for (const [co, owner] of [[CO, 'g-owner'], [OTHER, 'g-other-owner']]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, owner, ts(), ts())
  }
  for (const [u, co, role] of [['g-owner', CO, 'owner'], ['g-admin', CO, 'admin'], ['g-sato', CO, 'member'], ['g-tanaka', CO, 'member'],
    ['g-other-owner', OTHER, 'owner'], ['g-other-member', OTHER, 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, co, role, ts(), ts())
  }
})

afterAll(async () => {
  fake.close()
  await new Promise(r => server.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL']) delete process.env[k]
})

const DRIVE = 'https://www.googleapis.com/auth/drive.file'
const MINUTES = [CAL, 'https://www.googleapis.com/auth/meetings.space.readonly', 'https://www.googleapis.com/auth/drive.meet.readonly', 'https://www.googleapis.com/auth/documents.readonly']
const featureScopes = (url: URL) => url.searchParams.get('scope')!.split(' ').filter(s => s !== 'openid' && s !== 'email').sort()
const sendAs = (user: string) =>
  services.googleClient.request(CO, user, { api: 'gmail', method: 'POST', path: '/gmail/v1/users/me/messages/send', body: { raw: Buffer.from('To: tanaka@div.example\r\nSubject: t\r\n\r\nhi').toString('base64url') }, scope: SEND, operation: 'gmail.send' })

describe('「仕事の道具をつなぐ」: one consent for what the company offers', () => {
  it('受信を読む is allowed for a company by default and is the company\'s one switch; only owners and admins switch', async () => {
    expect((await call('g-owner', 'PUT', `${C()}/google/features`, { feature: 'inbox', on: true })).status).toBe(404)
    const saved = await call('g-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: DOMAIN })
    expect(saved.status).toBe(200)
    // The defaults (owner decision 2026-11-02): 受信を読む allowed (each member starts off); no Picker yet, so no Drive.
    // The relay's スプレッドシート is off until the admin ticks it (2026-11-04, google-relay.test.ts), and so is
    // 済んだメールを Gmail でもアーカイブする (2026-11-05, google-inbox-archive.test.ts).
    expect(saved.body.data).toMatchObject({ featuresOff: ['sheets', 'inbox_archive'], companyFeatures: ['minutes', 'mail', 'inbox'] })
    expect((await call('g-sato', 'PUT', `${C()}/google/features`, { feature: 'inbox', on: false })).status).toBe(403)
    expect((await call('g-admin', 'PUT', `${C()}/google/features`, { feature: 'everything', on: false })).status).toBe(400)
    // Off, on and off again: the history says so, and it is the company's 受信を読む (task settings) itself.
    const off = await call('g-admin', 'PUT', `${C()}/google/features`, { feature: 'inbox', on: false })
    expect(off.body.data).toMatchObject({ featuresOff: ['inbox', 'sheets', 'inbox_archive'], companyFeatures: ['minutes', 'mail'] })
    expect(services.taskSettings.settingsOf(CO).readIncoming.allowed).toBe(false)
    const on = await call('g-admin', 'PUT', `${C()}/google/features`, { feature: 'inbox', on: true })
    expect(on.body.data).toMatchObject({ featuresOff: ['sheets', 'inbox_archive'], companyFeatures: ['minutes', 'mail', 'inbox'] })
    expect(services.taskSettings.settingsOf(CO).readIncoming.allowed).toBe(true)
    const offAgain = await call('g-admin', 'PUT', `${C()}/google/features`, { feature: 'inbox', on: false })
    expect(offAgain.body.data.history[0]).toMatchObject({ action: 'features', detail: { feature: 'inbox', on: false } })
  })

  it('{ all } asks exactly the company\'s features in one consent, and marks them seen', async () => {
    const before = (await call('g-sato', 'GET', `${C()}/me/google`)).body.data
    expect(before).toMatchObject({ available: true, connected: false, companyFeatures: ['minutes', 'mail'], seen: [] })
    const { url, page } = await allow('g-sato', 'all', GOOGLE_SEED.member)
    expect(page.status).toBe(200)
    expect(featureScopes(url)).toEqual([...MINUTES, SEND].sort())
    // The member's own ACB email is the account Google is asked for (and the callback checks it).
    expect(url.searchParams.get('login_hint')).toBe(EMAILS['g-sato'])
    const mine = (await call('g-sato', 'GET', `${C()}/me/google`)).body.data
    expect(mine).toMatchObject({ connected: true, features: ['minutes', 'mail'], seen: ['minutes', 'mail'] })
  })

  it('a feature the company turned off is never asked, even by name or when allowed before', async () => {
    const named = await call('g-sato', 'POST', `${C()}/me/google/connect`, { features: ['inbox'] })
    expect(named.status).toBe(409)
    expect(named.body.code).toBe('GOOGLE_FEATURE_COMPANY_OFF')
    // The Picker registered: Drive is offered and asked with the next consent.
    expect((await call('g-owner', 'PUT', `${C()}/google/picker`, { apiKey: 'fake-picker-key-NOT-REAL-0123456789abcd', appId: '123456789012' })).status).toBe(200)
    // Mail turned off: the member had allowed it; the next consent does not ask it again.
    expect((await call('g-owner', 'PUT', `${C()}/google/features`, { feature: 'mail', on: false })).status).toBe(200)
    const r = await call('g-sato', 'POST', `${C()}/me/google/connect`, { all: true })
    expect(r.status).toBe(200)
    expect(featureScopes(new URL(r.body.data.authorizeUrl))).toEqual([...MINUTES, DRIVE].sort())
    // A send with the grant the member still holds is refused before anything leaves ACB.
    const sent = fake.sent.length
    expect(await sendAs('g-sato')).toMatchObject({ ok: false, kind: 'not-sent', reason: 'off' })
    expect(fake.sent.length).toBe(sent)
    // 予定と議事録を読む keeps working; mail on again works from the next call.
    expect((await services.googleClient.request(CO, 'g-sato', { api: 'calendar', method: 'GET', path: '/calendar/v3/calendars/primary/events', scope: CAL, operation: 'calendar.events.list' })).ok).toBe(true)
    expect((await call('g-owner', 'PUT', `${C()}/google/features`, { feature: 'mail', on: true })).status).toBe(200)
    expect((await sendAs('g-sato')).ok).toBe(true)
    expect(fake.sent.length).toBe(sent + 1)
  })

  it('a member who unticks some on Google\'s page keeps the rest, sees what is missing, and is not asked again', async () => {
    const { page } = await allow('g-tanaka', 'all', GOOGLE_SEED.colleague, CO, [SEND, DRIVE])
    expect(page.status).toBe(200)
    const mine = (await call('g-tanaka', 'GET', `${C()}/me/google`)).body.data
    expect(mine).toMatchObject({ connected: true, features: ['minutes'], companyFeatures: ['minutes', 'mail', 'drive'] })
    // Shown once: nothing left for the screen to offer (the app compares companyFeatures, features and seen).
    expect(mine.seen).toEqual(['minutes', 'mail', 'drive'])
    // Still asked when first used (the person's own act), with what they allowed.
    const later = await allow('g-tanaka', ['mail'], GOOGLE_SEED.colleague)
    expect(featureScopes(later.url)).toEqual([...MINUTES, SEND].sort())
    expect((await call('g-tanaka', 'GET', `${C()}/me/google`)).body.data.features).toEqual(['minutes', 'mail'])
  })

  it('「あとで」 marks what is offered now; a feature the company adds later, or 受信を読む the member turns on, is new', async () => {
    expect((await call('g-admin', 'PUT', `${C()}/me/google/seen`)).body.data.seen).toEqual(['minutes', 'mail', 'drive'])
    expect((await call('g-owner', 'PUT', `${C()}/google/features`, { feature: 'inbox', on: true })).body.data.companyFeatures).toEqual(['minutes', 'mail', 'drive', 'inbox'])
    // Allowed, but the admin's own 受信を読む is off: not offered to them.
    expect((await call('g-admin', 'GET', `${C()}/me/google`)).body.data.companyFeatures).toEqual(['minutes', 'mail', 'drive'])
    expect((await services.workSwitches.set({ companyId: CO, userId: 'g-admin', role: 'admin' }, { switch: 'readIncoming', on: true })).ok).toBe(true)
    const mine = (await call('g-admin', 'GET', `${C()}/me/google`)).body.data
    expect(mine.companyFeatures.filter((f: string) => !mine.seen.includes(f))).toEqual(['inbox'])
    // 「許可をやめる」 does not bring the screen back.
    await call('g-sato', 'DELETE', `${C()}/me/google`)
    expect((await call('g-sato', 'GET', `${C()}/me/google`)).body.data.seen).toEqual(['minutes', 'mail', 'drive'])
  })

  it('a company without Google offers nothing and records nothing', async () => {
    const r = await call('g-other-member', 'PUT', `${C(OTHER)}/me/google/seen`)
    expect(r.body.data).toMatchObject({ available: false, companyFeatures: [], seen: [] })
    expect((await call('g-other-member', 'POST', `${C(OTHER)}/me/google/connect`, { all: true })).body.code).toBe('GOOGLE_UNAVAILABLE')
    expect(db.prepare('SELECT COUNT(*) AS n FROM connector_setup_seen WHERE company_id = ?').get(OTHER).n).toBe(0)
  })
})
