/**
 * End-to-end: the card's 元のスレッド and replies into the same thread (stage 3 A4,
 * `.claude/rules/outbound-mail.md` "Replies") against the fake Google and the fake Slack behind
 * the practice redirect — the server's own routes and the real composition.
 *
 * What it protects (each guard mutation-checked, see the PR):
 * - the thread is read with the viewer's own permission and shown only to who reads the record:
 *   an owner-only 来た連絡 is its owner's (another member, the company owner: the same 404);
 * - the member's own switch (受信を読む off) reads nothing and says so;
 * - nothing of a thread is stored (no table holds its text) or logged;
 * - a mail reply goes into the member's own conversation: Gmail's threadId, In-Reply-To /
 *   References from the thread, recipients only from the thread (source `thread`), the member
 *   left out; the draft is owner-only like its 連絡; no new やりとり, the inbox hears it;
 * - a Slack reply goes into the thread (thread_ts) as the member, body only (no recipients),
 *   only with 返事を送る on, once; the AI cannot send either (no route).
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
import { createFakeSlack, defaultSlackSeed, type FakeSlack } from '../fakes/slack/fake-slack'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const EMAILS: Record<string, string> = {
  'th-owner': 'owner@div.example',
  'th-sato': GOOGLE_SEED.member,
  'th-tanaka': GOOGLE_SEED.colleague,
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
const CO = 'th-co'
const PUBLIC = 'http://localhost:13003'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-threadclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-thread-0123456789'
const CLIENT = 'client@acme.example'
const BOSS = 'boss@acme.example'
const MAIL_TEXT_1 = '見積の件、THREAD-MARK-ONE をご確認ください。'
const MAIL_TEXT_2 = '追加で THREAD-MARK-TWO もお願いします。'
const SLACK_TEXT = 'Slack で THREAD-MARK-SLACK の件です'
const SLACK_CHANNEL = 'C0SALES'
const SLACK_ROOT = '1793400000.000100'
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let google: FakeGoogle
let slack: FakeSlack
let googleServer: ServerType, slackServer: ServerType
let kekDir: string, shelfDir: string
const logLines: string[] = []
let mailInteraction: string
let chatInteraction: string

async function call(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res: Response = await app.request(`${PUBLIC}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body: json, text }
}
const person = (user: string, method: string, path: string, body?: unknown) => call(user, method, `/api/companies/${CO}${path}`, body)

async function allowGoogle(user: string, features: string[]) {
  google.signIn({ email: EMAILS[user] })
  const r = await person(user, 'POST', '/me/google/connect', { features })
  expect(r.status, r.text).toBe(200)
  const res = await fetch(r.body.data.authorizeUrl, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  expect((await call(null, 'GET', `/api/oauth/google/callback${back.search}`)).status).toBe(200)
}

async function allowSlack(user: string, slackUser: string, features: string[]) {
  const member = { companyId: CO, userId: user, role: 'member' }
  const started = await services.slackConnector.connect(member, { features })
  if (!started.ok) throw new Error(JSON.stringify(started))
  const url = new URL(started.value.authorizeUrl)
  const code = slack.issueCode({ clientId: slack.seed.apps[0].clientId, userId: slackUser, scopes: url.searchParams.get('user_scope')!.split(','), redirectUri: url.searchParams.get('redirect_uri')! })
  expect((await services.memberOAuth.callback('slack', { state: url.searchParams.get('state')!, code }))?.granted).toBe(true)
}

const interactionOf = (messageId: string) => (db.prepare('SELECT interaction_id FROM inbox_messages WHERE company_id = ? AND message_id = ?').get(CO, messageId) as Json).interaction_id as string
const interactionCount = () => (db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'interaction'").get(CO) as Json).n as number

/** Every text cell of every table (the thread's text must be in none). */
function everyTable(): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
  return tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
}

