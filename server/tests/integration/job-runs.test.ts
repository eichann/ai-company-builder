/**
 * Integration Test: a PC job's claim and the grant at every call (定期の仕事, placement `a`, B PR 5a; jobs.md
 * "The PC's claim"). The AI never runs here (nor on any server): the responsible person's app claims the
 * occurrence's run, its record token is scoped to the job's grant at every call, and the finish makes the one
 * やること. The company has no shared folder, so its Skill is pinned from the Skill shelf.
 *
 * Guards (each mutation-checked, listed in jobs.md "Tests"):
 * - only the approved version's responsible person lists and claims (another member, an owner, another
 *   company's occurrence: the one 404); the claim makes the occurrence's run (generation 1) and takes it;
 * - the emergency stop answers 503 before anything; the company's jobs stop, a pause, another version
 *   approved, not accepted, expired, absent, a pinned shelf version gone each refuse the claim;
 * - the grant at every call: only routes the grant names within the ceiling (never a create), whatever build
 *   calls; a narrowed right refuses the next call, pauses the job (`OWNER_RIGHTS_CHANGED`, owners / admins
 *   told) and holds the occurrence — also found at the claim; a stop or pause refuses the next call;
 * - the finish: exactly one やること (owner-only, id from the occurrence, key `create_task`), also when finished
 *   twice; `nothing` makes none; no result → nothing changes; a run that went to a person → `needs_person`,
 *   told; a temporary failure leaves it claimable again;
 * - names: the turn's name follows `HIDDEN_JOB_NAME`; the clock expires a run left unfinished past its time;
 * - the server's runner is never starved by PC occurrences.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

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
import { services } from '../../src/composition'
import { createJobOccurrences } from '../../src/services/job-occurrences'
import { createJobService } from '../../src/services/jobs'
import { createServiceRecordWriter } from '../../src/services/record-engine/service-writer'
import { createRecordRunSubjects, runSubjectsByKind } from '../../src/services/run-subjects'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { occurrenceTaskId } from '../../../shared/core/jobs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)
app.route('/api/records-ai', recordsAiRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const MINUTE = 60_000
let CO = ''
let OTHER = ''

async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown; headers?: Record<string, string> }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const as = (user: string, method: string, path: string, body?: unknown, co = CO) => call({ user, method, path: `/api/companies/${co}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => call({ token, method, path: `/api/records-ai${path}`, body, headers })

const owner = (co = CO) => ({ companyId: co, userId: 'jr-owner', role: 'owner' })
const alice = (co = CO) => ({ companyId: co, userId: 'jr-alice', role: 'member' })
const companyData = sqliteCompanyData(db)

/** 人事部: alice reads it, nobody else but owners / admins (a read-restricted department). */
async function restrictHr(aliceReads: boolean) {
  const rules: Json[] = [{ subjectType: 'everyone', canRead: false, canWrite: false }]
  if (aliceReads) rules.push({ subjectType: 'user', subjectId: 'jr-alice', canRead: true, canWrite: true })
  const r = await as('jr-owner', 'PUT', '/permissions/scopes/by-path', { path: '人事部', rules })
  if (r.status !== 200) throw new Error(JSON.stringify(r.body))
}

/** The Skill 面談報告書 on the company's shelf; its current version. */
function publishSkill(co = CO, text = '# 面談報告書\n文字起こしから報告書の下書きを作る。'): { item: string; version: string } {
  const r = services.skillShelf.publish(owner(co), { kind: 'skill', departmentId: null, name: 'interview-report', files: [{ path: 'SKILL.md', base64: Buffer.from(text).toString('base64') }], expectedVersion: currentShelf(co) })
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return { item: r.value.item.id, version: r.value.item.version as string }
}
function currentShelf(co: string): string | null {
  const row = db.prepare("SELECT current_version FROM shelf_items WHERE company_id = ? AND name = 'interview-report'").get(co) as { current_version: string | null } | undefined
  return row?.current_version ?? null
}

function pcJob(item: string, overrides: Record<string, unknown> = {}): Json {
  return {
    schema: 1, name: '面談報告書の下書き', actingUser: 'jr-alice',
    trigger: { every: 'day', at: '09:00', businessDaysOnly: false },
    check: { kind: 'new_files', path: '人事部' },
    run: { kind: 'procedure', procedure: { source: 'shelf_skill', item } },
    placement: 'a',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: {
      tools: ['files_read', 'records'], creates: ['task'], routes: ['POST /item', 'GET /item/:recordId', 'POST /query', 'POST /outbound'],
      reads: { paths: ['人事部'], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 },
    },
    ...overrides,
  }
}

/** Made, approved, accepted by alice; and one `due` occurrence of it now. */
async function runnable(co = CO, overrides: Record<string, unknown> = {}): Promise<{ job: string; occ: string }> {
  const { item } = publishSkill(co)
  const made = await services.jobs.create(owner(co), { definition: pcJob(item, overrides) })
  if (!made.ok) throw new Error(JSON.stringify(made.body))
  const job = made.value.id
  const approved = await services.jobs.approve(owner(co), job, { version: 1 })
  if (!approved.ok) throw new Error(JSON.stringify(approved.body))
  const accepted = await services.jobs.accept(alice(co), job, { version: 1 })
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.body))
  return { job, occ: dueOccurrence(job, co) }
}

let slot = 0
function dueOccurrence(job: string, co = CO, opts: { expiresInMs?: number; version?: number } = {}): string {
  const id = `occ.${(++slot).toString(16).padStart(32, '0')}`
  const now = Date.now()
  db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Asia/Tokyo', ?, ?, 'due', ?, ?)`).run(co, id, job, opts.version ?? 1, `2026-11-${String(10 + (slot % 18)).padStart(2, '0')}T09:${String(slot % 60).padStart(2, '0')}`,
    new Date(now - MINUTE).toISOString(), new Date(now + (opts.expiresInMs ?? 24 * 60 * MINUTE)).toISOString(), new Date(now).toISOString(), new Date(now).toISOString())
  return id
}

const claim = (occurrenceId: string, user = 'jr-alice', deviceId = 'device-alice-1', co = CO) =>
  as(user, 'POST', '/job-run-claims', { occurrenceId, deviceId, conversationId: `conv-${deviceId}`, checks: ['new_files', 'new_meetings'] }, co)
