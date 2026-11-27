/**
 * Integration Test: the set watch finds its records and makes occurrences (schema 5, 4b-4 PR2; owner memo 「4b-4 商談から提案書」
 * 第6版 §2 / §3 ①② / §6 / 付録 B, T1–T7 / T9 / T14 / T18 / T21 / T22; jobs.md "The set watch (schema 5)"). The AI never runs:
 * the clock's scan, the app's claim, calls and renews are made as the app would, and the server's checks are what is tested.
 *
 * Guards (each mutation-checked; the results in the PR):
 * - only a 「議事録を確認する」 the minutes intake made for its one meeting (its id from the meeting), in its **first** done, by a
 *   person, assigned to the responsible person from its making, is an event (T1 / T2 / T3 / T5);
 * - one mark per record in the company, written whatever came of it; a marked record never makes an occurrence (T1 / T14);
 * - the guards: made and first read after the acceptance (by delivery number; a row without one is out — T21), a members-only
 *   meeting with an outside attendee whose people include the responsible person (T4), no business plugin step busy with it
 *   (§3 ②); paused (a gap) and the day's limit, its one notice a day without a meeting's name (T6);
 * - someone else's record is never this job's to mark (T18);
 * - who sees an occurrence: the record's and the meeting's people only — never an owner who did not attend (T7);
 * - a line taken out of the opened list: the scan reads nothing and a running occurrence ends (T22);
 * - the claim needs an app naming `matched_record`; the list hands such a turn only to it; the run reads that one meeting's
 *   minutes and no other; its conditions end it (the record reopened, the meeting changed).
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
import { permissionRulesRoute } from '../../src/routes/permission-rules'
import { recordsRoute } from '../../src/routes/records'
import { recordsAiRoute } from '../../src/routes/records-ai'
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { jobsRoute } from '../../src/routes/jobs'
import { notificationsRoute } from '../../src/routes/notifications'
import { createMinutesReview } from '../../src/services/minutes-review'
import { services } from '../../src/composition'
import { createJobService } from '../../src/services/jobs'
import { createServiceRecordWriter } from '../../src/services/record-engine'
import { meetingOutputId } from '../../src/services/meeting-outputs'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds, sha256TokenDigest } from '../../src/adapters/system'
import { departmentSkill } from '../../src/lib/skill-trees'
import { MINUTES_ACTOR, MINUTES_REVIEW_KEY } from '../../../shared/core/core-types'
import { JOB_MINUTES_ROUTE, JOB_SET_WATCH_OPENED, type JobSetTrigger } from '../../../shared/core/jobs'
import { turnTiming } from '../../../shared/core/turn-timing'
import { makeTempDir } from '../../shared/testing/temp-dirs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)
app.route('/api/companies/:companyId', notificationsRoute)
app.route('/api/records-ai', recordsAiRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const READS = [1, 2, 3, 4, 5]
const DEPT = '法人ソリューション'
const COPY = 'sales-proposal-auto'
const ORIGINAL = 'sales-proposal-v1'
const ALICE = 'ss-alice'
const BOB = 'ss-bob'
let CO = ''
let workDir = ''

const member = (userId: string, role: string) => ({ companyId: CO, userId, role })
const owner = () => member('ss-owner', 'owner')
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

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
}
function putSkills() {
  const base = join(workDir, DEPT, '.claude', 'skills')
  mkdirSync(join(base, COPY), { recursive: true })
  mkdirSync(join(base, ORIGINAL), { recursive: true })
  writeFileSync(join(base, COPY, 'SKILL.md'), '# 提案書のたたき台（自動）\n')
  writeFileSync(join(base, COPY, 'decision.json'), JSON.stringify({ reasons: [{ code: 'requested', label: '提案を求められた' }, { code: 'introduction', label: '顔合わせ・情報交換' }] }))
  writeFileSync(join(base, ORIGINAL, 'SKILL.md'), '# 提案書\n')
  git(workDir, 'add', '-A')
  git(workDir, 'commit', '-q', '--allow-empty', '-m', 'skills')
  git(workDir, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
}

const OPENED = (): JobSetTrigger => JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED[0]))
function setWatch(actingUser = ALICE, runsPerDay = 10): Json {
  return {
    schema: 5, name: '提案書のたたき台', actingUser, trigger: OPENED(), check: { kind: 'matched_record' },
    run: { kind: 'procedure', procedure: { source: 'department_skill', place: DEPT, skill: COPY } },
    placement: 'a', missed: { policy: 'skip', expiresAfterMinutes: 1440 },
    grant: {
      tools: ['files_read', 'files_write', 'records'], creates: ['task'], routes: [JOB_MINUTES_ROUTE],
      reads: { paths: [`${DEPT}/提案書`], calls: [], skills: [{ place: DEPT, skill: ORIGINAL }] },
      writes: { area: 'deliverable', place: DEPT, folder: '提案書' }, outbound: 'none', limits: { minutes: 30, runsPerDay },
    },
  }
}
/** Made by the owner, approved, accepted by its responsible person: its cursor and boundary at now. */
async function running(actingUser = ALICE, runsPerDay = 10): Promise<string> {
  const id = ok(await jobs.create(owner(), { definition: setWatch(actingUser, runsPerDay) }, READS)).id
  ok(await jobs.approve(owner(), id, { version: 1 }, READS))
  ok(await jobs.accept(member(actingUser, 'member'), id, { version: 1 }, READS, true))
  return id
}

const versionOf = (id: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).version
/** A meeting as the minutes intake makes it: members-only, its people, outside attendees counted. */
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
/** Its assignee's AI reads it (start, finish): the minutes service makes its 「議事録を確認する」 for them. */
async function read(meetingId: string, by = alice()): Promise<string> {
  ok(await services.recordEngine.act(by, AI, meetingId, 'start_reading', { expectedVersion: versionOf(meetingId) }))
  ok(await services.recordEngine.act(by, AI, meetingId, 'finish_reading', { expectedVersion: versionOf(meetingId), args: { summary_text: '提案書を送ることになった' } }))
  return reviewOf(meetingId)
}
const reviewOf = (meetingId: string) => meetingOutputId(sha256TokenDigest, 'task', meetingId, MINUTES_REVIEW_KEY)
const complete = async (id: string, by = alice()) => ok(await services.recordEngine.act(by, HUMAN, id, 'complete', { expectedVersion: versionOf(id) }))
const reopen = async (id: string, by = alice()) => ok(await services.recordEngine.act(by, HUMAN, id, 'reopen', { expectedVersion: versionOf(id) }))
const tick = () => services.jobOccurrences.makeOccurrences(CO)

