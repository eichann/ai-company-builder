/**
 * End-to-end against the fake Google (`.claude/rules/google-drive.md`, owner decisions 2026-11-14):
 *
 * "How long a pick lasts" — a file the member linked to a record stays readable by their AI while the link exists
 * (unlinking ends it); a plain file pick slides (each successful read or link renews it for 7 days); a folder pick is
 * renewed by each put into it (90 days); nothing is ever extended for another member.
 *
 * "Continuing a document people edited" (option ア) — a Google document changed in Drive since ACB's put is overwritten
 * only after the AI read it in this consultation and only while it is still what was read; the member's own edits only →
 * written at once; someone else's edit or comment → a confirmation the member presses (session only) that writes exactly
 * the content that waited; changed after the read or while asking → refused. A comment on the document is warned of.
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
import { createFakeGoogle, type FakeGoogle, SOMEONE_ELSE } from '../fakes/google/fake-google'
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
const CO = 'drive-continue-co'
const PUBLIC = 'http://localhost:13006'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-continueclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-continue-0123456789'
const PICKER_KEY = 'fake-picker-key-NOT-REAL-0123456789abcd'
const APP_ID = '123456789012'
const DAY = 24 * 60 * 60 * 1000
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

async function tokenFor(user: string, conversationId = 'conv-continue'): Promise<string> {
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
const docBody = (content: Buffer, over: Record<string, unknown> = {}) => ({
  folderId: GOOGLE_SEED.proposalsFolder, name: '報告書.md', kind: 'markdown', as: 'google_doc', sha256: sha(content),
  contentBase64: content.toString('base64'), requestKey: `key-${randomBytes(6).toString('hex')}`, ...over,
})
const pickRow = (user: string, fileId: string) =>
  db.prepare('SELECT * FROM google_drive_picks WHERE company_id = ? AND user_id = ? AND file_id = ?').get(CO, user, fileId) as Json
const setPickExpiry = (user: string, fileId: string, ms: number) =>
  db.prepare('UPDATE google_drive_picks SET expires_at = ? WHERE company_id = ? AND user_id = ? AND file_id = ?').run(new Date(Date.now() + ms).toISOString(), CO, user, fileId)
const patches = (fileId: string) => google.requests.filter(r => r.method === 'PATCH' && r.path === `/upload/drive/v3/files/${fileId}`).length

beforeAll(async () => {
  google = createFakeGoogle()
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  googleServer = serve({ fetch: google.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  kekDir = mkdtempSync(join(tmpdir(), 'acb-drive-continue-kek-'))
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
  google.pick(CLIENT_ID, GOOGLE_SEED.member, [GOOGLE_SEED.proposalsFolder, GOOGLE_SEED.pastProposalDoc, GOOGLE_SEED.handNotesPdf, GOOGLE_SEED.pastProposalSlides])
  expect((await person('m-sato', 'POST', '/me/google/drive/picks', { mode: 'folder', ids: [GOOGLE_SEED.proposalsFolder] })).body.data.picks).toHaveLength(1)
  const files = await person('m-sato', 'POST', '/me/google/drive/picks', { mode: 'files', ids: [GOOGLE_SEED.pastProposalDoc, GOOGLE_SEED.handNotesPdf, GOOGLE_SEED.pastProposalSlides] })
  expect(files.body.data.picks).toHaveLength(3)
})

afterAll(async () => {
  google.close()
  await new Promise(r => googleServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL', 'ACB_DRIVE_DOC_SETTLE_MS', 'ACB_DRIVE_DOC_QUIET_MS', 'ACB_DRIVE_DOC_GAP_MS']) delete process.env[k]
})

describe('how long a pick lasts (google-drive.md "How long a pick lasts")', () => {
  const linkDrive = (user: string, recordId: string, fileId: string, expectedVersion: number) =>
    person(user, 'POST', `/records/item/${recordId}/file-links`, { target: { kind: 'drive', fileId }, expectedVersion })
  const unlinkDrive = (user: string, recordId: string, fileId: string, expectedVersion: number) =>
    person(user, 'POST', `/records/item/${recordId}/file-links/remove`, { target: { kind: 'drive', fileId }, expectedVersion })

  it('a file linked to a record stays readable by the linker\'s AI past its 7 days; taking the link off ends it (and says the pick lapsed)', async () => {
    const token = await tokenFor('m-sato')
    const made = await person('m-sato', 'POST', '/records/item', { type: 'task', title: '提案の準備', fields: { assignee: 'm-sato' } })
    const id = made.body.data.record.id as string
    expect((await linkDrive('m-sato', id, GOOGLE_SEED.pastProposalDoc, 1)).status).toBe(200)
    // The member did not open ACB for weeks: the pick is long over, the link is not.
    setPickExpiry('m-sato', GOOGLE_SEED.pastProposalDoc, -14 * DAY)
    const read = await ai(token, 'POST', '/read', { fileId: GOOGLE_SEED.pastProposalDoc })
    expect(read.status, read.text).toBe(200)
    expect(read.body.data.text).toContain('対象：営業部 30名')
    // Reading through the link renews no expired pick (a pick is renewed only while it is live).
    expect(Date.parse(pickRow('m-sato', GOOGLE_SEED.pastProposalDoc).expires_at)).toBeLessThan(Date.now())
    // Another member's AI does not read it through Sato's link (Google's drive.file is per person: Tanaka must pick it himself).
    const tanaka = await tokenFor('m-tanaka')
    const calls = google.requests.length
    const his = await ai(tanaka, 'POST', '/read', { fileId: GOOGLE_SEED.pastProposalDoc })
    expect([his.status, his.body.code]).toEqual([403, 'DRIVE_NOT_PICKED'])
    expect(google.requests.length).toBe(calls)

    expect((await unlinkDrive('m-sato', id, GOOGLE_SEED.pastProposalDoc, 2)).status).toBe(200)
    const gone = await ai(token, 'POST', '/read', { fileId: GOOGLE_SEED.pastProposalDoc })
    expect([gone.status, gone.body.code, gone.body.lapsed]).toEqual([403, 'DRIVE_NOT_PICKED', true])
    expect(gone.body.error).toContain('7日')
    expect(google.requests.length).toBe(calls)
  })

  it('a link someone else made, or a link brought back without its facts (an undo), keeps nothing alive', async () => {
    const token = await tokenFor('m-sato')
    setPickExpiry('m-sato', GOOGLE_SEED.handNotesPdf, -DAY)
    // A link row of this file made by Tanaka (he picked it himself) is not Sato's.
    const made = await person('m-sato', 'POST', '/records/item', { type: 'task', title: '他の人のつながり', fields: { assignee: 'm-sato' } })
    const id = made.body.data.record.id as string
    db.prepare(`INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path, created_by, target_meta) VALUES (?, ?, 'files', 0, NULL, ?, 'm-tanaka', ?)`)
      .run(CO, id, `drive:${GOOGLE_SEED.handNotesPdf}`, JSON.stringify({ revisionId: null, name: 'x', sha256: null, mimeType: null, linkedAt: ts() }))
    expect((await ai(token, 'POST', '/read', { fileId: GOOGLE_SEED.handNotesPdf })).body.code).toBe('DRIVE_NOT_PICKED')
    // Sato's own link with no kept facts (as an undo brings it back): not enough either.
    db.prepare(`INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path, created_by, target_meta) VALUES (?, ?, 'files', 1, NULL, ?, 'm-sato', NULL)`)
      .run(CO, id, `drive:${GOOGLE_SEED.handNotesPdf}`)
    expect((await ai(token, 'POST', '/read', { fileId: GOOGLE_SEED.handNotesPdf })).body.code).toBe('DRIVE_NOT_PICKED')
    db.prepare('DELETE FROM record_links WHERE company_id = ? AND source_id = ?').run(CO, id)
  })

  it('a plain file pick slides: each read and each link renews it for 7 days — the member\'s own only, never another member\'s', async () => {
    const token = await tokenFor('m-sato')
    const fileId = GOOGLE_SEED.pastProposalSlides
    // Tanaka's own pick of the same file (his own choice), ending in an hour.
    const tanakaEnds = new Date(Date.now() + 60 * 60_000).toISOString()
    db.prepare('INSERT OR REPLACE INTO google_drive_picks (company_id, user_id, file_id, kind, name, mime_type, picked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(CO, 'm-tanaka', fileId, 'file', 'スライド', 'application/vnd.google-apps.presentation', ts(), tanakaEnds)
    setPickExpiry('m-sato', fileId, 60 * 60_000)
    expect((await ai(token, 'POST', '/read', { fileId })).status).toBe(200)
    const renewed = Date.parse(pickRow('m-sato', fileId).expires_at)
    expect(renewed).toBeGreaterThan(Date.now() + 7 * DAY - 60_000)
    expect(renewed).toBeLessThanOrEqual(Date.now() + 7 * DAY)
    expect(pickRow('m-tanaka', fileId).expires_at).toBe(tanakaEnds)
    // A refused read renews nothing (a folder is not a file to read).
    setPickExpiry('m-sato', GOOGLE_SEED.proposalsFolder, DAY)
    const folderEnds = pickRow('m-sato', GOOGLE_SEED.proposalsFolder).expires_at
    expect((await ai(token, 'POST', '/read', { fileId: GOOGLE_SEED.proposalsFolder })).body.code).toBe('DRIVE_NOT_PICKED')
    expect(pickRow('m-sato', GOOGLE_SEED.proposalsFolder).expires_at).toBe(folderEnds)
    // Linking it to a record renews it too.
    setPickExpiry('m-sato', fileId, 60 * 60_000)
    const made = await person('m-sato', 'POST', '/records/item', { type: 'task', title: 'スライドを見る', fields: { assignee: 'm-sato' } })
    expect((await linkDrive('m-sato', made.body.data.record.id, fileId, 1)).status).toBe(200)
    expect(Date.parse(pickRow('m-sato', fileId).expires_at)).toBeGreaterThan(Date.now() + 7 * DAY - 60_000)
    // Used for the last time more than 7 days ago: over.
    db.prepare('DELETE FROM record_links WHERE company_id = ? AND source_id = ?').run(CO, made.body.data.record.id)
    setPickExpiry('m-sato', fileId, -1000)
    expect((await ai(token, 'POST', '/read', { fileId })).body.code).toBe('DRIVE_NOT_PICKED')
  })

  it('a folder pick is renewed by each put into it (90 days); a refused put renews nothing', async () => {
    const token = await tokenFor('m-sato')
    setPickExpiry('m-sato', GOOGLE_SEED.proposalsFolder, DAY)
    const before = pickRow('m-sato', GOOGLE_SEED.proposalsFolder).expires_at
    // Refused (a PDF cannot become a document): nothing renewed.
    const pdf = Buffer.from('%PDF-1.7\n%%EOF\n')
    expect((await ai(token, 'POST', '/put', { ...docBody(pdf), name: 'x.pdf', kind: 'pdf' })).body.code).toBe('DRIVE_TYPE_REFUSED')
    expect(pickRow('m-sato', GOOGLE_SEED.proposalsFolder).expires_at).toBe(before)
    const r = await ai(token, 'POST', '/put', docBody(Buffer.from('# 延びる\n'), { name: '延びる.md' }))
    expect(r.body.data?.drivePut.state, r.text).toBe('done')
    const after = Date.parse(pickRow('m-sato', GOOGLE_SEED.proposalsFolder).expires_at)
    expect(after).toBeGreaterThan(Date.now() + 90 * DAY - 60_000)
    expect(after).toBeLessThanOrEqual(Date.now() + 90 * DAY)
  })
})

describe('continuing a Google document people edited (google-drive.md "Continuing a document people edited")', () => {
  const ROW = (id: string) => db.prepare('SELECT * FROM google_drive_overwrite_confirmations WHERE company_id = ? AND id = ?').get(CO, id) as Json
  async function putDoc(token: string, text: string, name: string) {
    const r = await ai(token, 'POST', '/put', docBody(Buffer.from(text), { name }))
    expect(r.body.data?.drivePut.state, r.text).toBe('done')
    return r.body.data.drivePut as Json
  }
  const update = (token: string, name: string, fileId: string, text: string, over: Record<string, unknown> = {}) =>
    ai(token, 'POST', '/put', docBody(Buffer.from(text), { name, updateFileId: fileId, ...over }))
  const press = (user: string, id: string, action: 'confirm' | 'decline') => person(user, 'POST', `/me/google/drive/overwrite-confirmations/${id}`, { action })

  it('the member\'s own edits only: refused until the AI reads it in this consultation, then written at once (no copy made)', async () => {
    const token = await tokenFor('m-sato')
    const doc = await putDoc(token, '# 一版\n', '自分で直す.md')
    google.editDriveFile(doc.fileId, '# 一版（佐藤さんが直した）\n', GOOGLE_SEED.member)
    const uploads = google.uploads().length
    const first = await update(token, '自分で直す.md', doc.fileId, '# 二版\n')
    expect([first.status, first.body.code, first.body.needsRead]).toEqual([409, 'DRIVE_FILE_CHANGED_SINCE', true])
    expect(first.body.error).toContain('drive_read')
    // A read in another consultation is not this one's.
    const elsewhere = await tokenFor('m-sato', 'conv-elsewhere')
    expect((await ai(elsewhere, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    expect((await update(token, '自分で直す.md', doc.fileId, '# 二版\n')).body.code).toBe('DRIVE_FILE_CHANGED_SINCE')
    expect(patches(doc.fileId)).toBe(0)

    const read = await ai(token, 'POST', '/read', { fileId: doc.fileId })
    expect(read.body.data.text).toContain('佐藤さんが直した')
    const written = await update(token, '自分で直す.md', doc.fileId, '# 二版（直しを取り込んだ）\n')
    expect(written.body.data?.drivePut, written.text).toMatchObject({ state: 'done', fileId: doc.fileId, updatedFileId: doc.fileId })
    expect(written.body.data.continued).toBe('own')
    expect(google.driveFile(doc.fileId)!.content.toString()).toBe('# 二版（直しを取り込んだ）\n')
    expect(google.uploads()).toHaveLength(uploads)
    // The continued update keeps a baseline from the revision it started from: the next update with nothing changed goes
    // straight through, without another read.
    const next = await update(token, '自分で直す.md', doc.fileId, '# 三版\n')
    expect(next.body.data?.drivePut.state, next.text).toBe('done')
    expect(next.body.data.continued).toBeUndefined()
  })

  it('changed again after the read: 「読み直して」, nothing written', async () => {
    const token = await tokenFor('m-sato')
    const doc = await putDoc(token, '# 一版\n', '読んだあとに直る.md')
    google.editDriveFile(doc.fileId, '# 自分で直した\n', GOOGLE_SEED.member)
    expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    google.editDriveFile(doc.fileId, '# 読んだあとにまた直した\n', GOOGLE_SEED.member)
    const r = await update(token, '読んだあとに直る.md', doc.fileId, '# 二版\n')
    expect([r.status, r.body.code, r.body.needsRead]).toEqual([409, 'DRIVE_READ_AGAIN', true])
    expect(patches(doc.fileId)).toBe(0)
    // Even a change of look only after the read (a new revision, the same text).
    expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    google.formatDriveFile(doc.fileId, GOOGLE_SEED.member)
    expect((await update(token, '読んだあとに直る.md', doc.fileId, '# 二版\n')).body.code).toBe('DRIVE_READ_AGAIN')
    expect(google.driveFile(doc.fileId)!.content.toString()).toBe('# 読んだあとにまた直した\n')
  })

  it('a document with no baseline: after a read, the member\'s own revisions only → written; never without the read', async () => {
    const token = await tokenFor('m-sato')
    const doc = await putDoc(token, '# 控えなし\n', '控えなし.md')
    db.prepare('UPDATE google_drive_puts SET doc_fingerprint = NULL, doc_revision = NULL, doc_revision_at = NULL, doc_baseline_at = NULL WHERE company_id = ? AND id = ?').run(CO, doc.id)
    expect((await update(token, '控えなし.md', doc.fileId, '# 二版\n')).body.code).toBe('DRIVE_FILE_NOT_VERIFIABLE')
    expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    const r = await update(token, '控えなし.md', doc.fileId, '# 二版\n')
    expect(r.body.data?.continued, r.text).toBe('own')
    expect(google.driveFile(doc.fileId)!.content.toString()).toBe('# 二版\n')
  })

  it('someone else\'s edit: a confirmation, nothing written; the member\'s press writes exactly the content that waited, once', async () => {
    const token = await tokenFor('m-sato')
    const doc = await putDoc(token, '# 一版\n', '人が直す報告書.md')
    google.editDriveFile(doc.fileId, '# 田中さんが直した版\n', GOOGLE_SEED.colleague)
    expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    const content = '# 二版（田中さんの直しを取り込んだ）\n'
    const body = docBody(Buffer.from(content), { name: '人が直す報告書.md', updateFileId: doc.fileId, requestKey: 'key-confirm-0001' })
    const asked = await ai(token, 'POST', '/put', body)
    expect([asked.status, asked.body.code], asked.text).toEqual([409, 'DRIVE_OVERWRITE_NEEDS_CONFIRMATION'])
    const c = asked.body.confirmation
    expect(c).toMatchObject({ id: expect.stringMatching(/^drive-confirm-/), fileName: '人が直す報告書', editors: ['tanaka'], commented: false })
    expect(asked.body.error).toContain('tanakaさん')
    expect(patches(doc.fileId)).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_drive_puts WHERE company_id = ? AND request_key = ?').get(CO, 'key-confirm-0001').n).toBe(0)
    expect(Buffer.from(ROW(c.id).content).toString()).toBe(content)
    // The same request again while it waits: the same confirmation. Another content for the same file replaces it (one
    // waits per file: their kept contents stay bounded).
    expect((await ai(token, 'POST', '/put', body)).body.confirmation.id).toBe(c.id)
    const other = await ai(token, 'POST', '/put', docBody(Buffer.from('# 別の版\n'), { name: '人が直す報告書.md', updateFileId: doc.fileId }))
    expect(other.body.confirmation.id).not.toBe(c.id)
    expect([ROW(c.id).state, ROW(c.id).content]).toEqual(['declined', null])
    db.prepare("UPDATE google_drive_overwrite_confirmations SET state = 'open', content = ? WHERE company_id = ? AND id = ?").run(Buffer.from(content), CO, c.id)
    db.prepare("UPDATE google_drive_overwrite_confirmations SET state = 'declined', content = NULL WHERE company_id = ? AND id = ?").run(CO, other.body.confirmation.id)

    // Not another member's to press, and no record token reaches the press.
    expect((await press('m-tanaka', c.id, 'confirm')).status).toBe(404)
    expect((await call({ token, method: 'POST', path: `${C}/me/google/drive/overwrite-confirmations/${c.id}`, body: { action: 'confirm' } })).status).toBe(401)
    expect(patches(doc.fileId)).toBe(0)

    const done = await press('m-sato', c.id, 'confirm')
    expect(done.status, done.text).toBe(200)
    expect(done.body.data).toMatchObject({ state: 'written', drivePut: { state: 'done', fileId: doc.fileId, sha256: sha(Buffer.from(content)) } })
    expect(done.body.data.recordId).toBeUndefined()
    expect(google.driveFile(doc.fileId)!.content.toString()).toBe(content)
    expect(patches(doc.fileId)).toBe(1)
    expect([ROW(c.id).state, ROW(c.id).content]).toEqual(['written', null])
    // Pressed again: nothing more.
    expect((await press('m-sato', c.id, 'confirm')).body.code).toBe('DRIVE_CONFIRMATION_DONE')
    expect(patches(doc.fileId)).toBe(1)
  })

  it('someone else\'s comment: a confirmation; after the press the AI hears that comments may have moved', async () => {
    const token = await tokenFor('m-sato')
    const doc = await putDoc(token, '# 一版\n', 'コメントがある.md')
    google.commentOnDriveFile(doc.fileId, GOOGLE_SEED.colleague)
    expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    const asked = await update(token, 'コメントがある.md', doc.fileId, '# 二版\n')
    expect(asked.body.code).toBe('DRIVE_OVERWRITE_NEEDS_CONFIRMATION')
    expect(asked.body.confirmation).toMatchObject({ editors: ['tanaka'], commented: true })
    const done = await press('m-sato', asked.body.confirmation.id, 'confirm')
    expect(done.body.data).toMatchObject({ state: 'written', commentsMayMove: true })
    // The member's own comment is theirs: written at once, with the warning.
    const mine = await putDoc(token, '# 一版\n', '自分のコメント.md')
    google.commentOnDriveFile(mine.fileId, GOOGLE_SEED.member)
    expect((await ai(token, 'POST', '/read', { fileId: mine.fileId })).status).toBe(200)
    const r = await update(token, '自分のコメント.md', mine.fileId, '# 二版\n')
    expect(r.body.data).toMatchObject({ continued: 'own', commentsMayMove: true })
  })

  it('changed while the person looked (an edit or a new comment): the press writes nothing and the AI must read again', async () => {
    const token = await tokenFor('m-sato')
    for (const change of ['edit', 'comment'] as const) {
      const doc = await putDoc(token, '# 一版\n', `確かめ中に変わる-${change}.md`)
      google.editDriveFile(doc.fileId, '# 他の人の直し\n', SOMEONE_ELSE)
      expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
      const asked = await update(token, `確かめ中に変わる-${change}.md`, doc.fileId, '# 二版\n')
      expect(asked.body.code).toBe('DRIVE_OVERWRITE_NEEDS_CONFIRMATION')
      if (change === 'edit') google.editDriveFile(doc.fileId, '# さらに直した\n', SOMEONE_ELSE)
      else google.commentOnDriveFile(doc.fileId, SOMEONE_ELSE)
      const r = await press('m-sato', asked.body.confirmation.id, 'confirm')
      expect([r.status, r.body.code], change).toEqual([409, 'DRIVE_READ_AGAIN'])
      expect(patches(doc.fileId)).toBe(0)
      expect(ROW(asked.body.confirmation.id).state).toBe('declined')
    }
  })

  it('「やめる」: nothing written, the confirmation closed; an expired one writes nothing', async () => {
    const token = await tokenFor('m-sato')
    const doc = await putDoc(token, '# 一版\n', 'やめる.md')
    google.editDriveFile(doc.fileId, '# 他の人の直し\n', SOMEONE_ELSE)
    expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    const asked = await update(token, 'やめる.md', doc.fileId, '# 二版\n')
    expect((await press('m-sato', asked.body.confirmation.id, 'decline')).body.data).toEqual({ state: 'declined' })
    expect(ROW(asked.body.confirmation.id).content).toBeNull()
    expect((await press('m-sato', asked.body.confirmation.id, 'confirm')).body.code).toBe('DRIVE_CONFIRMATION_DECLINED')
    expect(patches(doc.fileId)).toBe(0)
    const again = await update(token, 'やめる.md', doc.fileId, '# 三版\n')
    db.prepare('UPDATE google_drive_overwrite_confirmations SET expires_at = ? WHERE company_id = ? AND id = ?').run(new Date(Date.now() - 1000).toISOString(), CO, again.body.confirmation.id)
    expect((await press('m-sato', again.body.confirmation.id, 'confirm')).body.code).toBe('DRIVE_CONFIRMATION_EXPIRED')
    expect(patches(doc.fileId)).toBe(0)
  })

  it('every other check still holds at the press: the file shared outside by itself is refused for the AI\'s content', async () => {
    const token = await tokenFor('m-sato')
    const doc = await putDoc(token, '# 一版\n', '外に出る.md')
    google.editDriveFile(doc.fileId, '# 他の人の直し\n', SOMEONE_ELSE)
    expect((await ai(token, 'POST', '/read', { fileId: doc.fileId })).status).toBe(200)
    const asked = await update(token, '外に出る.md', doc.fileId, '# 二版\n')
    google.shareDriveFile(doc.fileId, { type: 'anyone', role: 'reader' })
    const r = await press('m-sato', asked.body.confirmation.id, 'confirm')
    expect(r.body.code).toBe('DRIVE_FILE_SHARED_OUTSIDE')
    expect(patches(doc.fileId)).toBe(0)
  })
})