const runOf = (id: string, co = CO) => db.prepare('SELECT state, failure_code, generation, claim_expires_at FROM ai_runs WHERE company_id = ? AND id = ?').get(co, id) as Json
const occOf = (id: string, co = CO) => db.prepare('SELECT state, outcome_code, run_id FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(co, id) as Json
const jobOf = (id: string, co = CO) => db.prepare('SELECT state, paused_reason FROM ai_jobs WHERE company_id = ? AND id = ?').get(co, id) as Json
const tasksOf = (co = CO) => db.prepare("SELECT id, personal_owner FROM records WHERE company_id = ? AND type = 'task'").all(co) as Json[]
const noticesOf = (kind: string, co = CO) => (db.prepare('SELECT user_id FROM notifications WHERE company_id = ? AND kind = ? ORDER BY user_id').all(co, kind) as Json[]).map(n => n.user_id)

async function tokenFor(run: Json, deviceId = 'device-alice-1'): Promise<string> {
  const r = await as('jr-alice', 'POST', '/me/record-tokens', { conversationId: `conv-${deviceId}`, agent: 'claude-code', scope: 'act', run: { id: run.id, generation: run.generation } })
  if (r.status !== 201 && r.status !== 200) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}
const finish = (run: Json, body: Record<string, unknown>) => as('jr-alice', 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, ...body })

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'jr-owner'
  const a = await call({ user: 'jr-owner', method: 'POST', path: '/api/companies', body: { name: 'Job Runs Co', folderKind: 'none' } })
  expect(a.status).toBe(201)
  CO = a.body.data.id
  const b = await call({ user: 'jr-owner', method: 'POST', path: '/api/companies', body: { name: 'Other Job Co', folderKind: 'none' } })
  OTHER = b.body.data.id
  const at = new Date().toISOString()
  for (const co of [CO, OTHER]) {
    for (const [user, role] of [['jr-alice', 'member'], ['jr-bob', 'member'], ['jr-admin', 'admin']]) {
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${user}`, user, co, role, at, at)
    }
  }
  vi.useFakeTimers({ toFake: ['Date'] })
})

beforeEach(async () => {
  for (const t of ['ai_job_occurrences', 'ai_job_versions', 'ai_jobs', 'notifications', 'member_absences', 'ai_job_settings', 'agent_stops']) db.prepare(`DELETE FROM ${t}`).run()
  db.prepare("DELETE FROM ai_runs WHERE subject_kind = 'occurrence'").run()
  db.prepare("DELETE FROM record_state WHERE record_id IN (SELECT id FROM records WHERE type = 'task')").run()
  db.prepare("DELETE FROM records WHERE type = 'task'").run()
  for (const co of [CO, OTHER]) {
    currentUser.id = 'jr-owner'
    await restrictHrIn(co)
  }
})
async function restrictHrIn(co: string) {
  const r = await as('jr-owner', 'PUT', '/permissions/scopes/by-path', { path: '人事部', rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'user', subjectId: 'jr-alice', canRead: true, canWrite: true }] }, co)
  if (r.status !== 200) throw new Error(JSON.stringify(r.body))
}

describe('the turns and the claim are the responsible person’s alone', () => {
  it('alice lists her turn with what her app needs; bob, an admin and the owner list nothing and cannot claim', async () => {
    const { job, occ } = await runnable()
    const turns = await as('jr-alice', 'GET', '/me/job-turns')
    expect(turns.status).toBe(200)
    expect(turns.body.data.turns).toEqual([expect.objectContaining({
      occurrenceId: occ, jobId: job, jobVersion: 1, name: '面談報告書の下書き', state: 'due',
      check: { kind: 'new_files', path: '人事部' }, procedure: expect.objectContaining({ source: 'shelf_skill', skill: 'interview-report' }),
      grant: expect.objectContaining({ reads: { paths: ['人事部'], calls: [] } }),
    })])
    for (const user of ['jr-bob', 'jr-admin', 'jr-owner']) {
      expect((await as(user, 'GET', '/me/job-turns')).body.data.turns).toEqual([])
      expect(await claim(occ, user, `device-${user}`)).toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } })
    }
    expect(occOf(occ)).toMatchObject({ state: 'due', run_id: null })
  })

  it('the claim makes the occurrence’s run (generation 1) and takes the occurrence; another PC then gets RUN_CLAIMED', async () => {
    const { job, occ } = await runnable()
    const r = await claim(occ)
    expect(r.status).toBe(201)
    expect(r.body.data.run).toMatchObject({ step: 'job-procedure', generation: 1, recordId: '', subject: { kind: 'occurrence', id: occ }, state: 'running' })
    expect(r.body.data.run.procedure).toMatchObject({ step: 'job-procedure', job: { id: job, version: 1 } })
    expect(r.body.data.turn).toMatchObject({ occurrenceId: occ, state: 'running' })
    expect(occOf(occ)).toEqual({ state: 'running', outcome_code: null, run_id: r.body.data.run.id })
    expect(await claim(occ, 'jr-alice', 'device-alice-2')).toMatchObject({ status: 409, body: { code: 'RUN_CLAIMED' } })
    // A held run is not a turn to claim again.
    expect((await as('jr-alice', 'GET', '/me/job-turns')).body.data.turns).toEqual([])
  })

  it('another company’s occurrence is the same 404, and nothing of it changes', async () => {
    const theirs = await runnable(OTHER)
    expect(await claim(theirs.occ)).toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } })
    expect(occOf(theirs.occ, OTHER)).toMatchObject({ state: 'due', run_id: null })
    expect((db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE subject_kind = 'occurrence'").get() as Json).n).toBe(0)
  })

  it('the record claim never takes an occurrence; a record run’s finish takes no jobResult', async () => {
    const { occ } = await runnable()
    expect((await as('jr-alice', 'POST', '/ai-run-claims', { recordId: occ, step: 'job-procedure', deviceId: 'device-alice-1', conversationId: 'c-1' })).status).toBe(400)
    expect(occOf(occ).state).toBe('due')
  })
})

describe('what refuses a claim', () => {
  it('the emergency stop: 503 before anything is read or written', async () => {
    const { occ } = await runnable()
    expect(services.agentStops.stop(owner(), { userId: 'jr-alice' }).ok).toBe(true)
    expect(await claim(occ)).toMatchObject({ status: 503, body: { code: 'AI_STOPPED' } })
    expect(occOf(occ)).toMatchObject({ state: 'due', run_id: null })
  })

  it('the company’s jobs stop, a pause, another approved version, an expired occurrence', async () => {
    const stopped = await runnable()
    expect(services.jobs.setStopped(owner(), { stopped: true }).ok).toBe(true)
    // The stop held it already; and a running one is refused on its re-claim (below).
    expect(await claim(stopped.occ)).toMatchObject({ status: 409, body: { code: 'JOB_TURN_GONE' } })
    services.jobs.setStopped(owner(), { stopped: false })

    const paused = await runnable()
    const occ2 = dueOccurrence(paused.job)
    db.prepare("UPDATE ai_jobs SET state = 'paused', paused_reason = 'ADMIN' WHERE company_id = ? AND id = ?").run(CO, paused.job)
    expect(await claim(occ2)).toMatchObject({ status: 409, body: { code: 'JOB_PAUSED' } })

    const changed = await runnable()
    db.prepare('UPDATE ai_jobs SET approved_version = 2 WHERE company_id = ? AND id = ?').run(CO, changed.job)
    expect(await claim(changed.occ)).toMatchObject({ status: 409, body: { code: 'JOB_VERSION_CHANGED' } })
    expect(occOf(changed.occ)).toMatchObject({ state: 'held', outcome_code: 'JOB_VERSION_CHANGED' })

    const old = await runnable()
    const late = dueOccurrence(old.job, CO, { expiresInMs: -1 })
    expect(await claim(late)).toMatchObject({ status: 409, body: { code: 'JOB_TURN_EXPIRED' } })
    expect((await as('jr-alice', 'GET', '/me/job-turns')).body.data.turns.map((t: Json) => t.occurrenceId)).toEqual([old.occ])
  })

  it('not accepted: the approved version’s consent is not the one alice accepted', async () => {
    const { job, occ } = await runnable()
    db.prepare('UPDATE ai_jobs SET accepted_consent = NULL WHERE company_id = ? AND id = ?').run(CO, job)
    expect(await claim(occ)).toMatchObject({ status: 409, body: { code: 'JOB_NOT_ACCEPTED' } })
  })

  it('absent that day: skipped and told, nobody runs it (D5)', async () => {
    const { occ } = await runnable()
    db.prepare(`INSERT INTO member_absences (company_id, id, user_id, from_day, until_day, delegate_id, set_by, set_at) VALUES (?, 'abs-jr', 'jr-alice', '2026-01-01', '2026-12-31', 'jr-bob', 'jr-alice', ?)`).run(CO, new Date().toISOString())
    expect(await claim(occ)).toMatchObject({ status: 409, body: { code: 'JOB_OWNER_ABSENT' } })
    expect(occOf(occ)).toMatchObject({ state: 'skipped', outcome_code: 'OWNER_ABSENT' })
    expect(noticesOf('job_skipped')).toEqual(['jr-alice', 'jr-owner'])
    expect(await claim(occ, 'jr-bob', 'device-bob')).toMatchObject({ status: 404 })
  })

  it('the pinned shelf version removed: JOB_SKILL_MISSING, nothing claimed', async () => {
    const { occ } = await runnable()
    const pinned = (db.prepare('SELECT definition FROM ai_job_versions WHERE company_id = ?').get(CO) as Json).definition
    const { item, fingerprint } = JSON.parse(pinned).run.procedure
    publishSkill(CO, '# 面談報告書\n新しい手順。')
    expect(services.skillShelf.removeVersion(owner(), item, fingerprint).ok).toBe(true)
    expect(await claim(occ)).toMatchObject({ status: 409, body: { code: 'JOB_SKILL_MISSING' } })
    expect(occOf(occ).state).toBe('due')
  })

  it('rights narrowed before the claim: refused, the job paused (OWNER_RIGHTS_CHANGED, owners / admins told), the occurrence held', async () => {
    const { job, occ } = await runnable()
    await restrictHr(false)
    expect((await as('jr-alice', 'GET', '/me/job-turns')).body.data.turns).toEqual([])
    expect(await claim(occ)).toMatchObject({ status: 409, body: { code: 'JOB_GRANT_EXCEEDS' } })
    expect(jobOf(job)).toEqual({ state: 'paused', paused_reason: 'OWNER_RIGHTS_CHANGED' })
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'OWNER_RIGHTS_CHANGED' })
    expect(noticesOf('job_paused')).toEqual(['jr-admin', 'jr-owner'])
  })
})

describe('the grant at every call', () => {
  it('only the routes the grant names within the ceiling — never a create — whatever build calls', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    expect((await ai(token, 'GET', '/types')).status).toBe(200)
    expect((await ai(token, 'POST', '/query', { type: 'task' })).status).toBe(200)
    // Granted on paper, but a run's token never creates (the finish makes the one やること).
    expect(await ai(token, 'POST', '/item', { type: 'task', title: 'x' }, { 'Idempotency-Key': 'k-1' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    // An outbound route without `draft_only`, and a route the grant does not name.
    expect(await ai(token, 'POST', '/outbound', {}, { 'Idempotency-Key': 'k-2' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    expect(await ai(token, 'GET', '/my-turn')).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    // An old build is scoped all the same (no released-app gate for a job's run).
    expect(await ai(token, 'GET', '/my-turn', undefined, { 'X-ACB-Client-Version': '0.1.0+aaaaaaa 2026-01-01' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    expect(tasksOf()).toEqual([])
  })

  it('rights narrowed while it runs: the next call is refused, the job paused and owners / admins told, the occurrence held', async () => {
    const { job, occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    expect((await ai(token, 'POST', '/query', { type: 'task' })).status).toBe(200)
    await restrictHr(false)
    expect(await ai(token, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    expect(jobOf(job)).toEqual({ state: 'paused', paused_reason: 'OWNER_RIGHTS_CHANGED' })
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'OWNER_RIGHTS_CHANGED' })
    expect(noticesOf('job_paused')).toEqual(['jr-admin', 'jr-owner'])
    // Its run was ended with it: the finish is refused and makes nothing.
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書の下書き' } })).status).toBe(409)
    expect(tasksOf()).toEqual([])
  })

  it('a pause holds a running occurrence and ends its run: nothing comes back after resuming (claim, pause, call, resume, call, finish)', async () => {
    const { job, occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    expect((await ai(token, 'POST', '/query', { type: 'task' })).status).toBe(200)
    expect(services.jobs.pause(owner(), job).ok).toBe(true)
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'JOB_PAUSED' })
    expect(runOf(run.id)).toMatchObject({ state: 'waiting_person', failure_code: 'JOB_PAUSED' })
    expect(await ai(token, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 409, body: { code: 'RUN_SUPERSEDED' } })
    expect((await services.jobs.resume(owner(), job)).ok).toBe(true)
    // Resumed: the same token, the finish, a renew and a later claim all stay refused; nothing is made.
    expect(await ai(token, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 409, body: { code: 'RUN_SUPERSEDED' } })
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書の下書き' } })).status).toBe(409)
    expect((await as('jr-alice', 'POST', `/ai-runs/${run.id}/renew`, { generation: run.generation })).status).toBe(409)
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    expect(await claim(occ, 'jr-alice', 'device-alice-2')).toMatchObject({ status: 409, body: { code: 'JOB_TURN_GONE' } })
    // 「もう一度」 of the ended run gives it back, and still nothing claims the held occurrence.
    expect((await as('jr-alice', 'POST', `/ai-runs/${run.id}/retry`)).status).toBe(200)
    expect(await claim(occ, 'jr-alice', 'device-alice-3')).toMatchObject({ status: 409, body: { code: 'JOB_TURN_GONE' } })
    vi.setSystemTime(Date.now() - 6 * MINUTE)
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'JOB_PAUSED' })
    expect(tasksOf()).toEqual([])
  })

  it('a pause also ends a run waiting to be retried later, and marks an outside operation still in flight unknown', async () => {
    const waiting = await runnable()
    const run = (await claim(waiting.occ)).body.data.run
    expect((await finish(run, { outcome: 'failed', failure: { class: 'temporary', code: 'OFFLINE' } })).status).toBe(200)
    expect(runOf(run.id).state).toBe('retry_later')
    expect(services.jobs.pause(owner(), waiting.job).ok).toBe(true)
    expect(occOf(waiting.occ)).toMatchObject({ state: 'held', outcome_code: 'JOB_PAUSED' })
    expect(runOf(run.id)).toMatchObject({ state: 'waiting_person', failure_code: 'JOB_PAUSED' })

    const inFlight = await runnable()
    const run2 = (await claim(inFlight.occ, 'jr-alice', 'device-alice-2')).body.data.run
    const at = new Date().toISOString()
    db.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, created_at, updated_at)
      VALUES (?, ?, 'draft-1', 'f', 'outbound', 'in_progress', 1, ?, ?)`).run(CO, run2.id, at, at)
    expect(services.jobs.pause(owner(), inFlight.job).ok).toBe(true)
    expect((db.prepare("SELECT state FROM ai_run_operations WHERE company_id = ? AND run_id = ? AND key = 'draft-1'").get(CO, run2.id) as Json).state).toBe('unknown')
    expect(runOf(run2.id)).toMatchObject({ state: 'waiting_reconcile', failure_code: 'JOB_PAUSED' })

    // A run open again after a person reconciled its operation (its occurrence still running) is ended too.
    const reopened = await runnable()
    const run3 = (await claim(reopened.occ, 'jr-alice', 'device-alice-3')).body.data.run
    db.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, created_at, updated_at)
      VALUES (?, ?, 'draft-2', 'f', 'outbound', 'unknown', 1, ?, ?)`).run(CO, run3.id, at, at)
    expect((await finish(run3, { outcome: 'done', jobResult: 'nothing' })).status).toBe(200)
    expect((await as('jr-alice', 'POST', `/ai-runs/${run3.id}/operations/draft-2/reconcile`, { done: true })).status).toBe(200)
    expect(runOf(run3.id).state).toBe('open')
    expect(services.jobs.pause(owner(), reopened.job).ok).toBe(true)
    expect(runOf(run3.id)).toMatchObject({ state: 'waiting_person', failure_code: 'JOB_PAUSED' })
  })

  it('the company’s jobs stop holds a running occurrence and ends its run; lifting it brings nothing back', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    services.jobs.setStopped(owner(), { stopped: true })
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'COMPANY_STOPPED' })
    services.jobs.setStopped(owner(), { stopped: false })
    expect(await ai(token, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 409, body: { code: 'RUN_SUPERSEDED' } })
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書の下書き' } })).status).toBe(409)
    expect(tasksOf()).toEqual([])
  })

  it('a stop or a pause written without holding (an older build) still refuses the next call, the re-claim and the finish', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    db.prepare('INSERT OR REPLACE INTO ai_job_settings (company_id, stopped, updated_by, updated_at) VALUES (?, 1, ?, ?)').run(CO, 'jr-owner', new Date().toISOString())
    expect(await ai(token, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    expect(await claim(occ, 'jr-alice', 'device-alice-2')).toMatchObject({ status: 409, body: { code: 'JOB_STOPPED' } })
    vi.setSystemTime(Date.now() - 6 * MINUTE)
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書の下書き' } })).status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'COMPANY_STOPPED' })
    expect(tasksOf()).toEqual([])
    db.prepare('DELETE FROM ai_job_settings WHERE company_id = ?').run(CO)

    const paused = await runnable()
    const run2 = (await claim(paused.occ)).body.data.run
    const token2 = await tokenFor(run2)
    db.prepare("UPDATE ai_jobs SET state = 'paused', paused_reason = 'ADMIN' WHERE company_id = ? AND id = ?").run(CO, paused.job)
    expect(await ai(token2, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
  })

  it('rights narrowed by the time of the finish (no call in between): nothing made, the job paused and owners / admins told', async () => {
    const { job, occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    await restrictHr(false)
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書の下書き' } })).status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'OWNER_RIGHTS_CHANGED' })
    expect(jobOf(job)).toEqual({ state: 'paused', paused_reason: 'OWNER_RIGHTS_CHANGED' })
    expect(noticesOf('job_paused')).toEqual(['jr-admin', 'jr-owner'])
    expect(tasksOf()).toEqual([])
  })

  it('a token binds only to the run of a PC job (the server’s own run of a job binds none)', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    db.prepare("UPDATE ai_runs SET step = 'job-operation' WHERE company_id = ? AND id = ?").run(CO, run.id)
    const r = await as('jr-alice', 'POST', '/me/record-tokens', { conversationId: 'conv-device-alice-1', agent: 'claude-code', scope: 'act', run: { id: run.id, generation: 1 } })
    expect(r).toMatchObject({ status: 404, body: { code: 'RUN_NOT_FOUND' } })
  })
})

describe('the finish', () => {
  it('exactly one やること, owner-only for alice, its id from the occurrence — also when finished twice', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    const done = await finish(run, { outcome: 'done', jobResult: { title: 'A社の面談報告書（下書き）', summary: '人事部/.personal/reports/ に置きました' } })
    expect(done.status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'done', run_id: run.id })
    expect(tasksOf()).toEqual([{ id: occurrenceTaskId(occ), personal_owner: 'jr-alice' }])
    expect(db.prepare("SELECT key, state, ref_id FROM ai_run_operations WHERE company_id = ? AND run_id = ?").all(CO, run.id)).toEqual([{ key: 'create_task', state: 'done', ref_id: occurrenceTaskId(occ) }])
    expect(await finish(run, { outcome: 'done', jobResult: { title: 'もう一度' } })).toMatchObject({ status: 409, body: { code: 'RUN_SUPERSEDED' } })
    expect(tasksOf()).toHaveLength(1)
    // Nobody else sees it, owners included.
    expect((await as('jr-owner', 'GET', `/records/item/${occurrenceTaskId(occ)}`)).status).toBe(404)
  })

  it('nothing new: `nothing`, no やること; no result at all: refused and nothing changes', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    expect(await finish(run, { outcome: 'done' })).toMatchObject({ status: 400, body: { code: 'JOB_RESULT_REQUIRED' } })
    expect(occOf(occ).state).toBe('running')
    expect((db.prepare('SELECT state FROM ai_runs WHERE company_id = ? AND id = ?').get(CO, run.id) as Json).state).toBe('running')
    expect((await finish(run, { outcome: 'done', jobResult: 'nothing' })).status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'nothing' })
    expect(tasksOf()).toEqual([])
  })

  it('a run that went to a person: needs_person RUN_FAILED, told; a temporary failure is claimable again later', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    expect((await finish(run, { outcome: 'failed', failure: { class: 'bad-input', code: 'NO_TRANSCRIPT' } })).status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RUN_FAILED' })
    expect(noticesOf('job_failed')).toEqual(['jr-alice', 'jr-owner'])

    const again = await runnable()
    const first = (await claim(again.occ)).body.data.run
    expect((await finish(first, { outcome: 'failed', failure: { class: 'temporary', code: 'OFFLINE' } })).status).toBe(200)
    expect(occOf(again.occ).state).toBe('running')
    expect((await as('jr-alice', 'GET', '/me/job-turns')).body.data.turns).toEqual([])
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    expect((await as('jr-alice', 'GET', '/me/job-turns')).body.data.turns.map((t: Json) => [t.occurrenceId, t.state])).toEqual([[again.occ, 'running']])
    const second = await claim(again.occ, 'jr-alice', 'device-alice-2')
    expect(second.body.data.run).toMatchObject({ id: first.id, generation: 2 })
    vi.setSystemTime(Date.now() - 6 * MINUTE)
  })

  it('a grant that creates nothing makes no やること: such a result is refused and nothing changes', async () => {
    const { occ } = await runnable(CO, { grant: { ...pcJob('x').grant, tools: ['files_read'], creates: [], routes: [] } })
    const run = (await claim(occ)).body.data.run
    expect(await finish(run, { outcome: 'done', jobResult: { title: '報告書' } })).toMatchObject({ status: 400, body: { code: 'JOB_TASK_NOT_GRANTED' } })
    expect(occOf(occ).state).toBe('running')
    expect(tasksOf()).toEqual([])
  })

  it('records off at the finish: the run ends, needs_person RECORDS_OFF, told — never left running', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    db.prepare('UPDATE record_settings SET enabled = 0 WHERE company_id = ?').run(CO)
    try {
      expect(await finish(run, { outcome: 'done', jobResult: { title: '報告書' } })).toMatchObject({ status: 409, body: { code: 'RECORDS_DISABLED' } })
    } finally {
      db.prepare('UPDATE record_settings SET enabled = 1 WHERE company_id = ?').run(CO)
    }
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RECORDS_OFF' })
    expect(runOf(run.id)).toMatchObject({ state: 'waiting_person', failure_code: 'RECORDS_OFF' })
    expect(noticesOf('job_failed')).toEqual(['jr-alice', 'jr-owner'])
    expect(tasksOf()).toEqual([])
  })

  it('a record run’s finish takes no jobResult', async () => {
    const t = await as('jr-alice', 'POST', '/records/item', { type: 'task', title: '準備', state: 'preparing', fields: { assignee: 'jr-alice' } })
    const run = (await as('jr-alice', 'POST', '/ai-run-claims', { recordId: t.body.data.record.id, step: 'task-prep', deviceId: 'device-rec-1', conversationId: 'c-rec' })).body.data.run
    expect((await finish(run, { outcome: 'done', jobResult: 'nothing' })).status).toBe(400)
  })
})

describe('names, the clock and the runner', () => {
  it('the turn’s name is 「定期の仕事」 while the newest version names a place alice cannot read', async () => {
    const { job, item } = await (async () => { const r = await runnable(); return { ...r, item: JSON.parse((db.prepare('SELECT definition FROM ai_job_versions WHERE company_id = ?').get(CO) as Json).definition).run.procedure.item } })()
    const edited = await services.jobs.update(owner(), job, { definition: pcJob(item, { name: '経理部の面談', check: { kind: 'new_files', path: '経理部' }, grant: { ...pcJob(item).grant, reads: { paths: ['経理部'], calls: [] } } }) })
    expect(edited.ok).toBe(true)
    const r = await as('jr-owner', 'PUT', '/permissions/scopes/by-path', { path: '経理部', rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }] })
    expect(r.status).toBe(200)
    expect((await as('jr-alice', 'GET', '/me/job-turns')).body.data.turns.map((t: Json) => t.name)).toEqual(['定期の仕事'])
  })

  it('the clock expires a run left unfinished past its time (not one still held), and tells', async () => {
    const { occ } = await runnable()
    const held = await runnable()
    const occurrences = createJobOccurrences({
      companyData, transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
      timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf: (co, user) => sqliteMembershipRepository(db).roleOf(co, user),
      jobs: services.jobs, writer: { check: () => null, create: () => { throw new Error('no task') } }, log: () => {},
    })
    await claim(occ)
    await claim(held.occ, 'jr-alice', 'device-alice-3')
    db.prepare('UPDATE ai_job_occurrences SET expires_at = ? WHERE company_id = ?').run(new Date(Date.now() - 1).toISOString(), CO)
    // alice's first claim's lease ran out; the other is renewed to stay held.
    db.prepare("UPDATE ai_runs SET claim_expires_at = ? WHERE company_id = ? AND record_id = ?").run(new Date(Date.now() - 1).toISOString(), CO, occ)
    occurrences.makeOccurrences(CO)
    expect(occOf(occ)).toMatchObject({ state: 'expired', outcome_code: 'EXPIRED' })
    // Its run is ended too: nothing may claim or finish it later.
    expect(runOf(occOf(occ).run_id)).toMatchObject({ state: 'waiting_person', failure_code: 'EXPIRED' })
    expect(occOf(held.occ).state).toBe('running')
    expect(noticesOf('job_expired')).toEqual(['jr-alice', 'jr-owner'])
  })

  it('a run whose occurrence ended (expired by the clock while its run still says running) reaches nothing', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    expect((await ai(token, 'POST', '/query', { type: 'task' })).status).toBe(200)
    db.prepare("UPDATE ai_job_occurrences SET state = 'expired', outcome_code = 'EXPIRED' WHERE company_id = ? AND id = ?").run(CO, occ)
    expect(await ai(token, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
  })

  it('a run of a kind with no resolver reaches no route', () => {
    const byKind = runSubjectsByKind({ record: createRecordRunSubjects({ aiTurnOf: () => 'not-found' }) })
    expect(byKind.routeRefusal?.({ companyId: CO, userId: 'jr-alice', role: 'member' }, { id: 'r', subject: { kind: 'occurrence', id: 'occ.x' }, step: 'job-procedure', userId: 'jr-alice', state: 'running' }, 'GET /types'))
      .toMatchObject({ ok: false, body: { code: 'NOT_IN_STEP' } })
    expect(byKind.bindsTokens?.({ id: 'r', subject: { kind: 'occurrence', id: 'occ.x' }, step: 'job-procedure', userId: 'jr-alice', state: 'running' })).toBe(false)
  })

  it('PC occurrences never take the server runner’s places', async () => {
    const { job } = await runnable()
    for (let i = 0; i < 55; i++) dueOccurrence(job)
    const serverJob = await services.jobs.create(owner(), { definition: {
      schema: 1, name: '週の報告', actingUser: 'jr-alice', trigger: { every: 'day', at: '09:00', businessDaysOnly: false }, check: { kind: 'none' },
      run: { kind: 'operation', operation: 'create_task', title: '週の報告を書く', dueBusinessDays: null }, placement: 'e',
      missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
      grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 1, runsPerDay: 1 } },
    } })
    if (!serverJob.ok) throw new Error(JSON.stringify(serverJob.body))
    const serverOcc = dueOccurrence(serverJob.value.id)
    db.prepare('UPDATE ai_job_occurrences SET due_at = ? WHERE company_id = ? AND id = ?').run(new Date(Date.now()).toISOString(), CO, serverOcc)
    const occurrences = createJobOccurrences({
      companyData, transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
      timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf: (co, user) => sqliteMembershipRepository(db).roleOf(co, user),
      jobs: createJobService({ companyData, memberships: sqliteMembershipRepository(db), transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds, skillTree: async () => null, hasCompanyFolder: () => false }),
      writer: { check: () => null, create: () => { throw new Error('unused') } }, log: () => {},
    })
    expect(occurrences.dueIds(CO)).toEqual([serverOcc])
    // And a server job's occurrence is nobody's to claim from a PC (alice is its responsible person).
    expect(await claim(serverOcc)).toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } })
  })
})

describe('a Skill pinned from the Skill shelf (a company without the shared folder)', () => {
  const withFolder = () => createJobService({
    companyData, memberships: sqliteMembershipRepository(db), transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
    skillTree: async () => 'a'.repeat(40), hasCompanyFolder: () => true, shelfSkill: (who, id, v) => services.skillShelf.jobSkill(who, id, v),
  })

  it('the server fills the shelf Skill’s name and current version (never the caller’s); a company Skill is refused here, a shelf Skill where the folder is', async () => {
    const { item, version } = publishSkill()
    const pinned = { kind: 'procedure', procedure: { source: 'shelf_skill', item, skill: 'interview-report', fingerprint: version } }
    const made = await services.jobs.create(owner(), { definition: pcJob(item) })
    expect(made.ok && made.value.versions?.[0].definition?.run).toEqual(pinned)
    const forged = await services.jobs.create(owner(), { definition: pcJob(item, { run: { kind: 'procedure', procedure: { source: 'shelf_skill', item, skill: 'other', fingerprint: 'f'.repeat(64) } } }) })
    expect(forged.ok && forged.value.versions?.[0].definition?.run).toEqual(pinned)
    expect(await services.jobs.create(owner(), { definition: pcJob(item, { run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'interview-report' } } }) }))
      .toMatchObject({ ok: false, body: { code: 'JOB_SKILL_NOT_HERE' } })
    expect(await withFolder().create(owner(), { definition: pcJob(item) })).toMatchObject({ ok: false, body: { code: 'JOB_SKILL_NOT_HERE' } })
  })

  it('a shelf Skill at a place the responsible person does not read is not there for them; a version naming one is hidden from them', async () => {
    const accounting = (db.prepare("SELECT id FROM departments WHERE company_id = ? AND folder = '経理部'").get(CO) as Json).id
    const restrict = (bobReads: boolean) => as('jr-owner', 'PUT', '/permissions/scopes/by-path', {
      path: '経理部', rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, ...(bobReads ? [{ subjectType: 'user', subjectId: 'jr-bob', canRead: true, canWrite: false }] : [])],
    })
    expect((await restrict(true)).status).toBe(200)
    const r = services.skillShelf.publish(owner(), { kind: 'skill', departmentId: accounting, name: 'ledger-check', files: [{ path: 'SKILL.md', base64: Buffer.from('# 経理\n帳簿を見る。').toString('base64') }], expectedVersion: null })
    if (!r.ok) throw new Error(JSON.stringify(r.body))
    const item = r.value.item.id
    // alice does not read 経理部: its Skill does not exist for her job.
    expect(await services.jobs.create(owner(), { definition: pcJob(item) })).toMatchObject({ ok: false, body: { code: 'JOB_SKILL_MISSING' } })
    // bob reads 経理部; his job reads 営業部 (everyone's), so only the Skill's place can hide it from him.
    const bobs = await services.jobs.create(owner(), { definition: pcJob(item, {
      actingUser: 'jr-bob', check: { kind: 'new_files', path: '営業部' }, grant: { ...pcJob(item).grant, reads: { paths: ['営業部'], calls: [] } },
    }) })
    if (!bobs.ok) throw new Error(JSON.stringify(bobs.body))
    expect(bobs.value.versions?.[0].definition?.run).toMatchObject({ procedure: { item, skill: 'ledger-check' } })
    // Taken off bob's places: the version naming that Skill is hidden from him, its name too.
    expect((await restrict(false)).status).toBe(200)
    const seen = services.jobs.get({ companyId: CO, userId: 'jr-bob', role: 'member' }, bobs.value.id)
    expect(seen.ok && seen.value.versions?.map(v => v.definition)).toEqual([null])
    expect(seen.ok && seen.value.name).toBe('定期の仕事')
  })

  it('approval refuses a shelf Skill changed since the version was made', async () => {
    const { item } = publishSkill()
    const made = await services.jobs.create(owner(), { definition: pcJob(item) })
    if (!made.ok) throw new Error(JSON.stringify(made.body))
    publishSkill(CO, '# 面談報告書\n変えた手順。')
    expect(await services.jobs.approve(owner(), made.value.id, { version: 1 })).toMatchObject({ ok: false, body: { code: 'JOB_SKILL_CHANGED' } })
  })
})

describe('the approved minutes are a hard deadline from the first claim', () => {
  const short = () => runnable(CO, { grant: { ...pcJob('x').grant, limits: { minutes: 1, runsPerDay: 1 } } })

  it('renewing never moves it: after it the next call is refused, the run ended, needs_person TIME_LIMIT and told; renew and finish refused', async () => {
    const { occ } = await short()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    vi.setSystemTime(Date.now() + 40_000)
    expect((await as('jr-alice', 'POST', `/ai-runs/${run.id}/renew`, { generation: run.generation })).status).toBe(200)
    expect((await ai(token, 'POST', '/query', { type: 'task' })).status).toBe(200)
    vi.setSystemTime(Date.now() + 40_000)
    // Renewed past the deadline: the lease is still the app's, the deadline is not.
    expect((await as('jr-alice', 'POST', `/ai-runs/${run.id}/renew`, { generation: run.generation })).status).toBe(200)
    expect(await ai(token, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'TIME_LIMIT' })
    expect(runOf(run.id)).toMatchObject({ state: 'waiting_person', failure_code: 'TIME_LIMIT' })
    expect(noticesOf('job_failed')).toEqual(['jr-alice', 'jr-owner'])
    expect((await as('jr-alice', 'POST', `/ai-runs/${run.id}/renew`, { generation: run.generation })).status).toBe(409)
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書' } })).status).toBe(409)
    vi.setSystemTime(Date.now() - 80_000)
    expect(tasksOf()).toEqual([])
  })

  it('a finish after it is refused (JOB_TIME_LIMIT) and makes nothing, with no call in between', async () => {
    const { occ } = await short()
    const run = (await claim(occ)).body.data.run
    vi.setSystemTime(Date.now() + 2 * MINUTE)
    expect(await finish(run, { outcome: 'done', jobResult: { title: '報告書' } })).toMatchObject({ status: 409, body: { code: 'JOB_TIME_LIMIT' } })
    vi.setSystemTime(Date.now() - 2 * MINUTE)
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'TIME_LIMIT' })
    expect(runOf(run.id).state).toBe('waiting_person')
    expect(tasksOf()).toEqual([])
  })

  it('a re-claim keeps the first claim’s deadline (after a temporary failure)', async () => {
    const { occ } = await short()
    const run = (await claim(occ)).body.data.run
    expect((await finish(run, { outcome: 'failed', failure: { class: 'temporary', code: 'OFFLINE' } })).status).toBe(200)
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    expect((await as('jr-alice', 'GET', '/me/job-turns')).body.data.turns).toEqual([])
    expect(await claim(occ, 'jr-alice', 'device-alice-2')).toMatchObject({ status: 409, body: { code: 'JOB_TIME_LIMIT' } })
    vi.setSystemTime(Date.now() - 6 * MINUTE)
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'TIME_LIMIT' })
  })

  it('the clock ends a run past its deadline even while its app renews it', async () => {
    const { occ } = await short()
    const run = (await claim(occ)).body.data.run
    vi.setSystemTime(Date.now() + 2 * MINUTE)
    expect((await as('jr-alice', 'POST', `/ai-runs/${run.id}/renew`, { generation: run.generation })).status).toBe(200)
    occurrencesNow().makeOccurrences(CO)
    vi.setSystemTime(Date.now() - 2 * MINUTE)
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'TIME_LIMIT' })
    expect(runOf(run.id)).toMatchObject({ state: 'waiting_person', failure_code: 'TIME_LIMIT' })
  })
})

describe('a run waiting for a person to reconcile an outside operation', () => {
  it('stays while in time; out of time it is needs_person RESULT_UNKNOWN and told — never expired as if nothing had happened', async () => {
    const { occ } = await runnable()
    const run = (await claim(occ)).body.data.run
    const at = new Date().toISOString()
    db.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, created_at, updated_at)
      VALUES (?, ?, 'draft-1', 'f', 'outbound', 'unknown', 1, ?, ?)`).run(CO, run.id, at, at)
    expect((await finish(run, { outcome: 'done', jobResult: 'nothing' })).status).toBe(200)
    expect(runOf(run.id).state).toBe('waiting_reconcile')
    expect(occOf(occ).state).toBe('running')
    occurrencesNow().makeOccurrences(CO)
    expect(occOf(occ).state).toBe('running')
    db.prepare('UPDATE ai_job_occurrences SET expires_at = ? WHERE company_id = ? AND id = ?').run(new Date(Date.now() - 1).toISOString(), CO, occ)
    occurrencesNow().makeOccurrences(CO)
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RESULT_UNKNOWN' })
    expect(runOf(run.id).state).toBe('waiting_reconcile')
    expect(noticesOf('job_failed')).toEqual(['jr-alice', 'jr-owner'])
    expect(noticesOf('job_expired')).toEqual([])
  })
})