const occurrences = (job: string) => db.prepare('SELECT id, state, outcome_code, event_record_id, event_meeting_id, due_slot FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? ORDER BY created_at').all(CO, job) as Json[]
const markOf = (record: string) => db.prepare('SELECT job_id, meeting_id, outcome, occurrence_id FROM ai_job_meeting_reviews WHERE company_id = ? AND record_id = ?').get(CO, record) as Json
const notices = (kind: string) => db.prepare('SELECT user_id, dedupe_key FROM notifications WHERE company_id = ? AND kind = ?').all(CO, kind) as Json[]
/** The meeting read and its review completed by alice: the record, after one tick. */
async function completedReview(opts: Parameters<typeof meeting>[0] = {}): Promise<{ meeting: string; review: string }> {
  const m = meeting(opts)
  const review = await read(m)
  await complete(review)
  tick()
  return { meeting: m, review }
}

const claim = (occurrenceId: string, checks = ['matched_record']) =>
  as(ALICE, 'POST', '/job-run-claims', { occurrenceId, deviceId: 'device-alice-1', conversationId: 'conv-device-alice-1', checks, kinds: ['event'] })
async function tokenFor(run: Json): Promise<string> {
  const r = await as(ALICE, 'POST', '/me/record-tokens', { conversationId: 'conv-device-alice-1', agent: 'claude-code', scope: 'act', run: { id: run.id, generation: run.generation } })
  if (r.status !== 201 && r.status !== 200) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}
const renew = (run: Json) => as(ALICE, 'POST', `/ai-runs/${run.id}/renew`, { generation: run.generation })

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'ss-owner'
  currentUser.id = 'ss-owner'
  const res = await app.request('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Set Watch Scan Co', folderKind: 'none' }) })
  expect(res.status).toBe(201)
  CO = ((await res.json()) as Json).data.id
  const at = new Date().toISOString()
  for (const [user, role] of [[ALICE, 'member'], [BOB, 'member'], ['ss-admin', 'admin']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, at, at)
  }
  const { companyRepoPath } = await import('../../src/lib/config')
  const bare = companyRepoPath(CO)
  mkdirSync(bare, { recursive: true })
  git(bare, 'init', '-q', '--bare')
  workDir = makeTempDir('acb-ss-work-')
  git(workDir, 'init', '-q')
  git(workDir, 'remote', 'add', 'origin', bare)
  putSkills()
})

afterAll(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

beforeEach(() => {
  for (const t of ['ai_job_occurrences', 'ai_job_event_cursors', 'ai_job_event_gaps', 'ai_job_versions', 'ai_jobs', 'notifications', 'ai_job_meeting_reviews',
    'ai_job_set_reports', 'ai_job_set_feedback',
    'plugin_step_requests', 'plugin_step_pins', 'ai_job_settings', 'member_absences']) db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(CO)
  db.prepare("DELETE FROM ai_runs WHERE company_id = ? AND subject_kind = 'occurrence'").run(CO)
  db.prepare('UPDATE record_settings SET enabled = 1 WHERE company_id = ?').run(CO)
})

describe('the event: the first completion of the responsible person’s own 「議事録を確認する」 (T1 / T2 / T3 / T5)', () => {
  it('one occurrence, pinned to the record and its meeting, its mark `made`; reopened and completed again, read again, two ticks: no more', async () => {
    const job = await running()
    const { meeting: m, review } = await completedReview()
    const made = occurrences(job)
    expect(made).toEqual([expect.objectContaining({ state: 'due', event_record_id: review, event_meeting_id: m })])
    expect(made[0].due_slot).toMatch(/^ev:/)
    expect(markOf(review)).toEqual({ job_id: job, meeting_id: m, outcome: 'made', occurrence_id: made[0].id })
    await reopen(review)
    await complete(review)
    tick()
    tick()
    expect(occurrences(job)).toHaveLength(1)
  })

  it('a record marked already (by any job) makes nothing', async () => {
    const job = await running()
    const m = meeting()
    const review = await read(m)
    db.prepare("INSERT INTO ai_job_meeting_reviews (company_id, record_id, meeting_id, job_id, outcome, occurrence_id, at) VALUES (?, ?, ?, 'job.other', 'paused', NULL, ?)").run(CO, review, m, new Date().toISOString())
    await complete(review)
    tick()
    expect(occurrences(job)).toEqual([])
  })

  it('a task of the same kind, linked to the meeting, that the minutes intake did not make — or whose id the meeting does not give — never is', async () => {
    const job = await running()
    const m = meeting()
    // The meeting read after the acceptance (its own review made): only the record's own identity can keep these out.
    await read(m)
    // Written by someone else than the intake (the server's own writer, as an outside actor).
    const other = writer.create(CO, {
      type: 'task', title: '議事録を確認する：A社', members: [ALICE, BOB],
      fields: { assignee: ALICE, requested_by: ALICE, task_kind: 'minutes_review' }, links: { meeting: [m] }, actor: { id: 'google', kind: 'external', source: 'google' },
    })
    // Written by the intake, but not under the meeting's own id.
    const notIts = writer.create(CO, {
      type: 'task', title: '議事録を確認する：A社', members: [ALICE, BOB],
      fields: { assignee: ALICE, requested_by: ALICE, task_kind: 'minutes_review' }, links: { meeting: [m] }, actor: MINUTES_ACTOR,
    })
    if (!other.ok || !notIts.ok) throw new Error('not made')
    await complete(other.record.id)
    await complete(notIts.record.id)
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(other.record.id)).toBeUndefined()
    expect(markOf(notIts.record.id)).toBeUndefined()
  })

  it('the meeting’s own review whose first version was not the intake’s, or not of the kind when made: never the event', async () => {
    const job = await running()
    const byOther = meeting({ title: 'A社 初回' })
    const notKind = meeting({ title: 'B社 初回' })
    const r1 = await read(byOther)
    const r2 = await read(notKind)
    // A first version written by someone else than the intake (any writer but the minutes service), and one made as another kind.
    db.prepare("UPDATE record_ledger SET actor_id = ?, actor_kind = 'external' WHERE company_id = ? AND record_id = ? AND version = 1").run('google', CO, r1)
    const v1 = db.prepare('SELECT changes FROM record_ledger WHERE company_id = ? AND record_id = ? AND version = 1').get(CO, r2) as Json
    expect(v1.changes).toContain('"minutes_review"')
    db.prepare('UPDATE record_ledger SET changes = ? WHERE company_id = ? AND record_id = ? AND version = 1').run(v1.changes.replaceAll('"minutes_review"', 'null'), CO, r2)
    await complete(r1)
    await complete(r2)
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(r1)).toBeUndefined()
    expect(markOf(r2)).toBeUndefined()
  })

  it('a completion written by a run (or any change the ledger does not count) is not the event', async () => {
    const job = await running()
    const m = meeting()
    const review = await read(m)
    await complete(review)
    db.prepare("UPDATE record_ledger SET run_id = 'run-x' WHERE company_id = ? AND record_id = ? AND to_state = 'done'").run(CO, review)
    tick()
    expect(occurrences(job)).toEqual([])
  })

  it('first completed by a run, reopened and completed by her: not its first completion — nothing', async () => {
    const job = await running()
    const m = meeting()
    const review = await read(m)
    await complete(review)
    db.prepare("UPDATE record_ledger SET run_id = 'run-x' WHERE company_id = ? AND record_id = ? AND to_state = 'done'").run(CO, review)
    await reopen(review)
    await complete(review)
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review)).toBeUndefined()
  })

  it('completed before the job and reopened, completed after: not the first completion — nothing', async () => {
    const m = meeting()
    const review = await read(m)
    await complete(review)
    await reopen(review)
    const job = await running()
    await complete(review)
    tick()
    expect(occurrences(job)).toEqual([])
  })

  it('made for someone else (bob read it) and handed to alice later: not hers from its making — nothing, no mark', async () => {
    const job = await running()
    const m = meeting({ people: [BOB, ALICE] })
    const review = await read(m, bob())
    db.prepare("UPDATE record_state SET fields = json_set(fields, '$.assignee', ?) WHERE company_id = ? AND record_id = ?").run(ALICE, CO, review)
    await complete(review, bob())
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review)).toBeUndefined()
  })
})

