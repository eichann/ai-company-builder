/**
 * Integration Test: the set watch's second line — 「自分が担当の会議の議事録を、AI が初めて読み終えたとき」 (4b-4 A3; owner memo
 * 「4b-4 自動で読む・知らせ・受け箱の数」 第1.1版 §2 and Codex #2 / #3, owner decision D2 2026-11-25; jobs.md "The set watch (schema 5)"
 * "The second line"). The AI never runs: the meeting's reading is written as the AI's (its consultation, or its 「AI の番」 run), the
 * clock's scan, the app's claim, renews and finish are made as the app would, and the server's checks are what is tested.
 *
 * Guards (each mutation-checked; the results in the PR):
 * - the event is the meeting's **first** `finish_reading → read`, written by the AI of **any of the meeting's people** (owner
 *   decision 2026-11-25: the reading is shared; no run, or that person's own `minutes-reading` run of that very meeting) — never a
 *   person, the AI of someone not on the meeting, another run or step, an origin-marked or plugin-screen row; `ledgerRowIsEvent`
 *   is not widened; it runs the job of a responsible person who is one of the meeting's people (`attendee_responsible`), never of
 *   one who is not;
 * - the mark is the meeting's for each responsible person: every attendee's job once, no person twice — also across both lines;
 * - the acceptance: a meeting that arrived before it but was first read after runs; no boundary known → never;
 * - the guards it shares (outside attendee, members-only meeting) hold for it;
 * - its occurrence names the meeting as its record; the conditions while it runs are its own (still read, still theirs, still that
 *   meeting); only its people see it; its finish makes the one owner-only やること linked to the meeting;
 * - this line taken out (a build that knows schema 5 but not it): nothing is read, a running occurrence ends.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { recordsRoute } from '../../src/routes/records'
import { recordsAiRoute } from '../../src/routes/records-ai'
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { jobsRoute } from '../../src/routes/jobs'
import { services } from '../../src/composition'
import { createJobService } from '../../src/services/jobs'
import { createServiceRecordWriter } from '../../src/services/record-engine'
import { meetingOutputId } from '../../src/services/meeting-outputs'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds, sha256TokenDigest } from '../../src/adapters/system'
import { departmentSkill } from '../../src/lib/skill-trees'
import { MINUTES_REVIEW_KEY } from '../../../shared/core/core-types'
import { JOB_MINUTES_ROUTE, JOB_SET_FIRST_READ_LOCK, JOB_SET_WATCH_OPENED, type JobSetTrigger } from '../../../shared/core/jobs'
import { makeTempDir } from '../../shared/testing/temp-dirs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)
app.route('/api/records-ai', recordsAiRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const READS = [1, 2, 3, 4, 5]
const DEPT = '法人ソリューション'
const COPY = 'sales-proposal-auto'
const ORIGINAL = 'sales-proposal-v1'
const ALICE = 'fr-alice'
const BOB = 'fr-bob'
let CO = ''
let workDir = ''

const member = (userId: string, role: string) => ({ companyId: CO, userId, role })
const owner = () => member('fr-owner', 'owner')
const alice = () => member(ALICE, 'member')
const bob = () => member(BOB, 'member')
const HUMAN = { kind: 'human' as const }
const AI = { kind: 'ai' as const, source: 'claude' }
const companyData = sqliteCompanyData(db)
const roleOf = (co: string, user: string) => sqliteMembershipRepository(db).roleOf(co, user)
const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() }
const jobs = createJobService({
  companyData, memberships: sqliteMembershipRepository(db), transactions: sqliteTransactions(db), clock, ids: randomIds,
  skillTree: async () => null, hasCompanyFolder: () => true,
  departmentSkill: (companyId, place, name) => departmentSkill(companyId, place, name),
})
const writer = createServiceRecordWriter({
  companyData, transactions: sqliteTransactions(db), clock, ids: randomIds,
  isMember: (co, user) => roleOf(co, user) !== null, roleOf, notify: () => {}, recordChanged: () => {},
})

async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const as = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `/api/companies/${CO}${path}`, body })
const ai = (token: string, method: string, path: string) => call({ token, method, path: `/api/records-ai${path}` })
const ok = <T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
function gitIn(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
}

const line = (event: 'first_done' | 'first_read'): JobSetTrigger => JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED.find(t => t.event === event)))
function setWatch(actingUser: string, event: 'first_done' | 'first_read'): Json {
  return {
    schema: 5, name: '提案書のたたき台', actingUser, trigger: line(event), check: { kind: 'matched_record' },
    run: { kind: 'procedure', procedure: { source: 'department_skill', place: DEPT, skill: COPY } },
    placement: 'a', missed: { policy: 'skip', expiresAfterMinutes: 1440 },
    grant: {
      tools: ['files_read', 'files_write', 'records'], creates: ['task'], routes: [JOB_MINUTES_ROUTE],
      reads: { paths: [`${DEPT}/提案書`], calls: [], skills: [{ place: DEPT, skill: ORIGINAL }] },
      writes: { area: 'deliverable', place: DEPT, folder: '提案書' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 10 },
    },
  }
}
/** Made by the owner, approved, accepted by its responsible person: its cursor and boundary at now. */
async function running(actingUser = ALICE, event: 'first_done' | 'first_read' = 'first_read'): Promise<string> {
  const id = ok(await jobs.create(owner(), { definition: setWatch(actingUser, event) }, READS)).id
  ok(await jobs.approve(owner(), id, { version: 1 }, READS))
  ok(await jobs.accept(member(actingUser, 'member'), id, { version: 1 }, READS, true))
  return id
}

