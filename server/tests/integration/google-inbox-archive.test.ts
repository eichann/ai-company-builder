/**
 * Integration Test: Gmail ⇄ ACB archive (owner decision 2026-11-05, `.claude/rules/inbox.md` "Mail
 * archived in the mailbox", `google-connector.md` "Archiving in Gmail"), end to end against the fake
 * Google through the practice redirect.
 *
 * What it protects:
 * - 「済んだメールを Gmail でもアーカイブする」 (`inbox_archive`, `gmail.modify`) is off for a company
 *   until its admin turns it on, never asked in the one consent, asked only when the member chooses
 *   it; the company's switch and the member's own both stop it before anything leaves ACB;
 * - the one guard (`gmailCallAllowed` in the Google client): with that permission nothing leaves
 *   ACB but one message's INBOX label taken off or put back — no thread, trash, delete, draft, send,
 *   read, other label, batch or other mailbox, also when such a call names another permission;
 * - Gmail → ACB: a mail Sato archived in Gmail closes its 来た連絡 on the next clock run, as the
 *   inbox, with a notice to him, read with labels and history only, and asks Gmail to change nothing;
 * - ACB → Gmail: Sato's own 「済んだ」 archives the thread in his own mailbox with his own
 *   permission (not Tanaka's mailbox), tells him, and his ［元に戻す］ puts it back;
 * - review of #607: a reply that reached Gmail after the last poll is never archived with the
 *   thread (it is taken in next); his own 「済んだ」 taken back is not closed again by ACB's own
 *   archive; another record of the same conversation stays open.
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

const EMAILS: Record<string, string> = {
  'ga-owner': 'owner@div.example',
  'ga-sato': 'sato@div.example',
  'ga-tanaka': GOOGLE_SEED.colleague,
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
const CO = 'ga-co'
const PUBLIC = 'http://localhost:13002'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-archiveclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-archive-0123456789'
const DOMAIN = GOOGLE_SEED.internalDomain
const READ = 'https://www.googleapis.com/auth/gmail.readonly'
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify'
const SEND = 'https://www.googleapis.com/auth/gmail.send'
const SATO = GOOGLE_SEED.member
const TANAKA = GOOGLE_SEED.colleague
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any, companyData: any
let fake: FakeGoogle
let server: ServerType
let kekDir: string, shelfDir: string

async function call(user: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  currentUser.id = user
  const res: Response = await app.request(`${PUBLIC}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* the callback's page */ }
  return { status: res.status, body: json }
}
const C = `/api/companies/${CO}`

