/**
 * Integration Test: 「もう一度」 of a scheduled job's occurrence (定期の仕事, B PR 5b; jobs.md "「もう一度」").
 *
 * Guards (each mutation-checked, listed in jobs.md "Tests"):
 * - only an owner / admin presses it (the responsible person who is a member, another member: 403, nothing written);
 *   the 「もう一度」 fields of an occurrence view only for them;
 * - only on `needs_person` / `expired` (due, running, done, skipped, held: 409 `NOT_RETRYABLE`);
 * - only the job's newest occurrence; only while the company's jobs are not stopped, the job active, the same approved
 *   version, accepted, the responsible person's rights and AI not stopped, the pinned Skill kept, the place usable;
 * - 結果が分からないうちは再開しない: an unknown outside operation of its run refuses it until an owner / admin
 *   reconciles it (who, which operation, the body);
 * - the press: the same occurrence `due` with a new deadline and no run, who pressed it kept, its old run closed (its
 *   own 「もう一度」 refused), the responsible person's app claims it as a new run with a fresh hard deadline and the
 *   one やること is still `occurrenceTaskId`; a second failure is told again;
 * - another company's occurrence id answers as one that does not exist.
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
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { jobsRoute } from '../../src/routes/jobs'
import { notificationsRoute } from '../../src/routes/notifications'
import { services } from '../../src/composition'
import { createJobOccurrences } from '../../src/services/job-occurrences'
import { createJobRetry } from '../../src/services/job-retry'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { occurrenceTaskId } from '../../../shared/core/jobs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)
app.route('/api/companies/:companyId', notificationsRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const MINUTE = 60_000
let CO = ''
let OTHER = ''

async function call(opts: { user?: string | null; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const res = await app.request(opts.path, { method: opts.method, headers: { 'Content-Type': 'application/json' }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const as = (user: string, method: string, path: string, body?: unknown, co = CO) => call({ user, method, path: `/api/companies/${co}${path}`, body })

const owner = (co = CO) => ({ companyId: co, userId: 'jy-owner', role: 'owner' })
const alice = (co = CO) => ({ companyId: co, userId: 'jy-alice', role: 'member' })
const companyData = sqliteCompanyData(db)
const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() }

function publishSkill(co = CO): string {
  const current = (db.prepare("SELECT current_version FROM shelf_items WHERE company_id = ? AND name = 'interview-report'").get(co) as Json)?.current_version ?? null
  const r = services.skillShelf.publish(owner(co), { kind: 'skill', departmentId: null, name: 'interview-report', files: [{ path: 'SKILL.md', base64: Buffer.from('# 面談報告書\n').toString('base64') }], expectedVersion: current })
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value.item.id
}

function pcJob(item: string, grant: Record<string, unknown> = {}): Json {
  return {
    schema: 1, name: '面談報告書の下書き', actingUser: 'jy-alice',
    trigger: { every: 'day', at: '09:00', businessDaysOnly: false },
    check: { kind: 'new_files', path: '人事部' },
    run: { kind: 'procedure', procedure: { source: 'shelf_skill', item } },
    placement: 'a',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: {
      tools: ['files_read', 'records'], creates: ['task'], routes: ['GET /item/:recordId'],
      reads: { paths: ['人事部'], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 }, ...grant,
    },
  }
}

/** Made and approved by the owner, accepted by alice (unless `accept` is false). */
async function approvedJob(co = CO, opts: { grant?: Record<string, unknown>; accept?: boolean } = {}): Promise<string> {
  const made = await services.jobs.create(owner(co), { definition: pcJob(publishSkill(co), opts.grant) })
  if (!made.ok) throw new Error(JSON.stringify(made.body))
  const approved = await services.jobs.approve(owner(co), made.value.id, { version: 1 })
  if (!approved.ok) throw new Error(JSON.stringify(approved.body))
  if (opts.accept !== false) {
    const accepted = await services.jobs.accept(alice(co), made.value.id, { version: 1 })
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.body))
  }
  return made.value.id
}

