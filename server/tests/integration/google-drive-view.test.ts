/**
 * Viewing a Drive video (google-drive.md "Viewing a video", owner decisions 2026-11-26) end to end against the fake
 * Google: the pick ticket with `purpose: 'view'`, the Picker page's config and its result, and the service function the
 * later streaming route calls at every play (`useViewPick`).
 *
 * What it protects (each mutation-checked, see the PR):
 * - a view ticket is files mode with exactly one Drive id (bound to it), never widened into another purpose;
 * - its Picker shows and lets select only the video types, under ACB's own title;
 * - its result keeps nothing unless the picked id is the bound one and Google says it is a video;
 * - a view pick is kept apart: never in the AI's status / drive_read, 「つなぐ」's list, a link — nor usable by another
 *   member, another Google account, or as an ordinary pick;
 * - it lasts 90 days since its last play (each play renews it), and goes with the member, the grant or the switch;
 * - the other purposes are unchanged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { runInNewContext } from 'vm'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeGoogle, type FakeGoogle } from '../fakes/google/fake-google'
import { defaultGoogleSeed, GOOGLE_SEED } from '../fakes/google/seed'
import { DRIVE_PICKABLE_MIMES, DRIVE_VIEW_MIMES, DRIVE_VIEW_PICK_TTL_MS } from '../../shared/core/google-drive'

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
const CO = 'drive-view-co'
const PUBLIC = 'http://localhost:13006'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-driveviewclient.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-driveview-0123456789'
const PICKER_KEY = 'fake-picker-key-NOT-REAL-0123456789abcd'
const APP_ID = '123456789012'
const VIDEO = 'fake-video-lesson-0001'
const OTHER_VIDEO = 'fake-video-other-0002'
const VIEW_TITLE = '資料が、この動画を選ぶよう求めています。動画のときだけ［選択］を押してください。'
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, db: any, services: any
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
const member = (userId: string) => ({ companyId: CO, userId, role: 'member' })
const viewRows = () => db.prepare('SELECT * FROM google_drive_view_picks WHERE company_id = ? ORDER BY user_id, file_id').all(CO) as Json[]
const pickRows = (fileId: string) => db.prepare('SELECT * FROM google_drive_picks WHERE company_id = ? AND file_id = ?').all(CO, fileId) as Json[]
const clearViews = () => db.prepare('DELETE FROM google_drive_view_picks').run()

async function tokenFor(user: string, scope: 'read' | 'act'): Promise<string> {
  const r = await call({ user, method: 'POST', path: `${C}/me/record-tokens`, body: { conversationId: 'conv-drive-view', agent: 'claude-code', scope } })
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

/** A pick through a ticket as the page makes it: the config it got, the result's answer and the state the app reads. */
async function pickThroughTicket(user: string, start: Record<string, unknown>, ids: string[]) {
  const t = await person(user, 'POST', '/me/google/drive/pick-tickets', start)
  expect(t.status, t.text).toBe(200)
  const cfg = await page('config', { ticket: t.body.data.ticket })
  expect(cfg.status, cfg.text).toBe(200)
  const result = await page('result', { ticket: t.body.data.ticket, mode: start.mode, action: 'picked', ids })
  const state = await person(user, 'GET', `/me/google/drive/pick-tickets/${t.body.data.ticketId}`)
  const row = db.prepare('SELECT purpose, max_items, file_ids FROM google_drive_pick_tickets WHERE id = ?').get(t.body.data.ticketId) as Json
  await person(user, 'DELETE', `/me/google/drive/pick-tickets/${t.body.data.ticketId}`)
  return { cfg: cfg.body.data, result, state: state.body.data, row }
}
const viewOf = (user: string, fileId: string, ids: string[] = [fileId]) => pickThroughTicket(user, { mode: 'files', purpose: 'view', fileIds: [fileId] }, ids)