/** 「Google で許可」 all the way: the member signs in at the fake as `email`; answers the scopes asked. */
async function allow(user: string, body: { features: string[] } | { all: true }, email: string): Promise<string[]> {
  fake.signIn({ email })
  const r = await call(user, 'POST', `${C}/me/google/connect`, body)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  const url = new URL(r.body.data.authorizeUrl)
  const res = await fetch(url, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const back = new URL(res.headers.get('location')!)
  expect((await call(null, 'GET', `/api/oauth/google/callback${back.search}`)).status).toBe(200)
  return url.searchParams.get('scope')!.split(' ')
}

const member = (userId: string) => ({ companyId: CO, userId, role: userId === 'ga-owner' ? 'owner' : 'member' })
const human = () => ({ kind: 'human' as const, source: undefined })
const ai = (userId: string) => ({ id: userId, kind: 'ai' as const, source: 'claude-code', conversationId: null, runId: null })
const stateOf = (id: string) => db.prepare('SELECT state, version, fields FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as { state: string; version: number; fields: string }
/** The ledger as the services read it (notes come back from the content store). */
const ledger = (id: string) => companyData.forCompany(CO).records.ledger(id) as Array<{ action: string; actorId: string; note: string; version: number }>
const noticesOf = (userId: string) => (db.prepare('SELECT kind, record_id AS recordId FROM notifications WHERE company_id = ? AND user_id = ? ORDER BY created_at').all(CO, userId) as Array<{ kind: string; recordId: string }>)
const gmailCalls = (from: number) => fake.requests.slice(from).filter(r => r.path.startsWith('/gmail/'))
const inboxOf = (account: string, thread: string) => fake.threadLabels(account, thread).some(l => l.includes('INBOX'))

let seq = 200
/** A mail from outside arrives in an account's Gmail (To the account): its thread id. */
function deliver(account: string, at: string, subject = 'ご相談'): { thread: string; messageId: string; id: string } {
  const k = ++seq
  const thread = `fakethread0${k}`
  fake.deliver({
    id: `fakemail0${k}`, threadId: thread, account, labelIds: ['INBOX'], receivedAt: at,
    headers: { From: '"鈴木 一郎" <suzuki@a-corp.example>', To: account, Subject: subject, 'Message-ID': `<fake-0${k}@a-corp.example>` },
    text: '本文です。',
  })
  return { thread, messageId: `<fake-0${k}@a-corp.example>`, id: `fakemail0${k}` }
}
const interactionOf = (messageId: string) => (db.prepare(`SELECT r.id FROM records r JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id
  WHERE r.company_id = ? AND r.type = 'interaction' AND json_extract(s.fields, '$.message_id') = ?`).get(CO, messageId) as { id: string }).id

async function clockAt(iso: string) {
  vi.setSystemTime(new Date(iso))
  expect(await services.serverClock.runOnce()).toMatchObject({ ran: true })
  await services.inbox.whenIdle()
}

beforeAll(async () => {
  fake = createFakeGoogle()
  fake.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-ga-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-ga-shelf-'))
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, PUBLIC_URL: PUBLIC,
    ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${port}`,
  })
  for (const level of ['log', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  companyData = (await import('../../src/adapters/sqlite/company-data')).sqliteCompanyData(db)
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'ga-owner', ts(), ts())
  for (const [u, role] of [['ga-owner', 'owner'], ['ga-sato', 'member'], ['ga-tanaka', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, role, ts(), ts())
  }
  expect((await call('ga-owner', 'PUT', `${C}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: DOMAIN })).status).toBe(200)
  expect(services.records.updateSettings(member('ga-owner'), { enabled: true }).ok).toBe(true)
})