let slot = 0
/** An occurrence of the job in `state` (a later slot each time: the newest is the last one made). */
function occurrence(job: string, state: string, opts: { co?: string; outcome?: string | null; expiresInMs?: number } = {}): string {
  const co = opts.co ?? CO
  const id = `occ.${(++slot).toString(16).padStart(32, '0')}`
  const now = Date.now()
  db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, outcome_code, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, 'Asia/Tokyo', ?, ?, ?, ?, ?, ?)`).run(co, id, job, `2026-${String(1 + Math.floor(slot / 28) % 12).padStart(2, '0')}-${String(1 + (slot % 28)).padStart(2, '0')}T09:00`,
    new Date(now - 2 * MINUTE).toISOString(), new Date(now + (opts.expiresInMs ?? 24 * 60 * MINUTE)).toISOString(), state, opts.outcome ?? null, new Date(now).toISOString(), new Date(now).toISOString())
  return id
}

const claim = (occurrenceId: string, deviceId = 'device-alice-1') =>
  as('jy-alice', 'POST', '/job-run-claims', { occurrenceId, deviceId, conversationId: `conv-${deviceId}`, checks: ['new_files', 'new_meetings'] })
const finish = (run: Json, body: Record<string, unknown>) => as('jy-alice', 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, ...body })
const retry = (user: string, job: string, occ: string, co = CO) => as(user, 'POST', `/jobs/${job}/occurrences/${occ}/retry`, undefined, co)
const reconcile = (user: string, job: string, occ: string, key: string, body: unknown) => as(user, 'POST', `/jobs/${job}/occurrences/${occ}/operations/${key}/reconcile`, body)
const occOf = (id: string, co = CO) => db.prepare('SELECT state, outcome_code, run_id, expires_at, retries, retried_by, retried_at FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(co, id) as Json
const runOf = (id: string) => db.prepare('SELECT id, state, closed_at, generation, created_at FROM ai_runs WHERE company_id = ? AND id = ?').get(CO, id) as Json
const noticesOf = (kind: string) => (db.prepare('SELECT user_id FROM notifications WHERE company_id = ? AND kind = ? ORDER BY user_id').all(CO, kind) as Json[]).map(n => n.user_id)
const occurrenceView = async (user: string, job: string, occ: string) => (await as(user, 'GET', `/jobs/${job}/occurrences`)).body.data.occurrences.find((o: Json) => o.id === occ)

/** A claimed run of a due occurrence finished as failed (bad input): the occurrence `needs_person` `RUN_FAILED`. */
async function failedRun(job: string): Promise<{ occ: string; run: Json }> {
  const occ = occurrence(job, 'due')
  const claimed = await claim(occ)
  if (claimed.status !== 201) throw new Error(JSON.stringify(claimed.body))
  const run = claimed.body.data.run
  expect((await finish(run, { outcome: 'failed', failure: { class: 'bad-input', code: 'NO_INFO' } })).status).toBe(200)
  expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RUN_FAILED' })
  return { occ, run }
}

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'jy-owner'
  const a = await call({ user: 'jy-owner', method: 'POST', path: '/api/companies', body: { name: 'Job Retry Co', folderKind: 'none' } })
  expect(a.status).toBe(201)
  CO = a.body.data.id
  const b = await call({ user: 'jy-owner', method: 'POST', path: '/api/companies', body: { name: 'Other Retry Co', folderKind: 'none' } })
  OTHER = b.body.data.id
  const at = new Date().toISOString()
  for (const co of [CO, OTHER]) {
    for (const [user, role] of [['jy-alice', 'member'], ['jy-bob', 'member'], ['jy-admin', 'admin']]) {
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
  for (const co of [CO, OTHER]) await restrictHr(true, co)
})
async function restrictHr(aliceReads: boolean, co = CO) {
  const rules: Json[] = [{ subjectType: 'everyone', canRead: false, canWrite: false }]
  if (aliceReads) rules.push({ subjectType: 'user', subjectId: 'jy-alice', canRead: true, canWrite: true })
  const r = await as('jy-owner', 'PUT', '/permissions/scopes/by-path', { path: '人事部', rules }, co)
  if (r.status !== 200) throw new Error(JSON.stringify(r.body))
}

describe('who presses 「もう一度」', () => {
  it('an owner or an admin; the responsible person who is a member and another member are refused and nothing changes', async () => {
    const job = await approvedJob()
    const occ = occurrence(job, 'expired', { outcome: 'EXPIRED' })
    for (const user of ['jy-alice', 'jy-bob']) {
      expect(await retry(user, job, occ)).toMatchObject({ status: 403, body: { error: 'Only owners and admins can manage scheduled jobs' } })
      expect(await reconcile(user, job, occ, 'k1', { done: true })).toMatchObject({ status: 403 })
    }
    expect(occOf(occ)).toMatchObject({ state: 'expired', retries: 0 })
    expect(await retry('jy-admin', job, occ)).toMatchObject({ status: 200, body: { data: { occurrence: { id: occ, state: 'due', retries: 1, retriedBy: 'jy-admin' } } } })
  })

  it('the view’s 「もう一度」 fields only for owners / admins: the responsible person sees slots and states only', async () => {
    const job = await approvedJob()
    const occ = occurrence(job, 'needs_person', { outcome: 'RUN_FAILED' })
    expect(await occurrenceView('jy-owner', job, occ)).toMatchObject({ retries: 0, retry: { allowed: true }, unknownOperations: [] })
    const hers = await occurrenceView('jy-alice', job, occ)
    expect(hers).toMatchObject({ id: occ, state: 'needs_person' })
    for (const k of ['retry', 'retries', 'retriedBy', 'unknownOperations']) expect(hers).not.toHaveProperty(k)
  })

  it('another company’s occurrence, or another job’s, answers as one that does not exist', async () => {
    const job = await approvedJob()
    const otherJob = await approvedJob(OTHER)
    const theirs = occurrence(otherJob, 'expired', { co: OTHER, outcome: 'EXPIRED' })
    const anotherJob = await approvedJob()
    const notThisJob = occurrence(anotherJob, 'expired', { outcome: 'EXPIRED' })
    const missing = await retry('jy-owner', job, `occ.${'0'.repeat(32)}`)
    expect(missing).toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } })
    expect(await retry('jy-owner', job, theirs)).toEqual(missing)
    expect(await retry('jy-owner', job, notThisJob)).toEqual(missing)
    expect(occOf(theirs, OTHER).state).toBe('expired')
    expect(occOf(notThisJob).state).toBe('expired')
  })
})

describe('which occurrences', () => {
  it('needs_person and expired only: due, running, done, nothing, skipped (an absence) and held are refused', async () => {
    for (const [state, outcome] of [['due', null], ['running', null], ['done', null], ['nothing', null], ['skipped', 'OWNER_ABSENT'], ['held', 'JOB_PAUSED']] as const) {
      db.prepare('DELETE FROM ai_job_occurrences').run()
      const job = await approvedJob()
      const occ = occurrence(job, state, { outcome })
      expect(await retry('jy-owner', job, occ), state).toMatchObject({ status: 409, body: { code: 'NOT_RETRYABLE' } })
      expect(occOf(occ)).toMatchObject({ state, retries: 0 })
    }
  })

  it('only the job’s newest occurrence: once a later one came, its check covered this window', async () => {
    const job = await approvedJob()
    const older = occurrence(job, 'expired', { outcome: 'EXPIRED' })
    occurrence(job, 'done')
    expect(await retry('jy-owner', job, older)).toMatchObject({ status: 409, body: { code: 'NOT_LATEST' } })
    expect(await occurrenceView('jy-owner', job, older)).toMatchObject({ retry: { allowed: false, why: 'NOT_LATEST' } })
  })
})

describe('only while the job would run it as pinned', () => {
  it('the company’s jobs stopped, the job paused, another version approved, not accepted', async () => {
    const stoppedJob = await approvedJob()
    const a = occurrence(stoppedJob, 'expired', { outcome: 'EXPIRED' })
    db.prepare("INSERT INTO ai_job_settings (company_id, stopped, updated_by, updated_at) VALUES (?, 1, 'jy-owner', ?)").run(CO, new Date().toISOString())
    expect(await retry('jy-owner', stoppedJob, a)).toMatchObject({ status: 409, body: { code: 'JOB_STOPPED', error: expect.stringContaining('すべて止める') } })
    db.prepare('DELETE FROM ai_job_settings').run()

    const paused = await approvedJob()
    const b = occurrence(paused, 'expired', { outcome: 'EXPIRED' })
    db.prepare("UPDATE ai_jobs SET state = 'paused', paused_reason = 'ADMIN' WHERE company_id = ? AND id = ?").run(CO, paused)
    expect(await retry('jy-owner', paused, b)).toMatchObject({ status: 409, body: { code: 'JOB_PAUSED' } })

    const changed = await approvedJob()
    const c = occurrence(changed, 'needs_person', { outcome: 'RUN_FAILED' })
    db.prepare('UPDATE ai_jobs SET approved_version = 2 WHERE company_id = ? AND id = ?').run(CO, changed)
    expect(await retry('jy-owner', changed, c)).toMatchObject({ status: 409, body: { code: 'JOB_VERSION_CHANGED' } })

    const unaccepted = await approvedJob(CO, { accept: false })
    const d = occurrence(unaccepted, 'needs_person', { outcome: 'RUN_FAILED' })
    expect(await retry('jy-owner', unaccepted, d)).toMatchObject({ status: 409, body: { code: 'JOB_NOT_ACCEPTED' } })
    for (const o of [a, b, c, d]) expect(occOf(o).retries).toBe(0)
  })

  it('the responsible person’s rights now, and their AI stopped (the claim’s own stop check)', async () => {
    const job = await approvedJob()
    const occ = occurrence(job, 'expired', { outcome: 'EXPIRED' })
    await restrictHr(false)
    expect(await retry('jy-owner', job, occ)).toMatchObject({ status: 409, body: { code: 'JOB_GRANT_EXCEEDS' } })
    await restrictHr(true)
    expect(services.agentStops.stop(owner(), { userId: 'jy-alice' }).ok).toBe(true)
    expect(await retry('jy-owner', job, occ)).toMatchObject({ status: 409, body: { code: 'AI_STOPPED' } })
    expect(await occurrenceView('jy-owner', job, occ)).toMatchObject({ retry: { allowed: false, why: 'AI_STOPPED' } })
    expect(occOf(occ)).toMatchObject({ state: 'expired', retries: 0 })
  })

  it('the pinned shelf Skill version removed', async () => {
    const job = await approvedJob()
    const occ = occurrence(job, 'expired', { outcome: 'EXPIRED' })
    const pinned = (db.prepare('SELECT definition FROM ai_job_versions WHERE company_id = ? AND job_id = ?').get(CO, job) as Json).definition
    const { item, fingerprint } = JSON.parse(pinned).run.procedure
    const current = (db.prepare("SELECT current_version FROM shelf_items WHERE company_id = ? AND name = 'interview-report'").get(CO) as Json).current_version
    expect(services.skillShelf.publish(owner(), { kind: 'skill', departmentId: null, name: 'interview-report', files: [{ path: 'SKILL.md', base64: Buffer.from('# 新しい手順\n').toString('base64') }], expectedVersion: current }).ok).toBe(true)
    expect(services.skillShelf.removeVersion(owner(), item, fingerprint).ok).toBe(true)
    expect(await retry('jy-owner', job, occ)).toMatchObject({ status: 409, body: { code: 'JOB_SKILL_MISSING' } })
  })

  it('a deliverable place outside no longer usable', async () => {
    const job = await approvedJob(CO, {
      accept: false,
      grant: { tools: ['files_read', 'records', 'files_write'], writes: { area: 'deliverable', place: '人事部', folder: 'reports' }, deliverTo: { connector: 'google', kind: 'drive_folder', ref: null } },
    })
    const consent = (db.prepare('SELECT consent_fingerprint FROM ai_job_versions WHERE company_id = ? AND job_id = ?').get(CO, job) as Json).consent_fingerprint
    db.prepare(`UPDATE ai_jobs SET accepted_version = 1, accepted_consent = ?, accepted_place = '{"connector":"google","kind":"drive_folder","ref":"folder-1"}' WHERE company_id = ? AND id = ?`).run(consent, CO, job)
    const occ = occurrence(job, 'needs_person', { outcome: 'PLACE_NOT_USABLE' })
    let usable = false
    const jobRetry = createJobRetry({
      companyData, transactions: sqliteTransactions(db), clock, jobs: services.jobs,
      roleOf: (co, user) => sqliteMembershipRepository(db).roleOf(co, user), aiStops: () => ({ all: false, tools: [] }),
      placeUsable: (_co, user, place) => usable && user === 'jy-alice' && place.ref === 'folder-1',
      reconcileFor: () => { throw new Error('unused') },
    })
    expect(jobRetry.retry(owner(), job, occ)).toMatchObject({ ok: false, body: { code: 'JOB_PLACE_NOT_USABLE' } })
    usable = true
    expect(jobRetry.retry(owner(), job, occ)).toMatchObject({ ok: true })
  })
})

describe('the press', () => {
  it('the same occurrence back to due with a new deadline; a new run with a fresh deadline; still one やること', async () => {
    const job = await approvedJob()
    const { occ, run: first } = await failedRun(job)
    // An hour later (the first run's 30 minutes would be over by now).
    vi.setSystemTime(Date.now() + 60 * MINUTE)
    const pressedAt = Date.now()
    expect(await retry('jy-admin', job, occ)).toMatchObject({ status: 200 })
    const after = occOf(occ)
    expect(after).toMatchObject({ state: 'due', outcome_code: null, run_id: null, retries: 1, retried_by: 'jy-admin' })
    // The deadline: from the press, as long as the approved version gives a slot (1440 minutes here).
    expect(Date.parse(after.expires_at)).toBe(pressedAt + 1440 * MINUTE)
    expect(Date.parse(after.retried_at)).toBe(pressedAt)
    // The old run is closed for good: its own 「もう一度」 gives nothing back.
    expect(runOf(first.id)).toMatchObject({ state: 'done', closed_at: expect.any(String) })
    expect(db.prepare("SELECT code FROM ai_run_events WHERE company_id = ? AND run_id = ? ORDER BY seq DESC LIMIT 1").get(CO, first.id)).toEqual({ code: 'RETRIED' })
    expect(await as('jy-alice', 'POST', `/ai-runs/${first.id}/retry`)).toMatchObject({ status: 409, body: { code: 'RUN_DONE' } })
    // Alice's app sees it again (with the count, so it is tried again today) and claims it as a new run.
    const turns = (await as('jy-alice', 'GET', '/me/job-turns')).body.data.turns
    expect(turns).toEqual([expect.objectContaining({ occurrenceId: occ, state: 'due', retries: 1 })])
    const again = await claim(occ, 'device-alice-2')
    expect(again).toMatchObject({ status: 201, body: { data: { created: true } } })
    const second = again.body.data.run
    expect(second.id).not.toBe(first.id)
    expect(Date.parse(runOf(second.id).created_at)).toBe(pressedAt)
    // Renewing and calling within its own 30 minutes works; the one やること has the occurrence's id.
    expect((await finish(second, { outcome: 'done', jobResult: { title: '面談報告書を確かめる' } })).status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'done', run_id: second.id })
    expect(db.prepare("SELECT id FROM records WHERE company_id = ? AND type = 'task'").all(CO)).toEqual([{ id: occurrenceTaskId(occ) }])
    vi.setSystemTime(Date.now() - 60 * MINUTE)
  })

  it('an expired occurrence that never ran is claimed after the press', async () => {
    const job = await approvedJob()
    const occ = occurrence(job, 'expired', { outcome: 'EXPIRED', expiresInMs: -MINUTE })
    expect(await claim(occ)).toMatchObject({ status: 409 })
    expect((await retry('jy-owner', job, occ)).status).toBe(200)
    expect(await claim(occ)).toMatchObject({ status: 201 })
  })

  it('a second failure after the press is told again (its notice key carries the press)', async () => {
    const job = await approvedJob()
    const { occ } = await failedRun(job)
    expect(noticesOf('job_failed')).toEqual(['jy-alice', 'jy-owner'])
    expect((await retry('jy-owner', job, occ)).status).toBe(200)
    const run = (await claim(occ, 'device-alice-2')).body.data.run
    expect((await finish(run, { outcome: 'failed', failure: { class: 'bad-input' } })).status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RUN_FAILED' })
    expect(noticesOf('job_failed')).toEqual(['jy-alice', 'jy-alice', 'jy-owner', 'jy-owner'])
    // The bell still shows both (the job and the occurrence are read from the key's first parts).
    const bell = (await as('jy-alice', 'GET', '/me/notifications')).body.data.items.filter((n: Json) => n.kind === 'job_failed')
    expect(bell).toHaveLength(2)
  })

  it('a server job’s occurrence (placement e) runs again by the server’s runner', async () => {
    const made = await services.jobs.create(owner(), { definition: {
      schema: 1, name: '週の報告', actingUser: 'jy-alice', trigger: { every: 'day', at: '09:00', businessDaysOnly: false },
      check: { kind: 'none' }, run: { kind: 'operation', operation: 'create_task', title: '週の報告を書く', dueBusinessDays: null },
      placement: 'e', missed: { policy: 'latest_only', expiresAfterMinutes: 60 },
      grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
    } })
    if (!made.ok) throw new Error(JSON.stringify(made.body))
    expect((await services.jobs.approve(owner(), made.value.id, { version: 1 })).ok).toBe(true)
    expect((await services.jobs.accept(alice(), made.value.id, { version: 1 })).ok).toBe(true)
    const occ = occurrence(made.value.id, 'needs_person', { outcome: 'TASK_NOT_CREATED' })
    expect(await retry('jy-owner', made.value.id, occ)).toMatchObject({ status: 200 })
    expect(Date.parse(occOf(occ).expires_at)).toBe(Date.now() + 60 * MINUTE)
    const made2: string[] = []
    const runner = createJobOccurrences({
      companyData, transactions: sqliteTransactions(db), clock, ids: randomIds,
      timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf: (co, user) => sqliteMembershipRepository(db).roleOf(co, user), jobs: services.jobs,
      writer: { check: () => null, create: (_co, input) => { made2.push(input.id as string); return { ok: true, record: { id: input.id } } as Json } }, log: () => {},
    })
    expect(runner.runOccurrence(CO, occ)).toBe('done')
    expect(made2).toEqual([occurrenceTaskId(occ)])
  })
})

describe('結果が分からないうちは再開しない', () => {
  async function unknownResult(job: string): Promise<{ occ: string; run: Json }> {
    const occ = occurrence(job, 'due')
    const run = (await claim(occ)).body.data.run
    const at = new Date().toISOString()
    db.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, created_at, updated_at)
      VALUES (?, ?, 'draft-1', 'f', 'mail-draft', 'unknown', 1, ?, ?)`).run(CO, run.id, at, at)
    expect((await finish(run, { outcome: 'done', jobResult: 'nothing' })).status).toBe(200)
    db.prepare("UPDATE ai_job_occurrences SET state = 'needs_person', outcome_code = 'RESULT_UNKNOWN' WHERE company_id = ? AND id = ?").run(CO, occ)
    return { occ, run }
  }

  it('refused while an outside operation’s result is unknown; the view names it; an owner / admin reconciles, then it runs', async () => {
    const job = await approvedJob()
    const { occ, run } = await unknownResult(job)
    expect(await retry('jy-owner', job, occ)).toMatchObject({ status: 409, body: { code: 'JOB_RESULT_UNKNOWN', error: expect.stringContaining('確かめて') } })
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', retries: 0 })
    expect(runOf(run.id).state).toBe('waiting_reconcile')
    expect(await occurrenceView('jy-owner', job, occ)).toMatchObject({ retry: { allowed: false, why: 'JOB_RESULT_UNKNOWN' }, unknownOperations: [{ key: 'draft-1', kind: 'mail-draft' }] })
    // The body, then the operation: only one of this occurrence's run whose result is unknown.
    expect(await reconcile('jy-owner', job, occ, 'draft-1', {})).toMatchObject({ status: 400 })
    expect(await reconcile('jy-owner', job, occ, 'draft-2', { done: true })).toMatchObject({ status: 404, body: { code: 'OPERATION_NOT_FOUND' } })
    expect(await reconcile('jy-admin', job, occ, 'draft-1', { done: true })).toMatchObject({ status: 200 })
    expect(db.prepare('SELECT state, reconciled_by FROM ai_run_operations WHERE company_id = ? AND run_id = ?').get(CO, run.id)).toEqual({ state: 'done', reconciled_by: 'jy-admin' })
    expect(await reconcile('jy-admin', job, occ, 'draft-1', { done: true })).toMatchObject({ status: 404 })
    expect(await retry('jy-owner', job, occ)).toMatchObject({ status: 200 })
    expect(runOf(run.id).state).toBe('done')
    expect(await claim(occ, 'device-alice-2')).toMatchObject({ status: 201, body: { data: { created: true } } })
  })

  it('reconciling only an occurrence a person looks at (not one still running)', async () => {
    const job = await approvedJob()
    const { occ } = await unknownResult(job)
    db.prepare("UPDATE ai_job_occurrences SET state = 'running', outcome_code = NULL WHERE company_id = ? AND id = ?").run(CO, occ)
    expect(await reconcile('jy-owner', job, occ, 'draft-1', { done: false })).toMatchObject({ status: 409, body: { code: 'NOT_RETRYABLE' } })
  })
})