describe('the guards (T4 / T6 / T21 / §3 ②)', () => {
  it('no outside attendee, a meeting with a folder (before members-only): marked not_matched, nothing made', async () => {
    const job = await running()
    const internal = await completedReview({ external: 0 })
    const folder = await completedReview({ membersOnly: false })
    expect(occurrences(job)).toEqual([])
    expect(markOf(internal.review).outcome).toBe('not_matched')
    expect(markOf(folder.review).outcome).toBe('not_matched')
  })

  it('the meeting first read before the acceptance (its review made later or not): before_acceptance, never made', async () => {
    const m1 = meeting()
    const early = await read(m1)
    const m2 = meeting()
    await read(m2)
    // The review of m2 failed to be made at the reading and is made after the acceptance: the meeting's first reading decides.
    db.prepare('DELETE FROM records WHERE company_id = ? AND id = ?').run(CO, reviewOf(m2))
    db.prepare('DELETE FROM record_state WHERE company_id = ? AND record_id = ?').run(CO, reviewOf(m2))
    db.prepare('DELETE FROM record_ledger WHERE company_id = ? AND record_id = ?').run(CO, reviewOf(m2))
    db.prepare('DELETE FROM record_links WHERE company_id = ? AND source_id = ?').run(CO, reviewOf(m2))
    const job = await running()
    expect(createMinutesReview({ companyData, writer, tokenDigest: sha256TokenDigest }).ensure(CO, m2)).toBe(reviewOf(m2))
    await complete(early)
    await complete(reviewOf(m2))
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(early).outcome).toBe('before_acceptance')
    expect(markOf(reviewOf(m2)).outcome).toBe('before_acceptance')
  })

  it('hers when made, handed to bob and completed by him: not_matched, nothing made', async () => {
    const job = await running()
    const m = meeting()
    const review = await read(m)
    ok(await services.recordEngine.act(alice(), HUMAN, review, 'assign', { expectedVersion: versionOf(review), note: 'お願いします', args: { assignee: BOB } }))
    await complete(review, bob())
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review).outcome).toBe('not_matched')
  })

  it('her review, but she is no longer one of the meeting’s people when she completes it: not_matched, nothing made', async () => {
    const job = await running()
    const m = meeting({ people: [ALICE, BOB] })
    const review = await read(m)
    db.prepare('DELETE FROM record_viewers WHERE company_id = ? AND record_id = ? AND user_id = ?').run(CO, m, ALICE)
    db.prepare("UPDATE record_state SET fields = json_set(fields, '$.assignee', ?, '$.attendees', ?) WHERE company_id = ? AND record_id = ?").run(BOB, JSON.stringify([BOB]), CO, m)
    await complete(review)
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review).outcome).toBe('not_matched')
  })

  it('a review whose making has no delivery number is out, even when the meeting was read after the acceptance', async () => {
    const job = await running()
    const m = meeting()
    const review = await read(m)
    db.prepare('UPDATE record_ledger SET delivery_seq = NULL WHERE company_id = ? AND record_id = ? AND version = 1').run(CO, review)
    await complete(review)
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review).outcome).toBe('before_acceptance')
  })

  it('a meeting whose first reading has no delivery number is out (a later one never stands in)', async () => {
    const job = await running()
    const m = meeting()
    const review = await read(m)
    db.prepare("UPDATE record_ledger SET delivery_seq = NULL WHERE company_id = ? AND record_id = ? AND to_state = 'read'").run(CO, m)
    await complete(review)
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review).outcome).toBe('before_acceptance')
  })

  it('a business plugin step that runs one of its Skills, asked for that meeting on its まとまり: step_busy, nothing made', async () => {
    const job = await running()
    const m = meeting()
    const deal = ok(services.recordEngine.create(alice(), HUMAN, { type: 'task', title: 'まとまりの代わり', fields: { assignee: ALICE } })).record.id
    companyData.forCompany(CO).records.replaceLinks(m, [{ sourceId: m, name: 'bundle', position: 0, targetId: deal, targetPath: null }])
    const at = new Date().toISOString()
    db.prepare("INSERT INTO plugin_step_requests (company_id, record_id, plugin_id, step, requested_at, meeting_id, done_at) VALUES (?, ?, 'corporate-sales', 'prepare_proposal', ?, ?, NULL)").run(CO, deal, at, m)
    db.prepare("INSERT INTO plugin_step_pins (company_id, record_id, plugin_id, step, source, version, skill, fingerprint, pinned_at, updated_at) VALUES (?, ?, 'corporate-sales', 'prepare_proposal', 'company_skill', NULL, ?, ?, ?, ?)").run(CO, deal, ORIGINAL, 'd'.repeat(40), at, at)
    const review = await read(m)
    await complete(review)
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review).outcome).toBe('step_busy')
  })

  it('a run of such a step going on (running, its lease live) is busy; one that is never claimed again (4b-4 PR4) is not', async () => {
    const job = await running()
    const at = new Date().toISOString()
    const later = new Date(Date.now() + 5 * 60_000).toISOString()
    const earlier = new Date(Date.now() - 5 * 60_000).toISOString()
    const withRun = (state: string, expires: string | null) => {
      const m = meeting()
      const deal = ok(services.recordEngine.create(alice(), HUMAN, { type: 'task', title: 'まとまりの代わり', fields: { assignee: ALICE } })).record.id
      companyData.forCompany(CO).records.replaceLinks(m, [{ sourceId: m, name: 'bundle', position: 0, targetId: deal, targetPath: null }])
      db.prepare("INSERT INTO plugin_step_pins (company_id, record_id, plugin_id, step, source, version, skill, fingerprint, pinned_at, updated_at) VALUES (?, ?, 'corporate-sales', 'prepare_proposal', 'company_skill', NULL, ?, ?, ?, ?)").run(CO, deal, ORIGINAL, 'd'.repeat(40), at, at)
      db.prepare(`INSERT INTO ai_runs (company_id, id, subject_kind, record_id, step, user_id, state, generation, device_id, conversation_id, claim_expires_at, attempts, created_at, updated_at)
        VALUES (?, ?, 'record', ?, 'corporate-sales__prepare_proposal', ?, ?, 1, NULL, NULL, ?, 0, ?, ?)`).run(CO, `run-busy-${deal}`, deal, ALICE, state, expires, at, at)
      return m
    }
    const live = withRun('running', later)
    const lapsed = withRun('running', earlier)
    const waiting = withRun('waiting_person', null)
    const reviews = [await read(live), await read(lapsed), await read(waiting)]
    for (const review of reviews) await complete(review)
    tick()
    expect(reviews.map(r => markOf(r).outcome)).toEqual(['step_busy', 'made', 'made'])
    expect(occurrences(job)).toHaveLength(2)
  })

  it('completed while the job was paused: marked paused, never made after the resume', async () => {
    const job = await running()
    const m = meeting()
    const review = await read(m)
    ok(jobs.pause(owner(), job, READS))
    // The pause's gap opens in the service's hold (wired in composition): open it here as the composed pause would.
    services.jobOccurrences.holdDue(CO, job, 'JOB_PAUSED')
    await complete(review)
    tick()
    ok(await jobs.resume(owner(), job, READS))
    services.jobOccurrences.holdPassedSlot(CO, job, 'JOB_PAUSED')
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review).outcome).toBe('paused')
  })

  it('the day’s limit: beyond it nothing is made, marked day_limit; one notice a day to her alone, naming no meeting', async () => {
    const job = await running(ALICE, 1)
    const first = await completedReview({ title: 'A社 初回' })
    const second = await completedReview({ title: 'B社 初回' })
    const third = await completedReview({ title: 'C社 初回' })
    expect(occurrences(job)).toHaveLength(1)
    expect(markOf(first.review).outcome).toBe('made')
    expect(markOf(second.review).outcome).toBe('day_limit')
    expect(markOf(third.review).outcome).toBe('day_limit')
    expect(notices('job_day_limit').map(n => n.user_id)).toEqual([ALICE])
    const inbox = (await as(ALICE, 'GET', '/me/notifications')).body.data
    const text = JSON.stringify(inbox)
    // Its day from its key (company time), never 「今日」: it may be read days later.
    const day = (notices('job_day_limit')[0].dedupe_key as string).split(':')[2]
    expect(text).toContain(`${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日、1日の上限`)
    expect(text).not.toContain('今日')
    expect(text).not.toMatch(/A社|B社|C社/)
    expect(JSON.stringify((await as('ss-owner', 'GET', '/me/notifications')).body.data)).not.toContain('1日の上限')
  })

  it('the day’s notice of an admin who was its responsible person: no longer shown to them once it is handed over', async () => {
    const ADMIN = 'ss-admin'
    const admin = () => member(ADMIN, 'admin')
    const job = await running(ADMIN, 1)
    for (const title of ['A社 初回', 'B社 初回']) {
      const m = meeting({ people: [ADMIN, BOB], title })
      await complete(await read(m, admin()), admin())
      tick()
    }
    expect(notices('job_day_limit').map(n => n.user_id)).toEqual([ADMIN])
    expect(JSON.stringify((await as(ADMIN, 'GET', '/me/notifications')).body.data)).toContain('1日の上限')
    // Handed over to bob (a new version approved): the admin still sees the job, but the notice was the responsible person's.
    ok(await jobs.update(owner(), job, { definition: setWatch(BOB, 1) }, READS))
    ok(await jobs.approve(owner(), job, { version: 2 }, READS))
    expect(JSON.stringify((await as(ADMIN, 'GET', '/me/notifications')).body.data)).not.toContain('1日の上限')
  })
})