const versionOf = (id: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).version
/** A meeting as the minutes intake makes it (received for its first person, who had it read). */
function meeting(opts: { people?: string[]; external?: number; membersOnly?: boolean; title?: string } = {}): string {
  const people = opts.people ?? [ALICE, BOB]
  const made = writer.create(CO, {
    type: 'meeting', title: opts.title ?? 'A社 初回の商談', state: 'received',
    ...(opts.membersOnly === false ? { folder: DEPT } : { members: people }),
    fields: { assignee: people[0], attendees: JSON.stringify(people), external_count: opts.external ?? 1, meeting_at: new Date().toISOString() },
    actor: { id: 'google', kind: 'external', source: 'google' }, quiet: true,
  })
  if (!made.ok) throw new Error(made.reason)
  return made.record.id
}
/** The AI of `by` reads it (start, finish) in their consultation (no run). */
async function read(meetingId: string, by = alice()): Promise<void> {
  ok(await services.recordEngine.act(by, AI, meetingId, 'start_reading', { expectedVersion: versionOf(meetingId) }))
  ok(await services.recordEngine.act(by, AI, meetingId, 'finish_reading', { expectedVersion: versionOf(meetingId), args: { summary_text: '提案書を送ることになった' } }))
}
const readRow = (meetingId: string) => db.prepare("SELECT version FROM record_ledger WHERE company_id = ? AND record_id = ? AND action = 'finish_reading' ORDER BY version DESC LIMIT 1").get(CO, meetingId) as Json
/** Rewrite the reading row as another writer would have left it (what the scan reads). */
const asWritten = (meetingId: string, set: string, ...args: unknown[]) =>
  db.prepare(`UPDATE record_ledger SET ${set} WHERE company_id = ? AND record_id = ? AND version = ?`).run(...args, CO, meetingId, readRow(meetingId).version)
/** A run of the 「AI の番」 (what the reading row's `run_id` points at). */
function aiRun(id: string, opts: { subject: string; step?: string; userId?: string; kind?: 'record' | 'occurrence' }): string {
  const at = new Date().toISOString()
  companyData.forCompany(CO).aiRuns.insert({
    id, subject: { kind: opts.kind ?? 'record', id: opts.subject }, step: opts.step ?? 'minutes-reading', userId: opts.userId ?? ALICE, state: 'done', generation: 1,
    deviceId: null, conversationId: null, claimExpiresAt: null, failureClass: null, failureCode: null, retryAt: null, attempts: 0,
    pluginVersion: null, stepsVersion: null, procedure: null, createdAt: at, updatedAt: at, closedAt: at,
  })
  return id
}
const reviewOf = (meetingId: string) => meetingOutputId(sha256TokenDigest, 'task', meetingId, MINUTES_REVIEW_KEY)
const tick = () => services.jobOccurrences.makeOccurrences(CO)
const occurrences = (job: string) => db.prepare('SELECT id, state, outcome_code, event_record_id, event_meeting_id FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? ORDER BY created_at').all(CO, job) as Json[]
/** The second line's mark of a meeting for a responsible person (`<review id>#<user>`). */
const keyOf = (meetingId: string, user = ALICE) => `${reviewOf(meetingId)}#${user}`
const markOf = (key: string) => db.prepare('SELECT job_id, meeting_id, outcome, occurrence_id FROM ai_job_meeting_reviews WHERE company_id = ? AND record_id = ?').get(CO, key) as Json
const claim = (occurrenceId: string, checks = ['matched_record', JOB_SET_FIRST_READ_LOCK]) =>
  as(ALICE, 'POST', '/job-run-claims', { occurrenceId, deviceId: 'device-alice-1', conversationId: 'conv-device-alice-1', checks, kinds: ['event'] })
