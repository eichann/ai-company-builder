/**
 * Integration Test: the Google connection (milestone 4 G3, `.claude/rules/google-connector.md`),
 * end to end against the fake Google (`tests/fakes/google/`), the way staging runs it: the
 * practice redirect on (ACB_ALLOW_FAKE_UPSTREAMS=1 + ACB_FAKE_GOOGLE_URL), so every Google host
 * and the browser's sign-in page go to the fake on this machine.
 *
 * What it protects:
 * - nothing secret anywhere: no client secret, refresh / access token, code or PKCE verifier in
 *   any answer, error, log line (every console line captured, the request log mounted) or table;
 * - the public callback: a state of another company, a forged, reused or expired one stores
 *   nothing (a cross-tenant leak, design §3-8); another Google account than the member's ACB
 *   email, or one outside the company's domain, is refused and stores nothing (§4-6, §9 q10);
 * - who: only owners / admins manage the client and stop grants; a member only their own;
 * - every stop works from the next `googleRequest`: the company switch, an admin's stop of one
 *   grant, 「すべての鍵を止める」, the member's 「許可をやめる」, the operator's stop file,
 *   removing the member, Google refusing the token (invalid_grant);
 * - incremental consent (minutes first, mail when needed), PKCE S256, offline access;
 * - practice mode: a real client secret cannot be saved, and one saved before is never sent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
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
const CO = 'g-co'
const OTHER = 'g-other'
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
async function start(user: string, features: string[], co = CO): Promise<{ url: URL; back: URL }> {
  const r = await call(user, 'POST', `${C(co)}/me/google/connect`, { features })
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
async function allow(user: string, features: string[], email: string, co = CO) {
  fake.signIn({ email })
  const { url, back } = await start(user, features, co)
  return { url, back, page: await callback(back) }
}

const grantRow = (user: string, co = CO) => db.prepare('SELECT * FROM connector_grants WHERE company_id = ? AND user_id = ?').get(co, user) as Json
const calendar = (user = 'g-sato') => services.googleClient.request(CO, user, {
  api: 'calendar', method: 'GET', path: '/calendar/v3/calendars/primary/events', query: { maxResults: '5' }, scope: CAL, operation: 'calendar.events.list',
})

beforeAll(async () => {
  fake = createFakeGoogle()
  fake.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  fake.addClient({ clientId: OTHER_CLIENT_ID, clientSecret: OTHER_SECRET, redirectUris: [REDIRECT] })
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-g-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-g-shelf-'))
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

describe('the Google connection', () => {
  it('only owners and admins manage the client; the secret is sent once and never answered', async () => {
    expect((await call('g-sato', 'GET', `${C()}/google`)).status).toBe(403)
    expect((await call('g-sato', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: DOMAIN })).status).toBe(403)
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_oauth_clients').get().n).toBe(0)

    const saved = await call('g-admin', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: ` ${DOMAIN.toUpperCase()} ` })
    expect(saved.status, saved.text).toBe(200)
    expect(saved.body.data).toMatchObject({
      configured: true, clientId: CLIENT_ID, secretLast4: SECRET.slice(-4), domain: DOMAIN, enabled: true,
      redirectUri: REDIRECT, practice: true, vaultEnabled: true,
    })
    // Without a secret the stored one is kept (editing the domain never needs it again).
    const kept = await call('g-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, domain: DOMAIN })
    expect(kept.body.data.secretLast4).toBe(SECRET.slice(-4))
    // The other company has its own client (its own Google Cloud project).
    expect((await call('g-other-owner', 'PUT', `${C(OTHER)}/google/client`, { clientId: OTHER_CLIENT_ID, clientSecret: OTHER_SECRET, domain: DOMAIN })).status).toBe(200)
  })

  it('on the practice Google, a real client secret is refused and never stored', async () => {
    const before = db.prepare('SELECT * FROM google_oauth_clients WHERE company_id = ?').get(CO)
    const r = await call('g-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: 'GOCSPX-real-looking-secret-1234', domain: DOMAIN })
    expect([r.status, r.body.code]).toEqual([400, 'REAL_KEY_ON_PRACTICE'])
    expect(r.text).not.toContain('GOCSPX')
    expect(db.prepare('SELECT * FROM google_oauth_clients WHERE company_id = ?').get(CO)).toEqual(before)
  })

  it('「Google で許可」: PKCE, offline, the member\'s account and domain; then a call works and is recorded without content', async () => {
    const { url, page } = await allow('g-sato', ['minutes'], GOOGLE_SEED.member)
    const q = url.searchParams
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect([q.get('access_type'), q.get('prompt'), q.get('include_granted_scopes'), q.get('hd'), q.get('login_hint')])
      .toEqual(['offline', 'consent', 'true', DOMAIN, EMAILS['g-sato']])
    expect(q.get('redirect_uri')).toBe(REDIRECT)
    expect(q.get('state')).toMatch(new RegExp(`^${CO}\\.[0-9a-f]{64}$`))
    // Minutes only: never mail, never broader Drive / Gmail scopes.
    expect(q.get('scope')!.split(' ')).toEqual(['openid', 'email', CAL,
      'https://www.googleapis.com/auth/meetings.space.readonly', 'https://www.googleapis.com/auth/drive.meet.readonly'])

    expect(page.status).toBe(200)
    expect(page.text).toContain('許可しました。アプリに戻ってください。')
    const mine = await call('g-sato', 'GET', `${C()}/me/google`)
    expect(mine.body.data).toMatchObject({ available: true, connected: true, googleEmail: GOOGLE_SEED.member, features: ['minutes'] })
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_pending').get().n).toBe(0)

    const res = await calendar()
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect((res.json as Json).kind).toBe('calendar#events')
    expect(grantRow('g-sato').last_used_at).toBeTruthy()
    const rec = db.prepare("SELECT tool, target_kind, target_text FROM agent_events WHERE company_id = ? AND tool LIKE 'google:%' ORDER BY rowid DESC").get(CO) as Json
    expect(rec.tool).toBe('google:calendar.events.list')
    // Not granted yet: mail.
    const send = await services.googleClient.request(CO, 'g-sato', { api: 'gmail', method: 'POST', path: '/gmail/v1/users/me/messages/send', body: { raw: 'x' }, scope: SEND, operation: 'gmail.send' })
    expect(send).toMatchObject({ ok: false, kind: 'not-sent', reason: 'scope-not-granted' })
  })

  it('mail is asked for when first needed, adding to what was allowed (no forced consent)', async () => {
    const { url, page } = await allow('g-sato', ['mail'], GOOGLE_SEED.member)
    expect(url.searchParams.get('prompt')).toBeNull()
    expect(url.searchParams.get('scope')).toContain(SEND)
    expect(url.searchParams.get('scope')).toContain(CAL)
    expect(page.status).toBe(200)
    expect((await call('g-sato', 'GET', `${C()}/me/google`)).body.data.features).toEqual(['minutes', 'mail'])
    expect((await calendar()).ok).toBe(true)
  })

  it('another Google account than the member\'s ACB email, or outside the company domain, is refused and stores nothing', async () => {
    // Tanaka signs in with Sato's account: same domain, another person.
    const other = await allow('g-tanaka', ['minutes'], GOOGLE_SEED.member)
    expect(other.page.status).toBe(400)
    expect(other.page.text).toContain('ACB に登録しているメールアドレスと同じ Google アカウントで許可してください')
    expect(other.page.text).not.toContain(GOOGLE_SEED.member)
    expect(grantRow('g-tanaka')).toBeUndefined()
    // A private account outside the Workspace.
    const before = fake.refreshTokenCount(CLIENT_ID, GOOGLE_SEED.privateAccount)
    const priv = await allow('g-tanaka', ['minutes'], GOOGLE_SEED.privateAccount)
    expect(priv.page.status).toBe(400)
    expect(priv.page.text).toContain(`@${DOMAIN}`)
    expect(priv.page.text).not.toContain(GOOGLE_SEED.privateAccount)
    expect(grantRow('g-tanaka')).toBeUndefined()
    // The tokens Google issued for the refused account were revoked at once.
    expect(fake.refreshTokenCount(CLIENT_ID, GOOGLE_SEED.privateAccount)).toBe(before)
  })

  it('the callback finds nothing for another company\'s, a forged, a reused or an expired state', async () => {
    const tables = () => ({
      grants: db.prepare('SELECT company_id, user_id, grant_id, status FROM connector_grants ORDER BY company_id, user_id').all(),
    })
    // Reused: the same answer from Google a second time.
    const sato = grantRow('g-sato')
    fake.signIn({ email: GOOGLE_SEED.member })
    const once = await start('g-sato', ['minutes'])
    expect((await callback(once.back)).status).toBe(200)
    const after = tables()
    const again = await callback(once.back)
    expect(again.status).toBe(400)
    expect(again.text).toContain('この許可の手続きは使えません')
    expect(tables()).toEqual(after)
    expect(grantRow('g-sato').grant_id).not.toBe(sato.grant_id)

    // Another company's start, its state's company swapped for this one: found in neither.
    fake.signIn({ email: GOOGLE_SEED.member })
    const theirs = await start('g-other-member', ['minutes'], OTHER)
    const state = theirs.back.searchParams.get('state')!
    const swapped = new URL(theirs.back)
    swapped.searchParams.set('state', `${CO}.${state.split('.')[1]}`)
    const before = tables()
    const cross = await callback(swapped)
    expect(cross.status).toBe(400)
    expect(tables()).toEqual(before)
    // The same random part forged with no company, or junk: nothing either.
    for (const bad of [state.split('.')[1], `${CO}.${'0'.repeat(64)}`, `${CO}.${state.split('.')[1]}x`, '../../etc']) {
      const forged = new URL(theirs.back)
      forged.searchParams.set('state', bad)
      expect((await callback(forged)).status).toBe(400)
    }
    expect(tables()).toEqual(before)
    // Its own company's state still works (the pending row in OTHER was not touched by the swap).
    expect((await callback(theirs.back)).status).toBe(200)
    expect(grantRow('g-other-member', OTHER).status).toBe('active')
    expect(grantRow('g-other-member', CO)).toBeUndefined()

    // Expired: older than 10 minutes.
    fake.signIn({ email: GOOGLE_SEED.colleague })
    const late = await start('g-tanaka', ['minutes'])
    db.prepare("UPDATE oauth_pending SET expires_at = '2000-01-01T00:00:00.000Z' WHERE company_id = ?").run(CO)
    expect((await callback(late.back)).status).toBe(400)
    expect(grantRow('g-tanaka')).toBeUndefined()
    // Refused by the person at Google.
    fake.signIn({ deny: true })
    const denied = await start('g-tanaka', ['minutes'])
    expect(denied.back.searchParams.get('error')).toBe('access_denied')
    const page = await callback(denied.back)
    expect([page.status, page.text.includes('Google で許可されませんでした')]).toEqual([400, true])
    expect(grantRow('g-tanaka')).toBeUndefined()
  })

  it('a member manages only their own permission; only owners and admins stop another\'s', async () => {
    await allow('g-tanaka', ['minutes'], GOOGLE_SEED.colleague)
    expect(grantRow('g-tanaka').status).toBe('active')
    expect((await call('g-sato', 'DELETE', `${C()}/google/grants/g-tanaka`)).status).toBe(403)
    expect((await call('g-sato', 'GET', `${C()}/google`)).status).toBe(403)
    // Sato's 「許可をやめる」 touches only Sato's.
    expect((await call('g-sato', 'DELETE', `${C()}/me/google`)).body.data.connected).toBe(false)
    expect(grantRow('g-sato')).toBeUndefined()
    expect(grantRow('g-tanaka').status).toBe('active')
    // An admin's view lists members' grants without anything secret.
    const view = await call('g-admin', 'GET', `${C()}/google`)
    expect(view.body.data.grants.map((g: Json) => [g.userId, g.googleEmail, g.status])).toEqual([['g-tanaka', GOOGLE_SEED.colleague, 'active']])
    // Another company's member cannot be named here.
    expect((await call('g-owner', 'DELETE', `${C()}/google/grants/g-other-member`)).status).toBe(404)
    expect(grantRow('g-other-member', OTHER).status).toBe('active')
  })

  describe('every stop works from the next call', () => {
    const reconnect = async () => {
      if (grantRow('g-sato')?.status !== 'active') await allow('g-sato', ['minutes'], GOOGLE_SEED.member)
      expect((await calendar()).ok).toBe(true)
    }

    it('the company switch', async () => {
      await reconnect()
      expect((await call('g-owner', 'PUT', `${C()}/google/enabled`, { enabled: false })).status).toBe(200)
      expect(await calendar()).toMatchObject({ ok: false, kind: 'not-sent', reason: 'off' })
      expect((await call('g-sato', 'GET', `${C()}/me/google`)).body.data).toMatchObject({ available: false, reason: 'off' })
      expect((await call('g-sato', 'POST', `${C()}/me/google/connect`, { features: ['minutes'] })).status).toBe(409)
      expect((await call('g-owner', 'PUT', `${C()}/google/enabled`, { enabled: true })).status).toBe(200)
      expect((await calendar()).ok).toBe(true)
    })

    it('an admin stops a member\'s permission (revoked at Google too)', async () => {
      await reconnect()
      const live = fake.refreshTokenCount(CLIENT_ID, GOOGLE_SEED.member)
      const r = await call('g-admin', 'DELETE', `${C()}/google/grants/g-sato`)
      expect(r.body.data.grants.find((g: Json) => g.userId === 'g-sato').status).toBe('stopped')
      expect(grantRow('g-sato').refresh_token_sealed).toBeNull()
      expect(await calendar()).toMatchObject({ ok: false, reason: 'grant-stopped' })
      expect(fake.refreshTokenCount(CLIENT_ID, GOOGLE_SEED.member)).toBe(live - 1)
    })

    it('「すべての鍵を止める」 stops every member\'s Google permission', async () => {
      await reconnect()
      expect((await call('g-owner', 'POST', `${C()}/broker/stop-all`)).status).toBe(200)
      expect(await calendar()).toMatchObject({ ok: false, reason: 'grant-stopped' })
      expect(grantRow('g-tanaka').status).toBe('stopped')
      // Only this company.
      expect(grantRow('g-other-member', OTHER).status).toBe('active')
    })

    it('the member\'s 「許可をやめる」 (revoked at Google too)', async () => {
      await reconnect()
      await call('g-sato', 'DELETE', `${C()}/me/google`)
      expect(await calendar()).toMatchObject({ ok: false, reason: 'no-grant' })
    })

    it('the operator\'s stop file (google or *)', async () => {
      await reconnect()
      for (const line of ['google', '*']) {
        writeFileSync(join(shelfDir, 'stopped'), `${line}\n`)
        expect(await calendar()).toMatchObject({ ok: false, reason: 'operator-stopped' })
        unlinkSync(join(shelfDir, 'stopped'))
        expect((await calendar()).ok).toBe(true)
      }
    })

    it('a member removed from the company', async () => {
      await reconnect()
      db.prepare('DELETE FROM memberships WHERE user_id = ? AND company_id = ?').run('g-sato', CO)
      expect(await calendar()).toMatchObject({ ok: false, reason: 'not-member' })
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-g-sato', 'g-sato', CO, 'member', ts(), ts())
      expect((await calendar()).ok).toBe(true)
    })

    it('Google no longer honours the token (removed in the Google account): the grant ends', async () => {
      await reconnect()
      fake.revokeAllFor(GOOGLE_SEED.member)
      expect(await calendar()).toMatchObject({ ok: false, reason: 'grant-revoked' })
      expect(grantRow('g-sato')).toMatchObject({ status: 'revoked', status_reason: 'invalid_grant', refresh_token_sealed: null })
      // The other company's grant for the same Google account is that company's business: also gone at Google.
    })
  })

  it('a client secret saved before the practice redirect was on is never sent to the practice Google', async () => {
    // Saved through services built without the redirect (as on a server where it was off).
    const { createServices } = await import('../../src/composition')
    const plain = createServices(db, undefined, { practiceUpstreams: { state: 'off' } })
    const owner = { companyId: CO, userId: 'g-owner', role: 'owner' }
    expect((await plain.googleConnector.saveClient(owner, { clientId: CLIENT_ID, clientSecret: 'GOCSPX-real-looking-secret-5678', domain: DOMAIN })).ok).toBe(true)
    secrets.push('GOCSPX-real-looking-secret-5678')
    const sent = fake.requests.length
    const r = await call('g-tanaka', 'POST', `${C()}/me/google/connect`, { features: ['minutes'] })
    expect([r.status, r.body.reason]).toEqual([409, 'practice-real-secret'])
    expect(await calendar('g-tanaka')).toMatchObject({ ok: false })
    expect(fake.requests.length).toBe(sent)
  })

  it('no client secret, token, code or verifier in any answer, log line or table', async () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    const dump = tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n')
    const everywhere = [...answers, ...logLines, dump]
    expect(secrets.length).toBeGreaterThan(5)
    for (const text of everywhere) {
      for (const s of secrets) expect(text.includes(s), `a secret shows up: ${text.slice(0, 200)}`).toBe(false)
      // Every practice token, code and secret has a recognisable prefix.
      for (const prefix of ['ya29.fake-', '1//fake-', '4/fake-', 'fake-google-secret-']) {
        expect(text.includes(prefix), `${prefix}… shows up: ${text.slice(0, 200)}`).toBe(false)
      }
    }
    // The request log printed the callback without its query.
    expect(logLines.some(l => l.includes('/api/oauth/google/callback') && l.includes('state='))).toBe(false)
  })
})