describe('whose it is, and who sees it (T7 / T18)', () => {
  it('bob’s own review completed by him: alice’s job neither makes nor marks it', async () => {
    const job = await running()
    const m = meeting({ people: [BOB, ALICE] })
    const review = await read(m, bob())
    await complete(review, bob())
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review)).toBeUndefined()
  })

  it('the owner (who did not attend) sees neither the occurrence nor its last one; alice does', async () => {
    const job = await running()
    await completedReview()
    const forOwner = await as('ss-owner', 'GET', `/jobs/${job}/occurrences`)
    expect(forOwner.status).toBe(200)
    expect(forOwner.body.data.occurrences).toEqual([])
    const list = (await as('ss-owner', 'GET', '/jobs')).body.data.jobs.find((j: Json) => j.id === job)
    expect(list.lastOccurrence ?? null).toBeNull()
    const forAlice = await as(ALICE, 'GET', `/jobs/${job}/occurrences`)
    expect(forAlice.body.data.occurrences).toHaveLength(1)
  })

  it('an alice who is no longer one of the meeting’s people (taken off its list): she no longer sees it either', async () => {
    const job = await running()
    const { meeting: m } = await completedReview({ people: [ALICE, BOB] })
    // The meeting's own list and fields without her: she reads the review (its own list) but is not one of the meeting's people.
    db.prepare('DELETE FROM record_viewers WHERE company_id = ? AND record_id = ? AND user_id = ?').run(CO, m, ALICE)
    db.prepare("UPDATE record_state SET fields = json_set(fields, '$.assignee', ?, '$.attendees', ?) WHERE company_id = ? AND record_id = ?").run(BOB, JSON.stringify([BOB]), CO, m)
    expect((await as(ALICE, 'GET', `/jobs/${job}/occurrences`)).body.data.occurrences).toEqual([])
    expect((await as(ALICE, 'GET', '/me/job-occurrences')).body.data.occurrences).toEqual([])
  })

  it('an alice who still reads the meeting through a group on its list, but is not one of its people: she does not see it', async () => {
    const job = await running()
    const { meeting: m } = await completedReview({ people: [ALICE, BOB] })
    expect((await as(ALICE, 'GET', '/me/job-occurrences')).body.data.occurrences).toHaveLength(1)
    const at = new Date().toISOString()
    const group = `grp-${m}`
    db.prepare('INSERT INTO member_groups (id, company_id, name, name_key, created_at, created_by) VALUES (?, ?, ?, ?, ?, NULL)').run(group, CO, group, group, at)
    try {
      db.prepare('INSERT INTO member_group_members (company_id, group_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?, NULL)').run(CO, group, ALICE, at)
      db.prepare("INSERT INTO record_viewer_sets (company_id, record_id, subject_type, subject_id, added_at, added_by) VALUES (?, ?, 'group', ?, ?, ?)").run(CO, m, group, at, BOB)
      db.prepare('DELETE FROM record_viewers WHERE company_id = ? AND record_id = ? AND user_id = ?').run(CO, m, ALICE)
      db.prepare("UPDATE record_state SET fields = json_set(fields, '$.assignee', ?, '$.attendees', ?) WHERE company_id = ? AND record_id = ?").run(BOB, JSON.stringify([BOB]), CO, m)
      // She still reads the meeting (through the group) and her review: only "one of its people" keeps it from her.
      expect((await as(ALICE, 'GET', `/records/item/${m}`)).status).toBe(200)
      expect((await as(ALICE, 'GET', '/me/job-occurrences')).body.data.occurrences).toEqual([])
      expect((await as(ALICE, 'GET', `/jobs/${job}/occurrences`)).body.data.occurrences).toEqual([])
    } finally {
      db.prepare('DELETE FROM member_groups WHERE company_id = ? AND id = ?').run(CO, group)
    }
  })

  it('an expired occurrence is told to alice only — not to the owner who made the job', async () => {
    const job = await running()
    await completedReview()
    db.prepare("UPDATE ai_job_occurrences SET expires_at = '2000-01-01T00:00:00.000Z' WHERE company_id = ? AND job_id = ?").run(CO, job)
    tick()
    expect(occurrences(job)[0]).toMatchObject({ state: 'expired' })
    expect(notices('job_expired').map(n => n.user_id)).toEqual([ALICE])
  })
})