beforeAll(async () => {
  const seed = defaultGoogleSeed()
  const video = (id: string, name: string) => ({
    id, name, mimeType: 'video/mp4', owner: GOOGLE_SEED.member, readers: [GOOGLE_SEED.member, GOOGLE_SEED.colleague], content: 'fake mp4',
    permissions: [{ type: 'user' as const, role: 'owner', emailAddress: GOOGLE_SEED.member }],
  })
  seed.driveFiles = [...(seed.driveFiles ?? []), video(VIDEO, '研修動画.mp4'), video(OTHER_VIDEO, '別の動画.mp4')]
  google = createFakeGoogle({ seed })
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  googleServer = serve({ fetch: google.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  kekDir = mkdtempSync(join(tmpdir(), 'acb-drive-view-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
  })
  for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
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
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`mv-${u}`, u, CO, role, ts(), ts())
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
  // What the member pressed 「選択」 on in Google's Picker (Google's own drive.file grant: ACB cannot take it back).
  google.pick(CLIENT_ID, GOOGLE_SEED.member, [VIDEO, OTHER_VIDEO, GOOGLE_SEED.handNotesPdf])
  google.pick(CLIENT_ID, GOOGLE_SEED.colleague, [VIDEO])
})

afterAll(async () => {
  google.close()
  await new Promise(r => googleServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL']) delete process.env[k]
})

describe('the view ticket', () => {
  it('needs files mode and exactly one Drive id, and is bound to it; it never becomes another purpose', async () => {
    for (const body of [
      { mode: 'files', purpose: 'view' },
      { mode: 'files', purpose: 'view', fileIds: [] },
      { mode: 'files', purpose: 'view', fileIds: [VIDEO, OTHER_VIDEO] },
      { mode: 'files', purpose: 'view', fileIds: ['bad id!'] },
      { mode: 'files', purpose: 'view', fileIds: VIDEO },
      { mode: 'files', purpose: 'view', fileIds: [VIDEO, 'bad id!'] },
      { mode: 'folder', purpose: 'view', fileIds: [VIDEO] },
    ]) {
      const r = await person('m-sato', 'POST', '/me/google/drive/pick-tickets', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM google_drive_pick_tickets WHERE company_id = ?").get(CO).n).toBe(0)
    const ok = await person('m-sato', 'POST', '/me/google/drive/pick-tickets', { mode: 'files', purpose: 'view', fileIds: [VIDEO] })
    expect(ok.status, ok.text).toBe(200)
    const row = db.prepare('SELECT purpose, mode, max_items, file_ids FROM google_drive_pick_tickets WHERE id = ?').get(ok.body.data.ticketId) as Json
    expect(row).toEqual({ purpose: 'view', mode: 'files', max_items: 1, file_ids: JSON.stringify([VIDEO]) })
    await person('m-sato', 'DELETE', `/me/google/drive/pick-tickets/${ok.body.data.ticketId}`)
  })

  it('is the member\'s session only, with the Drive switch on (the existing checks hold)', async () => {
    const token = await tokenFor('m-sato', 'act')
    // A record token never reaches the session route (401: no session).
    expect((await call({ token, method: 'POST', path: `${C}/me/google/drive/pick-tickets`, body: { mode: 'files', purpose: 'view', fileIds: [VIDEO] } })).status).toBe(401)
    expect((await person('m-sato', 'PUT', '/me/google/features', { feature: 'drive', on: false })).status).toBe(200)
    try {
      const off = await person('m-sato', 'POST', '/me/google/drive/pick-tickets', { mode: 'files', purpose: 'view', fileIds: [VIDEO] })
      expect(off.body.code).toBe('GOOGLE_FEATURE_OFF')
    } finally {
      expect((await person('m-sato', 'PUT', '/me/google/features', { feature: 'drive', on: true })).status).toBe(200)
    }
  })

  it('its config lists only the video types, for the one bound file', async () => {
    const t = await person('m-sato', 'POST', '/me/google/drive/pick-tickets', { mode: 'files', purpose: 'view', fileIds: [VIDEO] })
    const cfg = (await page('config', { ticket: t.body.data.ticket })).body.data
    expect(cfg).toMatchObject({ mode: 'files', purpose: 'view', maxItems: 1, fileIds: [VIDEO], mimeTypes: [...DRIVE_VIEW_MIMES] })
    expect(cfg.mimeTypes.every((m: string) => m.startsWith('video/'))).toBe(true)
    await page('result', { ticket: t.body.data.ticket, action: 'cancel' })
    await person('m-sato', 'DELETE', `/me/google/drive/pick-tickets/${t.body.data.ticketId}`)
  })
})

describe('the view result', () => {
  it('the bound video picked: kept as a view pick of that member and Google account — never as a pick', async () => {
    clearViews()
    const r = await viewOf('m-sato', VIDEO)
    expect(r.result.body.data).toMatchObject({ state: 'picked', kept: 1, refused: 0 })
    expect(r.state.picks).toEqual([expect.objectContaining({ id: VIDEO, mimeType: 'video/mp4' })])
    expect(viewRows()).toEqual([expect.objectContaining({ user_id: 'm-sato', account_email: GOOGLE_SEED.member.toLowerCase(), file_id: VIDEO, mime_type: 'video/mp4', last_viewed_at: null })])
    const kept = viewRows()[0]
    expect(Date.parse(kept.expires_at) - Date.parse(kept.picked_at)).toBeGreaterThan(DRIVE_VIEW_PICK_TTL_MS - 60_000)
    expect(pickRows(VIDEO)).toEqual([])
  })

  it('another id than the bound one is refused (not-requested) before Google is asked; nothing usable is kept', async () => {
    clearViews()
    const asked = google.requests.length
    const r = await viewOf('m-sato', VIDEO, [OTHER_VIDEO])
    expect(r.result.body.data).toMatchObject({ state: 'picked', kept: 0, refused: 1 })
    expect(r.state.refusedWhy).toEqual({ 'not-requested': 1 })
    expect(r.result.body.data.message).toContain('資料が求めた動画とは違う')
    expect(viewRows()).toEqual([])
    expect(pickRows(OTHER_VIDEO)).toEqual([])
    expect(google.requests.slice(asked).some(r => r.path.includes(OTHER_VIDEO))).toBe(false)
  })

  it('a file that is not a video is refused (not-video), even when the document asked for exactly it', async () => {
    clearViews()
    const r = await viewOf('m-sato', GOOGLE_SEED.handNotesPdf)
    expect(r.result.body.data).toMatchObject({ state: 'picked', kept: 0, refused: 1 })
    expect(r.state.refusedWhy).toEqual({ 'not-video': 1 })
    expect(r.result.body.data.message).toContain('動画ではない')
    expect(viewRows()).toEqual([])
    expect(pickRows(GOOGLE_SEED.handNotesPdf)).toEqual([])
  })

  it('never seen by the AI or 「つなぐ」: not in the status, not readable, not listed, not linkable', async () => {
    clearViews()
    await viewOf('m-sato', VIDEO)
    expect(viewRows()).toHaveLength(1)
    const token = await tokenFor('m-sato', 'read')
    const status = (await ai(token, 'GET', '/status')).body.data
    expect(status.picks.map((p: Json) => p.id)).not.toContain(VIDEO)
    expect(JSON.stringify(status)).not.toContain(VIDEO)
    const read = await ai(token, 'POST', '/read', { fileId: VIDEO })
    expect(read.status).toBe(403)
    expect(read.body.code).toBe('DRIVE_NOT_PICKED')
    const files = (await person('m-sato', 'GET', '/me/google/drive/files')).body.data.files as Json[]
    expect(files.map(f => f.id)).not.toContain(VIDEO)
    const made = await person('m-sato', 'POST', '/records/item', { type: 'task', title: '動画をつなぐ', fields: { assignee: 'm-sato' } })
    const linked = await person('m-sato', 'POST', `/records/item/${made.body.data.record.id}/file-links`, { target: { kind: 'drive', fileId: VIDEO }, expectedVersion: 1 })
    expect(linked.status).toBe(403)
    expect(linked.body.code).toBe('DRIVE_NOT_PICKED')
    // Another member sees nothing of it either.
    const tanaka = await tokenFor('m-tanaka', 'read')
    expect(JSON.stringify((await ai(tanaka, 'GET', '/status')).body.data)).not.toContain(VIDEO)
  })
})

describe('using a view pick (what the later streaming route calls)', () => {
  it('the member\'s own live view pick: usable, and each use renews it (last viewed now, 90 days more)', async () => {
    clearViews()
    await viewOf('m-sato', VIDEO)
    // Picked 80 days ago, never played: still usable, and the play moves its end 90 days from now.
    const old = new Date(Date.now() - 80 * 86_400_000).toISOString()
    db.prepare('UPDATE google_drive_view_picks SET picked_at = ?, expires_at = ? WHERE company_id = ?').run(old, new Date(Date.now() + 10 * 86_400_000).toISOString(), CO)
    const used = await services.googleDrive.useViewPick(member('m-sato'), VIDEO)
    expect(used.ok, JSON.stringify(used)).toBe(true)
    expect(used.value).toMatchObject({ fileId: VIDEO, mimeType: 'video/mp4', name: '研修動画.mp4' })
    const row = viewRows()[0]
    expect(row.last_viewed_at).not.toBeNull()
    expect(Date.now() - Date.parse(row.last_viewed_at)).toBeLessThan(60_000)
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now() + DRIVE_VIEW_PICK_TTL_MS - 60_000)
  })

  it('another member, another Google account, an expired one or an ordinary pick: not usable', async () => {
    clearViews()
    await viewOf('m-sato', VIDEO)
    const refused = async (userId: string) => {
      const r = await services.googleDrive.useViewPick(member(userId), VIDEO)
      expect(r.ok).toBe(false)
      return r.body.code
    }
    expect(await refused('m-tanaka')).toBe('DRIVE_VIEW_NOT_PICKED')
    // Another member's row never counts, even under the Google account this member's grant has.
    db.prepare('UPDATE google_drive_view_picks SET account_email = ? WHERE company_id = ?').run(GOOGLE_SEED.colleague.toLowerCase(), CO)
    expect(await refused('m-tanaka')).toBe('DRIVE_VIEW_NOT_PICKED')
    // The member's grant is now another Google account: the pick made under the first one does not count.
    db.prepare('UPDATE google_drive_view_picks SET account_email = ? WHERE company_id = ?').run('someone-else@div.example', CO)
    expect(await refused('m-sato')).toBe('DRIVE_VIEW_NOT_PICKED')
    db.prepare('UPDATE google_drive_view_picks SET account_email = ? WHERE company_id = ?').run(GOOGLE_SEED.member.toLowerCase(), CO)
    // 90 days without a play: over (and the sweep removes it).
    db.prepare('UPDATE google_drive_view_picks SET expires_at = ? WHERE company_id = ?').run(new Date(Date.now() - 1000).toISOString(), CO)
    expect(await refused('m-sato')).toBe('DRIVE_VIEW_NOT_PICKED')
    services.googleDrive.sweep(CO)
    expect(viewRows()).toEqual([])
    // An ordinary pick of the same video (the AI's or 「つなぐ」's) is never a view pick.
    db.prepare('INSERT OR REPLACE INTO google_drive_picks (company_id, user_id, file_id, kind, name, mime_type, picked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(CO, 'm-tanaka', VIDEO, 'file', '研修動画.mp4', 'video/mp4', ts(), new Date(Date.now() + 86_400_000).toISOString())
    expect(await refused('m-tanaka')).toBe('DRIVE_VIEW_NOT_PICKED')
    db.prepare('DELETE FROM google_drive_picks WHERE company_id = ? AND file_id = ?').run(CO, VIDEO)
  })

  it('not while the Drive switch is off or Google is stopped for the company; a member who leaves loses them', async () => {
    clearViews()
    await viewOf('m-sato', VIDEO)
    expect((await person('m-sato', 'PUT', '/me/google/features', { feature: 'drive', on: false })).status).toBe(200)
    try {
      expect((await services.googleDrive.useViewPick(member('m-sato'), VIDEO)).body.code).toBe('GOOGLE_FEATURE_OFF')
    } finally {
      expect((await person('m-sato', 'PUT', '/me/google/features', { feature: 'drive', on: true })).status).toBe(200)
    }
    expect((await person('m-owner', 'PUT', '/google/enabled', { enabled: false })).status).toBe(200)
    try {
      expect((await services.googleDrive.useViewPick(member('m-sato'), VIDEO)).body.code).toBe('GOOGLE_STOPPED')
    } finally {
      expect((await person('m-owner', 'PUT', '/google/enabled', { enabled: true })).status).toBe(200)
    }
    expect((await services.googleDrive.useViewPick(member('m-sato'), VIDEO)).ok).toBe(true)
    const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
    sqliteCompanyData(db).forCompany(CO).googleDrive.forgetMember('m-sato')
    expect(viewRows()).toEqual([])
  })
})

describe('the other purposes are unchanged', () => {
  it('reading and linking keep their types, maxima and storage', async () => {
    const read = await pickThroughTicket('m-sato', { mode: 'files' }, [GOOGLE_SEED.handNotesPdf])
    expect(read.cfg).toMatchObject({ purpose: 'read', mimeTypes: [...DRIVE_PICKABLE_MIMES], maxItems: 10 })
    expect(read.row).toMatchObject({ purpose: 'read', max_items: 10 })
    expect(pickRows(GOOGLE_SEED.handNotesPdf)).toHaveLength(1)
    const link = await pickThroughTicket('m-sato', { mode: 'files', purpose: 'link' }, [VIDEO])
    expect(link.cfg).toMatchObject({ purpose: 'link', mimeTypes: [], maxItems: 10 })
    expect(link.result.body.data).toMatchObject({ kept: 1 })
    expect(pickRows(VIDEO)).toHaveLength(1)
    const folder = await pickThroughTicket('m-sato', { mode: 'folder' }, [GOOGLE_SEED.proposalsFolder])
    expect(folder.row).toMatchObject({ purpose: 'read', max_items: 1 })
    db.prepare('DELETE FROM google_drive_picks WHERE company_id = ?').run(CO)
  })
})

describe('the Picker page for a view pick', () => {
  /** Runs the page's script with the given config against a stand-in Picker that records each call. */
  async function runPage(config: Record<string, unknown>, answer?: { action: string; docs: Array<{ id: string }> }) {
    const r = await call({ method: 'GET', path: '/api/google-picker' })
    const script = /<script>([\s\S]*)<\/script>/.exec(r.text)![1]
    const calls: Array<[string, unknown]> = []
    const posted: Json[] = []
    const msg = { textContent: '' }
    function DocsView() {
      const view: Record<string, unknown> = {}
      for (const m of ['setMimeTypes', 'setIncludeFolders', 'setSelectFolderEnabled', 'setEnableDrives', 'setFileIds', 'setParent', 'setLabel', 'setOwnedByMe']) {
        view[m] = (v: unknown) => { calls.push([m, v]); return view }
      }
      return view
    }
    let callback: (data: unknown) => void = () => {}
    const builder: Record<string, unknown> = {}
    for (const m of ['addView', 'setOAuthToken', 'setDeveloperKey', 'setAppId', 'setOrigin', 'setLocale', 'setMaxItems', 'setAuthUser']) builder[m] = () => builder
    builder.setTitle = (t: unknown) => { calls.push(['title', t]); return builder }
    builder.enableFeature = (f: unknown) => { calls.push(['feature', f]); return builder }
    builder.setSelectableMimeTypes = (t: unknown) => { calls.push(['selectable', t]); return builder }
    builder.setCallback = (f: (data: unknown) => void) => { callback = f; return builder }
    builder.build = () => ({ setVisible: () => { calls.push(['visible', true]); if (answer) callback(answer) } })
    const window: Record<string, unknown> = {
      location: { origin: PUBLIC, pathname: '/api/google-picker', hash: `#t=${'a'.repeat(64)}` },
      history: { replaceState: () => {} },
      addEventListener: () => {},
      fetch: async (path: string, init: { body: string }) => {
        const body = JSON.parse(init.body)
        posted.push({ path, body })
        if (path.endsWith('/config')) return new Response(JSON.stringify({ success: true, data: config }), { status: 200 })
        return new Response(JSON.stringify({ success: true, data: { state: 'picked', kept: 1, refused: 0 } }), { status: 200 })
      },
      gapi: { load: (_n: string, o: { callback: () => void }) => o.callback() },
      google: { picker: { DocsView, PickerBuilder: function () { return builder }, ViewId: { DOCS: 'docs', FOLDERS: 'folders' }, Action: { PICKED: 'picked', CANCEL: 'cancel' }, Feature: { MULTISELECT_ENABLED: 'multi' } } },
    }
    const document = { getElementById: () => msg, createElement: () => ({}), head: { appendChild: (el: { onload: () => void }) => { el.onload() } } }
    runInNewContext(script, { window, document })
    for (let i = 0; i < 100 && !calls.some(c => c[0] === 'visible') && !/アプリに戻って/.test(msg.textContent); i++) await new Promise(res => setTimeout(res, 10))
    for (let i = 0; i < 20 && answer && !posted.some(p => p.path.endsWith('/result')); i++) await new Promise(res => setTimeout(res, 10))
    return { calls, posted, msg: () => msg.textContent }
  }
  const base = { accessToken: 't', apiKey: 'k', appId: APP_ID, scriptOrigin: 'https://apis.google.com', mode: 'files', maxItems: 1 }

  it('shows just the bound file, filtered and selectable as video only, under ACB\'s own title; no multi-select', async () => {
    const run = await runPage({ ...base, purpose: 'view', mimeTypes: [...DRIVE_VIEW_MIMES], fileIds: [VIDEO] })
    expect(run.calls).toContainEqual(['setFileIds', VIDEO])
    expect(run.calls).toContainEqual(['setMimeTypes', DRIVE_VIEW_MIMES.join(',')])
    expect(run.calls).toContainEqual(['selectable', DRIVE_VIEW_MIMES.join(',')])
    expect(run.calls).toContainEqual(['title', VIEW_TITLE])
    expect(run.calls.map(c => c[0])).not.toContain('feature')
    expect(run.calls.map(c => c[0])).not.toContain('setEnableDrives')
    expect(run.msg()).toContain(VIEW_TITLE)
    expect(run.msg()).not.toContain('AI が、このファイル')
    // A reading pick narrowed to an id is still the AI's warning, with no selectable filter (unchanged).
    const reading = await runPage({ ...base, purpose: 'read', mimeTypes: ['application/pdf'], fileIds: [VIDEO], maxItems: 10 })
    expect(reading.calls.map(c => c[0])).not.toContain('selectable')
    expect(reading.calls).toContainEqual(['title', 'AI が、このファイルを選ぶよう求めています。中身に覚えがなければ選ばないでください。'])
  })

  it('never opens the whole Drive for a view pick without its one file; sends only the bound id', async () => {
    const none = await runPage({ ...base, purpose: 'view', mimeTypes: [...DRIVE_VIEW_MIMES] })
    expect(none.calls.map(c => c[0])).not.toContain('visible')
    expect(none.posted.filter(p => p.path.endsWith('/result')).map(p => p.body.action)).toEqual(['cancel'])
    const other = await runPage({ ...base, purpose: 'view', mimeTypes: [...DRIVE_VIEW_MIMES], fileIds: [VIDEO] }, { action: 'picked', docs: [{ id: OTHER_VIDEO }] })
    expect(other.posted.filter(p => p.path.endsWith('/result')).map(p => p.body.action)).toEqual(['cancel'])
  })
})
