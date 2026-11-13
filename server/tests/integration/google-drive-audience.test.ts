/**
 * Asking before a put into a place others see (`.claude/rules/google-drive.md` "Asking before a put", owner decisions
 * 2026-11-14), end to end against the fake Google:
 *
 * - a folder people outside the company see: a consultation's AI asks the member (the app's card) — the content waits on
 *   the server and the press writes exactly it, only while the same people see the place; an older app, a scheduled job
 *   and a link for anyone keep their rules (refused as before / always asked);
 * - 「このフォルダはもう聞かない」: the member's own, per folder, for exactly the people outside who saw it then;
 * - a private folder's file (`privateSource`): straight in where only the member sees it, after a press where people in
 *   the company see it, never where anyone outside does.
 *
 * Each guard is mutation-checked (see the PR).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeGoogle, type FakeGoogle } from '../fakes/google/fake-google'
import { GOOGLE_SEED } from '../fakes/google/seed'

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
const CO = 'drive-audience-co'
const PUBLIC = 'http://localhost:13007'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-audienceclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-audience-0123456789'
const PICKER_KEY = 'fake-picker-key-NOT-REAL-0123456789abcd'
const APP_ID = '123456789012'
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, db: any
let google: FakeGoogle
let googleServer: ServerType
let kekDir: string

async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res: Response = await app.request(`${PUBLIC}${opts.path}`, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  const text = await res.text()
  let body: Json = null
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body, text }
}
const C = `/api/companies/${CO}`
const person = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `${C}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown) => call({ token, method, path: `/api/records-ai/google/drive${path}`, body })

async function tokenFor(user: string, conversationId = 'conv-audience'): Promise<string> {
  const r = await call({ user, method: 'POST', path: `${C}/me/record-tokens`, body: { conversationId, agent: 'claude-code', scope: 'act' } })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}

async function allow(user: string) {
  google.signIn({ email: EMAILS[user] })
  const r = await call({ user, method: 'POST', path: `${C}/me/google/connect`, body: { features: ['drive'] } })
  expect(r.status, r.text).toBe(200)
  const res = await fetch(r.body.data.authorizeUrl, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  expect((await call({ method: 'GET', path: `/api/oauth/google/callback${back.search}` })).status).toBe(200)
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
// An update says `askPerson: true` like the current app (it can show the card); a released app before it says nothing.
const docBody = (content: Buffer, over: Record<string, unknown> = {}) => ({
  folderId: GOOGLE_SEED.proposalsFolder, name: '報告書.md', kind: 'markdown', as: 'google_doc', sha256: sha(content),
  contentBase64: content.toString('base64'), requestKey: `key-${randomBytes(6).toString('hex')}`,
  ...(over.updateFileId ? { askPerson: true } : {}), ...over,
})
// The current app: it can show the card for who sees the place.
const pdfBody = (name: string, over: Record<string, unknown> = {}) => {
  const content = Buffer.from(`%PDF-1.7\n% ${name} ${randomBytes(4).toString('hex')}\n%%EOF\n`)
  return {
    folderId: GOOGLE_SEED.sharedOutsideFolder, name, kind: 'pdf', sha256: sha(content), contentBase64: content.toString('base64'),
    requestKey: `key-${randomBytes(6).toString('hex')}`, askAudience: true, ...over,
  }
}
const owner = (email: string) => ({ type: 'user' as const, role: 'owner', emailAddress: email })
const OUTSIDE = GOOGLE_SEED.customerSuzuki
const ROW = (id: string) => db.prepare('SELECT * FROM google_drive_overwrite_confirmations WHERE company_id = ? AND id = ?').get(CO, id) as Json
const press = (user: string, id: string, action: 'confirm' | 'decline', trust?: boolean) =>
  person(user, 'POST', `/me/google/drive/overwrite-confirmations/${id}`, { action, ...(trust !== undefined ? { trust } : {}) })
const uploads = () => google.uploads().length
beforeAll(async () => {
  google = createFakeGoogle()
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  googleServer = serve({ fetch: google.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  kekDir = mkdtempSync(join(tmpdir(), 'acb-drive-audience-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_DRIVE_DOC_SETTLE_MS: '0', ACB_DRIVE_DOC_QUIET_MS: '0', ACB_DRIVE_DOC_GAP_MS: '0',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
  })
  for (const level of ['log', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  const drive = await import('../../src/routes/google-drive')
  app.route('/api/companies/:companyId', drive.googleDriveRoute)
  app.route('/api/records-ai/google/drive', drive.googleDriveAiRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)

  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'm-owner', ts(), ts())
  for (const [u, role] of [['m-owner', 'owner'], ['m-sato', 'member'], ['m-tanaka', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, role, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  const { ensureCoreTypes } = await import('../../src/services/record-index')
  const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
  ensureCompanyScope(db, CO)
  db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(CO, ts(), 'x')
  ensureCoreTypes(sqliteCompanyData(db).forCompany(CO).records, ts())
  expect((await person('m-owner', 'PUT', '/google/client', { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
  expect((await person('m-owner', 'PUT', '/google/picker', { apiKey: PICKER_KEY, appId: APP_ID })).status).toBe(200)
  await allow('m-tanaka')
  await allow('m-sato')
  google.pick(CLIENT_ID, GOOGLE_SEED.member, [GOOGLE_SEED.proposalsFolder, GOOGLE_SEED.sharedOutsideFolder])
  for (const id of [GOOGLE_SEED.proposalsFolder, GOOGLE_SEED.sharedOutsideFolder]) {
    expect((await person('m-sato', 'POST', '/me/google/drive/picks', { mode: 'folder', ids: [id] })).body.data.picks).toHaveLength(1)
  }
})

afterAll(async () => {
  google.close()
  await new Promise(r => googleServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL', 'ACB_DRIVE_DOC_SETTLE_MS', 'ACB_DRIVE_DOC_QUIET_MS', 'ACB_DRIVE_DOC_GAP_MS']) delete process.env[k]
})


describe('a folder people outside the company see (google-drive.md "Asking before a put")', () => {
  it('the status says the server checks a private folder\'s file', async () => {
    const token = await tokenFor('m-sato')
    expect((await ai(token, 'GET', '/status')).body.data.privateSourceChecked).toBe(true)
  })

  it('an older app (no askAudience) is refused as before; the current app gets a card, nothing sent until the press, which writes exactly that once', async () => {
    google.setDrivePermissions(GOOGLE_SEED.sharedOutsideFolder, [owner(GOOGLE_SEED.member), { type: 'user', role: 'writer', emailAddress: OUTSIDE }])
    const token = await tokenFor('m-sato')
    const before = uploads()
    const old = await ai(token, 'POST', '/put', pdfBody('見積.pdf', { askAudience: undefined }))
    expect(old.body.code).toBe('DRIVE_FOLDER_SHARED_OUTSIDE')
    const body = pdfBody('見積.pdf')
    const asked = await ai(token, 'POST', '/put', body)
    expect(asked.status, asked.text).toBe(409)
    expect(asked.body.code).toBe('DRIVE_PUT_NEEDS_CONFIRMATION')
    const c = asked.body.confirmation
    expect(c).toMatchObject({ fileName: '見積.pdf', update: false, audience: { anyone: false, outsideDomains: ['a-corp.example'], insideOthers: 0, privateSource: false, trustOffered: true } })
    // The AI's sentence names nobody (the domains are for the member's card).
    expect(asked.body.error).not.toContain('a-corp')
    expect(uploads()).toBe(before)
    // The same request again while it waits: the same card.
    expect((await ai(token, 'POST', '/put', body)).body.confirmation.id).toBe(c.id)
    // Not another member's to press.
    expect((await press('m-tanaka', c.id, 'confirm')).status).toBe(404)
    const done = await press('m-sato', c.id, 'confirm')
    expect(done.status, done.text).toBe(200)
    expect(done.body.data).toMatchObject({ state: 'written', update: false, drivePut: { state: 'done', name: '見積.pdf', sha256: body.sha256 } })
    expect(google.driveFile(done.body.data.drivePut.fileId)!.content.toString('base64')).toBe(body.contentBase64)
    expect(uploads()).toBe(before + 1)
    expect([ROW(c.id).state, ROW(c.id).content]).toEqual(['written', null])
    expect((await press('m-sato', c.id, 'confirm')).body.code).toBe('DRIVE_CONFIRMATION_DONE')
    // Nothing is trusted unless the member asked for it.
    expect((await person('m-sato', 'GET', '/me/google/drive/trusted-folders')).body.data.folders).toEqual([])
  })

  it('someone else outside can see it while the member looks: the press writes nothing (DRIVE_SHARING_CHANGED)', async () => {
    google.setDrivePermissions(GOOGLE_SEED.sharedOutsideFolder, [owner(GOOGLE_SEED.member), { type: 'user', role: 'writer', emailAddress: OUTSIDE }])
    const token = await tokenFor('m-sato')
    const c = (await ai(token, 'POST', '/put', pdfBody('途中で変わる.pdf'))).body.confirmation
    google.shareDriveFile(GOOGLE_SEED.sharedOutsideFolder, { type: 'user', role: 'reader', emailAddress: 'yamada@b-corp.example' })
    const before = uploads()
    const r = await press('m-sato', c.id, 'confirm')
    expect(r.body.code, r.text).toBe('DRIVE_SHARING_CHANGED')
    expect(uploads()).toBe(before)
    expect(ROW(c.id).state).toBe('declined')
  })

  it('「このフォルダはもう聞かない」: for exactly those people outside; anyone else (or a link for anyone) asks again; the member can take it away', async () => {
    google.setDrivePermissions(GOOGLE_SEED.sharedOutsideFolder, [owner(GOOGLE_SEED.member), { type: 'user', role: 'writer', emailAddress: OUTSIDE }])
    const token = await tokenFor('m-sato')
    const c = (await ai(token, 'POST', '/put', pdfBody('一回目.pdf'))).body.confirmation
    expect((await press('m-sato', c.id, 'confirm', true)).body.data.state).toBe('written')
    const listed = (await person('m-sato', 'GET', '/me/google/drive/trusted-folders')).body.data.folders
    expect(listed).toMatchObject([{ folderId: GOOGLE_SEED.sharedOutsideFolder, folderName: '共有：株式会社サンプル', outsideDomains: ['a-corp.example'] }])
    // Another member's list is their own.
    expect((await person('m-tanaka', 'GET', '/me/google/drive/trusted-folders')).body.data.folders).toEqual([])
    // Now it goes straight in.
    const straight = await ai(token, 'POST', '/put', pdfBody('二回目.pdf'))
    expect(straight.body.data?.drivePut.state, straight.text).toBe('done')
    // The old app still cannot (it never sends askAudience): trust is for the app that asks.
    expect((await ai(token, 'POST', '/put', pdfBody('古いアプリ.pdf', { askAudience: undefined }))).body.code).toBe('DRIVE_FOLDER_SHARED_OUTSIDE')
    // One more person outside: asked again.
    google.shareDriveFile(GOOGLE_SEED.sharedOutsideFolder, { type: 'user', role: 'reader', emailAddress: 'yamada@b-corp.example' })
    const again = await ai(token, 'POST', '/put', pdfBody('三回目.pdf'))
    expect(again.body.code).toBe('DRIVE_PUT_NEEDS_CONFIRMATION')
    expect(again.body.confirmation.audience.outsideDomains).toEqual(['a-corp.example', 'b-corp.example'])
    // A link for anyone: always asked, never offered trust (and a trust asked for anyway is not kept).
    google.setDrivePermissions(GOOGLE_SEED.sharedOutsideFolder, [owner(GOOGLE_SEED.member), { type: 'anyone', role: 'reader' }])
    const anyone = await ai(token, 'POST', '/put', pdfBody('誰でも.pdf'))
    expect(anyone.body.confirmation.audience).toMatchObject({ anyone: true, trustOffered: false })
    expect((await press('m-sato', anyone.body.confirmation.id, 'confirm', true)).body.data.state).toBe('written')
    expect((await ai(token, 'POST', '/put', pdfBody('誰でも2.pdf'))).body.code).toBe('DRIVE_PUT_NEEDS_CONFIRMATION')
    // Even a trust row naming exactly a link for anyone (never written by the app) lets nothing through.
    const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
    const repo = sqliteCompanyData(db).forCompany(CO).googleDrive
    const kept = repo.folderTrust('m-sato', GOOGLE_SEED.sharedOutsideFolder)!
    repo.trustFolder({ ...kept, audienceSig: createHash('sha256').update('anyone').digest('hex') })
    expect((await ai(token, 'POST', '/put', pdfBody('誰でも3.pdf'))).body.code).toBe('DRIVE_PUT_NEEDS_CONFIRMATION')
    repo.trustFolder(kept)
    // Back to the trusted people; then the member takes the trust away: asked again.
    google.setDrivePermissions(GOOGLE_SEED.sharedOutsideFolder, [owner(GOOGLE_SEED.member), { type: 'user', role: 'writer', emailAddress: OUTSIDE }])
    expect((await ai(token, 'POST', '/put', pdfBody('戻った.pdf'))).body.data?.drivePut.state).toBe('done')
    expect((await person('m-tanaka', 'DELETE', `/me/google/drive/trusted-folders/${GOOGLE_SEED.sharedOutsideFolder}`)).status).toBe(404)
    expect((await person('m-sato', 'DELETE', `/me/google/drive/trusted-folders/${GOOGLE_SEED.sharedOutsideFolder}`)).status).toBe(200)
    expect((await person('m-sato', 'DELETE', `/me/google/drive/trusted-folders/${GOOGLE_SEED.sharedOutsideFolder}`)).status).toBe(404)
    expect((await ai(token, 'POST', '/put', pdfBody('外した.pdf'))).body.code).toBe('DRIVE_PUT_NEEDS_CONFIRMATION')
  })

  it('an update of a file in that folder asks too (update: true); a document someone edited there asks once for both', async () => {
    google.setDrivePermissions(GOOGLE_SEED.sharedOutsideFolder, [owner(GOOGLE_SEED.member), { type: 'user', role: 'writer', emailAddress: OUTSIDE }])
    const token = await tokenFor('m-sato')
    const first = (await ai(token, 'POST', '/put', pdfBody('版つき.pdf'))).body.confirmation
    const made = (await press('m-sato', first.id, 'confirm')).body.data.drivePut
    const upd = pdfBody('版つき.pdf', { updateFileId: made.fileId })
    const asked = await ai(token, 'POST', '/put', upd)
    expect(asked.body.confirmation, asked.text).toMatchObject({ update: true, audience: { outsideDomains: ['a-corp.example'] } })
    const written = await press('m-sato', asked.body.confirmation.id, 'confirm')
    expect(written.body.data).toMatchObject({ state: 'written', update: true, drivePut: { fileId: made.fileId, updatedFileId: made.fileId } })
    // A Google document there, edited by a colleague, read by the AI: one card with the editor and the people outside.
    const docAsk = (await ai(token, 'POST', '/put', docBody(Buffer.from('# 一版\n'), { folderId: GOOGLE_SEED.sharedOutsideFolder, name: '外の報告.md', askAudience: true }))).body.confirmation
    const doc = (await press('m-sato', docAsk.id, 'confirm')).body.data.drivePut
    google.editDriveFile(doc.fileId, '# 田中さんの直し\n', GOOGLE_SEED.colleague)
    expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    const both = await ai(token, 'POST', '/put', docBody(Buffer.from('# 二版\n'), { folderId: GOOGLE_SEED.sharedOutsideFolder, name: '外の報告.md', updateFileId: doc.fileId, askAudience: true }))
    expect(both.body.code, both.text).toBe('DRIVE_OVERWRITE_NEEDS_CONFIRMATION')
    expect(both.body.confirmation).toMatchObject({ update: true, audience: { outsideDomains: ['a-corp.example'] } })
    expect((await press('m-sato', both.body.confirmation.id, 'confirm')).body.data.state).toBe('written')
  })
})

describe('a private folder\'s file (google-drive.md "Asking before a put")', () => {
  it('never where anyone outside sees it — trusted or not', async () => {
    google.setDrivePermissions(GOOGLE_SEED.sharedOutsideFolder, [owner(GOOGLE_SEED.member), { type: 'user', role: 'writer', emailAddress: OUTSIDE }])
    const token = await tokenFor('m-sato')
    const c = (await ai(token, 'POST', '/put', pdfBody('信頼.pdf'))).body.confirmation
    await press('m-sato', c.id, 'confirm', true)
    const before = uploads()
    const r = await ai(token, 'POST', '/put', pdfBody('非公開の報告.pdf', { privateSource: true }))
    expect(r.body.code, r.text).toBe('DRIVE_PRIVATE_SHARED_OUTSIDE')
    expect(uploads()).toBe(before)
    await person('m-sato', 'DELETE', `/me/google/drive/trusted-folders/${GOOGLE_SEED.sharedOutsideFolder}`)
  })

  it('straight in where only the member sees it; after a press (never trusted) where people in the company see it; an app without the card is refused', async () => {
    const token = await tokenFor('m-sato')
    google.setDrivePermissions(GOOGLE_SEED.proposalsFolder, [owner(GOOGLE_SEED.member)])
    const mine = await ai(token, 'POST', '/put', pdfBody('自分だけ.pdf', { folderId: GOOGLE_SEED.proposalsFolder, privateSource: true }))
    expect(mine.body.data?.drivePut.state, mine.text).toBe('done')
    google.setDrivePermissions(GOOGLE_SEED.proposalsFolder, [owner(GOOGLE_SEED.member), { type: 'domain', role: 'reader', domain: GOOGLE_SEED.internalDomain }])
    expect((await ai(token, 'POST', '/put', pdfBody('社内.pdf', { folderId: GOOGLE_SEED.proposalsFolder, privateSource: true, askAudience: undefined }))).body.code).toBe('DRIVE_PRIVATE_SHARED')
    const asked = await ai(token, 'POST', '/put', pdfBody('社内.pdf', { folderId: GOOGLE_SEED.proposalsFolder, privateSource: true }))
    expect(asked.body.confirmation, asked.text).toMatchObject({ audience: { anyone: false, outsideDomains: [], insideOthers: 'domain', privateSource: true, trustOffered: false } })
    expect((await press('m-sato', asked.body.confirmation.id, 'confirm', true)).body.data.state).toBe('written')
    expect((await person('m-sato', 'GET', '/me/google/drive/trusted-folders')).body.data.folders).toEqual([])
    expect((await ai(token, 'POST', '/put', pdfBody('社内2.pdf', { folderId: GOOGLE_SEED.proposalsFolder, privateSource: true }))).body.code).toBe('DRIVE_PUT_NEEDS_CONFIRMATION')
    // A plain file there needs nobody's press (people in the company seeing it is fine).
    expect((await ai(token, 'POST', '/put', pdfBody('ふつう.pdf', { folderId: GOOGLE_SEED.proposalsFolder }))).body.data?.drivePut.state).toBe('done')
  })

  it('a folder in a shared drive (its members may not be listed): a private folder\'s file always asks', async () => {
    const token = await tokenFor('m-sato')
    google.setDrivePermissions(GOOGLE_SEED.proposalsFolder, [owner(GOOGLE_SEED.member)])
    google.setDriveSharedDrive(GOOGLE_SEED.proposalsFolder, 'fake-shared-drive-0001')
    const r = await ai(token, 'POST', '/put', pdfBody('共有ドライブ.pdf', { folderId: GOOGLE_SEED.proposalsFolder, privateSource: true }))
    expect(r.body.code, r.text).toBe('DRIVE_PUT_NEEDS_CONFIRMATION')
    // A plain file there goes in as before.
    expect((await ai(token, 'POST', '/put', pdfBody('共有ドライブふつう.pdf', { folderId: GOOGLE_SEED.proposalsFolder }))).body.data?.drivePut.state).toBe('done')
    google.setDriveSharedDrive(GOOGLE_SEED.proposalsFolder, null)
  })

  it('who in the company sees it changes while the member looks: nothing written', async () => {
    const token = await tokenFor('m-sato')
    google.setDrivePermissions(GOOGLE_SEED.proposalsFolder, [owner(GOOGLE_SEED.member), { type: 'domain', role: 'reader', domain: GOOGLE_SEED.internalDomain }])
    const c = (await ai(token, 'POST', '/put', pdfBody('変わる.pdf', { folderId: GOOGLE_SEED.proposalsFolder, privateSource: true }))).body.confirmation
    google.setDrivePermissions(GOOGLE_SEED.proposalsFolder, [owner(GOOGLE_SEED.member), { type: 'user', role: 'reader', emailAddress: GOOGLE_SEED.colleague }])
    const before = uploads()
    expect((await press('m-sato', c.id, 'confirm')).body.code).toBe('DRIVE_SHARING_CHANGED')
    expect(uploads()).toBe(before)
  })

  it('the same number of people but someone else inside: nothing written (people are compared, not counted)', async () => {
    const token = await tokenFor('m-sato')
    google.setDrivePermissions(GOOGLE_SEED.proposalsFolder, [owner(GOOGLE_SEED.member), { type: 'user', role: 'reader', emailAddress: GOOGLE_SEED.colleague }])
    const c = (await ai(token, 'POST', '/put', pdfBody('入れ替わる.pdf', { folderId: GOOGLE_SEED.proposalsFolder, privateSource: true }))).body.confirmation
    expect(c.audience.insideOthers).toBe(1)
    google.setDrivePermissions(GOOGLE_SEED.proposalsFolder, [owner(GOOGLE_SEED.member), { type: 'user', role: 'reader', emailAddress: 'yoshida@div.example' }])
    const before = uploads()
    expect((await press('m-sato', c.id, 'confirm')).body.code).toBe('DRIVE_SHARING_CHANGED')
    expect(uploads()).toBe(before)
  })

  it('a private folder\'s document asked about only for someone\'s edit keeps being private at the press: shared meanwhile → nothing written', async () => {
    const token = await tokenFor('m-sato')
    google.setDrivePermissions(GOOGLE_SEED.proposalsFolder, [owner(GOOGLE_SEED.member)])
    const made = await ai(token, 'POST', '/put', docBody(Buffer.from('# 非公開の報告\n'), { name: '非公開の報告.md', privateSource: true, askAudience: true }))
    const doc = made.body.data?.drivePut
    expect(doc?.state, made.text).toBe('done')
    google.editDriveFile(doc.fileId, '# 田中さんの直し\n', GOOGLE_SEED.colleague)
    expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    const asked = await ai(token, 'POST', '/put', docBody(Buffer.from('# 二版\n'), { name: '非公開の報告.md', updateFileId: doc.fileId, privateSource: true, askAudience: true }))
    expect(asked.body.code, asked.text).toBe('DRIVE_OVERWRITE_NEEDS_CONFIRMATION')
    expect(asked.body.confirmation.audience).toBeUndefined()
    expect(ROW(asked.body.confirmation.id).private_source).toBe(1)
    google.setDrivePermissions(GOOGLE_SEED.proposalsFolder, [owner(GOOGLE_SEED.member), { type: 'domain', role: 'reader', domain: GOOGLE_SEED.internalDomain }])
    const r = await press('m-sato', asked.body.confirmation.id, 'confirm')
    expect(r.body.code, r.text).toBe('DRIVE_SHARING_CHANGED')
    expect(google.driveFile(doc.fileId)!.content.toString()).not.toContain('二版')
  })

  it('a member leaving takes their trusted folders with them', async () => {
    const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
    const repo = sqliteCompanyData(db).forCompany(CO).googleDrive
    repo.trustFolder({ userId: 'm-gone', folderId: GOOGLE_SEED.sharedOutsideFolder, folderName: 'x', audienceSig: 'a'.repeat(64), outsideDomains: [], createdAt: ts() })
    expect(repo.trustedFolders('m-gone')).toHaveLength(1)
    repo.forgetMember('m-gone')
    expect(repo.trustedFolders('m-gone')).toEqual([])
  })
})