describe('「もう一度」 and 「AI が動いた回」 (the event PC occurrence rules, D11)', () => {
  it('expired: alice finds it in her list and presses 「もう一度」; the owner who did not attend finds nothing to press', async () => {
    const job = await running()
    await completedReview()
    const occ = occurrences(job)[0].id
    db.prepare("UPDATE ai_job_occurrences SET expires_at = '2000-01-01T00:00:00.000Z' WHERE company_id = ? AND id = ?").run(CO, occ)
    tick()
    const mine = (await as(ALICE, 'GET', '/me/job-occurrences')).body.data.occurrences
    expect(mine).toEqual([expect.objectContaining({ id: occ, jobId: job, retry: { allowed: true } })])
    expect((await as('ss-owner', 'POST', `/jobs/${job}/occurrences/${occ}/retry`)).status).toBe(404)
    expect((await as(ALICE, 'POST', `/jobs/${job}/occurrences/${occ}/retry`)).status).toBe(200)
    expect(occurrences(job)[0]).toMatchObject({ state: 'due' })
  })
})

describe('the run on the PC (the claim, the read path, the conditions)', () => {
  it('only an app naming `matched_record` lists or claims it; the turn names the record and its meeting', async () => {
    const job = await running()
    const { meeting: m, review } = await completedReview()
    const occ = occurrences(job)[0].id
    // The app of 4b-2 (kinds event, its own checks): not listed, and its claim refused, nothing written.
    expect((await as(ALICE, 'GET', '/me/job-turns?kinds=time,event')).body.data.turns).toEqual([])
    expect(await claim(occ, ['source_record', 'new_files', 'new_meetings'])).toMatchObject({ status: 409, body: { code: 'JOB_CHECK_NOT_SUPPORTED' } })
    const listed = (await as(ALICE, 'GET', '/me/job-turns?kinds=time,event&checks=matched_record')).body.data.turns
    expect(listed).toEqual([expect.objectContaining({ occurrenceId: occ, kind: 'event', source: { recordId: review, meetingId: m } })])
    expect((await as(BOB, 'GET', '/me/job-turns?kinds=time,event&checks=matched_record')).body.data.turns).toEqual([])
    expect((await claim(occ)).status).toBe(201)
  })

  it('its run reads that one meeting’s minutes only (another meeting: NOT_IN_STEP)', async () => {
    const job = await running()
    const { meeting: m } = await completedReview()
    const other = meeting({ title: 'B社 定例' })
    const run = (await claim(occurrences(job)[0].id)).body.data.run
    const token = await tokenFor(run)
    expect(await ai(token, 'GET', `/minutes/${other}/text`)).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    // Its own meeting passes the job's gate (the minutes route's own rules — Google — answer after it).
    expect((await ai(token, 'GET', `/minutes/${m}/text`)).body?.code).not.toBe('NOT_IN_STEP')
  })

  it('the review reopened while it runs: the renew ends it (EVENT_NOT_NEEDED)', async () => {
    const job = await running()
    const { review } = await completedReview()
    const occ = occurrences(job)[0].id
    const run = (await claim(occ)).body.data.run
    expect((await renew(run)).status).toBe(200)
    await reopen(review)
    expect(await renew(run)).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'EVENT_NOT_NEEDED' } })
    expect(occurrences(job)[0]).toMatchObject({ state: 'nothing', outcome_code: 'EVENT_NOT_NEEDED' })
  })

  it('the record’s meeting replaced while it runs: ended (SET_WATCH_MEETING_CHANGED)', async () => {
    const job = await running()
    const { review } = await completedReview()
    const run = (await claim(occurrences(job)[0].id)).body.data.run
    const other = meeting({ title: 'B社 定例' })
    companyData.forCompany(CO).records.replaceLinks(review, [{ sourceId: review, name: 'meeting', position: 0, targetId: other, targetPath: null }])
    expect(await renew(run)).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'SET_WATCH_MEETING_CHANGED' } })
  })
})

describe('the record kind no longer means what the job names (T9)', () => {
  it('a task type without `task_kind: minutes_review`: nothing read (no mark); once it is back, what was completed meanwhile never runs (the cursor followed now)', async () => {
    const job = await running()
    const m = meeting()
    const review = await read(m)
    await complete(review)
    const current = db.prepare("SELECT version, definition, source, commit_sha FROM record_types WHERE company_id = ? AND name = 'task' ORDER BY version DESC LIMIT 1").get(CO) as Json
    const changed = JSON.parse(current.definition)
    delete changed.fields.task_kind
    db.prepare('INSERT INTO record_types (company_id, name, version, definition, source, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(CO, 'task', current.version + 1, JSON.stringify(changed), current.source, current.commit_sha, new Date().toISOString())
    try {
      tick()
      expect(occurrences(job)).toEqual([])
      expect(markOf(review)).toBeUndefined()
    } finally {
      db.prepare("DELETE FROM record_types WHERE company_id = ? AND name = 'task' AND version = ?").run(CO, current.version + 1)
    }
    tick()
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review)).toBeUndefined()
    // A review completed after the kind is back runs as usual.
    await completedReview({ title: 'B社 初回' })
    expect(occurrences(job)).toHaveLength(1)
  })
})

