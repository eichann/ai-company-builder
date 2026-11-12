/**
 * Integration Test: a scheduled job's deliverable place outside ACB (jobs.md "A deliverable place outside",
 * google-drive.md) against the fake Google behind the practice redirect. The job names `{ connector: 'google',
 * kind: 'drive_folder', ref: null }`; its responsible person picks the folder (their own `drive.file` pick)
 * when accepting; the run's token may put only into that folder; the finish links what it put to its やること.
 *
 * Guards (each mutation-checked, listed in jobs.md "Tests"):
 * - accepting: a version naming a place needs one (`JOB_PLACE_NEEDED`), of its connector and kind (400), that is
 *   the responsible person's own live pick (`JOB_PLACE_NOT_USABLE`: someone else's pick, a file, none); a
 *   version naming none takes none; the folder's name only to the responsible person;
 * - the run's token: the place's routes only with a place (no place → `NOT_IN_STEP`), never a read; a put only into
 *   the chosen folder (`DRIVE_FOLDER_NOT_GRANTED`, nothing uploaded), its status shows only that folder; a pause
 *   refuses the next call; a body's `recordId` is never linked from a run;
 * - the finish links the run's puts to its やること (receipt facts), never another run's;
 * - the 90-day pick: past it, the claim sends the occurrence to a person (`needs_person` `PLACE_NOT_USABLE`, told),
 *   and so does the clock at the slot; choosing it again with 「受け取る」 makes the next one runnable.
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

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const EMAILS: Record<string, string> = { 'jd-owner': 'owner@div.example', 'jd-alice': GOOGLE_SEED.member, 'jd-bob': GOOGLE_SEED.colleague }
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
const PUBLIC = 'http://localhost:13005'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-jobdrive.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-jobdrive-0123456789'
const PLACE = { connector: 'google', kind: 'drive_folder' } as const
const FOLDER = GOOGLE_SEED.proposalsFolder
const OTHER_FOLDER = GOOGLE_SEED.sharedOutsideFolder
const DAY = 24 * 60 * 60_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, db: any, services: any, createJobOccurrences: any
let google: FakeGoogle
let googleServer: ServerType
let kekDir: string
let CO = ''

async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown; headers?: Record<string, string> }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res: Response = await app.request(`${PUBLIC}${opts.path}`, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  const text = await res.text()
  let body: Json = null
  try { body = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body, text }
}
const as = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `/api/companies/${CO}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown) =>
  call({ token, method, path: `/api/records-ai${path}`, body, headers: method === 'GET' ? {} : { 'Idempotency-Key': `idem-${randomBytes(8).toString('hex')}` } })
const alice = () => ({ companyId: CO, userId: 'jd-alice', role: 'member' })
const owner = () => ({ companyId: CO, userId: 'jd-owner', role: 'owner' })

const MD = Buffer.from('# 面談報告書\n\n- 要点\n')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const putBody = (over: Record<string, unknown> = {}) => ({
  folderId: FOLDER, name: '面談報告書.md', kind: 'markdown', as: 'google_doc', sha256: sha(MD), contentBase64: MD.toString('base64'),
  requestKey: `key-${randomBytes(6).toString('hex')}`, ...over,
})

async function allow(user: string) {
  google.signIn({ email: EMAILS[user] })
  const r = await as(user, 'POST', '/me/google/connect', { features: ['drive'] })
  expect(r.status, r.text).toBe(200)
  const res = await fetch(r.body.data.authorizeUrl, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  expect((await call({ method: 'GET', path: `/api/oauth/google/callback${back.search}` })).status).toBe(200)
}
async function pickFolder(user: string, id: string) {
  google.pick(CLIENT_ID, EMAILS[user], [id])
  const r = await as(user, 'POST', '/me/google/drive/picks', { mode: 'folder', ids: [id] })
  expect(r.body.data.picks, r.text).toHaveLength(1)
}

function skill(): string {
  const current = (db.prepare("SELECT current_version FROM shelf_items WHERE company_id = ? AND name = 'interview-report'").get(CO) as Json)?.current_version ?? null
  const r = services.skillShelf.publish(owner(), { kind: 'skill', departmentId: null, name: 'interview-report', files: [{ path: 'SKILL.md', base64: Buffer.from('# 面談報告書\n').toString('base64') }], expectedVersion: current })
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value.item.id
}
function definition(item: string, grant: Record<string, unknown> = {}): Json {
  return {
    schema: 1, name: '面談報告書の下書き（A社）', actingUser: 'jd-alice',
    trigger: { every: 'day', at: '09:00', businessDaysOnly: false },
    check: { kind: 'new_meetings', titleWords: [] },
    run: { kind: 'procedure', procedure: { source: 'shelf_skill', item } },
    placement: 'a', missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: {
      tools: ['records', 'files_write'], creates: ['task'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] },
      writes: { area: 'deliverable', place: '人事部', folder: 'reports' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 },
      deliverTo: { ...PLACE, ref: null }, ...grant,
    },
  }
}
/** The same job without a place outside (the grant has no `deliverTo` key at all). */
function withoutPlace(item: string): Json {
  const d = definition(item)
  delete d.grant.deliverTo
  return d
}
async function approvedJob(grant: Record<string, unknown> = {}): Promise<string> {
  const made = await services.jobs.create(owner(), { definition: definition(skill(), grant) })
  if (!made.ok) throw new Error(JSON.stringify(made.body))
  expect((await services.jobs.approve(owner(), made.value.id, { version: 1 })).ok).toBe(true)
  return made.value.id
}
let slot = 0
function dueOccurrence(job: string): string {
  const id = `occ.${(0xd000 + ++slot).toString(16).padStart(32, '0')}`
  const now = Date.now()
  db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, 'Asia/Tokyo', ?, ?, 'due', ?, ?)`).run(CO, id, job, `2026-10-${String(1 + slot).padStart(2, '0')}T09:00`,
    new Date(now - 60_000).toISOString(), new Date(now + DAY).toISOString(), new Date(now).toISOString(), new Date(now).toISOString())
  return id
}
const claim = (occurrenceId: string) =>
  as('jd-alice', 'POST', '/job-run-claims', { occurrenceId, deviceId: 'device-alice', conversationId: 'conv-job', checks: ['new_files', 'new_meetings'] })
async function runToken(run: Json): Promise<string> {
  const r = await as('jd-alice', 'POST', '/me/record-tokens', { conversationId: 'conv-job', agent: 'claude-code', scope: 'act', run: { id: run.id, generation: run.generation } })
  expect([200, 201], r.text).toContain(r.status)
  return r.body.data.token
}
const occOf = (id: string) => db.prepare('SELECT state, outcome_code FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, id) as Json
const expirePicks = () => db.prepare("UPDATE google_drive_picks SET expires_at = ? WHERE company_id = ? AND user_id = 'jd-alice' AND kind = 'folder'").run(new Date(Date.now() - 1000).toISOString(), CO)

beforeAll(async () => {
  google = createFakeGoogle()
  google.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  googleServer = serve({ fetch: google.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  kekDir = mkdtempSync(join(tmpdir(), 'acb-jobdrive-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PUBLIC_URL: PUBLIC, ACB_ALLOW_FAKE_UPSTREAMS: '1', OPERATOR_USER_IDS: 'jd-owner',
    ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${(googleServer.address() as AddressInfo).port}`,
  })
  for (const level of ['log', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  createJobOccurrences = (await import('../../src/services/job-occurrences')).createJobOccurrences
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies', (await import('../../src/routes/companies')).companiesRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/ai-runs')).aiRunsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/jobs')).jobsRoute)
  const drive = await import('../../src/routes/google-drive')
  app.route('/api/companies/:companyId', drive.googleDriveRoute)
  app.route('/api/records-ai/google/drive', drive.googleDriveAiRoute)
  app.route('/api/records-ai', (await import('../../src/routes/records-ai')).recordsAiRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)

  const made = await call({ user: 'jd-owner', method: 'POST', path: '/api/companies', body: { name: 'Job Drive Co', folderKind: 'none' } })
  expect(made.status, made.text).toBe(201)
  CO = made.body.data.id
  const at = new Date().toISOString()
  for (const [user, role] of [['jd-alice', 'member'], ['jd-bob', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${user}`, user, CO, role, at, at)
  }
  expect((await as('jd-owner', 'PUT', '/google/client', { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
  expect((await as('jd-owner', 'PUT', '/google/picker', { apiKey: 'fake-picker-key-NOT-REAL-0123456789abcd', appId: '123456789012' })).status).toBe(200)
  await allow('jd-alice')
  await pickFolder('jd-alice', FOLDER)
  await pickFolder('jd-alice', OTHER_FOLDER)
})

afterAll(async () => {
  vi.useRealTimers()
  google.close()
  await new Promise(r => googleServer.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL', 'OPERATOR_USER_IDS']) delete process.env[k]
})

describe('accepting a job that puts into a place outside', () => {
  it('needs the place: of its connector and kind, the responsible person\'s own live pick; the name only to them', async () => {
    const job = await approvedJob()
    expect((await services.jobs.accept(alice(), job, { version: 1 })).body.code).toBe('JOB_PLACE_NEEDED')
    expect((await services.jobs.accept(alice(), job, { version: 1, place: { connector: 'google', kind: 'drive_file', ref: FOLDER } })).body.code).toBe('BAD_REQUEST')
    expect((await services.jobs.accept(alice(), job, { version: 1, place: { connector: 'onedrive', kind: 'drive_folder', ref: FOLDER } })).body.code).toBe('BAD_REQUEST')
    // Not her pick: a folder she never picked, a picked file, a folder only someone else picked.
    expect((await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: 'fake-folder-not-picked-0001' } })).body.code).toBe('JOB_PLACE_NOT_USABLE')
    db.prepare('INSERT INTO google_drive_picks (company_id, user_id, file_id, kind, name, mime_type, picked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(CO, 'jd-bob', 'fake-folder-bobs-only-0001', 'folder', '田中さんのフォルダ', 'application/vnd.google-apps.folder', new Date().toISOString(), new Date(Date.now() + DAY).toISOString())
    expect((await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: 'fake-folder-bobs-only-0001' } })).body.code).toBe('JOB_PLACE_NOT_USABLE')
    // A file she picked is not a folder.
    google.pick(CLIENT_ID, EMAILS['jd-alice'], [GOOGLE_SEED.pastProposalDoc])
    expect((await as('jd-alice', 'POST', '/me/google/drive/picks', { mode: 'files', ids: [GOOGLE_SEED.pastProposalDoc] })).body.data.picks).toHaveLength(1)
    expect((await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: GOOGLE_SEED.pastProposalDoc } })).body.code).toBe('JOB_PLACE_NOT_USABLE')
    expect((await services.jobs.get(alice(), job)).value.accepted).toBe(false)
    // The acceptance notice says the place is chosen there (an older app cannot: it says to update).
    expect(services.jobs.acceptNotice(alice(), job, 1)).toMatchObject({ choosesPlace: true })
    const ok = await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })
    expect(ok.ok, JSON.stringify(ok.body)).toBe(true)
    expect(ok.value.deliverTo).toMatchObject({ ...PLACE, label: 'Google Drive のフォルダ', chosen: true, usable: true, name: '提案書' })
    // An owner sees that a place was chosen and is usable, never its name.
    const seen = (await services.jobs.get(owner(), job)).value
    expect(seen.deliverTo).toMatchObject({ chosen: true, usable: true, name: null, expiresAt: null })
    expect(JSON.stringify(seen)).not.toContain('提案書')
    // A version naming no place takes none.
    const plain = await services.jobs.create(owner(), { definition: withoutPlace(skill()) })
    expect(plain.ok, JSON.stringify(plain.body)).toBe(true)
    await services.jobs.approve(owner(), plain.value.id, { version: 1 })
    expect((await services.jobs.accept(alice(), plain.value.id, { version: 1, place: { ...PLACE, ref: FOLDER } })).body.code).toBe('BAD_REQUEST')
  })
})

describe('the run puts only into the folder chosen', () => {
  it('the claim names the place; its token reaches the place\'s routes only, puts there only, and never reads', async () => {
    const job = await approvedJob()
    expect((await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })).ok).toBe(true)
    const occ = dueOccurrence(job)
    const c = await claim(occ)
    expect(c.status, c.text).toBe(201)
    expect(c.body.data.turn.deliverTo).toEqual({ ...PLACE, ref: FOLDER })
    const token = await runToken(c.body.data.run)
    // Its status shows only its folder.
    const status = await ai(token, 'GET', '/google/drive/status')
    expect(status.status, status.text).toBe(200)
    expect(status.body.data.picks.map((p: Json) => p.id)).toEqual([FOLDER])
    // Another folder she picked: refused before anything is sent.
    const uploads = google.uploads().length
    const other = await ai(token, 'POST', '/google/drive/put', putBody({ folderId: OTHER_FOLDER }))
    expect([other.status, other.body.code]).toEqual([403, 'DRIVE_FOLDER_NOT_GRANTED'])
    expect(google.uploads()).toHaveLength(uploads)
    // Never a read of her picked files.
    expect((await ai(token, 'POST', '/google/drive/read', { fileId: GOOGLE_SEED.pastProposalDoc })).body.code).toBe('NOT_IN_STEP')
    // Into its folder: done, a Google document; a recordId in the body is never linked from a run.
    const task = await as('jd-alice', 'POST', '/records/item', { type: 'task', title: '関係ないやること', fields: { assignee: 'jd-alice' } })
    const put = await ai(token, 'POST', '/google/drive/put', { ...putBody(), recordId: task.body.data.record.id })
    expect(put.status, put.text).toBe(200)
    expect(put.body.data.drivePut).toMatchObject({ state: 'done', mimeType: 'application/vnd.google-apps.document', folderId: FOLDER })
    expect(put.body.data.linkedTo).toBeUndefined()
    expect((await ai(token, 'GET', `/google/drive/puts/${put.body.data.drivePut.id}`)).status).toBe(200)
    // The finish makes the やること and links what the run put to it (from the receipt).
    const run = c.body.data.run
    const fin = await as('jd-alice', 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, outcome: 'done', jobResult: { title: '面談報告書の下書きができました' } })
    expect(fin.status, fin.text).toBe(200)
    const { occurrenceTaskId } = await import('../../../shared/core/jobs')
    const item = await as('jd-alice', 'GET', `/records/item/${occurrenceTaskId(occ)}`)
    expect(item.status, item.text).toBe(200)
    expect((item.body.data.links as Json[]).filter(l => l.drive).map(l => l.drive)).toEqual([
      expect.objectContaining({ fileId: put.body.data.drivePut.fileId, mine: true, revisionId: 'version:1', sha256: sha(MD) }),
    ])
    expect(((await as('jd-alice', 'GET', `/records/item/${task.body.data.record.id}`)).body.data.links as Json[]).filter(l => l.drive)).toEqual([])
    // After the finish the token reaches nothing more.
    // (the run's token is fenced once the run ended: 409 from the token, before any route)
    expect([403, 409]).toContain((await ai(token, 'POST', '/google/drive/put', putBody())).status)
  })

  it('a job without a place: its run\'s token never reaches Drive; a pause refuses the next call', async () => {
    const plain = await services.jobs.create(owner(), { definition: withoutPlace(skill()) })
    const job = plain.value.id
    await services.jobs.approve(owner(), job, { version: 1 })
    expect((await services.jobs.accept(alice(), job, { version: 1 })).ok).toBe(true)
    const c = await claim(dueOccurrence(job))
    const token = await runToken(c.body.data.run)
    for (const [method, path, body] of [['GET', '/google/drive/status', undefined], ['POST', '/google/drive/put', putBody()]] as const) {
      expect((await ai(token, method, path, body)).body.code).toBe('NOT_IN_STEP')
    }
    // With a place, paused: the next call is refused.
    const placed = await approvedJob()
    await services.jobs.accept(alice(), placed, { version: 1, place: { ...PLACE, ref: FOLDER } })
    const c2 = await claim(dueOccurrence(placed))
    const t2 = await runToken(c2.body.data.run)
    expect((await ai(t2, 'GET', '/google/drive/status')).status).toBe(200)
    await services.jobs.pause(owner(), placed)
    const uploads = google.uploads().length
    expect([403, 409]).toContain((await ai(t2, 'POST', '/google/drive/put', putBody())).status)
    expect(google.uploads()).toHaveLength(uploads)
  })
})

describe('a folder pick past its 90 days (decision: never renewed by itself; a person chooses again)', () => {
  it('the claim sends the occurrence to a person and tells; choosing the folder again with 「受け取る」 makes the next one run', async () => {
    const job = await approvedJob()
    await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })
    expirePicks()
    try {
      expect((await services.jobs.get(alice(), job)).value.deliverTo).toMatchObject({ chosen: true, usable: false, name: null })
      const occ = dueOccurrence(job)
      expect((await as('jd-alice', 'GET', '/me/job-turns')).body.data.turns.map((t: Json) => t.occurrenceId)).not.toContain(occ)
      const c = await claim(occ)
      expect([c.status, c.body.code]).toEqual([409, 'JOB_PLACE_NOT_USABLE'])
      expect(occOf(occ)).toEqual({ state: 'needs_person', outcome_code: 'PLACE_NOT_USABLE' })
      const told = db.prepare("SELECT user_id FROM notifications WHERE company_id = ? AND kind = 'job_failed' AND dedupe_key LIKE ?").all(CO, `%${occ}%`) as Json[]
      expect(told.map(n => n.user_id).sort()).toEqual(['jd-alice', 'jd-owner'])
      // Re-accepting with the stale folder is refused; picking it again (the Picker) renews it.
      expect((await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })).body.code).toBe('JOB_PLACE_NOT_USABLE')
    } finally {
      await pickFolder('jd-alice', FOLDER)
    }
    expect((await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })).ok).toBe(true)
    expect((await claim(dueOccurrence(job))).status).toBe(201)
  })

  it('the clock: a slot whose place is no longer usable is made needs_person at once, and told', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
      const job = await approvedJob()
      await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })
      vi.setSystemTime(new Date('2026-11-21T01:00:00.000Z'))
      const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
      const { sqliteTransactions } = await import('../../src/adapters/sqlite/transactions')
      const { sqliteMembershipRepository } = await import('../../src/adapters/sqlite/memberships')
      const { randomIds } = await import('../../src/adapters/system')
      const occurrences = createJobOccurrences({
        companyData: sqliteCompanyData(db), transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
        timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf: (co: string, user: string) => sqliteMembershipRepository(db).roleOf(co, user),
        jobs: services.jobs, writer: { check: () => null, create: () => { throw new Error('unused') } }, log: () => {},
        placeUsable: (co: string, user: string, place: Json) => services.googleDrive.folderPlace(co, user, place.ref) !== null,
      })
      const made = () => db.prepare('SELECT state, outcome_code FROM ai_job_occurrences WHERE company_id = ? AND job_id = ?').all(CO, job) as Json[]
      // Usable: due, as before.
      occurrences.makeOccurrences(CO)
      expect(made()).toEqual([{ state: 'due', outcome_code: null }])
      db.prepare('DELETE FROM ai_job_occurrences WHERE company_id = ? AND job_id = ?').run(CO, job)
      expirePicks()
      occurrences.makeOccurrences(CO)
      expect(made()).toEqual([{ state: 'needs_person', outcome_code: 'PLACE_NOT_USABLE' }])
      const told = () => (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND kind = 'job_failed' AND dedupe_key LIKE ?").get(CO, `%${job}%`) as Json).n as number
      const once = told()
      expect(once).toBeGreaterThan(0)
      // The next slot, still not usable: made needs_person again, but nobody is told twice for the same cause.
      vi.setSystemTime(new Date('2026-11-22T01:00:00.000Z'))
      occurrences.makeOccurrences(CO)
      expect(made().map((o: Json) => o.outcome_code)).toEqual(['PLACE_NOT_USABLE', 'PLACE_NOT_USABLE'])
      expect(told()).toBe(once)
    } finally {
      vi.useRealTimers()
      await pickFolder('jd-alice', FOLDER)
    }
  })
})

describe('review fixes (#678): a run sees and changes only its own job\'s files in its folder', () => {
  const finishWith = (run: Json, title: string) => as('jd-alice', 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, outcome: 'done', jobResult: { title } })
  const driveLinksOf = async (recordId: string) => ((await as('jd-alice', 'GET', `/records/item/${recordId}`)).body.data.links as Json[]).filter(l => l.drive).map(l => l.drive.fileId)

  it('updates only what runs of the same job put; never a consultation\'s file in that folder', async () => {
    const job = await approvedJob()
    await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })
    // A consultation (no run) put a file into the same folder.
    const consultation = await (async () => {
      const r = await as('jd-alice', 'POST', '/me/record-tokens', { conversationId: 'conv-plain', agent: 'claude-code', scope: 'act' })
      return r.body.data.token as string
    })()
    const theirs = (await ai(consultation, 'POST', '/google/drive/put', putBody({ name: '相談の.md' }))).body.data.drivePut
    // The first run puts its report and finishes.
    const first = await claim(dueOccurrence(job))
    const t1 = await runToken(first.body.data.run)
    const mine = (await ai(t1, 'POST', '/google/drive/put', putBody({ name: '週の報告.md' }))).body.data.drivePut
    expect((await finishWith(first.body.data.run, '一回目')).status).toBe(200)
    // The next run: it sees and may update the first run's file, never the consultation's.
    const second = await claim(dueOccurrence(job))
    const t2 = await runToken(second.body.data.run)
    // Many newer puts of hers elsewhere never push the job's own file out of what it sees.
    const later = new Date(Date.now() + 60_000).toISOString()
    for (let i = 0; i < 35; i++) {
      db.prepare(`INSERT INTO google_drive_puts (id, company_id, user_id, request_key, actor_kind, conversation_id, run_id, folder_id, folder_name, name, mime_type, bytes, sha256, state,
        file_id, revision_id, link, reason, created_at, finished_at) VALUES (?, ?, 'jd-alice', ?, 'ai', NULL, NULL, 'fake-folder-elsewhere-0002', 'ほか', 'x.pdf', 'application/pdf', 1, ?, 'done',
        ?, 'rev-x', NULL, NULL, ?, ?)`).run(`drive-put-many-${i}`, CO, `key-many-${String(i).padStart(4, '0')}`, 'b'.repeat(64), `fake-upload-many-${String(i).padStart(4, '0')}`, later, later)
    }
    const listed = (await ai(t2, 'GET', '/google/drive/status')).body.data.puts.map((p: Json) => p.fileId)
    expect(listed).toContain(mine.fileId)
    expect(listed).not.toContain(theirs.fileId)
    const calls = google.requests.length
    const refused = await ai(t2, 'POST', '/google/drive/put', putBody({ name: '相談の.md', updateFileId: theirs.fileId, sha256: sha(Buffer.from('# x\n')), contentBase64: Buffer.from('# x\n').toString('base64') }))
    expect([refused.status, refused.body.code]).toEqual([403, 'DRIVE_FILE_NOT_THIS_JOB'])
    expect(google.requests.length).toBe(calls)
    // Another job of hers, into the same folder: never this job's file to update (nor listed for it).
    const other = await approvedJob()
    await services.jobs.accept(alice(), other, { version: 1, place: { ...PLACE, ref: FOLDER } })
    const otherRun = await claim(dueOccurrence(other))
    const t3 = await runToken(otherRun.body.data.run)
    expect((await ai(t3, 'GET', '/google/drive/status')).body.data.puts.map((p: Json) => p.fileId)).not.toContain(mine.fileId)
    const cross = await ai(t3, 'POST', '/google/drive/put', putBody({ name: '週の報告.md', updateFileId: mine.fileId, sha256: sha(Buffer.from('# y\n')), contentBase64: Buffer.from('# y\n').toString('base64') }))
    expect([cross.status, cross.body.code]).toEqual([403, 'DRIVE_FILE_NOT_THIS_JOB'])
    const next = Buffer.from('# 面談報告書（二回目）\n')
    const updated = await ai(t2, 'POST', '/google/drive/put', putBody({ name: '週の報告.md', updateFileId: mine.fileId, sha256: sha(next), contentBase64: next.toString('base64') }))
    expect(updated.body.data.drivePut, updated.text).toMatchObject({ state: 'done', fileId: mine.fileId, revisionId: 'version:2' })
  })

  it('a receipt of another folder is not there for a run (nothing answered, Google not asked)', async () => {
    const job = await approvedJob()
    await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })
    db.prepare(`INSERT INTO google_drive_puts (id, company_id, user_id, request_key, actor_kind, conversation_id, run_id, folder_id, folder_name, name, mime_type, bytes, sha256, state,
      file_id, revision_id, link, reason, created_at, finished_at) VALUES ('drive-put-elsewhere-0001', ?, 'jd-alice', 'key-elsewhere-01', 'ai', NULL, NULL, 'fake-folder-elsewhere-0001',
      '経理のフォルダ', '予算.pdf', 'application/pdf', 1, ?, 'unknown', NULL, NULL, NULL, 'answer-lost', ?, NULL)`).run(CO, 'a'.repeat(64), new Date().toISOString())
    const c = await claim(dueOccurrence(job))
    const token = await runToken(c.body.data.run)
    const calls = google.requests.length
    const r = await ai(token, 'GET', '/google/drive/puts/drive-put-elsewhere-0001')
    expect([r.status, r.body.code]).toEqual([404, 'DRIVE_PUT_NOT_FOUND'])
    expect(r.text).not.toContain('経理のフォルダ')
    expect(google.requests.length).toBe(calls)
  })

  it('a repeat of an earlier put (nothing uploaded again) is still linked to this run\'s やること; a pick that lapsed mid-run still links what was put', async () => {
    const job = await approvedJob()
    await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })
    const body = putBody({ name: '同じ報告.md' })
    const first = await claim(dueOccurrence(job))
    const t1 = await runToken(first.body.data.run)
    const put = (await ai(t1, 'POST', '/google/drive/put', body)).body.data.drivePut
    await finishWith(first.body.data.run, '一回目')
    const occ2 = dueOccurrence(job)
    const second = await claim(occ2)
    const t2 = await runToken(second.body.data.run)
    const uploads = google.uploads().length
    const again = await ai(t2, 'POST', '/google/drive/put', body)
    expect(again.body.data).toMatchObject({ existing: true, drivePut: { id: put.id } })
    expect(google.uploads()).toHaveLength(uploads)
    // The pick lapses before the finish: the work was done; what was put is linked.
    expirePicks()
    try {
      expect((await finishWith(second.body.data.run, '二回目')).status).toBe(200)
      const { occurrenceTaskId } = await import('../../../shared/core/jobs')
      expect(await driveLinksOf(occurrenceTaskId(occ2))).toEqual([put.fileId])
    } finally {
      await pickFolder('jd-alice', FOLDER)
    }
  })
})

describe('「もう一度」 after a run put a file (staging 2026-11-12: the retried run could not tell which Drive file it had made)', () => {
  /** Now fixed at 12:00 Tokyo no later than the real time (picks and Google's tokens were made then): the 09:00 slot is the newest. */
  function atNoon(): { noon: number; slot: string } {
    const real = Date.now()
    let noon = Date.parse(`${new Date(real + 9 * 3_600_000).toISOString().slice(0, 10)}T03:00:00.000Z`)
    if (noon > real) noon -= DAY
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(noon)
    return { noon, slot: `${new Date(noon + 9 * 3_600_000).toISOString().slice(0, 10)}T09:00` }
  }
  /** A due occurrence of today's slot (the job's newest), its deadline the same day. */
  function todaysOccurrence(job: string, noon: number, slotName: string): string {
    const id = `occ.${(0xe000 + ++slot).toString(16).padStart(32, '0')}`
    db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, 'Asia/Tokyo', ?, ?, 'due', ?, ?)`).run(CO, id, job, slotName, new Date(noon - 3 * 3_600_000).toISOString(),
      new Date(noon + 6 * 3_600_000).toISOString(), new Date(noon).toISOString(), new Date(noon).toISOString())
    return id
  }
  const failRun = (run: Json) => as('jd-alice', 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, outcome: 'failed', failure: { class: 'bad-input', code: 'NO_INFO' } })
  const turnOf = async (occ: string) => (await as('jd-alice', 'GET', '/me/job-turns')).body.data.turns.find((t: Json) => t.occurrenceId === occ)

  it('the responsible person\'s retried turn names the Drive file (id and name) so the run updates it; the owner\'s view stays kinds and counts', async () => {
    try {
      const { noon, slot: today } = atNoon()
      const job = await approvedJob()
      expect((await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })).ok).toBe(true)
      const occ = todaysOccurrence(job, noon, today)
      // The first run puts its weekly report, then fails: a person looks.
      const first = await claim(occ)
      expect(first.status, first.text).toBe(201)
      const t1 = await runToken(first.body.data.run)
      const put = (await ai(t1, 'POST', '/google/drive/put', putBody({ name: '週の報告.md' }))).body.data.drivePut
      expect(put).toMatchObject({ state: 'done', name: '週の報告' })
      expect((await failRun(first.body.data.run)).status).toBe(200)
      expect(occOf(occ)).toMatchObject({ state: 'needs_person' })
      // The owner's view and press: kinds and counts only — no file id, file name, folder or receipt.
      const viewed = (await as('jd-owner', 'GET', `/jobs/${job}/occurrences`)).body.data.occurrences.find((o: Json) => o.id === occ)
      expect(viewed.madeBefore).toEqual([{ kind: 'drive-put', count: 1 }])
      const pressed = await as('jd-owner', 'POST', `/jobs/${job}/occurrences/${occ}/retry`)
      expect(pressed.status, pressed.text).toBe(200)
      for (const seen of [JSON.stringify(viewed), pressed.text]) {
        for (const secret of [put.fileId, '週の報告', '提案書', put.id, FOLDER]) expect(seen).not.toContain(secret)
      }
      // Her turn names the file the earlier run made: what updateFileId takes, with the name it was put with.
      expect((await turnOf(occ)).madeBefore).toEqual([{ kind: 'drive-put', ref: { kind: 'drive-put', id: put.id }, file: { id: put.fileId, name: '週の報告' } }])
      // The retried run updates that same file (a new version, nothing uploaded as a new file).
      const second = await claim(occ)
      expect(second.status, second.text).toBe(201)
      expect(second.body.data.turn.madeBefore[0].file).toEqual({ id: put.fileId, name: '週の報告' })
      const t2 = await runToken(second.body.data.run)
      const next = Buffer.from('# 週の報告（直し）\n')
      const updated = await ai(t2, 'POST', '/google/drive/put', putBody({ name: '週の報告.md', updateFileId: put.fileId, sha256: sha(next), contentBase64: next.toString('base64') }))
      expect(updated.body.data.drivePut, updated.text).toMatchObject({ state: 'done', fileId: put.fileId, revisionId: 'version:2' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a receipt outside the chosen folder is not named as a file of the place', async () => {
    try {
      const { noon, slot: today } = atNoon()
      const job = await approvedJob()
      expect((await services.jobs.accept(alice(), job, { version: 1, place: { ...PLACE, ref: FOLDER } })).ok).toBe(true)
      const occ = todaysOccurrence(job, noon, today)
      const run = (await claim(occ)).body.data.run
      // An operation of the run naming her own done receipt in another folder (not the job's place).
      const at = new Date(noon).toISOString()
      db.prepare(`INSERT INTO google_drive_puts (id, company_id, user_id, request_key, actor_kind, conversation_id, run_id, folder_id, folder_name, name, mime_type, bytes, sha256, state,
        file_id, revision_id, link, reason, created_at, finished_at) VALUES ('drive-put-otherfolder-01', ?, 'jd-alice', 'key-otherfolder-01', 'ai', NULL, ?, ?, '外のフォルダ', '別の.pdf',
        'application/pdf', 1, ?, 'done', 'fake-upload-otherfolder-01', 'rev-1', NULL, NULL, ?, ?)`).run(CO, run.id, OTHER_FOLDER, 'c'.repeat(64), at, at)
      db.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, ref_kind, ref_id, created_at, updated_at)
        VALUES (?, ?, 'p1', 'f', 'drive-put', 'done', 1, 'drive-put', 'drive-put-otherfolder-01', ?, ?)`).run(CO, run.id, at, at)
      expect((await failRun(run)).status).toBe(200)
      expect((await as('jd-owner', 'POST', `/jobs/${job}/occurrences/${occ}/retry`)).status).toBe(200)
      const turn = await turnOf(occ)
      expect(turn.madeBefore).toEqual([{ kind: 'drive-put', ref: { kind: 'drive-put', id: 'drive-put-otherfolder-01' } }])
      expect(JSON.stringify(turn)).not.toContain('fake-upload-otherfolder-01')
    } finally {
      vi.useRealTimers()
    }
  })
})