const renew = (run: Json) => as(ALICE, 'POST', `/ai-runs/${run.id}/renew`, { generation: run.generation })
async function tokenFor(run: Json): Promise<string> {
  const r = await as(ALICE, 'POST', '/me/record-tokens', { conversationId: 'conv-device-alice-1', agent: 'claude-code', scope: 'act', run: { id: run.id, generation: run.generation } })
  if (r.status !== 201 && r.status !== 200) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}
/** A meeting alice's AI read after her job was accepted, after one tick. */
async function readByHer(opts: Parameters<typeof meeting>[0] = {}): Promise<string> {
  const m = meeting(opts)
  await read(m)
  tick()
  return m
}

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'fr-owner'
  currentUser.id = 'fr-owner'
  const res = await app.request('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'First Read Co', folderKind: 'none' }) })
  expect(res.status).toBe(201)
  CO = ((await res.json()) as Json).data.id
  const at = new Date().toISOString()
  for (const [user, role] of [[ALICE, 'member'], [BOB, 'member'], ['fr-admin', 'admin']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, at, at)
  }
  const { companyRepoPath } = await import('../../src/lib/config')
  const bare = companyRepoPath(CO)
  mkdirSync(bare, { recursive: true })
  gitIn(bare, 'init', '-q', '--bare')
  workDir = makeTempDir('acb-fr-work-')
  gitIn(workDir, 'init', '-q')
  gitIn(workDir, 'remote', 'add', 'origin', bare)
  const base = join(workDir, DEPT, '.claude', 'skills')
  mkdirSync(join(base, COPY), { recursive: true })
  mkdirSync(join(base, ORIGINAL), { recursive: true })
  writeFileSync(join(base, COPY, 'SKILL.md'), '# 提案書のたたき台（自動）\n')
  writeFileSync(join(base, COPY, 'decision.json'), JSON.stringify({ reasons: [{ code: 'requested', label: '提案を求められた' }] }))
  writeFileSync(join(base, ORIGINAL, 'SKILL.md'), '# 提案書\n')
  gitIn(workDir, 'add', '-A')
  gitIn(workDir, 'commit', '-q', '-m', 'skills')
  gitIn(workDir, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
})