describe('a change an older build made (a rollback round trip)', () => {
  it('moves the switch boundary to now: a meeting read before it never makes an occurrence afterwards', async () => {
    const job = await running()
    const m = meeting()
    const review = await read(m)
    // An older build changed the job (e.g. accepted a new consent without moving the boundary): its stamp no longer matches.
    db.prepare("UPDATE ai_jobs SET updated_at = ? WHERE company_id = ? AND id = ?").run(new Date(Date.now() + 1000).toISOString(), CO, job)
    tick()
    await complete(review)
    tick()
    expect(occurrences(job)).toEqual([])
    expect(markOf(review).outcome).toBe('before_acceptance')
    // A meeting read after that runs as usual.
    await completedReview({ title: 'B社 初回' })
    expect(occurrences(job)).toHaveLength(1)
  })
})

describe('a line taken out of the opened list (T22)', () => {
  it('the scan reads nothing, and an occurrence made before it ends at its next look', async () => {
    const job = await running()
    await completedReview()
    const occ = occurrences(job)[0].id
    const run = (await claim(occ)).body.data.run
    const line = (JOB_SET_WATCH_OPENED as unknown as JobSetTrigger[]).splice(0, 1)
    try {
      expect(await renew(run)).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'SET_WATCH_NOT_OPENED' } })
      const later = await completedReview({ title: 'B社 初回' })
      expect(occurrences(job)).toHaveLength(1)
      expect(markOf(later.review)).toBeUndefined()
    } finally {
      (JOB_SET_WATCH_OPENED as unknown as JobSetTrigger[]).splice(0, 0, ...line)
    }
    // The line back (a later build): what was completed while it was out never runs late.
    tick()
    expect(occurrences(job)).toHaveLength(1)
  })
})

// ── 4b-4 PR3: how a run ends — the judgement, its やること or notice, and its corrections (owner memo §5 / §5-1 / §5-2, I6 / I8,
// T12 / T15 / T17). The app's finish is sent as the app would; the server's checks are what is tested.
const finish = (run: Json, jobResult: unknown) => as(ALICE, 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, outcome: 'done', jobResult })
const reports = () => db.prepare('SELECT * FROM ai_job_set_reports WHERE company_id = ?').all(CO) as Json[]
const feedbackRows = () => db.prepare('SELECT * FROM ai_job_set_feedback WHERE company_id = ?').all(CO) as Json[]
const stateOf = (occ: string) => (db.prepare('SELECT state FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, occ) as Json).state
const taskOf = (occ: string) => `task-${occ.slice(4)}`
const DATE_ONLY = /^\d{1,2}月\d{1,2}日の会議のたたき台を確かめる$/
/** A completed review, its occurrence claimed by alice's app: the run, ready to finish. */
async function claimed(opts: Parameters<typeof meeting>[0] = {}): Promise<{ job: string; occ: string; run: Json; meeting: string; review: string }> {
  const job = await running()
  const done = await completedReview(opts)
  const occ = occurrences(job)[0].id
  const run = (await claim(occ)).body.data.run
  return { job, occ, run, ...done }
}
/** Alice taken off the meeting's list and people (she still reads her own review). */
const takeOff = (m: string) => {
  db.prepare('DELETE FROM record_viewers WHERE company_id = ? AND record_id = ? AND user_id = ?').run(CO, m, ALICE)
  db.prepare("UPDATE record_state SET fields = json_set(fields, '$.assignee', ?, '$.attendees', ?) WHERE company_id = ? AND record_id = ?").run(BOB, JSON.stringify([BOB]), CO, m)
}

describe('the judgement reaches the server as fixed kinds only (I6, T12)', () => {
  it('a reason the Skill did not declare is refused (400), nothing kept, the run still running', async () => {
    const { occ, run } = await claimed()
    expect(await finish(run, { decision: 'proceed', reason: 'A社が乗り気', confidence: 0.9 })).toMatchObject({ status: 400, body: { code: 'JOB_SET_REPORT_BAD' } })
    expect(reports()).toEqual([])
    expect(stateOf(occ)).toBe('running')
  })

  it('no free text: `evidence`, a title or a summary beside the judgement is refused; a title-only result is no judgement', async () => {
    const { run } = await claimed()
    for (const extra of [{ evidence: [{ at: '00:10', said: 'A社の田中' }] }, { title: 'A社 提案書' }, { summary: '…' }]) {
      expect(await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9, ...extra })).toMatchObject({ status: 400, body: { code: 'JOB_SET_REPORT_BAD' } })
    }
    expect(await finish(run, { title: 'A社 提案書' })).toMatchObject({ status: 400, body: { code: 'JOB_SET_REPORT_BAD' } })
    expect(reports()).toEqual([])
  })

  it('unconfirmed: only the fixed words, never with 見送る', async () => {
    const { run } = await claimed()
    expect((await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9, unconfirmed: ['A社の予算'] })).status).toBe(400)
    expect((await finish(run, { decision: 'decline', reason: 'introduction', confidence: 0.9, unconfirmed: ['budget'] })).status).toBe(400)
    expect(reports()).toEqual([])
  })

  it('confidence: a number from 0 to 1 only', async () => {
    const { run } = await claimed()
    expect((await finish(run, { decision: 'proceed', reason: 'requested', confidence: 1.5 })).status).toBe(400)
    expect((await finish(run, { decision: 'proceed', reason: 'requested', confidence: '0.9' })).status).toBe(400)
    expect(reports()).toEqual([])
  })

  it('updates is a small count only (PR3b): an integer 0–20 — a string, a fraction, a negative or 21 is refused', async () => {
    const { occ, run } = await claimed()
    for (const updates of ['2', 1.5, -1, 21, null, [1]]) {
      expect(await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9, updates }), String(updates)).toMatchObject({ status: 400, body: { code: 'JOB_SET_REPORT_BAD' } })
    }
    expect(reports()).toEqual([])
    expect(stateOf(occ)).toBe('running')
    expect((await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9, updates: 20 })).status).toBe(200)
    expect(reports()).toEqual([expect.objectContaining({ occurrence_id: occ, updates: 20 })])
  })

  it('gate_failed carries nothing else: a count beside it is refused (PR3b)', async () => {
    const { run } = await claimed()
    for (const updates of [0, 1]) expect((await finish(run, { decision: 'gate_failed', updates })).status).toBe(400)
    expect(reports()).toEqual([])
  })

  it('`nothing` is refused: whether it was needed is the server’s to say', async () => {
    const { run } = await claimed()
    expect(await finish(run, 'nothing')).toMatchObject({ status: 400, body: { code: 'JOB_EVENT_NOTHING_REFUSED' } })
  })

  it('kept on the occurrence: the decision, the reason’s code, the confidence in hundredths, the unconfirmed words', async () => {
    const { occ, run } = await claimed()
    expect((await finish(run, { decision: 'ask', reason: 'requested', confidence: 0.123456789, unconfirmed: ['budget', 'headcount'] })).status).toBe(200)
    expect(reports()).toEqual([expect.objectContaining({ occurrence_id: occ, decision: 'ask', reason: 'requested', confidence: 0.12, unconfirmed: '["budget","headcount"]' })])
    expect(stateOf(occ)).toBe('done')
  })
})