beforeAll(async () => {
  google = createFakeGoogle()
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  // Sato's mailbox: a conversation of two messages from outside (the second answers the first).
  const mail = (id: string, at: string, headers: Record<string, string>, text: string) => google.deliver({ id, threadId: 'thmail0001', account: GOOGLE_SEED.member, headers, labelIds: ['INBOX'], receivedAt: at, text })
  mail('msg0001', '2026-11-02T01:00:00.000Z', { From: `取引先 <${CLIENT}>`, To: GOOGLE_SEED.member, Cc: BOSS, Subject: '見積について', 'Message-ID': '<m1@acme.example>' }, MAIL_TEXT_1)
  mail('msg0002', '2026-11-02T02:00:00.000Z', { From: CLIENT, To: GOOGLE_SEED.member, Subject: 'Re: 見積について', 'Message-ID': '<m2@acme.example>', 'In-Reply-To': '<m1@acme.example>' }, MAIL_TEXT_2)
  googleServer = serve({ fetch: google.app.fetch, port: 0, hostname: '127.0.0.1' })

  const seed = defaultSlackSeed()
  seed.users.push({ id: 'U0SATO', email: GOOGLE_SEED.member, teamId: 'T0DIV' }, { id: 'U0TANAKA', email: GOOGLE_SEED.colleague, teamId: 'T0DIV' })
  seed.threads = [{ teamId: 'T0DIV', channel: SLACK_CHANNEL, ts: SLACK_ROOT, messages: [{ ts: SLACK_ROOT, user: 'U0ONE', text: `<@U0SATO> ${SLACK_TEXT}` }] }]
  slack = createFakeSlack(seed)
  slackServer = serve({ fetch: slack.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))

  kekDir = mkdtempSync(join(tmpdir(), 'acb-th-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-th-shelf-'))
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
    ACB_FAKE_SLACK_URL: `http://127.0.0.1:${(slackServer.address() as AddressInfo).port}`,
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
  app.route('/api/companies/:companyId', (await import('../../src/routes/outbound-mail')).outboundMailRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/threads')).threadsRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)

  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'th-owner', ts(), ts())
  for (const [u, role] of [['th-owner', 'owner'], ['th-sato', 'member'], ['th-tanaka', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, role, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  const { ensureCoreTypes } = await import('../../src/services/record-index')
  const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
  ensureCompanyScope(db, CO)
  db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(CO, ts(), 'x')
  ensureCoreTypes(sqliteCompanyData(db).forCompany(CO).records, ts())

  // Google on; Sato allows sending and 受信を読む.
  expect((await person('th-owner', 'PUT', '/google/client', { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
  // 受信を読む is off for a company until its admin turns it on (google-connector.md "One consent").
  expect((await person('th-owner', 'PUT', '/google/features', { feature: 'inbox', on: true })).status).toBe(200)
  await allowGoogle('th-sato', ['mail'])
  await allowGoogle('th-sato', ['inbox'])
  // Slack on (practice app); Sato allows reading and replying.
  const a = slack.seed.apps[0]
  const owner = { companyId: CO, userId: 'th-owner', role: 'owner' }
  const saved = await services.slackConnector.saveApp(owner, { teamId: a.teamId, clientId: a.clientId, clientSecret: a.clientSecret, signingSecret: a.signingSecret, botToken: a.botToken })
  expect(saved.ok, JSON.stringify(saved)).toBe(true)
  await allowSlack('th-sato', 'U0SATO', ['read', 'reply'])

  // The two 来た連絡 as the inbox makes them: owner-only records of Sato (To).
  expect(services.inbox.receive(CO, 'th-sato', {
    channel: 'email', messageId: '<m2@acme.example>', references: ['<m1@acme.example>'], threadRef: 'gmail:thmail0001', sourceRef: 'gmail:msg0002',
    occurredAt: '2026-11-02T02:00:00.000Z', subject: 'Re: 見積について', from: { address: CLIENT }, to: [{ address: GOOGLE_SEED.member }],
  })).toBe('created')
  mailInteraction = interactionOf('<m2@acme.example>')
  expect(services.inbox.receive(CO, 'th-sato', {
    channel: 'chat', messageId: `${SLACK_CHANNEL}:${SLACK_ROOT}`, references: [], threadRef: `slack:${SLACK_CHANNEL}:${SLACK_ROOT}`, sourceRef: `slack:${SLACK_CHANNEL}:${SLACK_ROOT}`,
    occurredAt: '2026-11-02T03:00:00.000Z', subject: null, from: { address: 'slack:U0ONE' }, to: [{ address: 'slack-member:th-sato', memberId: 'th-sato' }],
  })).toBe('created')
  chatInteraction = interactionOf(`${SLACK_CHANNEL}:${SLACK_ROOT}`)
})

afterAll(async () => {
  await new Promise(r => googleServer.close(r))
  await new Promise(r => slackServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
})

describe('元のスレッド: read now, with the viewer\'s own permission, shown only to who reads the record', () => {
  it('the owner of the 連絡 sees the mail thread, oldest first, with each message\'s text', async () => {
    const r = await person('th-sato', 'GET', `/threads/${mailInteraction}`)
    expect(r.status, r.text).toBe(200)
    const t = r.body.data.thread
    expect(t).toMatchObject({ interactionId: mailInteraction, channel: 'email', unavailable: null, more: false })
    expect(t.messages.map((m: Json) => [m.fromAddress, m.text])).toEqual([[CLIENT, MAIL_TEXT_1], [CLIENT, MAIL_TEXT_2]])
    expect(t.messages[0].cc).toEqual([BOSS])
  })

  it('another member and the company owner get the same 404 as a missing record (owner-only)', async () => {
    const missing = await person('th-tanaka', 'GET', '/threads/interaction-nosuch01')
    for (const user of ['th-tanaka', 'th-owner']) {
      const r = await person(user, 'GET', `/threads/${mailInteraction}`)
      expect(r.status).toBe(404)
      expect(r.body).toEqual(missing.body)
    }
    expect(missing.body.code).toBe('THREAD_NOT_FOUND')
  })

  it('the member\'s own 受信を読む off: nothing read, the reason and where to allow it', async () => {
    expect((await person('th-sato', 'PUT', '/me/google/features', { feature: 'inbox', on: false })).status).toBe(200)
    const r = await person('th-sato', 'GET', `/threads/${mailInteraction}`)
    expect(r.body.data.thread).toMatchObject({ messages: [], unavailable: { reason: 'turned-off', allow: 'google-inbox' } })
    expect((await person('th-sato', 'PUT', '/me/google/features', { feature: 'inbox', on: true })).status).toBe(200)
  })

  it('the Slack thread, read with the member\'s own token; their message is marked', async () => {
    const r = await person('th-sato', 'GET', `/threads/${chatInteraction}`)
    expect(r.status, r.text).toBe(200)
    expect(r.body.data.thread).toMatchObject({ channel: 'chat', unavailable: null })
    expect(r.body.data.thread.messages.map((m: Json) => m.text)).toEqual([`<@U0SATO> ${SLACK_TEXT}`])
    expect(r.body.data.thread.messages[0].mine).toBe(false)
    expect((await person('th-tanaka', 'GET', `/threads/${chatInteraction}`)).status).toBe(404)
  })
})

describe('a mail reply into the member\'s own conversation', () => {
  let draftId: string
  it('recipients come only from the thread (the member left out); the draft is owner-only and linked to its 連絡', async () => {
    const rec = await person('th-sato', 'POST', '/outbound-recipients', { interactionId: mailInteraction })
    expect(rec.status, rec.text).toBe(200)
    const thread = rec.body.data.recipients.filter((r: Json) => r.source === 'thread').map((r: Json) => r.email).sort()
    expect(thread).toEqual([BOSS, CLIENT])
    // Another member cannot draft a reply to Sato's own 連絡.
    expect((await person('th-tanaka', 'POST', '/outbound', { interactionId: mailInteraction, toRefs: [], subject: 'x', body: 'y' })).status).toBe(404)

    const client = rec.body.data.recipients.find((r: Json) => r.source === 'thread' && r.email === CLIENT)
    const made = await person('th-sato', 'POST', '/outbound', { interactionId: mailInteraction, toRefs: [client.ref], subject: 'Re: 見積について', body: 'ありがとうございます。確認します。' })
    expect(made.status, made.text).toBe(201)
    expect(made.body.data.draft).toMatchObject({ channel: 'email', interactionId: mailInteraction })
    draftId = made.body.data.draft.id
    const row = db.prepare('SELECT personal_owner, folder FROM records WHERE company_id = ? AND id = ?').get(CO, draftId) as Json
    expect(row).toEqual({ personal_owner: 'th-sato', folder: null })
    // The card lists it as Sato's reply; nobody else sees the 連絡 at all.
    const t = await person('th-sato', 'GET', `/threads/${mailInteraction}`)
    expect(t.body.data.thread.replies).toEqual([{ id: draftId, state: 'draft', channel: 'email' }])
  })

  it('「確かめて送る」: into the same Gmail thread, with In-Reply-To / References; no new やりとり; the inbox hears it', async () => {
    const before = interactionCount()
    const draft = (await person('th-sato', 'GET', `/outbound/${draftId}`)).body.data.draft
    const sent = await person('th-sato', 'POST', `/outbound/${draftId}/send`, { hash: draft.hash })
    expect(sent.status, sent.text).toBe(200)
    expect(sent.body.data.outcome).toBe('sent')
    const out = google.sent.at(-1)!
    expect(out.threadId).toBe('thmail0001')
    expect(out.headers['in-reply-to']).toBe('<m2@acme.example>')
    expect(out.headers.references.replace(/\s+/g, ' ')).toBe('<m1@acme.example> <m2@acme.example>')
    expect(out.to).toEqual([CLIENT])
    expect(interactionCount()).toBe(before)
    const heard = db.prepare("SELECT interaction_id, direction FROM inbox_messages WHERE company_id = ? AND direction = 'out'").all(CO) as Json[]
    expect(heard).toEqual([{ interaction_id: mailInteraction, direction: 'out' }])
  })
})

describe('a Slack reply into the thread', () => {
  let draftId: string
  it('a reply has a body only: recipients are refused; the thread is fixed with the draft', async () => {
    const withTo = await person('th-sato', 'POST', '/outbound', { interactionId: chatInteraction, toRefs: ['r000000000000000000000000'], body: 'x' })
    expect(withTo.status).toBe(400)
    const made = await person('th-sato', 'POST', '/outbound', { interactionId: chatInteraction, body: '確認して返します。' })
    expect(made.status, made.text).toBe(201)
    expect(made.body.data.draft).toMatchObject({ channel: 'slack', interactionId: chatInteraction, to: [], cc: [], subject: '' })
    draftId = made.body.data.draft.id
  })

  it('返事を送る off: nothing posted; on: posted once into the thread as the member', async () => {
    const draft = (await person('th-sato', 'GET', `/outbound/${draftId}`)).body.data.draft
    const before = slack.posted.length
    const member = { companyId: CO, userId: 'th-sato', role: 'member' }
    expect((await services.slackConnector.setFeature(member, { feature: 'reply', on: false })).ok).toBe(true)
    const off = await person('th-sato', 'POST', `/outbound/${draftId}/send`, { hash: draft.hash })
    expect(off.status).toBe(409)
    expect(off.body.code).toBe('SLACK_FEATURE_OFF')
    expect(slack.posted.length).toBe(before)
    expect((await services.slackConnector.setFeature(member, { feature: 'reply', on: true })).ok).toBe(true)

    const sent = await person('th-sato', 'POST', `/outbound/${draftId}/send`, { hash: draft.hash })
    expect(sent.status, sent.text).toBe(200)
    expect(slack.posted.slice(before)).toEqual([{ teamId: 'T0DIV', by: 'U0SATO', channel: SLACK_CHANNEL, text: '確認して返します。', threadTs: SLACK_ROOT }])
    const again = await person('th-sato', 'POST', `/outbound/${draftId}/send`, { hash: draft.hash })
    expect(again.body.code).toBe('NOT_DRAFT')
    expect(slack.posted.length).toBe(before + 1)
    // The member's own reply now shows in the thread, marked as theirs.
    const t = await person('th-sato', 'GET', `/threads/${chatInteraction}`)
    expect(t.body.data.thread.messages.at(-1)).toMatchObject({ mine: true, text: '確認して返します。' })
  })
})

describe('nothing of a thread is kept', () => {
  it('no table and no log line holds a thread\'s text', () => {
    const all = everyTable()
    const logs = logLines.join('\n')
    for (const mark of ['THREAD-MARK-ONE', 'THREAD-MARK-TWO', 'THREAD-MARK-SLACK']) {
      expect(all).not.toContain(mark)
      expect(logs).not.toContain(mark)
    }
  })
})