afterAll(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

beforeEach(() => {
  for (const t of ['ai_job_occurrences', 'ai_job_event_cursors', 'ai_job_event_gaps', 'ai_job_versions', 'ai_jobs', 'notifications', 'ai_job_meeting_reviews',
    'ai_job_set_reports', 'ai_job_set_feedback', 'ai_job_settings']) db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(CO)
  db.prepare('DELETE FROM ai_runs WHERE company_id = ?').run(CO)
  db.prepare('UPDATE record_settings SET enabled = 1 WHERE company_id = ?').run(CO)
})

describe('the event: the first reading of her meeting by her own AI', () => {
  it('in her consultation: one occurrence naming the meeting as its record, its mark the meeting’s for her; two ticks, no more', async () => {
    const job = await running()
    const m = await readByHer()
    const made = occurrences(job)
    expect(made).toEqual([expect.objectContaining({ state: 'due', event_record_id: m, event_meeting_id: m })])
    expect(markOf(keyOf(m))).toEqual({ job_id: job, meeting_id: m, outcome: 'made', occurrence_id: made[0].id })
    // Her own review's key too: a build before this line looks marks up there only, and must not run it again on its completion.
    expect(markOf(reviewOf(m))).toEqual({ job_id: job, meeting_id: m, outcome: 'made', occurrence_id: made[0].id })
    expect(markOf(m)).toBeUndefined()
    tick()
    expect(occurrences(job)).toHaveLength(1)
  })

  it('in her own 「AI の番」 reading run of that meeting: counted; a run of another step, meeting, member or kind: never', async () => {
    const job = await running()
    const counted = meeting({ title: '数える' })
    await read(counted)
    asWritten(counted, 'run_id = ?', aiRun('run-own', { subject: counted }))
    const others: Array<[string, Parameters<typeof aiRun>[1]]> = [
      ['別の手順', { step: 'inbox-triage' }], ['別の会議', { subject: 'meeting-elsewhere' }], ['bob の回', { userId: BOB }],
      ['定期の仕事の回', { kind: 'occurrence' }], ['ない回', {}],
    ]
    const notCounted: string[] = []
    for (const [title, opts] of others) {
      const m = meeting({ title })
      await read(m)
      const run = title === 'ない回' ? 'run-missing' : aiRun(`run-${notCounted.length}`, { ...opts, subject: opts.subject ?? m })
      asWritten(m, 'run_id = ?', run)
      notCounted.push(m)
    }
    tick()
    expect(occurrences(job).map(o => o.event_record_id)).toEqual([counted])
    for (const m of notCounted) expect(markOf(keyOf(m)), m).toBeUndefined()
  })

  it('never a row of the AI of someone not on the meeting, a person, an origin mark, a business plugin screen or another action', async () => {
    const job = await running()
    const forged: Array<[string, string, unknown[]]> = [
      ['出ていない管理者の AI', 'actor_id = ?', ['fr-admin']], ['人', "actor_kind = 'human'", []], ['移行', "origin = 'migration'", []],
      ['業務の画面', 'via = ?', ['{"plugin":"p","version":"1"}']], ['別の操作', "action = 'retry'", []], ['読んでいる途中から以外', "from_state = 'received'", []],
    ]
    for (const [title, set, args] of forged) {
      const m = meeting({ title })
      await read(m)
      asWritten(m, set, ...args)
    }
    tick()
    expect(occurrences(job)).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_job_meeting_reviews WHERE company_id = ?').get(CO) as Json).n).toBe(0)
  })

  it('another attendee’s AI reading it (bob had it read) runs alice’s job — once; her PC reads nothing again', async () => {
    const job = await running()
    const m = meeting({ people: [BOB, ALICE], title: 'bob が担当の会議' })
    await read(m, bob())
    tick()
    tick()
    expect(occurrences(job)).toEqual([expect.objectContaining({ state: 'due', event_record_id: m, event_meeting_id: m })])
    expect(markOf(keyOf(m)).outcome).toBe('made')
    // The review is bob's: its key is not hers to write (his own job of the first line may still run it).
    expect(markOf(reviewOf(m))).toBeUndefined()
  })

  it('two attendees with a job of this line: one reading runs each once', async () => {
    const hers = await running(ALICE)
    const his = await running(BOB)
    const m = meeting({ people: [BOB, ALICE] })
    await read(m, bob())
    tick()
    tick()
    expect(occurrences(hers)).toHaveLength(1)
    expect(occurrences(his)).toHaveLength(1)
    expect([markOf(keyOf(m, ALICE)).job_id, markOf(keyOf(m, BOB)).job_id]).toEqual([hers, his])
  })

  it('a responsible person who is not one of the meeting’s people: never (not_matched)', async () => {
    const job = await running()
    const m = meeting({ people: [BOB], title: 'bob だけの会議' })
    await read(m, bob())
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(keyOf(m)).outcome).toBe('not_matched')
  })

  it('only its first reading: read before the job, read again after (its reading put back) — nothing, no mark', async () => {
    const m = meeting()
    await read(m)
    const job = await running()
    // Put back to `reading` (as an undo would) and read again by her AI after the acceptance.
    db.prepare("UPDATE record_state SET state = 'reading' WHERE company_id = ? AND record_id = ?").run(CO, m)
    ok(await services.recordEngine.act(alice(), AI, m, 'finish_reading', { expectedVersion: versionOf(m), args: { summary_text: 'もう一度' } }))
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(keyOf(m))).toBeUndefined()
  })
})