describe('the app says which checks it runs (B PR 5a-2)', () => {
  it('a claim that does not name the occurrence’s check (an older app, or a newer check) is refused and nothing is written', async () => {
    const { occ } = await runnable()
    for (const checks of [undefined, [], ['new_meetings']]) {
      const r = await as('jr-alice', 'POST', '/job-run-claims', { occurrenceId: occ, deviceId: 'device-alice-1', conversationId: 'conv-x', ...(checks ? { checks } : {}) })
      expect(r, JSON.stringify(checks)).toMatchObject({ status: 409, body: { code: 'JOB_CHECK_NOT_SUPPORTED' } })
    }
    expect(occOf(occ)).toMatchObject({ state: 'due', run_id: null })
    expect((db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE subject_kind = 'occurrence'").get() as Json).n).toBe(0)
    expect((await as('jr-alice', 'POST', '/job-run-claims', { occurrenceId: occ, deviceId: 'device-alice-1', conversationId: 'c', checks: 'new_files' })).status).toBe(400)
  })
})

describe('a meeting check: the meetings the responsible person attended, and their minutes only (B PR 5a-2)', () => {
  const meetingWriter = createServiceRecordWriter({
    companyData, transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
    isMember: (co, user) => sqliteMembershipRepository(db).roleOf(co, user) !== null,
    roleOf: (co, user) => sqliteMembershipRepository(db).roleOf(co, user),
    notify: () => {}, recordChanged: () => {},
  })
  const meeting = (title: string, members: string[], at: number) => {
    const r = meetingWriter.create(CO, {
      type: 'meeting', title, members, fields: { assignee: members[0], meeting_at: new Date(at).toISOString() },
      actor: { id: 'acb:minutes', kind: 'external', source: 'minutes' }, quiet: true,
    })
    if (!r.ok) throw new Error(r.reason)
    return r.record.id
  }
  // Each test starts with no meeting (the records of an earlier one are removed, as a deleted record is).
  beforeEach(() => {
    const records = companyData.forCompany(CO).records
    for (const row of db.prepare("SELECT id FROM records WHERE company_id = ? AND type = 'meeting' AND removed_at IS NULL").all(CO) as Json[]) records.markRemoved(row.id, new Date().toISOString())
  })
  const meetingJob = {
    check: { kind: 'new_meetings', titleWords: ['面談'] },
    grant: {
      tools: ['records'], creates: ['task'], routes: ['GET /item/:recordId', 'GET /minutes/:recordId/text'],
      reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 },
    },
  }

  it('the claim answers the meetings found; the run reads those minutes and no other meeting’s', async () => {
    const before = meeting('面談：前の回より前', ['jr-alice'], Date.now() - 60 * MINUTE)
    const { occ } = await runnable(CO, meetingJob)
    vi.setSystemTime(Date.now() + 10 * MINUTE)
    try {
      const found = meeting('面談：佐藤さん', ['jr-alice', 'jr-bob'], Date.now() - 5 * MINUTE)
      const otherWords = meeting('定例', ['jr-alice'], Date.now() - 4 * MINUTE)
      const notHers = meeting('面談：ボブさん', ['jr-bob'], Date.now() - 3 * MINUTE)
      // On the calendar but not held yet: not a meeting since the previous occurrence.
      const later = meeting('面談：来週', ['jr-alice'], Date.now() + 60 * MINUTE)
      const r = await claim(occ)
      expect(r.status).toBe(201)
      expect(r.body.data.turn.meetings).toEqual([{ id: found, title: '面談：佐藤さん', at: expect.any(String) }])
      // The list never carries them (only the claim does).
      const token = await tokenFor(r.body.data.run)
      // Its own meeting reaches the handler (whatever Google answers there); any other is refused before it.
      const own = await ai(token, 'GET', `/minutes/${found}/text`)
      expect(own.body?.code).not.toBe('NOT_IN_STEP')
      for (const other of [before, otherWords, notHers, later]) {
        expect(await ai(token, 'GET', `/minutes/${other}/text`), other).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
      }
      // Never the meeting's other routes.
      expect(await ai(token, 'POST', `/minutes/${found}/bundle`, { bundleId: 'deal-000000' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    } finally {
      vi.setSystemTime(Date.now() - 10 * MINUTE)
    }
  })

  it('nothing found: the claim answers no meetings (the app finishes `nothing` without the AI)', async () => {
    const { occ } = await runnable(CO, meetingJob)
    vi.setSystemTime(Date.now() + 10 * MINUTE)
    try {
      meeting('定例', ['jr-alice'], Date.now() - 5 * MINUTE)
      const r = await claim(occ)
      expect(r.body.data.turn.meetings).toEqual([])
      expect((await finish(r.body.data.run, { outcome: 'done', jobResult: 'nothing' })).status).toBe(200)
      expect(occOf(occ)).toMatchObject({ state: 'nothing' })
      expect(tasksOf()).toEqual([])
    } finally {
      vi.setSystemTime(Date.now() - 10 * MINUTE)
    }
  })
})

function occurrencesNow() {
  return createJobOccurrences({
    companyData, transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
    timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf: (co, user) => sqliteMembershipRepository(db).roleOf(co, user),
    jobs: services.jobs, writer: { check: () => null, create: () => { throw new Error('no task') } }, log: () => {},
  })
}