describe('進める / 人に聞く / 判断できなかった: one やること named by the date only (§5-1, I6, T15 / T17)', () => {
  it('due the company day it was made (使い心地のメモ #39): in 「あなたの番」, never resting in 「いつか」 with no due', async () => {
    const { occ, run } = await claimed()
    const companyDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const before = companyDay()
    expect((await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9 })).status).toBe(200)
    const after = companyDay()
    const task = (await as(ALICE, 'GET', `/records/item/${taskOf(occ)}`)).body.data
    // The finish's own day (either side of a midnight that passes while it runs).
    expect([before, after]).toContain(task.record.fields.due)
    expect(turnTiming(task.record, after)).toBe('now')
  })

  it('owner-only for alice, linked to the meeting, its name the date only; nothing of the judgement on it — also once she no longer reads the meeting', async () => {
    const { occ, run, meeting: m } = await claimed({ title: 'A社 初回の商談' })
    expect((await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9, unconfirmed: ['budget'] })).status).toBe(200)
    const task = (await as(ALICE, 'GET', `/records/item/${taskOf(occ)}`)).body.data
    expect(task.record.title).toMatch(DATE_ONLY)
    expect(task.record.fields).toMatchObject({ assignee: ALICE })
    expect(JSON.stringify(task)).toContain(m)
    expect(JSON.stringify(task)).not.toMatch(/requested|proceed|budget|(?<![\d.])0\.9(?!\d)/)
    // Owner-only: bob (at the meeting) and the owner get a missing record's answer.
    expect((await as(BOB, 'GET', `/records/item/${taskOf(occ)}`)).status).toBe(404)
    expect((await as('ss-owner', 'GET', `/records/item/${taskOf(occ)}`)).status).toBe(404)
    // She no longer reads the meeting: the やること stays hers, without the meeting's name (T15) or the judgement (T17).
    takeOff(m)
    const after = (await as(ALICE, 'GET', `/records/item/${taskOf(occ)}`)).body.data
    expect(after.record.title).toMatch(DATE_ONLY)
    expect(JSON.stringify(after)).not.toMatch(/A社|requested|proceed|budget/)
  })

  it('判断できなかった (`gate_failed`): only that, its reason ACB’s own, the same date-only やること', async () => {
    const { occ, run } = await claimed()
    expect((await finish(run, { decision: 'gate_failed', reason: 'requested' })).status).toBe(400)
    expect((await finish(run, { decision: 'gate_failed' })).status).toBe(200)
    expect(reports()).toEqual([expect.objectContaining({ decision: 'gate_failed', reason: 'GATE_UNAVAILABLE', confidence: null })])
    expect((await as(ALICE, 'GET', `/records/item/${taskOf(occ)}`)).body.data.record.title).toMatch(DATE_ONLY)
  })
})

describe('update proposals (PR3b, owner memo 「4b-4 挟む部分」 §G-1): 見送る with a count still makes the one やること', () => {
  it('見送る with updates: one owner-only やること named by the date, saying how many and that no たたき台 was made; no 見送る notice', async () => {
    const { occ, run, meeting: m } = await claimed({ title: 'A社 初回の商談' })
    expect((await finish(run, { decision: 'decline', reason: 'introduction', confidence: 0.8, updates: 2 })).status).toBe(200)
    const task = (await as(ALICE, 'GET', `/records/item/${taskOf(occ)}`)).body.data
    expect(task.record.title).toMatch(/^\d{1,2}月\d{1,2}日の会議の更新案を確かめる$/)
    expect(task.record.summary).toBe('AI はたたき台を作りませんでした。更新案が 2 件あります。')
    expect(task.record.fields).toMatchObject({ assignee: ALICE })
    expect(JSON.stringify(task)).toContain(m)
    expect(JSON.stringify(task)).not.toMatch(/introduction|顔合わせ|(?<![\d.])0\.8(?!\d)/)
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND kind = 'job_set_declined'").get(CO)).toEqual({ n: 0 })
    expect(reports()).toEqual([expect.objectContaining({ occurrence_id: occ, decision: 'decline', updates: 2 })])
    expect(stateOf(occ)).toBe('done')
    // The responsible person's alone (§F #9): bob (at the meeting) and the owner get a missing record's answer.
    expect((await as(BOB, 'GET', `/records/item/${taskOf(occ)}`)).status).toBe(404)
    expect((await as('ss-owner', 'GET', `/records/item/${taskOf(occ)}`)).status).toBe(404)
    // Off the meeting: still hers, still without the meeting's name or the reason.
    takeOff(m)
    const after = (await as(ALICE, 'GET', `/records/item/${taskOf(occ)}`)).body.data
    expect(JSON.stringify(after)).not.toMatch(/A社|introduction|顔合わせ/)
    // Her own view of the occurrence carries the count while it is hers to see (here: no longer — nothing at all).
    expect((await as(ALICE, 'GET', '/me/job-occurrences')).body.data.occurrences).toEqual([])
  })

  it('見送る with updates 0: the notice only, no やること (as before PR3b)', async () => {
    const { occ, run } = await claimed()
    expect((await finish(run, { decision: 'decline', reason: 'introduction', confidence: 0.8, updates: 0 })).status).toBe(200)
    expect((await as(ALICE, 'GET', `/records/item/${taskOf(occ)}`)).status).toBe(404)
    expect(notices('job_set_declined')).toEqual([expect.objectContaining({ user_id: ALICE })])
  })

  it('進める with updates: the date-only たたき台 やること says how many; her own view carries the count', async () => {
    const { occ, run } = await claimed()
    expect((await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9, updates: 3 })).status).toBe(200)
    const task = (await as(ALICE, 'GET', `/records/item/${taskOf(occ)}`)).body.data.record
    expect(task.title).toMatch(DATE_ONLY)
    expect(task.summary).toBe('更新案が 3 件あります。')
    const mine = (await as(ALICE, 'GET', '/me/job-occurrences')).body.data.occurrences
    expect(mine).toEqual([expect.objectContaining({ id: occ, report: expect.objectContaining({ decision: 'proceed', updates: 3 }) })])
  })

  it('records off: a 見送る with updates is stopped like any やること — the occurrence needs a person, nothing kept', async () => {
    const { occ, run } = await claimed()
    db.prepare('UPDATE record_settings SET enabled = 0 WHERE company_id = ?').run(CO)
    expect((await finish(run, { decision: 'decline', reason: 'introduction', confidence: 0.8, updates: 1 })).status).toBe(409)
    expect(occurrences((db.prepare('SELECT job_id FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, occ) as Json).job_id)[0])
      .toMatchObject({ state: 'needs_person', outcome_code: 'RECORDS_OFF' })
    expect(reports()).toEqual([])
    expect(notices('job_set_declined')).toEqual([])
  })

})

describe('見送る: no やること, a notice whose words are built when read (§5-1, T15)', () => {
  it('to alice with the meeting’s name and the reason’s words; nothing stored but the kind and the key', async () => {
    const { occ, run } = await claimed({ title: 'A社 初回の商談' })
    expect((await finish(run, { decision: 'decline', reason: 'introduction', confidence: 0.8 })).status).toBe(200)
    expect((await as(ALICE, 'GET', `/records/item/${taskOf(occ)}`)).status).toBe(404)
    const rows = db.prepare("SELECT * FROM notifications WHERE company_id = ? AND kind = 'job_set_declined'").all(CO) as Json[]
    expect(rows).toEqual([expect.objectContaining({ user_id: ALICE, record_id: '' })])
    expect(JSON.stringify(rows[0])).not.toMatch(/A社|introduction|顔合わせ/)
    const list = (await as(ALICE, 'GET', '/me/notifications')).body.data
    expect(list.items.find((i: Json) => i.kind === 'job_set_declined').text).toMatch(/「A社 初回の商談」.*顔合わせ・情報交換/)
  })

  it('once she is no longer one of the meeting’s people: the notice is not shown at all, nor counted', async () => {
    const { run, meeting: m } = await claimed({ title: 'A社 初回の商談' })
    await finish(run, { decision: 'decline', reason: 'introduction', confidence: 0.8 })
    const before = (await as(ALICE, 'GET', '/me/notifications')).body.data.unread
    takeOff(m)
    const list = (await as(ALICE, 'GET', '/me/notifications')).body.data
    expect(list.items.some((i: Json) => i.kind === 'job_set_declined')).toBe(false)
    expect(list.unread).toBe(before - 1)
  })

  it('a 見送る notice is shown only for a 見送る: a row naming an occurrence judged 進める shows nothing (no meeting name)', async () => {
    const { job, occ, run } = await claimed({ title: 'A社 初回の商談' })
    await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9 })
    db.prepare('INSERT INTO notifications (company_id, id, user_id, kind, record_id, record_version, action, actor_id, actor_kind, dedupe_key, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)')
      .run(CO, 'n-not-declined', ALICE, 'job_set_declined', '', 0, '', `job_set_declined:${job}:${occ}`, new Date().toISOString())
    expect((await as(ALICE, 'GET', '/me/notifications')).body.data.items.some((i: Json) => i.kind === 'job_set_declined')).toBe(false)
  })

  it('never shown to anyone but the occurrence’s responsible person (the same row under the owner’s or bob’s name shows nothing)', async () => {
    const { run } = await claimed({ title: 'A社 初回の商談' })
    await finish(run, { decision: 'decline', reason: 'introduction', confidence: 0.8 })
    const row = db.prepare("SELECT * FROM notifications WHERE company_id = ? AND kind = 'job_set_declined'").get(CO) as Json
    for (const who of ['ss-owner', BOB]) {
      db.prepare('INSERT INTO notifications (company_id, id, user_id, kind, record_id, record_version, action, actor_id, actor_kind, dedupe_key, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)')
        .run(CO, `n-copy-${who}`, who, row.kind, '', 0, '', row.dedupe_key, row.created_at)
      expect((await as(who, 'GET', '/me/notifications')).body.data.items.some((i: Json) => i.kind === 'job_set_declined')).toBe(false)
    }
  })
})

