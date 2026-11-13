/**
 * Google Drive's usability fixes (owner FB 2026-11-14, 「Drive の使い勝手チェック」; `.claude/rules/google-drive.md`)
 * end to end against the fake Google: the server's routes, a session for the member's app, a record token for their AI.
 *
 * What it protects (each mutation-checked, see the PR):
 * - A: a file an earlier put made stays updatable however many puts came after: the AI's list is one entry per file
 *   (re-putting one file never pushes another out), paged, and one file's eligibility is answered by itself (`fileId`);
 *   only the member's own puts, a job's run only its folder;
 * - D / H: a pick says how many picked ids were not usable and why, and whether a picked folder is seen outside the
 *   company (the AI cannot put there) — in the ticket's result for the app and in the page's sentence;
 * - link only (owner decision 2026-11-14): a ticket for linking offers every file type and keeps a type the AI cannot
 *   read (linked with no sha256: never material); a ticket for reading still keeps only what drive_read reads;
 *   `purpose` exists only for files and only as read / link;
 * - G: a put that is done in Drive but could not be linked to the consultation's record says so (`notLinked`);
 * - L: a refused Google document names the way out (put it as a file);
 * - N: the AI's status says when the admin has not registered the Picker.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'
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
const CO = 'drive-ux-co'
const PUBLIC = 'http://localhost:13005'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-driveuxclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-driveux-0123456789'
const PICKER_KEY = 'fake-picker-key-NOT-REAL-0123456789abcd'
const APP_ID = '123456789012'
const DOCX = 'fake-docx-estimate-0001'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const SHORTCUT = 'fake-shortcut-proposals-0001'
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
  try { body = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body, text }
}
const C = `/api/companies/${CO}`
const person = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `${C}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown) => call({ token, method, path: `/api/records-ai/google/drive${path}`, body })
const page = (what: 'config' | 'result', body: unknown) => call({ method: 'POST', path: `/api/google-picker/${what}`, body })

async function tokenFor(user: string, scope: 'read' | 'act'): Promise<string> {
  const r = await call({ user, method: 'POST', path: `${C}/me/record-tokens`, body: { conversationId: 'conv-drive-ux', agent: 'claude-code', scope } })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}

async function allow(user: string, features: string[]) {
  google.signIn({ email: EMAILS[user] })
  const r = await call({ user, method: 'POST', path: `${C}/me/google/connect`, body: { features } })
  expect(r.status, r.text).toBe(200)
  const res = await fetch(r.body.data.authorizeUrl, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  expect((await call({ method: 'GET', path: `/api/oauth/google/callback${back.search}` })).status).toBe(200)
}

/** A pick through a ticket, as the page would make it: the result the page got and the state the app reads. */
async function pickThroughTicket(user: string, start: Record<string, unknown>, ids: string[]) {
  const t = await person(user, 'POST', '/me/google/drive/pick-tickets', start)
  expect(t.status, t.text).toBe(200)
  const cfg = await page('config', { ticket: t.body.data.ticket })
  expect(cfg.status, cfg.text).toBe(200)
  const result = await page('result', { ticket: t.body.data.ticket, mode: start.mode, action: 'picked', ids })
  const state = await person(user, 'GET', `/me/google/drive/pick-tickets/${t.body.data.ticketId}`)
  const row = db.prepare('SELECT purpose FROM google_drive_pick_tickets WHERE id = ?').get(t.body.data.ticketId) as { purpose: string }
  await person(user, 'DELETE', `/me/google/drive/pick-tickets/${t.body.data.ticketId}`)
  return { cfg: cfg.body.data, result, state: state.body.data, purpose: row.purpose }
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const putBody = (over: Record<string, unknown> = {}, content: Buffer = PDF) => ({
  folderId: GOOGLE_SEED.proposalsFolder, name: '株式会社サンプル_ご提案.pdf', kind: 'pdf', sha256: sha(content),
  contentBase64: content.toString('base64'), requestKey: `key-${randomBytes(6).toString('hex')}`, ...over,
})

beforeAll(async () => {
  const seed = defaultGoogleSeed()
  // A Word file 佐藤 has in Drive: the AI cannot read it; a person may still link it (owner decision 2026-11-14).
  seed.driveFiles = [...(seed.driveFiles ?? []), {
    id: DOCX, name: '見積書.docx', mimeType: DOCX_MIME, owner: GOOGLE_SEED.member, readers: [GOOGLE_SEED.member], content: 'PK fake docx',
    permissions: [{ type: 'user', role: 'owner', emailAddress: GOOGLE_SEED.member }],
  }, {
    id: SHORTCUT, name: '提案書へのショートカット', mimeType: 'application/vnd.google-apps.shortcut', owner: GOOGLE_SEED.member, readers: [GOOGLE_SEED.member], content: '',
    permissions: [{ type: 'user', role: 'owner', emailAddress: GOOGLE_SEED.member }],
  }]
  google = createFakeGoogle({ seed })
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  googleServer = serve({ fetch: google.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  kekDir = mkdtempSync(join(tmpdir(), 'acb-drive-ux-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_DRIVE_DOC_SETTLE_MS: '0', ACB_DRIVE_DOC_QUIET_MS: '0', ACB_DRIVE_DOC_GAP_MS: '0',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
  })
  for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {})
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
  app.route('/api/google-picker', drive.googlePickerPageRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)

  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'm-owner', ts(), ts())
  for (const [u, role] of [['m-owner', 'owner'], ['m-sato', 'member'], ['m-tanaka', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`mx-${u}`, u, CO, role, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  const { ensureCoreTypes } = await import('../../src/services/record-index')
  const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
  ensureCompanyScope(db, CO)
  db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(CO, ts(), 'x')
  ensureCoreTypes(sqliteCompanyData(db).forCompany(CO).records, ts())
  expect((await person('m-owner', 'PUT', '/google/client', { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
  expect((await person('m-owner', 'PUT', '/google/picker', { apiKey: PICKER_KEY, appId: APP_ID })).status).toBe(200)
  await allow('m-sato', ['drive'])
  await allow('m-tanaka', ['drive'])
  google.pick(CLIENT_ID, GOOGLE_SEED.member, [GOOGLE_SEED.proposalsFolder, GOOGLE_SEED.sharedOutsideFolder, GOOGLE_SEED.pastProposalDoc, GOOGLE_SEED.handNotesPdf, DOCX, SHORTCUT])
  expect((await person('m-sato', 'POST', '/me/google/drive/picks', { mode: 'folder', ids: [GOOGLE_SEED.proposalsFolder] })).status).toBe(200)
})

afterAll(async () => {
  google.close()
  await new Promise(r => googleServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL', 'ACB_DRIVE_DOC_SETTLE_MS', 'ACB_DRIVE_DOC_QUIET_MS', 'ACB_DRIVE_DOC_GAP_MS']) delete process.env[k]
})

/** A done receipt written straight into the table (the list's shape is what is tested, not the upload). */
let receiptN = 0
function receipt(user: string, fileId: string, over: Record<string, unknown> = {}) {
  const n = receiptN++
  const createdAt = new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
  const row = {
    id: `drive-put-seed${String(n).padStart(5, '0')}`, company_id: CO, user_id: user, request_key: `seed-key-${n}`, actor_kind: 'ai', conversation_id: 'conv-drive-ux', run_id: null,
    folder_id: GOOGLE_SEED.proposalsFolder, folder_name: '提案書', name: `${fileId}.pdf`, mime_type: 'application/pdf', bytes: 1, sha256: 'a'.repeat(64), state: 'done',
    file_id: fileId, revision_id: `rev-${n}`, link: null, reason: null, created_at: createdAt, finished_at: createdAt, ...over,
  }
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO google_drive_puts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row))
}

describe('A: a file an earlier put made stays updatable, however many puts came after', () => {
  it('one entry per file: re-putting one file many times never pushes another out; the list pages; one file is answered by itself', async () => {
    db.prepare('DELETE FROM google_drive_puts').run()
    receipt('m-sato', 'fake-upload-old-report-0001')
    // The member's AI then updated one other file 40 times (each update is a receipt of that same file).
    for (let i = 0; i < 40; i++) receipt('m-sato', 'fake-upload-busy-file-0001')
    const token = await tokenFor('m-sato', 'read')
    const listed = (await ai(token, 'GET', '/status')).body.data
    expect(listed.puts.map((p: Json) => p.fileId)).toEqual(['fake-upload-busy-file-0001', 'fake-upload-old-report-0001'])
    expect(listed.puts[0].revisionId).toBe(`rev-${receiptN - 1}`)
    expect(listed.putsNext).toBeUndefined()

    // 60 more files: 50 at a time, newest first, then the rest.
    for (let i = 0; i < 60; i++) receipt('m-sato', `fake-upload-many-${String(i).padStart(4, '0')}`)
    const first = (await ai(token, 'GET', '/status')).body.data
    expect(first.puts).toHaveLength(50)
    expect(first.puts[0].fileId).toBe('fake-upload-many-0059')
    expect(typeof first.putsNext).toBe('string')
    const second = (await ai(token, 'GET', `/status?putsBefore=${encodeURIComponent(first.putsNext)}`)).body.data
    expect(second.puts.map((p: Json) => p.fileId)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `fake-upload-many-${String(9 - i).padStart(4, '0')}`), 'fake-upload-busy-file-0001', 'fake-upload-old-report-0001',
    ])
    expect(second.putsNext).toBeUndefined()

    // The overwrite check's own question: just that file, its latest put, whatever its age.
    const one = (await ai(token, 'GET', '/status?fileId=fake-upload-old-report-0001')).body.data
    expect(one.puts).toEqual([expect.objectContaining({ fileId: 'fake-upload-old-report-0001', revisionId: 'rev-0', folderId: GOOGLE_SEED.proposalsFolder })])
    // Never another member's: 田中's token does not see 佐藤's file.
    const tanaka = await tokenFor('m-tanaka', 'read')
    expect((await ai(tanaka, 'GET', '/status?fileId=fake-upload-old-report-0001')).body.data.puts).toEqual([])
    expect((await ai(tanaka, 'GET', '/status')).body.data.puts).toEqual([])
    // A malformed id or cursor answers nothing more than it should.
    expect((await ai(token, 'GET', '/status?fileId=not%20an%20id')).body.data.puts).toEqual([])
    expect((await ai(token, 'GET', '/status?putsBefore=yesterday')).body.data.puts).toHaveLength(50)
  })

  it('files put in the same instant across a page boundary are never skipped (the cursor holds the time and the put id)', async () => {
    db.prepare('DELETE FROM google_drive_puts').run()
    const same = '2026-11-02T00:00:00.000Z'
    for (let i = 0; i < 53; i++) receipt('m-sato', `fake-upload-tie-${String(i).padStart(4, '0')}`, { created_at: same, finished_at: same })
    const token = await tokenFor('m-sato', 'read')
    const first = (await ai(token, 'GET', '/status')).body.data
    const second = (await ai(token, 'GET', `/status?putsBefore=${encodeURIComponent(first.putsNext)}`)).body.data
    const all = [...first.puts, ...second.puts].map((p: Json) => p.fileId)
    expect(all).toHaveLength(53)
    expect(new Set(all).size).toBe(53)
  })

  it('the app\'s 「つなぐ」 list is one entry per file too', async () => {
    db.prepare('DELETE FROM google_drive_puts').run()
    receipt('m-sato', 'fake-upload-old-report-0001')
    for (let i = 0; i < 40; i++) receipt('m-sato', 'fake-upload-busy-file-0001')
    const files = (await person('m-sato', 'GET', '/me/google/drive/files')).body.data.files as Json[]
    expect(files.filter(f => f.source === 'put').map(f => f.id)).toEqual(['fake-upload-busy-file-0001', 'fake-upload-old-report-0001'])
  })
})

describe('D / H / link only: what a pick says, and what it keeps', () => {
  it('a ticket for reading keeps only what the AI reads, and says why the rest was not usable (count and reason, in the page and to the app)', async () => {
    const r = await pickThroughTicket('m-sato', { mode: 'files' }, [GOOGLE_SEED.pastProposalDoc, DOCX, GOOGLE_SEED.salesNotesDoc])
    expect(r.cfg.purpose).toBe('read')
    expect(r.cfg.mimeTypes).not.toContain(DOCX_MIME)
    expect(r.result.body.data).toMatchObject({ state: 'picked', kept: 1, refused: 2 })
    expect(r.result.body.data.message).toContain('2件は使えませんでした')
    expect(r.result.body.data.message).toContain('AI では中身を読めない種類')
    expect(r.state.picks.map((p: Json) => p.id)).toEqual([GOOGLE_SEED.pastProposalDoc])
    expect(r.state.refusedWhy).toEqual({ type: 1, 'no-access': 1 })
  })

  it('a ticket for linking offers every type and keeps a Word file; it links with no sha256 (never material) and the AI still cannot read it', async () => {
    const r = await pickThroughTicket('m-sato', { mode: 'files', purpose: 'link' }, [DOCX])
    expect(r.cfg).toMatchObject({ purpose: 'link', mimeTypes: [] })
    expect(r.result.body.data).toMatchObject({ state: 'picked', kept: 1, refused: 0 })
    expect(r.state.picks).toEqual([expect.objectContaining({ id: DOCX, kind: 'file', mimeType: DOCX_MIME })])
    const made = await person('m-sato', 'POST', '/records/item', { type: 'task', title: '見積書を添える', fields: { assignee: 'm-sato' } })
    const id = made.body.data.record.id as string
    const linked = await person('m-sato', 'POST', `/records/item/${id}/file-links`, { target: { kind: 'drive', fileId: DOCX }, expectedVersion: 1 })
    expect(linked.status, linked.text).toBe(200)
    const drive = ((await person('m-sato', 'GET', `/records/item/${id}`)).body.data.links as Json[]).find(l => l.drive)?.drive
    expect(drive).toMatchObject({ fileId: DOCX, mine: true, name: '見積書.docx', mimeType: DOCX_MIME, sha256: null })
    const token = await tokenFor('m-sato', 'read')
    expect((await ai(token, 'POST', '/read', { fileId: DOCX })).body.code).toBe('DRIVE_TYPE_UNREADABLE')
  })

  it('`purpose` is only read / link and only for files: a folder pick is never widened', async () => {
    expect((await person('m-sato', 'POST', '/me/google/drive/pick-tickets', { mode: 'files', purpose: 'everything' })).status).toBe(400)
    const r = await pickThroughTicket('m-sato', { mode: 'folder', purpose: 'link' }, [DOCX])
    expect(r.cfg.purpose).toBeUndefined()
    expect(r.purpose).toBe('read')
    expect(r.cfg.mimeTypes).toEqual(expect.arrayContaining(['application/pdf']))
    expect(r.result.body.data).toMatchObject({ kept: 0, refused: 1 })
    expect(r.state.refusedWhy).toEqual({ 'not-folder': 1 })
  })

  it('a folder or a shortcut picked for linking has its own reason, never "a type the AI cannot read"', async () => {
    const r = await pickThroughTicket('m-sato', { mode: 'files', purpose: 'link' }, [GOOGLE_SEED.proposalsFolder, SHORTCUT])
    expect(r.result.body.data).toMatchObject({ kept: 0, refused: 2 })
    expect(r.state.refusedWhy).toEqual({ folder: 1, shortcut: 1 })
    expect(r.result.body.data.message).toContain('フォルダはまだつなげません')
    expect(r.result.body.data.message).not.toContain('AI では中身を読めない')
  })

  it('reading a folder\'s sharing that throws never fails the pick: kept, its sharing not known', async () => {
    const { services } = await import('../../src/composition')
    const real = services.googleClient.request.bind(services.googleClient)
    const spy = vi.spyOn(services.googleClient, 'request').mockImplementation(async (c, u, req) => {
      if (req.path.endsWith('/permissions')) throw new Error('boom')
      return real(c, u, req)
    })
    try {
      const r = await pickThroughTicket('m-sato', { mode: 'folder' }, [GOOGLE_SEED.proposalsFolder])
      expect(r.state.picks).toEqual([expect.objectContaining({ id: GOOGLE_SEED.proposalsFolder, sharing: 'unknown' })])
      expect(r.result.body.data.message).toContain('誰が見られるか確かめられなかった')
    } finally { spy.mockRestore() }
  })

  it('the page warns when the AI narrowed the chooser to files it named (reading only; never for the card\'s own link)', async () => {
    const pageText = (await call({ method: 'GET', path: '/api/google-picker' })).text
    expect(pageText).toContain('AI が、このファイルを選ぶよう求めています。中身に覚えがなければ選ばないでください。')
    expect(pageText).toContain("var aiAsked = !folder && cfg.purpose !== 'link' && only.length > 0")
  })

  it('a folder seen outside the company is said right after the pick (the AI asks before each put there); an internal one is not', async () => {
    const outside = await pickThroughTicket('m-sato', { mode: 'folder' }, [GOOGLE_SEED.sharedOutsideFolder])
    expect(outside.state.picks).toEqual([expect.objectContaining({ id: GOOGLE_SEED.sharedOutsideFolder, sharing: 'outside' })])
    expect(outside.result.body.data.message).toContain('社外の人も見られます。AI がここに置くときは、そのたびにメンバーに確かめます')
    const inside = await pickThroughTicket('m-sato', { mode: 'folder' }, [GOOGLE_SEED.proposalsFolder])
    expect(inside.state.picks).toEqual([expect.objectContaining({ id: GOOGLE_SEED.proposalsFolder, sharing: 'inside' })])
    expect(inside.result.body.data.message).not.toContain('社外')
    // The put still decides (the server is the authority): an app that cannot ask is refused.
    const token = await tokenFor('m-sato', 'act')
    expect((await ai(token, 'POST', '/put', putBody({ folderId: GOOGLE_SEED.sharedOutsideFolder }))).body.code).toBe('DRIVE_FOLDER_SHARED_OUTSIDE')
  })
})

describe('G / L: what a put tells the AI', () => {
  it('done in Drive but not linked to the consultation\'s やること: said plainly (notLinked), the put stays done', async () => {
    const hidden = await person('m-tanaka', 'POST', '/records/item', { type: 'task', title: '田中さんだけ', personal: true, fields: { assignee: 'm-tanaka' } })
    const token = await tokenFor('m-sato', 'act')
    const r = await ai(token, 'POST', '/put', { ...putBody({ name: 'つながらない.pdf' }), recordId: hidden.body.data.record.id })
    expect(r.status, r.text).toBe(200)
    expect(r.body.data.drivePut.state).toBe('done')
    expect(r.body.data.linkedTo).toBeUndefined()
    expect(r.body.data.notLinked).toEqual({ recordId: hidden.body.data.record.id, code: expect.stringMatching(/^[A-Z_]+$/) })
    // Linked: no notLinked.
    const own = await person('m-sato', 'POST', '/records/item', { type: 'task', title: '置いてつなぐ', fields: { assignee: 'm-sato' } })
    const linked = await ai(token, 'POST', '/put', { ...putBody({ name: 'つながる.pdf' }), recordId: own.body.data.record.id })
    expect(linked.body.data.linkedTo).toEqual({ recordId: own.body.data.record.id })
    expect(linked.body.data.notLinked).toBeUndefined()
  })

  it('a document that would fetch from outside: refused, with the way out (put it as a file)', async () => {
    const token = await tokenFor('m-sato', 'act')
    const md = Buffer.from('# 報告\n\n![図](https://example.com/a.png)\n')
    const r = await ai(token, 'POST', '/put', putBody({ name: '報告.md', kind: 'markdown', as: 'google_doc' }, md))
    expect([r.status, r.body.code, r.body.alternative]).toEqual([400, 'DRIVE_EXTERNAL_RESOURCE', 'as: file'])
    expect(r.body.error).toContain('as: "file"')
  })
})

describe('N: the AI hears why Drive is not there', () => {
  it('the admin has not registered the Picker: not available, with the reason', async () => {
    const token = await tokenFor('m-sato', 'read')
    expect((await ai(token, 'GET', '/status')).body.data.reason).toBeUndefined()
    expect((await person('m-owner', 'PUT', '/google/picker', { appId: null })).status).toBe(200)
    try {
      const s = (await ai(token, 'GET', '/status')).body.data
      expect([s.available, s.reason]).toEqual([false, 'picker-not-configured'])
    } finally {
      expect((await person('m-owner', 'PUT', '/google/picker', { apiKey: PICKER_KEY, appId: APP_ID })).status).toBe(200)
    }
  })
})
