/**
 * End-to-end: outbound mail (milestone 4 G8, `.claude/rules/outbound-mail.md`) against the fake
 * Google and the fake HubSpot behind the practice redirect, the way staging runs it — the
 * server's own routes, a session for the member and a record token for their AI.
 *
 * What it protects (each guard mutation-checked, see the PR):
 * - the AI drafts but can never send: no records-ai path sends, resolves, discards or adds an
 *   address; the session routes refuse a record token; the generic record action refuses it;
 * - recipients are verified: the AI passes refs only; a ref no source offers is refused;
 * - the hash on screen must be the current version's, or nothing is sent (the fake has 0 mails);
 * - every recipient is re-read at its source right before sending: an attendee removed from the
 *   calendar since drafting → nothing sent; a source that cannot be read → nothing sent;
 * - the send is never retried: a lost answer is `unknown` with exactly one mail in Gmail;
 * - no header injection through the subject or a typed address;
 * - another company's draft id (or another member's) answers the same 404 and changes nothing;
 * - the body is gone 30 days after sending (fake clock), the hash / subject / Gmail id stay;
 * - no access or refresh token in any answer, log line or table; no subject, body or address
 *   in any log line.
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
import { createFakeHubSpot, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'
import { enableSampleSales, putSampleHub } from '../helpers/plugin-packages'
import { withRecordText } from '../helpers/record-text'
import { awaitReplyDefault } from '../../../shared/core/mail'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const EMAILS: Record<string, string> = {
  'm-owner': 'owner@div.example',
  'm-sato': GOOGLE_SEED.member,
  'm-tanaka': GOOGLE_SEED.colleague,
  'm-other-owner': 'boss@other.example',
}
const NAMES: Record<string, string> = { 'm-owner': '阿部', 'm-sato': '佐藤 健', 'm-tanaka': '田中', 'm-other-owner': '他社' }
const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@x`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.filter(id => EMAILS[id]).map(id => [id, { email: EMAILS[id], name: NAMES[id] }]))),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const CO = 'mail-co'
const OTHER = 'mail-other'
const PUBLIC = 'http://localhost:13002'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-mailclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-mail-0123456789'
const HUB_KEY = 'pat-fake-NOT-REAL-mail-0123456789'
const MAPPING = `
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
  fields:
    title:      { from: dealname, write: false }
    next_step:  { from: hs_next_step, write: true }
policy:
  next_step: auto
`
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let google: FakeGoogle
let hub: FakeHubSpot
let googleServer: ServerType, hubServer: ServerType
let kekDir: string, shelfDir: string
const logLines: string[] = []
const answers: string[] = []
const owner = { companyId: CO, userId: 'm-owner', role: 'owner' }
let bundleId: string
let meetingId: string

async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res: Response = await app.request(`${PUBLIC}${opts.path}`, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  const text = await res.text()
  answers.push(text)
  let body: Json = null
  try { body = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body, text }
}
const C = (co = CO) => `/api/companies/${co}`
const person = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `${C()}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown) => call({ token, method, path: `/api/records-ai${path}`, body })

async function tokenFor(user: string): Promise<string> {
  const r = await call({ user, method: 'POST', path: `${C()}/me/record-tokens`, body: { conversationId: 'conv-mail', agent: 'claude-code', scope: 'act' } })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}

/** 「Google で許可」 all the way through the fake. */
async function allow(user: string, features: string[]) {
  google.signIn({ email: EMAILS[user] })
  const r = await call({ user, method: 'POST', path: `${C()}/me/google/connect`, body: { features } })
  expect(r.status, r.text).toBe(200)
  const res = await fetch(r.body.data.authorizeUrl, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  const page = await call({ method: 'GET', path: `/api/oauth/google/callback${back.search}` })
  expect(page.status, page.text).toBe(200)
}

const sentCount = () => google.sent.length
const stateOf = (id: string) => (db.prepare('SELECT state, fields, version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json)
const pick = (recipients: Json[], source: string, email: string) => recipients.find(r => r.source === source && r.email === email)

beforeAll(async () => {
  google = createFakeGoogle()
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  googleServer = serve({ fetch: google.app.fetch, port: 0, hostname: '127.0.0.1' })
  hub = createFakeHubSpot()
  hub.addKey(HUB_KEY)
  hubServer = serve({ fetch: hub.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  kekDir = mkdtempSync(join(tmpdir(), 'acb-mail-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-mail-shelf-'))
  putSampleHub(shelfDir)
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
    ACB_FAKE_HUBSPOT_URL: `http://127.0.0.1:${(hubServer.address() as AddressInfo).port}`,
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
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/plugins')).pluginsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/outbound-mail')).outboundMailRoute)
  app.route('/api/records-ai', (await import('../../src/routes/records-ai')).recordsAiRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)
  await services.pluginShelf.load()

  for (const [co, o] of [[CO, 'm-owner'], [OTHER, 'm-other-owner']]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, o, ts(), ts())
  }
  for (const [u, co, role] of [['m-owner', CO, 'owner'], ['m-sato', CO, 'member'], ['m-tanaka', CO, 'member'], ['m-other-owner', OTHER, 'owner']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, co, role, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  const { ensureCoreTypes } = await import('../../src/services/record-index')
  const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
  for (const co of [CO, OTHER]) {
    ensureCompanyScope(db, co)
    db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(co, ts(), 'x')
    // What turning the switch on does first (record-index.ts).
    ensureCoreTypes(sqliteCompanyData(db).forCompany(co).records, ts())
  }
  // Google: the company's client, on.
  expect((await person('m-owner', 'PUT', '/google/client', { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
  // HubSpot: the plugin on, read scope 佐藤, deals imported.
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: HUB_KEY, audience })).value.keys[0].id
  await enableSampleSales(services.plugins, owner)
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
  const saved = await services.plugins.saveMapping(owner, 'sample-sales', { text: MAPPING, acknowledgeAuto: ['next_step'] })
  expect(saved.ok, JSON.stringify(saved)).toBe(true)
  expect((await services.plugins.setReadScope(owner, 'sample-hub', { userIds: ['m-sato'] })).ok).toBe(true)
  expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
  expect((await person('m-owner', 'POST', '/plugins/sample-sales/import')).status).toBe(200)
  bundleId = (db.prepare("SELECT record_id FROM plugin_external_links WHERE company_id = ? AND external_id = '1000000001' AND object = 'deal'").get(CO) as Json).record_id
  // The minutes of the sales meeting (made by the minutes service in G7; here through the service writer).
  const { createServiceRecordWriter } = await import('../../src/services/record-engine')
  const { sqliteTransactions } = await import('../../src/adapters/sqlite/transactions')
  const { systemClock, randomIds } = await import('../../src/adapters/system')
  const writer = createServiceRecordWriter({
    companyData: sqliteCompanyData(db), transactions: sqliteTransactions(db), clock: systemClock, ids: randomIds,
    isMember: () => true, roleOf: () => 'member', notify: () => {},
  })
  const made = writer.create(CO, {
    type: 'meeting', title: '商談', folder: '営業部', state: 'received',
    fields: { assignee: 'm-sato', source_ref: JSON.stringify({ conference: GOOGLE_SEED.salesConference, event: GOOGLE_SEED.salesEvent, docs: [] }), external_count: 2 },
    links: { bundle: [bundleId] }, actor: { id: 'm-sato', kind: 'human', source: null },
  })
  expect(made.ok, JSON.stringify(made)).toBe(true)
  meetingId = (made as Json).record.id
})

afterAll(async () => {
  google.close()
  hub.close()
  await new Promise(r => googleServer.close(r))
  await new Promise(r => hubServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL', 'ACB_FAKE_HUBSPOT_URL']) delete process.env[k]
})

describe('outbound mail', () => {
  let token: string
  let draft: Json
  let recipients: Json[]

  it('the verified recipients: external calendar attendees, the deal\'s HubSpot contacts, members; refs are stable', async () => {
    await allow('m-sato', ['minutes'])
    token = await tokenFor('m-sato')
    const r = await ai(token, 'POST', '/outbound-recipients', { meetingId })
    expect(r.status, r.text).toBe(200)
    recipients = r.body.data.recipients
    expect(r.body.data.unreadable).toEqual([])
    const rows = recipients.map((x: Json) => `${x.source}:${x.email}`).sort()
    expect(rows).toEqual([
      `calendar:${GOOGLE_SEED.customerSuzuki}`, `calendar:${GOOGLE_SEED.customerYamaguchi}`,
      `hubspot:${GOOGLE_SEED.customerSuzuki}`, `hubspot:${GOOGLE_SEED.customerYamaguchi}`,
      `member:${EMAILS['m-owner']}`, `member:${EMAILS['m-tanaka']}`,
    ])
    // The member's own address and the internal attendee are not offered; nobody has been written to yet.
    expect(recipients.every((x: Json) => x.ref.match(/^r[0-9a-f]{24}$/))).toBe(true)
    expect(pick(recipients, 'calendar', GOOGLE_SEED.customerSuzuki).firstTime).toBe(true)
    expect(pick(recipients, 'member', EMAILS['m-tanaka']).firstTime).toBe(false)
    const again = await ai(token, 'POST', '/outbound-recipients', { meetingId })
    expect(again.body.data.recipients.map((x: Json) => x.ref)).toEqual(recipients.map((x: Json) => x.ref))
  })

  it('the AI drafts with refs; an address no source offers cannot be added by the AI (no route, no field)', async () => {
    const to = [pick(recipients, 'calendar', GOOGLE_SEED.customerSuzuki).ref, pick(recipients, 'hubspot', GOOGLE_SEED.customerYamaguchi).ref]
    const cc = [pick(recipients, 'member', EMAILS['m-tanaka']).ref]
    const forged = `r${'0'.repeat(24)}`
    const refused = await ai(token, 'POST', '/outbound', { meetingId, toRefs: [forged], subject: '件名', body: '本文' })
    expect([refused.status, refused.body.code]).toEqual([400, 'RECIPIENT_NOT_OFFERED'])
    // An address in the body of the request is not a recipient (refs only); a raw address as a ref is refused.
    const raw = await ai(token, 'POST', '/outbound', { meetingId, toRefs: ['evil@attacker.example'], to: ['evil@attacker.example'], subject: '件名', body: '本文' })
    expect(raw.status).toBe(400)

    const made = await ai(token, 'POST', '/outbound', {
      meetingId, toRefs: to, ccRefs: cc, to: ['evil@attacker.example'],
      subject: '本日はありがとうございました', body: '鈴木様\n\n本日はありがとうございました。\n資料: https://example.com/doc\n',
    })
    expect(made.status, made.text).toBe(201)
    draft = made.body.data.draft
    expect(draft).toMatchObject({ state: 'draft', version: 1, from: GOOGLE_SEED.member, linkCount: 1, bundleId, meetingId, lastChangedBy: 'ai' })
    expect(draft.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(draft.to.map((x: Json) => [x.source, x.email])).toEqual([['calendar', GOOGLE_SEED.customerSuzuki], ['hubspot', GOOGLE_SEED.customerYamaguchi]])
    expect(draft.cc.map((x: Json) => [x.source, x.email])).toEqual([['member', EMAILS['m-tanaka']]])
    expect(JSON.stringify(draft)).not.toContain('attacker')
    // The record is the AI's (the credential decided) and holds the hash, not the body.
    const s = stateOf(draft.id)
    expect(JSON.parse(s.fields)).toMatchObject({ payload_hash: draft.hash, payload_version: 1, requested_by: 'm-sato', channel: 'email' })
    expect(s.fields).not.toContain('ありがとうございました。')
    const ledger = db.prepare('SELECT actor_kind FROM record_ledger WHERE company_id = ? AND record_id = ?').get(CO, draft.id) as Json
    expect(ledger.actor_kind).toBe('ai')
    // The AI has no way to add a typed address.
    expect((await ai(token, 'POST', `/outbound/${draft.id}/recipients`, { email: 'evil@attacker.example' })).status).toBe(404)
  })

  it('an AI token reaches no send path; nothing is sent', async () => {
    for (const [method, path] of [
      ['POST', `/outbound/${draft.id}/send`], ['POST', `/outbound/${draft.id}/resolve`], ['POST', `/outbound/${draft.id}/discard`],
      ['POST', `/outbound/${draft.id}`], ['PUT', `/outbound/${draft.id}/send`], ['POST', '/outbound/send'],
    ]) {
      const r = await ai(token, method, path, { hash: draft.hash, sent: true })
      expect(r.status, `${method} ${path}`).toBe(404)
    }
    // The session routes do not take a record token.
    const viaToken = await call({ token, method: 'POST', path: `${C()}/outbound/${draft.id}/send`, body: { hash: draft.hash } })
    expect(viaToken.status).toBe(401)
    // The generic record routes refuse to change a mail's state, for the AI and the person alike.
    const action = await ai(token, 'POST', `/item/${draft.id}/actions/send`, { expectedVersion: stateOf(draft.id).version })
    expect(action.status).toBe(403)
    expect(sentCount()).toBe(0)
    expect(stateOf(draft.id).state).toBe('draft')
  })

  it('the AI makes a new version; a stale version is refused', async () => {
    const stale = await ai(token, 'PUT', `/outbound/${draft.id}`, { expectedVersion: 0, body: 'x' })
    expect([stale.status, stale.body.code]).toEqual([409, 'VERSION_CONFLICT'])
    const v2 = await ai(token, 'PUT', `/outbound/${draft.id}`, { expectedVersion: 1, body: '鈴木様\n\n本日はありがとうございました。\n' })
    expect(v2.status, v2.text).toBe(200)
    expect(v2.body.data.draft).toMatchObject({ version: 2, linkCount: 0 })
    expect(v2.body.data.draft.hash).not.toBe(draft.hash)
    expect(v2.body.data.draft.to).toEqual(draft.to)
  })

  it('sending needs the member\'s permission to send mail (needsGoogleConsent: mail)', async () => {
    const now = (await person('m-sato', 'GET', `/outbound/${draft.id}`)).body.data.draft
    const r = await person('m-sato', 'POST', `/outbound/${draft.id}/send`, { hash: now.hash })
    expect([r.status, r.body.code, r.body.needsGoogleConsent]).toEqual([409, 'GOOGLE_CONSENT_NEEDED', 'mail'])
    expect(sentCount()).toBe(0)
    await allow('m-sato', ['mail'])
  })

  it('the hash shown must be the current version\'s: an old or malformed hash sends nothing', async () => {
    const old = await person('m-sato', 'POST', `/outbound/${draft.id}/send`, { hash: draft.hash })
    expect([old.status, old.body.code]).toEqual([409, 'CONTENT_CHANGED'])
    expect(old.body.draft.version).toBe(2)
    expect((await person('m-sato', 'POST', `/outbound/${draft.id}/send`, { hash: 'sha256:abc' })).status).toBe(400)
    expect((await person('m-sato', 'POST', `/outbound/${draft.id}/send`, {})).status).toBe(400)
    expect(sentCount()).toBe(0)
  })

  it('another company\'s draft id, or another member\'s, answers the same 404 and changes nothing', async () => {
    const missing = await call({ user: 'm-other-owner', method: 'GET', path: `${C(OTHER)}/outbound/outbound_message-0000000000000000` })
    const before = stateOf(draft.id)
    for (const [method, suffix, body] of [
      ['GET', '', undefined], ['PUT', '', { expectedVersion: 2, body: 'x' }], ['POST', '/send', { hash: `sha256:${'0'.repeat(64)}` }],
      ['POST', '/resolve', { sent: true }], ['POST', '/discard', {}], ['POST', '/recipients', { email: 'a@b.example' }], ['GET', '/recipients', undefined],
    ] as Array<[string, string, unknown]>) {
      const cross = await call({ user: 'm-other-owner', method, path: `${C(OTHER)}/outbound/${draft.id}${suffix}`, body })
      expect([cross.status, cross.body], `${method} ${suffix}`).toEqual([404, missing.body])
      const colleague = await person('m-tanaka', method, `/outbound/${draft.id}${suffix}`, body)
      expect(colleague.status, `colleague ${method} ${suffix}`).toBe(404)
    }
    expect(stateOf(draft.id)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM outbound_typed_recipients').get().n).toBe(0)
    expect(sentCount()).toBe(0)
  })

  it('no header injection: a subject with a line break or a typed address with another header is refused', async () => {
    const now = (await person('m-sato', 'GET', `/outbound/${draft.id}`)).body.data.draft
    const subj = await person('m-sato', 'PUT', `/outbound/${draft.id}`, { expectedVersion: now.version, subject: 'お礼\r\nBcc: spy@attacker.example' })
    expect([subj.status, subj.body.code]).toEqual([400, 'MAIL_INVALID'])
    for (const email of ['a@b.example\r\nBcc: spy@attacker.example', 'a@b.example, spy@attacker.example', '"x" <spy@attacker.example>', 'a@b.example\nCc:x@y.example']) {
      const typed = await person('m-sato', 'POST', `/outbound/${draft.id}/recipients`, { email })
      expect([typed.status, typed.body.code], email).toEqual([400, 'BAD_ADDRESS'])
    }
    const name = await person('m-sato', 'POST', `/outbound/${draft.id}/recipients`, { email: 'ok@b.example', name: 'x\r\nBcc: spy@attacker.example' })
    expect(name.status).toBe(400)
    expect(sentCount()).toBe(0)
  })

  it('a person types an address (「あなたが入力」) and uses it; the AI cannot pick it by guessing', async () => {
    const typed = await person('m-sato', 'POST', `/outbound/${draft.id}/recipients`, { email: 'Partner@Third.Example', name: '外部 太郎' })
    expect(typed.status, typed.text).toBe(200)
    expect(typed.body.data.recipient).toMatchObject({ email: 'partner@third.example', source: 'typed', firstTime: true })
    const listed = await person('m-sato', 'GET', `/outbound/${draft.id}/recipients`)
    expect(pick(listed.body.data.recipients, 'typed', 'partner@third.example').ref).toBe(typed.body.data.recipient.ref)
    // Not offered for another draft's context (refs are per draft).
    const ctx = await ai(token, 'POST', '/outbound-recipients', { meetingId })
    expect(ctx.body.data.recipients.some((x: Json) => x.source === 'typed')).toBe(false)
  })

  it('an attendee removed from the calendar since drafting: nothing is sent', async () => {
    // A second draft to the calendar address (the first keeps the HubSpot one for the successful send).
    const made = await person('m-sato', 'POST', '/outbound', {
      meetingId, toRefs: [pick(recipients, 'calendar', GOOGLE_SEED.customerYamaguchi).ref], subject: 'ご連絡', body: '本文',
    })
    expect(made.status, made.text).toBe(201)
    google.changeEvent(GOOGLE_SEED.salesEvent, { removeAttendee: GOOGLE_SEED.customerYamaguchi })
    const r = await person('m-sato', 'POST', `/outbound/${made.body.data.draft.id}/send`, { hash: made.body.data.draft.hash })
    expect([r.status, r.body.code]).toEqual([409, 'RECIPIENT_GONE'])
    expect(r.body.goneRefs).toEqual([pick(recipients, 'calendar', GOOGLE_SEED.customerYamaguchi).ref])
    expect(sentCount()).toBe(0)
    expect(stateOf(made.body.data.draft.id).state).toBe('draft')
  })

  it('a source that cannot be read right now: 「確かめられないため送れません」, nothing sent', async () => {
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: false })).ok).toBe(true)
    const now = (await person('m-sato', 'GET', `/outbound/${draft.id}`)).body.data.draft
    const r = await person('m-sato', 'POST', `/outbound/${draft.id}/send`, { hash: now.hash })
    expect([r.status, r.body.code]).toEqual([409, 'RECIPIENTS_UNVERIFIABLE'])
    expect(r.body.error).toContain('確かめられないため送れません')
    expect(sentCount()).toBe(0)
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
  })

  it('「確かめて送る」: the shown hash, sent once from the member\'s Gmail; the deal gets a 「やりとり」', async () => {
    // Suzuki is still in the calendar and in HubSpot.
    const now = (await person('m-sato', 'GET', `/outbound/${draft.id}`)).body.data.draft
    const r = await person('m-sato', 'POST', `/outbound/${draft.id}/send`, { hash: now.hash })
    expect(r.status, r.text).toBe(200)
    expect(r.body.data.outcome).toBe('sent')
    expect(sentCount()).toBe(1)
    const mail = google.sent[0]
    expect(mail.account).toBe(GOOGLE_SEED.member)
    expect(mail.to).toEqual([GOOGLE_SEED.customerSuzuki, GOOGLE_SEED.customerYamaguchi])
    expect(mail.cc).toEqual([EMAILS['m-tanaka']])
    expect(mail.bcc).toEqual([])
    expect(mail.subject).toBe('本日はありがとうございました')
    expect(mail.body).toBe('鈴木様\n\n本日はありがとうございました。\n')
    expect(r.body.data.draft).toMatchObject({ state: 'sent', providerMessageId: mail.id })
    expect(JSON.parse(stateOf(draft.id).fields)).toMatchObject({ provider_message_id: mail.id, sent_at: expect.any(String) })
    // The interaction: channel email, the subject, domains only, Gmail's id; linked to the deal.
    const [interaction] = withRecordText(db, CO, db.prepare("SELECT r.id, r.title, s.fields FROM records r JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id WHERE r.company_id = ? AND r.type = 'interaction'").all(CO) as Json[])
    expect(interaction.title).toBe('本日はありがとうございました')
    expect(JSON.parse(interaction.fields)).toMatchObject({ channel: 'email', counterpart_text: 'a-corp.example, div.example', source_ref: `gmail:${mail.id}` })
    expect(interaction.fields).not.toContain('suzuki')
    const link = db.prepare("SELECT target_id FROM record_links WHERE company_id = ? AND source_id = ? AND name = 'bundle'").get(CO, interaction.id) as Json
    expect(link.target_id).toBe(bundleId)
    // And the まとまり's 相手 (the deal's customer, a type implementing counterpart).
    const customer = db.prepare("SELECT target_id FROM record_links WHERE company_id = ? AND source_id = ? AND name = 'customer'").get(CO, bundleId) as Json | undefined
    const counterpart = db.prepare("SELECT target_id FROM record_links WHERE company_id = ? AND source_id = ? AND name = 'counterpart'").get(CO, interaction.id) as Json | undefined
    expect(counterpart?.target_id ?? null).toBe(customer?.target_id ?? null)
    // Never twice.
    const again = await person('m-sato', 'POST', `/outbound/${draft.id}/send`, { hash: now.hash })
    expect([again.status, again.body.code]).toEqual([409, 'NOT_DRAFT'])
    expect(sentCount()).toBe(1)
    // The domain is no longer new.
    const after = await ai(token, 'POST', '/outbound-recipients', { meetingId })
    expect(pick(after.body.data.recipients, 'hubspot', GOOGLE_SEED.customerSuzuki).firstTime).toBe(false)
  })

  it('a lost answer: `unknown`, exactly one mail in Gmail, never re-sent; the person settles it', async () => {
    const made = await person('m-sato', 'POST', '/outbound', {
      bundleId, toRefs: [(await ai(token, 'POST', '/outbound-recipients', { bundleId })).body.data.recipients.find((x: Json) => x.source === 'hubspot').ref],
      subject: '追ってのご連絡', body: '本文です',
    })
    expect(made.status, made.text).toBe(201)
    const d = made.body.data.draft
    google.faults.dropAnswerAfterSend(1)
    const r = await person('m-sato', 'POST', `/outbound/${d.id}/send`, { hash: d.hash })
    expect(r.status, r.text).toBe(200)
    expect(r.body.data).toMatchObject({ outcome: 'unknown', message: '届いたか分かりません。Gmail の送信済みを確かめてください。' })
    expect(sentCount()).toBe(2)
    expect(stateOf(d.id).state).toBe('unknown')
    // Pressing again sends nothing.
    const again = await person('m-sato', 'POST', `/outbound/${d.id}/send`, { hash: d.hash })
    expect([again.status, again.body.code]).toEqual([409, 'NOT_DRAFT'])
    expect(sentCount()).toBe(2)
    // 「送られていなかった」 → back to draft (sending again is a new 確かめて送る).
    const back = await person('m-sato', 'POST', `/outbound/${d.id}/resolve`, { sent: false })
    expect(back.status, back.text).toBe(200)
    expect(back.body.data.draft.state).toBe('draft')
    expect(sentCount()).toBe(2)
    expect((await person('m-sato', 'POST', `/outbound/${d.id}/discard`, {})).body.data.draft.state).toBe('discarded')
  })

  it('the meeting\'s mail is made once: reading again with the same subject returns the earlier one; another subject is a new draft', async () => {
    const to = [pick(recipients, 'calendar', GOOGLE_SEED.customerSuzuki).ref]
    const before = (db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'outbound_message'").get(CO) as Json).n
    const again = await ai(token, 'POST', '/outbound', { meetingId, toRefs: to, subject: '本日は ありがとうございました。', body: '別の本文' })
    expect(again.status, again.text).toBe(200)
    expect([again.body.data.draft.id, again.body.data.reused]).toEqual([draft.id, true])
    expect((db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'outbound_message'").get(CO) as Json).n).toBe(before)
    const other = await ai(token, 'POST', '/outbound', { meetingId, toRefs: to, subject: '資料のご送付', body: '本文' })
    expect(other.status, other.text).toBe(201)
    expect(other.body.data.draft.id).not.toBe(draft.id)
  })

  it('no access or refresh token in any answer, log line or table; no subject, body or address in a log line', async () => {
    const haystack = [...answers, ...logLines].join('\n')
    for (const prefix of ['ya29.fake-', '1//fake-']) expect(haystack).not.toContain(prefix)
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Json[]) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())
      expect(dump, name).not.toContain('ya29.fake-')
      expect(dump, name).not.toContain('1//fake-')
    }
    const logs = logLines.join('\n')
    for (const secret of ['本日はありがとうございました', 'suzuki@', 'yamaguchi@', 'partner@third', '追ってのご連絡']) expect(logs).not.toContain(secret)
  })
})

describe('retention (fake clock)', () => {
  it('the body is deleted 30 days after sent / discarded; the hash, recipients, subject and Gmail id stay', async () => {
    const { createOutboundMailService } = await import('../../src/services/outbound-mail')
    const { createFixedPayloads } = await import('../../src/services/fixed-payloads')
    const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
    const { sqliteTransactions } = await import('../../src/adapters/sqlite/transactions')
    const companyData = sqliteCompanyData(db)
    const sent = db.prepare("SELECT message_id, finished_at FROM outbound_mails WHERE company_id = ? AND finished_at IS NOT NULL ORDER BY finished_at").all(CO) as Json[]
    expect(sent.length).toBe(2)
    let nowMs = Date.parse(sent[1].finished_at)
    const service = createOutboundMailService({
      companyData, transactions: sqliteTransactions(db),
      clock: { nowMs: () => nowMs, now: () => new Date(nowMs).toISOString() },
      ids: { newId: () => 'x', newToken: () => 'x' },
      writer: null as never, digest: () => '', members: () => [], meetingAttendees: async () => null,
      dealContacts: async () => ({ ok: false, reason: 'x' }), mail: { senderAccount: async () => ({ ok: false, reason: 'unavailable' }), send: async () => ({ ok: false, kind: 'not-sent', reason: 'x' }) },
      companyIds: () => [CO, OTHER],
      payloads: createFixedPayloads({ companyData, clock: { nowMs: () => nowMs, now: () => new Date(nowMs).toISOString() } }),
    })
    const bodies = () => db.prepare("SELECT COUNT(*) AS n FROM fixed_payloads WHERE company_id = ? AND canonical IS NOT NULL AND owner_id IN (?, ?)").get(CO, sent[0].message_id, sent[1].message_id).n
    const before = bodies()
    expect(before).toBeGreaterThan(0)
    nowMs += 29 * 24 * 3600_000
    expect(service.cleanupBodies().deleted).toBe(0)
    expect(bodies()).toBe(before)
    nowMs += 2 * 24 * 3600_000
    expect(service.cleanupBodies().deleted).toBe(2)
    expect(bodies()).toBe(0)
    expect(service.cleanupBodies().deleted).toBe(0)
    // What stays: the hashes, the record's subject and Gmail id, the recipients.
    const kept = (await person('m-sato', 'GET', `/outbound/${sent[0].message_id}`)).body.data.draft
    expect(kept).toMatchObject({ body: null, bodyDeleted: true, subject: expect.any(String), hash: expect.stringMatching(/^sha256:/) })
    expect(kept.to.length).toBeGreaterThan(0)
    const sentOne = [kept, (await person('m-sato', 'GET', `/outbound/${sent[1].message_id}`)).body.data.draft].find((x: Json) => x.state === 'sent')
    expect(sentOne.providerMessageId).toBe(google.sent[0].id)
    // A draft that is still a draft keeps its body.
    expect(db.prepare("SELECT COUNT(*) AS n FROM fixed_payloads WHERE company_id = ? AND canonical IS NULL AND owner_id NOT IN (?, ?)").get(CO, sent[0].message_id, sent[1].message_id).n).toBe(0)
  })
})

describe('返事を待つ: a new mail we send first waits for their answer (outbound-mail.md "Waiting for their answer")', () => {
  let token: string
  let hubRef: string
  const day = (offset: number) => new Date(Date.now() + offset * 24 * 3600_000 + 9 * 3600_000).toISOString().slice(0, 10)
  /** The 返事のお願い made for the interaction of a sent mail, if any. */
  const waitingFor = (interactionId: string) => db.prepare(`
    SELECT r.id, s.state, s.fields FROM records r JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id
    JOIN record_links l ON l.company_id = r.company_id AND l.source_id = r.id AND l.name = 'interaction' AND l.target_id = ?
    WHERE r.company_id = ? AND r.type = 'reply_request'`).all(interactionId, CO) as Json[]
  const requestCount = () => (db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'reply_request'").get(CO) as Json).n
  /** The interaction of the mail Gmail sent last (found by the Message-ID ACB gave it). */
  function interactionOfLastSent(): { id: string; messageId: string; fields: Json } {
    const messageId = google.sent[google.sent.length - 1].headers['message-id']
    const rows = db.prepare("SELECT r.id, s.fields FROM records r JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id WHERE r.company_id = ? AND r.type = 'interaction'").all(CO) as Json[]
    const row = rows.find(r => JSON.parse(r.fields).message_id === messageId)
    return { id: row?.id, messageId, fields: row ? JSON.parse(row.fields) : null }
  }
  async function draft(extra: Record<string, unknown> = {}) {
    const made = await ai(token, 'POST', '/outbound', { bundleId, toRefs: [hubRef], subject: `お見積りのご送付 ${Math.random()}`, body: '見積書をお送りします。ご確認ください。', ...extra })
    expect(made.status, made.text).toBe(201)
    return made.body.data.draft as Json
  }

  beforeAll(async () => {
    token = await tokenFor('m-sato')
    hubRef = (await ai(token, 'POST', '/outbound-recipients', { bundleId })).body.data.recipients.find((x: Json) => x.source === 'hubspot' && x.email === GOOGLE_SEED.customerSuzuki).ref
  })

  it('the card is offered the box: pre-ticked when the AI marked the draft, unticked for a draft without the mark (an older app)', async () => {
    const marked = await draft({ expectsReply: true })
    expect(marked.awaitReply).toEqual({ expected: true, defaultUntil: awaitReplyDefault(new Date(), []), chosenUntil: null })
    const plain = await draft()
    expect(plain.awaitReply).toMatchObject({ expected: false, chosenUntil: null })
    // The AI may change its mark; a value that is not a yes / no is refused.
    const unmarked = await ai(token, 'PUT', `/outbound/${marked.id}`, { expectedVersion: 1, expectsReply: false })
    expect(unmarked.body.data.draft.awaitReply.expected).toBe(false)
    expect((await ai(token, 'POST', '/outbound', { bundleId, toRefs: [hubRef], subject: 's', body: 'b', expectsReply: 'yes' })).status).toBe(400)
  })

  it('a day in the past or too far ahead is refused before anything is sent', async () => {
    const d = await draft({ expectsReply: true })
    const sentBefore = sentCount()
    for (const until of [day(-2), day(400), 'tomorrow']) {
      const r = await person('m-sato', 'POST', `/outbound/${d.id}/send`, { hash: d.hash, awaitReply: { until } })
      expect([r.status, r.body.code], until).toEqual([400, 'AWAIT_REPLY_DATE'])
    }
    expect(sentCount()).toBe(sentBefore)
    expect(stateOf(d.id).state).toBe('draft')
  })

  it('nothing waits when the send fails', async () => {
    const d = await draft({ expectsReply: true })
    const before = requestCount()
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: false })).ok).toBe(true)
    const r = await person('m-sato', 'POST', `/outbound/${d.id}/send`, { hash: d.hash, awaitReply: { until: day(5) } })
    expect([r.status, r.body.code]).toEqual([409, 'RECIPIENTS_UNVERIFIABLE'])
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
    expect(requestCount()).toBe(before)
    expect(JSON.parse(stateOf(d.id).fields).reply_wait_until).toBeUndefined()
  })

  it('unticked: sent as before, nothing waits', async () => {
    const d = await draft({ expectsReply: true })
    const before = requestCount()
    const r = await person('m-sato', 'POST', `/outbound/${d.id}/send`, { hash: d.hash })
    expect(r.body.data?.outcome, r.text).toBe('sent')
    expect(requestCount()).toBe(before)
    expect(r.body.data.draft.awaitReply.chosenUntil).toBeNull()
  })

  it('ticked: a 返事のお願い in 返事待ち until that morning, the sender\'s, linked to the mail\'s やりとり and the task; their reply moves it to the AI\'s check', async () => {
    const task = await person('m-sato', 'POST', '/records/item', { type: 'task', title: '見積を送って返事をもらう', fields: { assignee: 'm-sato' } })
    expect(task.status, task.text).toBe(201)
    const taskId = task.body.data.record.id as string
    const d = await draft({ expectsReply: true, taskId })
    const until = day(5)
    const r = await person('m-sato', 'POST', `/outbound/${d.id}/send`, { hash: d.hash, awaitReply: { until } })
    expect(r.body.data?.outcome, r.text).toBe('sent')
    expect(r.body.data.draft.awaitReply.chosenUntil).toBe(until)
    const interaction = interactionOfLastSent()
    expect(interaction.fields).toMatchObject({ message_id: interaction.messageId, assignee: 'm-sato', thread_ref: `gmail:${google.sent[google.sent.length - 1].threadId}` })
    const [rr] = waitingFor(interaction.id)
    expect(rr.state).toBe('waiting_reply')
    expect(JSON.parse(rr.fields)).toMatchObject({ assignee: 'm-sato', wait_until: `${until}T09:00`, waiting_on: expect.stringContaining('からの返事') })
    const task2 = db.prepare("SELECT target_id FROM record_links WHERE company_id = ? AND source_id = ? AND name = 'task'").get(CO, rr.id) as Json
    expect(task2.target_id).toBe(taskId)
    // Their reply in the same thread (their mail references ours): the AI's turn to check it.
    const answered = services.inbox.receive(CO, 'm-sato', {
      channel: 'email', messageId: '<answer-1@a-corp.example>', references: [interaction.messageId], sourceRef: 'gmail:answer1',
      occurredAt: new Date().toISOString(), subject: 'Re: お見積り', from: { address: GOOGLE_SEED.customerSuzuki }, to: [{ address: GOOGLE_SEED.member }],
    })
    expect(answered).toBe('continued')
    expect(waitingFor(interaction.id)[0].state).toBe('checking')
  })

  it('a lost answer, then 「送られていた」: the waiting chosen at the send starts then', async () => {
    const d = await draft({ expectsReply: true })
    const until = day(3)
    google.faults.dropAnswerAfterSend(1)
    const r = await person('m-sato', 'POST', `/outbound/${d.id}/send`, { hash: d.hash, awaitReply: { until } })
    expect(r.body.data?.outcome, r.text).toBe('unknown')
    const before = requestCount()
    const resolved = await person('m-sato', 'POST', `/outbound/${d.id}/resolve`, { sent: true })
    expect(resolved.status, resolved.text).toBe(200)
    expect(requestCount()).toBe(before + 1)
    const interaction = interactionOfLastSent()
    expect(JSON.parse(waitingFor(interaction.id)[0].fields).wait_until).toBe(`${until}T09:00`)
  })
})