describe('once per meeting for each person, across both lines', () => {
  it('a meeting this line ran never runs again when its 「議事録を確認する」 is completed under the first line', async () => {
    const reader = await running(ALICE, 'first_read')
    const m = await readByHer()
    expect(occurrences(reader)).toHaveLength(1)
    // Her job switched to the first line (the reading one paused: one active set watch per person).
    ok(services.jobs.pause(owner(), reader))
    const reviewer = await running(ALICE, 'first_done')
    ok(await services.recordEngine.act(alice(), HUMAN, reviewOf(m), 'complete', { expectedVersion: versionOf(reviewOf(m)) }))
    tick()
    expect(occurrences(reviewer)).toEqual([])
    expect(markOf(keyOf(m)).job_id).toBe(reader)
  })

  it('without its own key, her review’s key written by this line alone still stops the first line (as a build before this line reads it)', async () => {
    const reader = await running(ALICE, 'first_read')
    const m = await readByHer()
    db.prepare('DELETE FROM ai_job_meeting_reviews WHERE company_id = ? AND record_id = ?').run(CO, keyOf(m))
    ok(services.jobs.pause(owner(), reader))
    const reviewer = await running(ALICE, 'first_done')
    ok(await services.recordEngine.act(alice(), HUMAN, reviewOf(m), 'complete', { expectedVersion: versionOf(reviewOf(m)) }))
    tick()
    expect(occurrences(reviewer)).toEqual([])
  })

  it('a meeting the first line used for her review (her own) never runs this line for her; for another attendee it does', async () => {
    const m = meeting({ people: [ALICE, BOB] })
    const hers = await running(ALICE)
    const his = await running(BOB)
    // The first line's mark of her review (only her job ever writes it), written before the reading reached the scan.
    db.prepare("INSERT INTO ai_job_meeting_reviews (company_id, record_id, meeting_id, job_id, outcome, occurrence_id, at) VALUES (?, ?, ?, 'job.other', 'made', NULL, ?)").run(CO, reviewOf(m), m, new Date().toISOString())
    await read(m)
    tick()
    expect(occurrences(hers)).toEqual([])
    expect(occurrences(his)).toHaveLength(1)
  })

  it('a meeting marked already for her (by any job) makes nothing', async () => {
    const job = await running()
    const m = meeting()
    db.prepare("INSERT INTO ai_job_meeting_reviews (company_id, record_id, meeting_id, job_id, outcome, occurrence_id, at) VALUES (?, ?, ?, 'job.other', 'paused', NULL, ?)").run(CO, keyOf(m), m, new Date().toISOString())
    await read(m)
    tick()
    expect(occurrences(job)).toEqual([])
  })
})

describe('the acceptance and the shared guards', () => {
  it('a meeting that arrived before the acceptance and was first read after it runs', async () => {
    const m = meeting()
    const job = await running()
    await read(m)
    tick()
    expect(occurrences(job)).toEqual([expect.objectContaining({ event_record_id: m })])
  })

  it('no switch boundary known: before_acceptance, never made', async () => {
    const job = await running()
    db.prepare('UPDATE ai_job_event_cursors SET set_boundary_seq = NULL WHERE company_id = ? AND job_id = ?').run(CO, job)
    const m = await readByHer()
    expect(occurrences(job)).toEqual([])
    expect(markOf(keyOf(m)).outcome).toBe('before_acceptance')
  })

  it('no outside attendee, a meeting with a folder: not_matched, nothing made', async () => {
    const job = await running()
    const inside = await readByHer({ external: 0, title: '社内' })
    const folder = await readByHer({ membersOnly: false, title: 'フォルダ' })
    expect(occurrences(job)).toEqual([])
    expect(markOf(keyOf(inside)).outcome).toBe('not_matched')
    expect(markOf(keyOf(folder)).outcome).toBe('not_matched')
  })
})

