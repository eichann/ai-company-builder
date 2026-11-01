/**
 * Integration Test: Google as a built-in core connector and 受信を読む (stage 3 A1,
 * `.claude/rules/connector-roles.md`, `google-connector.md` "Gmail", `member-oauth.md`
 * "Feature toggles"), end to end against the fake Google through the practice redirect.
 *
 * What it protects:
 * - 受信を読む (`gmail.readonly`) is asked for only when the member first asks for it, never with
 *   minutes or mail, and no wider Gmail scope is ever asked for;
 * - the role メールを読む reads only the member's own mailbox, decodes what Japanese mail looks
 *   like (encoded subjects, ISO-2022-JP, HTML only), marks newsletters, and stores and logs
 *   nothing of a message;
 * - the member's own switch: 受信を読む off refuses the next call before anything leaves ACB,
 *   while the other features keep working; on again works; it survives a re-consent;
 * - 「つないでいるサービス」: owners / admins see Google with the roles it serves, switch it,
 *   and a switched-off Google serves no role from the next call.
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
const CO = 'gi-co'
const OTHER = 'gi-other'
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

beforeAll(async () => {
  fake = createFakeGoogle()
  fake.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  fake.addClient({ clientId: OTHER_CLIENT_ID, clientSecret: OTHER_SECRET, redirectUris: [REDIRECT] })
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-gi-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-gi-shelf-'))
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

const READ = 'https://www.googleapis.com/auth/gmail.readonly'
const AFTER = Date.parse('2026-11-01T00:00:00Z')
const gmailReads = () => fake.requests.filter(r => r.path.startsWith('/gmail/v1/users/me/messages') && !r.path.endsWith('/send')).length

describe('Google as a core connector: 受信を読む', () => {
  it('受信を読む is asked for only when first needed, and nothing wider', async () => {
    expect((await call('g-owner', 'PUT', `${C()}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: DOMAIN })).status).toBe(200)
    const first = await allow('g-sato', ['minutes'], GOOGLE_SEED.member)
    expect(first.url.searchParams.get('scope')).not.toContain('gmail')
    const { url, page } = await allow('g-sato', ['inbox'], GOOGLE_SEED.member)
    expect(page.status).toBe(200)
    const scopes = url.searchParams.get('scope')!.split(' ')
    expect(scopes.filter(s => s.includes('gmail'))).toEqual([READ])
    expect(scopes).toContain(CAL)
    const mine = (await call('g-sato', 'GET', `${C()}/me/google`)).body.data
    expect(mine).toMatchObject({ connected: true, features: ['minutes', 'inbox'], featuresOff: [] })
  })

  it('the role メールを読む reads the member\'s own mailbox only, in plain text, and keeps nothing', async () => {
    const list = await services.mailReader.listMessages(CO, 'g-sato', { afterMs: AFTER })
    expect(list.ok, JSON.stringify(list)).toBe(true)
    const messages = list.value.messages
    expect(messages.map((m: Json) => m.id)).toEqual(['fakemail0003', 'fakemail0002', 'fakemail0001'])
    const first = messages.find((m: Json) => m.id === 'fakemail0001')
    expect(first).toMatchObject({
      threadId: 'fakethread0001', subject: 'お見積もりのご相談', bulk: false, automated: false,
      from: { email: GOOGLE_SEED.customerSuzuki, name: '鈴木 一郎' },
      to: [{ email: GOOGLE_SEED.member, name: '佐藤 健' }], cc: [{ email: GOOGLE_SEED.customerYamaguchi, name: '' }],
      messageIdHeader: '<fake-0001@a-corp.example>',
    })
    expect(first.text).toBeUndefined()
    expect(messages.find((m: Json) => m.id === 'fakemail0002').bulk).toBe(true)
    // Only what arrived after the time asked for.
    const later = await services.mailReader.listMessages(CO, 'g-sato', { afterMs: Date.parse('2026-11-06T02:30:00Z') })
    expect(later.value.messages.map((m: Json) => m.id)).toEqual(['fakemail0003'])

    const jp = await services.mailReader.getMessage(CO, 'g-sato', 'fakemail0003')
    expect(jp.ok, JSON.stringify(jp)).toBe(true)
    expect(jp.value).toMatchObject({ text: '山口です。補足です。対象は営業部の30名です。', inReplyTo: '<fake-0001@a-corp.example>', truncated: false })
    const html = await services.mailReader.getMessage(CO, 'g-sato', 'fakemail0002')
    expect(html.value.text).toContain('今週のおすすめです。')
    expect(html.value.text).not.toContain('<')
    // Tanaka's message is not in Sato's mailbox.
    expect(await services.mailReader.getMessage(CO, 'g-sato', 'fakemail0004')).toEqual({ ok: false, reason: 'not-found' })

    // Nothing of a message was stored or logged; the action log names the operation only.
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    const dump = tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n')
    for (const text of [dump, ...logLines]) {
      for (const content of ['お見積もり', '山口です', 'おすすめ', 'a-corp.example', 'fake-0001']) {
        expect(text.includes(content), `message content shows up: ${content}`).toBe(false)
      }
    }
    const ops = (db.prepare("SELECT tool FROM agent_events WHERE company_id = ? AND tool LIKE 'google:gmail%'").all(CO) as Json[]).map(r => r.tool)
    expect(new Set(ops)).toEqual(new Set(['google:gmail.messages.list', 'google:gmail.messages.get']))
  })

  it('a member without 受信を読む is refused before anything leaves ACB', async () => {
    await allow('g-tanaka', ['minutes'], GOOGLE_SEED.colleague)
    const before = gmailReads()
    expect(await services.mailReader.listMessages(CO, 'g-tanaka', { afterMs: AFTER })).toEqual({ ok: false, reason: 'not-connected' })
    expect(gmailReads()).toBe(before)
    // The switch cannot be turned for a feature that was never allowed.
    expect((await call('g-tanaka', 'PUT', `${C()}/me/google/features`, { feature: 'inbox', on: false })).status).toBe(409)
  })

  it('the member turns 受信を読む off: refused from the next call, the rest keeps working; on again works', async () => {
    const off = await call('g-sato', 'PUT', `${C()}/me/google/features`, { feature: 'inbox', on: false })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body.data).toMatchObject({ features: ['minutes', 'inbox'], featuresOff: ['inbox'] })
    const before = gmailReads()
    expect(await services.mailReader.listMessages(CO, 'g-sato', { afterMs: AFTER })).toEqual({ ok: false, reason: 'turned-off' })
    expect(await services.mailReader.getMessage(CO, 'g-sato', 'fakemail0001')).toEqual({ ok: false, reason: 'turned-off' })
    expect(gmailReads()).toBe(before)
    // The one Google client refuses it (not only the role): any gmail.readonly call.
    const direct = await services.googleClient.request(CO, 'g-sato', { api: 'gmail', method: 'GET', path: '/gmail/v1/users/me/messages', scope: READ, operation: 'gmail.messages.list' })
    expect(direct).toMatchObject({ ok: false, kind: 'not-sent', reason: 'feature-off' })
    // 予定と議事録を読む is still on.
    expect((await services.googleClient.request(CO, 'g-sato', { api: 'calendar', method: 'GET', path: '/calendar/v3/calendars/primary/events', scope: CAL, operation: 'calendar.events.list' })).ok).toBe(true)
    // The admin sees it off.
    const admin = (await call('g-admin', 'GET', `${C()}/google`)).body.data
    expect(admin.grants.find((g: Json) => g.userId === 'g-sato').featuresOff).toEqual(['inbox'])
    // A re-consent (mail added) keeps the member's choice.
    await allow('g-sato', ['mail'], GOOGLE_SEED.member)
    expect((await call('g-sato', 'GET', `${C()}/me/google`)).body.data.featuresOff).toEqual(['inbox'])
    expect(await services.mailReader.listMessages(CO, 'g-sato', { afterMs: AFTER })).toEqual({ ok: false, reason: 'turned-off' })

    expect((await call('g-sato', 'PUT', `${C()}/me/google/features`, { feature: 'inbox', on: true })).body.data.featuresOff).toEqual([])
    expect((await services.mailReader.listMessages(CO, 'g-sato', { afterMs: AFTER })).ok).toBe(true)
    // Bad bodies.
    expect((await call('g-sato', 'PUT', `${C()}/me/google/features`, { feature: 'everything', on: false })).status).toBe(400)
    expect((await call('g-sato', 'PUT', `${C()}/me/google/features`, { feature: 'inbox' })).status).toBe(400)
  })

  it('メールを送る off: a send is refused before anything leaves ACB', async () => {
    expect((await call('g-sato', 'PUT', `${C()}/me/google/features`, { feature: 'mail', on: false })).status).toBe(200)
    expect(await services.connectorRoles.resolve(CO, 'mail', 'send')).toMatchObject({ ok: true, connectorId: 'google' })
    const sent = fake.sent.length
    const r = await services.googleClient.request(CO, 'g-sato', { api: 'gmail', method: 'POST', path: '/gmail/v1/users/me/messages/send', body: { raw: 'x' }, scope: SEND, operation: 'gmail.send' })
    expect(r).toMatchObject({ ok: false, kind: 'not-sent', reason: 'feature-off' })
    expect(fake.sent.length).toBe(sent)
    expect((await call('g-sato', 'PUT', `${C()}/me/google/features`, { feature: 'mail', on: true })).status).toBe(200)
  })

  it('「つないでいるサービス」: owners and admins see Google and its roles; off serves no role from the next call', async () => {
    expect((await call('g-sato', 'GET', `${C()}/connectors`)).status).toBe(403)
    const view = await call('g-admin', 'GET', `${C()}/connectors`)
    expect(view.status).toBe(200)
    const google = view.body.data.connectors.find((c: Json) => c.id === 'google')
    expect(google).toMatchObject({ status: 'on', configured: true, enabled: true, operatorStopped: false })
    expect(google.roles.map((r: Json) => r.role)).toEqual(['calendar', 'mail', 'meetings'])
    expect(google.capabilities.map((c: Json) => c.id)).toEqual(['drive'])
    const served = Object.fromEntries(view.body.data.roles.map((r: Json) => [r.role, r.servedBy]))
    expect(served).toEqual({ calendar: 'google', mail: 'google', meetings: 'google', chat: null })

    const offView = await call('g-admin', 'PUT', `${C()}/connectors/google/enabled`, { enabled: false })
    expect(offView.status).toBe(200)
    expect(offView.body.data.connectors[0].status).toBe('off')
    expect(offView.body.data.roles.every((r: Json) => r.servedBy === null)).toBe(true)
    const before = gmailReads()
    expect(await services.mailReader.listMessages(CO, 'g-sato', { afterMs: AFTER })).toEqual({ ok: false, reason: 'stopped' })
    expect(gmailReads()).toBe(before)
    expect((await call('g-sato', 'PUT', `${C()}/connectors/google/enabled`, { enabled: true })).status).toBe(403)
    expect((await call('g-owner', 'PUT', `${C()}/connectors/google/enabled`, { enabled: true })).status).toBe(200)
    expect((await services.mailReader.listMessages(CO, 'g-sato', { afterMs: AFTER })).ok).toBe(true)
    // A connector cannot be chosen for a role it does not serve; an unknown connector is not found.
    expect((await call('g-owner', 'PUT', `${C()}/connector-roles/chat`, { connectorId: 'google' })).status).toBe(400)
    expect((await call('g-owner', 'PUT', `${C()}/connectors/no-such/enabled`, { enabled: true })).status).toBe(404)
  })

  it('another company without Google reads no mail (stopped, nothing sent)', async () => {
    const before = gmailReads()
    expect(await services.mailReader.listMessages(OTHER, 'g-other-member', { afterMs: AFTER })).toEqual({ ok: false, reason: 'stopped' })
    expect(gmailReads()).toBe(before)
  })
})