describe('corrections of a judgement (§5-2, POST /me/job-occurrences/:id/feedback)', () => {
  const press = (who: string, occ: string, kind: unknown) => as(who, 'POST', `/me/job-occurrences/${occ}/feedback`, { kind })

  it('only alice while the occurrence is hers to see: bob, the owner, an admin, and alice off the meeting get the one 404', async () => {
    const { occ, run, meeting: m } = await claimed()
    await finish(run, { decision: 'decline', reason: 'introduction', confidence: 0.8 })
    for (const who of [BOB, 'ss-owner', 'ss-admin']) expect(await press(who, occ, 'made_anyway')).toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } })
    takeOff(m)
    expect(await press(ALICE, occ, 'made_anyway')).toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } })
    expect(feedbackRows()).toEqual([])
  })

  it('once per kind: the occurrence, the kind and the time only (never who); her view carries the judgement and it', async () => {
    const { occ, run } = await claimed()
    await finish(run, { decision: 'ask', reason: 'requested', confidence: 0.5 })
    expect(await press(ALICE, occ, 'went_ahead')).toMatchObject({ status: 201, body: { data: { recorded: true } } })
    expect(await press(ALICE, occ, 'went_ahead')).toMatchObject({ status: 200, body: { data: { recorded: false } } })
    const rows = feedbackRows()
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]).sort()).toEqual(['at', 'company_id', 'kind', 'occurrence_id'])
    const mine = (await as(ALICE, 'GET', '/me/job-occurrences')).body.data.occurrences
    expect(mine).toEqual([expect.objectContaining({ id: occ, report: { decision: 'ask', reason: 'requested', confidence: 0.5, unconfirmed: [], updates: 0, feedback: ['went_ahead'] } })])
  })

  it('a correction must answer the judgement; none before a judgement; a kind not in the list is 400', async () => {
    const { occ, run } = await claimed()
    expect(await press(ALICE, occ, 'too_early')).toMatchObject({ status: 409, body: { code: 'JOB_FEEDBACK_NO_REPORT' } })
    await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9 })
    expect(await press(ALICE, occ, 'made_anyway')).toMatchObject({ status: 409, body: { code: 'JOB_FEEDBACK_NOT_FOR_DECISION' } })
    expect(await press(ALICE, occ, 'went_ahead')).toMatchObject({ status: 409, body: { code: 'JOB_FEEDBACK_NOT_FOR_DECISION' } })
    expect(await press(ALICE, occ, 'A社は来月')).toMatchObject({ status: 400, body: { code: 'BAD_FEEDBACK' } })
    expect((await press(ALICE, occ, 'too_early')).status).toBe(201)
  })

  it('her own view shows no judgement once the occurrence is no longer hers to see', async () => {
    const { run, meeting: m } = await claimed()
    await finish(run, { decision: 'proceed', reason: 'requested', confidence: 0.9 })
    expect((await as(ALICE, 'GET', '/me/job-occurrences')).body.data.occurrences[0].report).toMatchObject({ decision: 'proceed' })
    takeOff(m)
    expect(JSON.stringify((await as(ALICE, 'GET', '/me/job-occurrences')).body.data)).not.toMatch(/requested|proceed/)
  })
})