describe('its occurrence: who sees it, the run, its conditions and its finish', () => {
  it('the owner who did not attend sees no occurrence; the turn names the meeting as record and meeting; its run reads that meeting only', async () => {
    const job = await running()
    const m = await readByHer()
    const other = meeting({ title: 'B社 定例' })
    expect((await as('fr-owner', 'GET', `/jobs/${job}/occurrences`)).body.data.occurrences).toEqual([])
    expect((await as(ALICE, 'GET', `/jobs/${job}/occurrences`)).body.data.occurrences).toHaveLength(1)
    // An app of PR5 (it names `matched_record` only) is neither handed nor allowed to claim it: it would run it with the first line's words.
    expect((await as(ALICE, 'GET', '/me/job-turns?kinds=time,event&checks=matched_record')).body.data.turns).toEqual([])
    expect(await claim(occurrences(job)[0].id, ['matched_record'])).toMatchObject({ status: 409, body: { code: 'JOB_CHECK_NOT_SUPPORTED' } })
    const listed = (await as(ALICE, 'GET', `/me/job-turns?kinds=time,event&checks=matched_record,${JOB_SET_FIRST_READ_LOCK}`)).body.data.turns
    expect(listed).toEqual([expect.objectContaining({ kind: 'event', source: { recordId: m, meetingId: m } })])
    const run = (await claim(occurrences(job)[0].id)).body.data.run
    const token = await tokenFor(run)
    expect(await ai(token, 'GET', `/minutes/${other}/text`)).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    expect((await ai(token, 'GET', `/minutes/${m}/text`)).body?.code).not.toBe('NOT_IN_STEP')
  })

  it('the meeting no longer read while it runs: ended (EVENT_NOT_NEEDED)', async () => {
    const job = await running()
    const m = await readByHer()
    const run = (await claim(occurrences(job)[0].id)).body.data.run
    expect((await renew(run)).status).toBe(200)
    db.prepare("UPDATE record_state SET state = 'reading' WHERE company_id = ? AND record_id = ?").run(CO, m)
    expect(await renew(run)).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'EVENT_NOT_NEEDED' } })
  })

  it('the meeting handed to bob while it runs goes on; alice taken off the meeting ends it (EVENT_RECORD_GONE)', async () => {
    const job = await running()
    const m = await readByHer()
    const run = (await claim(occurrences(job)[0].id)).body.data.run
    db.prepare("UPDATE record_state SET fields = json_set(fields, '$.assignee', ?) WHERE company_id = ? AND record_id = ?").run(BOB, CO, m)
    expect((await renew(run)).status).toBe(200)
    db.prepare('DELETE FROM record_viewers WHERE company_id = ? AND record_id = ? AND user_id = ?').run(CO, m, ALICE)
    db.prepare("UPDATE record_state SET fields = json_set(fields, '$.attendees', ?) WHERE company_id = ? AND record_id = ?").run(JSON.stringify([BOB]), CO, m)
    // Hers no longer to see: a missing run for her, and it ends there (`hides`).
    expect((await renew(run)).status).toBe(404)
    expect(occurrences(job)[0]).toMatchObject({ outcome_code: 'EVENT_RECORD_GONE' })
  })

  it('an occurrence whose record is not its meeting: ended (SET_WATCH_MEETING_CHANGED)', async () => {
    const job = await running()
    await readByHer()
    const occ = occurrences(job)[0].id
    const run = (await claim(occ)).body.data.run
    const other = meeting({ title: 'B社' })
    db.prepare('UPDATE ai_job_occurrences SET event_record_id = ? WHERE company_id = ? AND id = ?').run(other, CO, occ)
    expect(await renew(run)).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'SET_WATCH_MEETING_CHANGED' } })
  })

  it('its finish makes the one owner-only やること linked to the meeting, named by its date only', async () => {
    const job = await running()
    const m = await readByHer()
    const occ = occurrences(job)[0].id
    const run = (await claim(occ)).body.data.run
    const done = await as(ALICE, 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, outcome: 'done', jobResult: { decision: 'proceed', reason: 'requested', confidence: 0.9 } })
    expect(done.status).toBe(200)
    const task = companyData.forCompany(CO).records.byIds([`task-${occ.slice(4)}`])[0]
    expect(db.prepare('SELECT personal_owner FROM records WHERE company_id = ? AND id = ?').get(CO, task.id)).toEqual({ personal_owner: ALICE })
    expect(task.title).toMatch(/^\d{1,2}月\d{1,2}日の会議のたたき台を確かめる$/)
    expect(db.prepare("SELECT target_id FROM record_links WHERE company_id = ? AND source_id = ? AND name = 'meeting'").all(CO, `task-${occ.slice(4)}`)).toEqual([{ target_id: m }])
  })
})

describe('this line taken out (a build that knows schema 5 but not this line)', () => {
  it('nothing is read and a running occurrence ends; back, what was read meanwhile never runs late', async () => {
    const job = await running()
    await readByHer()
    const run = (await claim(occurrences(job)[0].id)).body.data.run
    const i = JOB_SET_WATCH_OPENED.findIndex(t => t.event === 'first_read')
    const removed = (JOB_SET_WATCH_OPENED as JobSetTrigger[]).splice(i, 1)
    let later = ''
    try {
      expect(await renew(run)).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'SET_WATCH_NOT_OPENED' } })
      later = await readByHer({ title: 'B社 初回' })
      expect(occurrences(job)).toHaveLength(1)
      expect(markOf(keyOf(later))).toBeUndefined()
    } finally {
      (JOB_SET_WATCH_OPENED as JobSetTrigger[]).splice(i, 0, ...removed)
    }
    tick()
    expect(occurrences(job)).toHaveLength(1)
    expect(markOf(keyOf(later))).toBeUndefined()
  })
})