afterAll(async () => {
  fake.close()
  await new Promise(r => server.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL']) delete process.env[k]
})

describe('「済んだメールを Gmail でもアーカイブする」: opt-in, and nothing but the INBOX label', () => {
  it('off for the company until the admin turns it on; never in the one consent; asked only when the member chooses it', async () => {
    const inbox = await allow('ga-sato', { features: ['minutes', 'inbox'] }, SATO)
    expect(inbox).toContain(READ)
    expect(inbox).not.toContain(MODIFY)
    const named = await call('ga-sato', 'POST', `${C}/me/google/connect`, { features: ['inbox_archive'] })
    expect(named.body.code).toBe('GOOGLE_FEATURE_COMPANY_OFF')
    expect((await call('ga-sato', 'PUT', `${C}/google/features`, { feature: 'inbox_archive', on: true })).status).toBe(403)
    expect((await call('ga-owner', 'PUT', `${C}/google/features`, { feature: 'inbox_archive', on: true })).status).toBe(200)
    // On for the company: offered by name, still never in the one consent.
    const mine = (await call('ga-sato', 'GET', `${C}/me/google`)).body.data
    expect(mine.offeredByName).toContain('inbox_archive')
    expect(mine.companyFeatures).not.toContain('inbox_archive')
    const all = await call('ga-sato', 'POST', `${C}/me/google/connect`, { all: true })
    expect(new URL(all.body.data.authorizeUrl).searchParams.get('scope')).not.toContain(MODIFY)
    const chosen = await allow('ga-sato', { features: ['inbox_archive'] }, SATO)
    expect(chosen).toContain(MODIFY)
    expect((await call('ga-sato', 'GET', `${C}/me/google`)).body.data.features).toEqual(['minutes', 'inbox', 'inbox_archive'])
    // Tanaka allows it too (his own mailbox only, below).
    await allow('ga-tanaka', { features: ['minutes', 'inbox', 'inbox_archive'] }, TANAKA)
  })

  it('the one guard: with gmail.modify only one message\'s INBOX label goes out — never a thread, trash, delete, a draft, a send, a read or another label', async () => {
    const { thread, id } = deliver(SATO, '2026-11-06T23:00:00.000Z', '守るもの')
    const forbidden: Array<{ method: string; path: string; scope: string; body?: unknown }> = [
      { method: 'POST', path: `/gmail/v1/users/me/threads/${thread}/trash`, scope: MODIFY },
      // The access token carries every granted permission: a write named under another one is refused too.
      { method: 'POST', path: `/gmail/v1/users/me/threads/${thread}/trash`, scope: READ },
      { method: 'POST', path: `/gmail/v1/users/me/messages/${id}/trash`, scope: SEND },
      { method: 'DELETE', path: `/gmail/v1/users/me/messages/${id}`, scope: MODIFY },
      { method: 'DELETE', path: `/gmail/v1/users/me/threads/${thread}`, scope: READ },
      { method: 'POST', path: '/gmail/v1/users/me/messages/send', scope: MODIFY, body: { raw: 'eA' } },
      { method: 'POST', path: '/gmail/v1/users/me/drafts', scope: MODIFY, body: { message: { raw: 'eA' } } },
      { method: 'GET', path: `/gmail/v1/users/me/messages/${id}`, scope: MODIFY },
      { method: 'GET', path: `/gmail/v1/users/me/messages/${id}`, scope: SEND },
      // Never a whole conversation: a reply ACB has not read yet would leave the inbox with it.
      { method: 'POST', path: `/gmail/v1/users/me/threads/${thread}/modify`, scope: MODIFY, body: { removeLabelIds: ['INBOX'] } },
      { method: 'POST', path: `/gmail/v1/users/me/messages/${id}/modify`, scope: MODIFY, body: { removeLabelIds: ['INBOX', 'UNREAD'] } },
      { method: 'POST', path: `/gmail/v1/users/me/messages/${id}/modify`, scope: MODIFY, body: { addLabelIds: ['TRASH'] } },
      { method: 'POST', path: `/gmail/v1/users/me/messages/${id}/modify`, scope: MODIFY, body: { removeLabelIds: ['INBOX'], addLabelIds: ['TRASH'] } },
      { method: 'POST', path: `/gmail/v1/users/me/messages/${id}/modify`, scope: READ, body: { removeLabelIds: ['INBOX'] } },
      { method: 'POST', path: '/gmail/v1/users/me/messages/batchModify', scope: MODIFY, body: { ids: [id], removeLabelIds: ['INBOX'] } },
      { method: 'POST', path: `/gmail/v1/users/${TANAKA}/messages/${id}/modify`, scope: MODIFY, body: { removeLabelIds: ['INBOX'] } },
      { method: 'PUT', path: `/gmail/v1/users/me/messages/${id}/modify`, scope: MODIFY, body: { removeLabelIds: ['INBOX'] } },
    ]
    const before = fake.requests.length
    for (const f of forbidden) {
      const r = await services.googleClient.request(CO, 'ga-sato', { api: 'gmail', operation: 'test', ...f })
      expect(r, `${f.method} ${f.path} (${f.scope})`).toMatchObject({ ok: false, kind: 'not-sent', reason: 'call-not-allowed' })
    }
    // Nor for another API — and no other API names a Gmail path (Google serves Gmail on that host too).
    const otherApis = [
      { api: 'calendar', method: 'GET', path: '/calendar/v3/calendars/primary/events', scope: MODIFY },
      { api: 'drive', method: 'POST', path: `/gmail/v1/users/me/messages/${id}/modify`, scope: MODIFY, body: { removeLabelIds: ['INBOX'] } },
      { api: 'calendar', method: 'POST', path: `/gmail/v1/users/me/threads/${thread}/trash`, scope: READ },
      { api: 'drive', method: 'POST', path: `/%67mail/v1/users/me/threads/${thread}/trash`, scope: READ },
    ]
    for (const o of otherApis) {
      expect(await services.googleClient.request(CO, 'ga-sato', { operation: 'test', ...o }), `${o.api} ${o.path}`)
        .toMatchObject({ ok: false, reason: 'call-not-allowed' })
    }
    expect(fake.requests.length).toBe(before)
    expect(fake.threadLabels(SATO, thread)).toEqual([['INBOX']])
    // What it is for: the INBOX label off, and back on.
    expect((await services.googleClient.request(CO, 'ga-sato', { api: 'gmail', method: 'POST', path: `/gmail/v1/users/me/messages/${id}/modify`, scope: MODIFY, body: { removeLabelIds: ['INBOX'] }, operation: 'test' })).ok).toBe(true)
    expect(inboxOf(SATO, thread)).toBe(false)
    expect((await services.googleClient.request(CO, 'ga-sato', { api: 'gmail', method: 'POST', path: `/gmail/v1/users/me/messages/${id}/modify`, scope: MODIFY, body: { addLabelIds: ['INBOX'] }, operation: 'test' })).ok).toBe(true)
    expect(inboxOf(SATO, thread)).toBe(true)
  })
})

describe('the server clock and the member\'s own closes', () => {
  it('Gmail → ACB: what Sato archived in Gmail is closed here on the next run, as the inbox, read by labels and history only', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await clockAt('2026-11-07T00:00:00.000Z')
      const a = deliver(SATO, '2026-11-07T00:01:00.000Z')
      await clockAt('2026-11-07T00:05:00.000Z')
      const id = interactionOf(a.messageId)
      expect(stateOf(id).state).toBe('received')
      fake.archiveInGmail(SATO, a.thread)
      const before = fake.requests.length
      await clockAt('2026-11-07T00:10:00.000Z')
      expect(stateOf(id).state).toBe('handled')
      expect(ledger(id).at(-1)).toMatchObject({ action: 'left_inbox', actorId: 'acb:inbox', note: 'Gmail ではアーカイブ済み' })
      expect(JSON.parse(stateOf(id).fields).settled_by ?? null).toBeNull()
      expect(noticesOf('ga-sato')).toContainEqual({ kind: 'mail_left_inbox', recordId: id })
      // The bell's words (built when read, the note from the content store), and its ［元に戻す］ version.
      const bell = services.notifications.list(member('ga-sato')).value.items.find((i: Json) => i.kind === 'mail_left_inbox')
      expect(bell.text).toBe('Gmail ではアーカイブ済みのため、閉じました：「ご相談」')
      expect(bell.version).toBe(ledger(id).at(-1)!.version)
      // Read as labels and history; nothing asked of Gmail to change (and no loop back into it).
      const calls = gmailCalls(before)
      expect(calls.some(r => r.path === '/gmail/v1/users/me/history')).toBe(true)
      expect(calls.every(r => r.method === 'GET')).toBe(true)
      expect(calls.filter(r => r.path.startsWith('/gmail/v1/users/me/threads/')).every(r => r.search.includes('format=minimal'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ACB → Gmail: Sato\'s own 「済んだ」 archives it in his own mailbox with his own permission; ［元に戻す］ puts it back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const a = deliver(SATO, '2026-11-07T00:11:00.000Z', '見積の件')
      // The same conversation in Tanaka's mailbox (another member's permission must never be used).
      fake.deliver({ id: 'fakemail0999', threadId: a.thread, account: TANAKA, labelIds: ['INBOX'], receivedAt: '2026-11-07T00:11:00.000Z', headers: { From: 'x@a-corp.example', To: TANAKA, Subject: '見積の件', 'Message-ID': '<tanaka-copy@a-corp.example>' } })
      await clockAt('2026-11-07T00:15:00.000Z')
      const id = interactionOf(a.messageId)
      const judged = services.inbox.judge(member('ga-sato'), ai('ga-sato'), id, { expectedVersion: stateOf(id).version, outcome: 'unsure', reason: '確かめる' })
      expect(judged.ok, JSON.stringify(judged)).toBe(true)
      const before = fake.requests.length
      const done = await services.recordEngine.act(member('ga-sato'), human(), id, 'settle', { expectedVersion: stateOf(id).version })
      expect(done.ok, JSON.stringify(done)).toBe(true)
      await services.inbox.whenIdle()
      const writes = gmailCalls(before).filter(r => r.method !== 'GET')
      expect(writes.map(r => r.path)).toEqual([`/gmail/v1/users/me/messages/${a.id}/modify`])
      expect(inboxOf(SATO, a.thread)).toBe(false)
      expect(inboxOf(TANAKA, a.thread)).toBe(true)
      const entry = ledger(id).at(-1)!
      expect(entry).toMatchObject({ action: 'archived_there', actorId: 'acb:inbox', note: 'Gmail でもアーカイブしました' })
      expect(noticesOf('ga-sato')).toContainEqual({ kind: 'mail_archived', recordId: id })
      expect(services.notifications.list(member('ga-sato')).value.items.find((i: Json) => i.kind === 'mail_archived').text).toBe('Gmail でもアーカイブしました：「見積の件」')
      // ［元に戻す］ (his undo of the inbox's entry): back in his inbox.
      const undone = await services.recordEngine.undo(member('ga-sato'), human(), id, { version: entry.version, expectedVersion: entry.version })
      expect(undone.ok, JSON.stringify(undone)).toBe(true)
      await services.inbox.whenIdle()
      expect(inboxOf(SATO, a.thread)).toBe(true)
      // The next run sees those label changes and changes nothing more here.
      const count = ledger(id).length
      await clockAt('2026-11-07T00:20:00.000Z')
      expect(ledger(id).length).toBe(count)
      expect(stateOf(id).state).toBe('handled')
    } finally {
      vi.useRealTimers()
    }
  })

  it('his own 「やめる」, or the company\'s switch off: his 「済んだ」 sends nothing to Gmail', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const settleNew = async (at: string) => {
        const m = deliver(SATO, at)
        await clockAt(new Date(Date.parse(at) + 4 * 60_000).toISOString())
        const id = interactionOf(m.messageId)
        expect(services.inbox.judge(member('ga-sato'), ai('ga-sato'), id, { expectedVersion: stateOf(id).version, outcome: 'unsure', reason: '確かめる' }).ok).toBe(true)
        const before = fake.requests.length
        expect((await services.recordEngine.act(member('ga-sato'), human(), id, 'settle', { expectedVersion: stateOf(id).version })).ok).toBe(true)
        await services.inbox.whenIdle()
        return { writes: gmailCalls(before).filter(r => r.method !== 'GET').length, thread: m.thread }
      }
      expect((await call('ga-sato', 'PUT', `${C}/me/google/features`, { feature: 'inbox_archive', on: false })).status).toBe(200)
      const off = await settleNew('2026-11-07T00:21:00.000Z')
      expect(off.writes).toBe(0)
      expect(inboxOf(SATO, off.thread)).toBe(true)
      expect((await call('ga-sato', 'PUT', `${C}/me/google/features`, { feature: 'inbox_archive', on: true })).status).toBe(200)
      expect((await call('ga-owner', 'PUT', `${C}/google/features`, { feature: 'inbox_archive', on: false })).status).toBe(200)
      const companyOff = await settleNew('2026-11-07T00:31:00.000Z')
      expect(companyOff.writes).toBe(0)
      expect(inboxOf(SATO, companyOff.thread)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('review of #607: the archive never loses mail nor closes what the member kept', () => {
  // The switches test above left the company's switch off: on again, and every case below checks it archived.
  beforeAll(async () => {
    expect((await call('ga-owner', 'PUT', `${C}/google/features`, { feature: 'inbox_archive', on: true })).status).toBe(200)
  })
  const settleIt = async (id: string) => {
    expect(services.inbox.judge(member('ga-sato'), ai('ga-sato'), id, { expectedVersion: stateOf(id).version, outcome: 'unsure', reason: 'x' }).ok).toBe(true)
    const r = await services.recordEngine.act(member('ga-sato'), human(), id, 'settle', { expectedVersion: stateOf(id).version })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    await services.inbox.whenIdle()
  }
  const messagesOf = (id: string) => (db.prepare('SELECT message_id FROM inbox_messages WHERE company_id = ? AND interaction_id = ?').all(CO, id) as Array<{ message_id: string }>).map(r => r.message_id)

  it('H1: a reply that reached Gmail after the last poll stays in the inbox and is taken in next', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await clockAt('2026-11-08T00:00:00.000Z')
      const a = deliver(SATO, '2026-11-08T00:01:00.000Z', '発注の件')
      await clockAt('2026-11-08T00:05:00.000Z')
      const id = interactionOf(a.messageId)
      // The customer replies at 00:06; ACB has not read the mailbox since.
      fake.deliver({ id: 'fakemailreply1', threadId: a.thread, account: SATO, labelIds: ['INBOX', 'UNREAD'], receivedAt: '2026-11-08T00:06:00.000Z',
        headers: { From: '"鈴木 一郎" <suzuki@a-corp.example>', To: SATO, Subject: 'Re: 発注の件', 'Message-ID': '<reply-1@a-corp.example>', 'In-Reply-To': a.messageId, References: a.messageId }, text: '至急：数量を変えてください' })
      vi.setSystemTime(new Date('2026-11-08T00:07:00.000Z'))
      await settleIt(id)
      expect(fake.threadLabels(SATO, a.thread)).toEqual([[], ['INBOX', 'UNREAD']])
      await clockAt('2026-11-08T00:10:00.000Z')
      expect(messagesOf(id)).toContain('<reply-1@a-corp.example>')
      // Their reply opened it again (the AI judges it); nothing closed it as archived.
      expect(stateOf(id).state).toBe('received')
      expect(ledger(id).some(e => e.action === 'left_inbox')).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('P1: he takes back his own 済んだ after ACB archived it: the next run does not close it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const a = deliver(SATO, '2026-11-08T01:01:00.000Z', '別件')
      await clockAt('2026-11-08T01:05:00.000Z')
      const id = interactionOf(a.messageId)
      await settleIt(id)
      expect(inboxOf(SATO, a.thread)).toBe(false)
      expect(ledger(id).at(-1)!.action).toBe('archived_there')
      const settle = ledger(id).find(e => e.action === 'settle')!
      const undone = await services.recordEngine.undo(member('ga-sato'), human(), id, { version: settle.version, expectedVersion: ledger(id).at(-1)!.version })
      expect(undone.ok, JSON.stringify(undone)).toBe(true)
      await clockAt('2026-11-08T01:10:00.000Z')
      expect(stateOf(id).state).toBe('unsure')
      expect(ledger(id).some(e => e.action === 'left_inbox')).toBe(false)
      expect(noticesOf('ga-sato').filter(n => n.recordId === id && n.kind === 'mail_left_inbox')).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('C1: two records of one Gmail conversation: closing one archives only its message, the other stays open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const a = deliver(SATO, '2026-11-08T02:01:00.000Z', '定例のご案内')
      fake.deliver({ id: 'fakemailsame2', threadId: a.thread, account: SATO, labelIds: ['INBOX'], receivedAt: '2026-11-08T02:02:00.000Z',
        headers: { From: '"鈴木 一郎" <suzuki@a-corp.example>', To: SATO, Subject: '定例のご案内', 'Message-ID': '<same-2@a-corp.example>' }, text: '別の依頼' })
      await clockAt('2026-11-08T02:05:00.000Z')
      const one = interactionOf(a.messageId)
      const two = interactionOf('<same-2@a-corp.example>')
      expect(one).not.toBe(two)
      await settleIt(one)
      await clockAt('2026-11-08T02:10:00.000Z')
      expect(stateOf(two).state).toBe('received')
      expect(ledger(two).some(e => e.action === 'left_inbox')).toBe(false)
      expect(fake.threadLabels(SATO, a.thread)).toEqual([[], ['INBOX']])
    } finally { vi.useRealTimers() }
  })
})

describe('review of #607 (2): only what ACB took out goes back, and a stop partway still has its undo', () => {
  beforeAll(async () => {
    expect((await call('ga-owner', 'PUT', `${C}/google/features`, { feature: 'inbox_archive', on: true })).status).toBe(200)
  })
  /** His message, his own Sent reply (never in the inbox) and their answer, one conversation. */
  const threadOf3 = (base: string, tag: string) => {
    const a = deliver(SATO, `${base}:01:00.000Z`, `件名${tag}`)
    fake.deliver({ id: `sent${tag}`, threadId: a.thread, account: SATO, labelIds: ['SENT'], receivedAt: `${base}:02:00.000Z`,
      headers: { From: SATO, To: 'suzuki@a-corp.example', Subject: `Re: 件名${tag}`, 'Message-ID': `<sent-${tag}@div.example>`, 'In-Reply-To': a.messageId, References: a.messageId }, text: '返信' })
    fake.deliver({ id: `reply${tag}`, threadId: a.thread, account: SATO, labelIds: ['INBOX'], receivedAt: `${base}:03:00.000Z`,
      headers: { From: '"鈴木 一郎" <suzuki@a-corp.example>', To: SATO, Subject: `Re: 件名${tag}`, 'Message-ID': `<reply-${tag}@a-corp.example>`, 'In-Reply-To': `<sent-${tag}@div.example>`, References: `${a.messageId} <sent-${tag}@div.example>` }, text: '追伸' })
    return a
  }
  const labelsById = (thread: string) => Object.fromEntries(
    (fake.threadLabels(SATO, thread)).map((l, i) => [i, l.includes('INBOX')]))

  it('N1: the undo puts back only what ACB took out — not his Sent reply, nor a message he archived himself', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const a = threadOf3('2026-11-08T03', 'n1')
      await clockAt('2026-11-08T03:05:00.000Z')
      const id = interactionOf(a.messageId)
      // He archived the first message himself in Gmail; their answer is still in the inbox.
      fake.archiveMessageInGmail(SATO, a.id)
      const r = await services.recordEngine.act(member('ga-sato'), human(), id, 'handle', { expectedVersion: stateOf(id).version })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      await services.inbox.whenIdle()
      expect(labelsById(a.thread)).toEqual({ 0: false, 1: false, 2: false })
      const entry = ledger(id).at(-1)!
      expect(entry.action).toBe('archived_there')
      expect((await services.recordEngine.undo(member('ga-sato'), human(), id, { version: entry.version, expectedVersion: entry.version })).ok).toBe(true)
      await services.inbox.whenIdle()
      // Oldest first: his first message (archived by him) and his Sent reply stay out; only their answer is back.
      expect(labelsById(a.thread)).toEqual({ 0: false, 1: false, 2: true })
    } finally { vi.useRealTimers() }
  })

  it('N2: one message fails: the one taken out still gets the entry, the notice and the undo', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const a = threadOf3('2026-11-08T04', 'n2')
      await clockAt('2026-11-08T04:05:00.000Z')
      const id = interactionOf(a.messageId)
      fake.faults.failOn('/gmail/v1/users/me/messages/replyn2/modify', 1, 500)
      expect((await services.recordEngine.act(member('ga-sato'), human(), id, 'handle', { expectedVersion: stateOf(id).version })).ok).toBe(true)
      await services.inbox.whenIdle()
      expect(labelsById(a.thread)).toEqual({ 0: false, 1: false, 2: true })
      const entry = ledger(id).at(-1)!
      expect(entry).toMatchObject({ action: 'archived_there', note: 'Gmail でもアーカイブしました（一部はできませんでした）' })
      expect(noticesOf('ga-sato')).toContainEqual({ kind: 'mail_archived', recordId: id })
      expect((await services.recordEngine.undo(member('ga-sato'), human(), id, { version: entry.version, expectedVersion: entry.version })).ok).toBe(true)
      await services.inbox.whenIdle()
      expect(labelsById(a.thread)).toEqual({ 0: true, 1: false, 2: true })
    } finally { vi.useRealTimers() }
  })
})
