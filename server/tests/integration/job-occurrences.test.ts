/**
 * Integration Test: scheduled jobs' occurrences — the clock and the server's operation (定期の仕事の回,
 * B PR 3b, jobs.md "The clock" / "The runner" / "Notices"). No AI runs anywhere here.
 *
 * Guards (each mutation-checked, listed in jobs.md):
 * - two clock runs, or a restart, make one occurrence per slot; nothing before its time, nothing from
 *   before the version was approved;
 * - missed slots: only the newest is made (`latest_only`); past its expiry it is `expired` and the
 *   responsible person and the creator are told; under `skip` a late one is `skipped`; an older `due`
 *   one is superseded; a `due` one whose time ran out is expired and told;
 * - the company's stop or the job's pause → `held`, nothing made (also after resuming);
 * - the responsible person no longer a member → the job paused (3a's notice), `held`, nothing made;
 * - absent that day (D5) → `skipped` and told, nothing made;
 * - exactly one やること per occurrence, also when the runner runs twice or crashes mid-way (all or
 *   nothing); the task is the responsible person's alone, and its 経緯 names `acb:job` and the run;
 * - records off → `needs_person` and told; every feature off → it still runs;
 * - another company's occurrences are neither listed nor touched; a slow company does not hold up
 *   another's occurrences;
 * - the record runs' paths never see an occurrence's run (GET /ai-runs, claims; the run is closed in
 *   the transaction that opened it — what a rollback to #668 / #669 would read).
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
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { jobsRoute } from '../../src/routes/jobs'
import { services } from '../../src/composition'
import { createJobService, type JobService } from '../../src/services/jobs'
import { companyTimeToUtc, createJobOccurrences, createJobRunner, type JobOccurrences } from '../../src/services/job-occurrences'
import { createServerClock } from '../../src/services/server-clock'
import { createServiceRecordWriter, type ServiceRecordWriter } from '../../src/services/record-engine'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { JOB_ACTOR } from '../../../shared/core/jobs'

const app = new Hono()
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)

const CO = 'occ-co'
const OTHER = 'occ-other'
const TS = '2026-11-01T00:00:00.000Z'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function as(user: string, method: string, path: string, body?: unknown, company = CO) {
  currentUser.id = user
  const res = await app.request(`/api/companies/${company}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}

/** Japan time → epoch ms. */
const jst = (local: string) => Date.parse(`${local}:00+09:00`)
let nowMs = jst('2026-11-13T10:00')
const clock = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }
const companyData = sqliteCompanyData(db)
const memberships = sqliteMembershipRepository(db)
const transactions = sqliteTransactions(db)
const roleOf = (co: string, user: string) => memberships.roleOf(co, user)
const pushed: string[][] = []

const realWriter: ServiceRecordWriter = createServiceRecordWriter({
  companyData, transactions, clock, ids: randomIds,
  featureOff: (co, type) => services.features.typeOff(co, type),
  isMember: (co, user) => roleOf(co, user) !== null, roleOf,
  notify: (co, users, change) => { if (change) services.notifications.recordChange(co, users, change) },
})
const jobService: JobService = createJobService({
  companyData, memberships, transactions, clock, ids: randomIds,
  skillTree: async () => null, hasCompanyFolder: () => true, noticesChanged: (_, users) => pushed.push(users),
  // As composition.ts: a pause / the company's stop holds the occurrences.
  occurrenceHolds: { holdDue: (co, job, code) => occ.holdDue(co, job, code), holdPassedSlot: (co, job, code) => occ.holdPassedSlot(co, job, code) },
})
let writer: Pick<ServiceRecordWriter, 'check' | 'create'> = realWriter
function occurrencesService(): JobOccurrences {
  return createJobOccurrences({
    companyData, transactions, clock, ids: randomIds, timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf, jobs: jobService,
    writer: { check: (co, input) => writer.check(co, input), create: (co, input) => writer.create(co, input) },
    noticesChanged: (_, users) => pushed.push(users), log: line => logged.push(line),
  })
}
const logged: string[] = []
let occ: JobOccurrences

const owner = (co = CO) => ({ companyId: co, userId: 'u-owner', role: 'owner' })
const alice = (co = CO) => ({ companyId: co, userId: 'u-alice', role: 'member' })

/** A server operation: a やること for alice every Monday at 09:00, due the next business day. */
function weekly(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1, name: '週の報告', actingUser: 'u-alice',
    trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 },
    check: { kind: 'none' },
    run: { kind: 'operation', operation: 'create_task', title: '週の報告を書く', dueBusinessDays: 1 },
    placement: 'e',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
    ...overrides,
  }
}

/** Made, approved by the owner and accepted by alice, at the clock's now. */
async function runnableJob(definition: Json = weekly(), co = CO, accept = true): Promise<string> {
  const made = await jobService.create(owner(co), { definition })
  if (!made.ok) throw new Error(JSON.stringify(made.body))
  const id = made.value.id
  const approved = await jobService.approve(owner(co), id, { version: 1 })
  if (!approved.ok) throw new Error(JSON.stringify(approved.body))
  if (accept) {
    const ok = await jobService.accept(alice(co), id, { version: 1 })
    if (!ok.ok) throw new Error(JSON.stringify(ok.body))
  }
  return id
}

const occurrencesOf = (jobId: string, co = CO) => db.prepare('SELECT id, due_slot, state, outcome_code, run_id, due_at, expires_at, job_version FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? ORDER BY due_slot').all(co, jobId) as Json[]
const tasksOf = (co = CO) => db.prepare("SELECT id, personal_owner FROM records WHERE company_id = ? AND type = 'task'").all(co) as Json[]
const noticesOf = (kind: string, co = CO) => db.prepare('SELECT user_id, dedupe_key FROM notifications WHERE company_id = ? AND kind = ? ORDER BY user_id').all(co, kind) as Json[]
const runsOf = (co = CO) => db.prepare('SELECT id, subject_kind, record_id, step, user_id, state, device_id, closed_at FROM ai_runs WHERE company_id = ?').all(co) as Json[]
function clearWork() {
  for (const t of ['ai_job_occurrences', 'ai_job_versions', 'ai_jobs', 'notifications', 'member_absences', 'ai_job_settings']) db.prepare(`DELETE FROM ${t}`).run()
  db.prepare("DELETE FROM ai_runs WHERE subject_kind = 'occurrence'").run()
  db.prepare("DELETE FROM record_state WHERE record_id IN (SELECT id FROM records WHERE type = 'task')").run()
  db.prepare("DELETE FROM records WHERE type = 'task'").run()
}

function member(co: string, user: string, role: string) {
  db.prepare('INSERT OR REPLACE INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${user}`, user, co, role, TS, TS)
}

beforeAll(async () => {
  initDatabase()
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', TS, TS)
    db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${co}-root`, co, TS)
    db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'everyone', NULL, 1, 1, ?)").run(`${co}-root-r`, co, `${co}-root`, TS)
    for (const [user, role] of [['u-owner', 'owner'], ['u-alice', 'member'], ['u-bob', 'member']]) member(co, user, role)
    db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(co, TS, 'u-owner')
    await services.records.refreshIndex(owner(co))
  }
})

beforeEach(() => {
  clearWork()
  for (const co of [CO, OTHER]) for (const [user, role] of [['u-owner', 'owner'], ['u-alice', 'member'], ['u-bob', 'member']]) member(co, user, role)
  db.prepare('UPDATE record_settings SET enabled = 1').run()
  db.prepare('DELETE FROM company_features').run()
  writer = realWriter
  pushed.length = 0
  logged.length = 0
  nowMs = jst('2026-11-13T10:00') // a Friday: the job is approved now
  occ = occurrencesService()
})

describe('the clock makes occurrences', () => {
  it('nothing before its time; then one per slot — however often it runs, and after a restart', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T08:59')
    expect(occ.makeOccurrences(CO)).toBe(0)
    expect(occurrencesOf(job)).toEqual([])
    nowMs = jst('2026-11-16T09:02')
    expect(occ.makeOccurrences(CO)).toBe(1)
    expect(occ.makeOccurrences(CO)).toBe(0)
    // A restart: a new service over the same database.
    expect(occurrencesService().makeOccurrences(CO)).toBe(0)
    expect(occurrencesOf(job)).toEqual([expect.objectContaining({
      due_slot: '2026-11-16T09:00', state: 'due', job_version: 1, due_at: '2026-11-16T00:00:00.000Z', expires_at: '2026-11-17T00:00:00.000Z',
    })])
  })

  it('never a slot from before the version was approved', async () => {
    nowMs = jst('2026-11-16T09:30')
    const job = await runnableJob()
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job)).toEqual([])
  })

  it('missed slots (the server was down): only the newest is made', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-30T10:00')
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job).map(o => [o.due_slot, o.state])).toEqual([['2026-11-30T09:00', 'due']])
  })

  it('past its expiry: expired, and the responsible person and the creator are told (once)', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-17T09:30')
    occ.makeOccurrences(CO)
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job).map(o => [o.due_slot, o.state, o.outcome_code])).toEqual([['2026-11-16T09:00', 'expired', 'EXPIRED']])
    expect(noticesOf('job_expired').map(n => n.user_id)).toEqual(['u-alice', 'u-owner'])
    expect(occ.runDue(CO)).toBe(0)
    expect(tasksOf()).toEqual([])
    const bell = services.notifications.list(alice())
    expect(bell.ok && bell.value.items.map(i => [i.kind, i.text])).toEqual([['job_expired', '定期の仕事「週の報告」の11月16日 09:00の回は、期限までに動かなかったため見送りました']])
    // Bob is neither responsible nor an admin: nothing.
    const bobs = services.notifications.list({ companyId: CO, userId: 'u-bob', role: 'member' })
    expect(bobs.ok && bobs.value.items).toEqual([])
    // Shown only while the member may see the job: once a new approved version names bob, alice's goes.
    const edited = await jobService.update(owner(), job, { definition: weekly({ actingUser: 'u-bob' }) })
    if (!edited.ok) throw new Error(JSON.stringify(edited.body))
    expect((await jobService.approve(owner(), job, { version: 2 })).ok).toBe(true)
    const after = services.notifications.list(alice())
    expect(after.ok && after.value.items).toEqual([])
  })

  it('told only to a responsible person still a member and a creator still an owner / admin', async () => {
    const job = await runnableJob()
    // The creator is a member now (not an owner / admin): not told.
    db.prepare("UPDATE ai_jobs SET created_by = 'u-bob' WHERE id = ?").run(job)
    nowMs = jst('2026-11-17T09:30')
    occ.makeOccurrences(CO)
    expect(noticesOf('job_expired').map(n => n.user_id)).toEqual(['u-alice'])
    // The responsible person left (no clock ran in between to pause the job): not told; the owner creator is.
    db.prepare('DELETE FROM notifications').run()
    db.prepare("UPDATE ai_jobs SET created_by = 'u-owner' WHERE id = ?").run(job)
    db.prepare("DELETE FROM memberships WHERE company_id = ? AND user_id = 'u-alice'").run(CO)
    nowMs = jst('2026-11-24T09:30')
    occ.makeOccurrences(CO)
    expect(noticesOf('job_expired').map(n => n.user_id)).toEqual(['u-owner'])
  })

  it('a due one whose time ran out before the runner took it: expired and told', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    nowMs = jst('2026-11-17T09:01')
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job).map(o => o.state)).toEqual(['expired'])
    expect(noticesOf('job_expired')).toHaveLength(2)
  })

  it('under `skip`, a slot found late is skipped, not run (nobody told); on time it is due', async () => {
    const job = await runnableJob(weekly({ missed: { policy: 'skip', expiresAfterMinutes: 1440 } }))
    nowMs = jst('2026-11-16T09:20')
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['skipped', 'MISSED']])
    expect(noticesOf('job_expired')).toEqual([])
    nowMs = jst('2026-11-23T09:04')
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job).map(o => o.state)).toEqual(['skipped', 'due'])
    // Past its expiry it is expired and told, whatever the policy; the 11-23 one (never taken) is superseded.
    nowMs = jst('2026-12-01T09:30')
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job).map(o => [o.due_slot, o.state, o.outcome_code])).toEqual([
      ['2026-11-16T09:00', 'skipped', 'MISSED'], ['2026-11-23T09:00', 'skipped', 'SUPERSEDED'], ['2026-11-30T09:00', 'expired', 'EXPIRED'],
    ])
    expect(noticesOf('job_expired')).toHaveLength(2)
  })

  it('a newer occurrence supersedes an older one still due', async () => {
    const job = await runnableJob(weekly({ trigger: { every: 'day', at: '09:00', businessDaysOnly: false }, missed: { policy: 'latest_only', expiresAfterMinutes: 7 * 24 * 60 } }))
    nowMs = jst('2026-11-14T09:02')
    occ.makeOccurrences(CO)
    nowMs = jst('2026-11-15T09:02')
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job).map(o => [o.due_slot, o.state, o.outcome_code])).toEqual([['2026-11-14T09:00', 'skipped', 'SUPERSEDED'], ['2026-11-15T09:00', 'due', null]])
  })

  it('a PC job (placement a) gets no occurrence before PR 5', async () => {
    db.prepare("INSERT OR IGNORE INTO scopes (id, company_id, path, kind, created_at) VALUES ('occ-doc', ?, '資料', 'folder', ?)").run(CO, TS)
    const made = await createJobService({
      companyData, memberships, transactions, clock, ids: randomIds, skillTree: async () => 'a'.repeat(40), hasCompanyFolder: () => true,
    }).create(owner(), { definition: {
      ...weekly(), check: { kind: 'new_files', path: '資料' }, run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'weekly-report' } }, placement: 'a',
      grant: { tools: ['files_read'], creates: [], routes: [], reads: { paths: ['資料'], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
    } })
    if (!made.ok) throw new Error(JSON.stringify(made.body))
    db.prepare("UPDATE ai_jobs SET state = 'active', approved_version = 1, approved_fingerprint = 'sha256:x' WHERE id = ?").run(made.value.id)
    db.prepare('UPDATE ai_job_versions SET approved_by = ?, approved_at = ? WHERE job_id = ?').run('u-owner', clock.now(), made.value.id)
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    expect(occurrencesOf(made.value.id)).toEqual([])
  })
})

describe('the runner does the server operation exactly once', () => {
  it('one やること for the responsible person alone; its 経緯 names acb:job and the run; a second run makes nothing', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    expect(occ.runDue(CO)).toBe(1)
    expect(occ.runDue(CO)).toBe(0)
    const [o] = occurrencesOf(job)
    expect(o).toMatchObject({ state: 'done', outcome_code: null })
    expect(occ.runOccurrence(CO, o.id)).toBeNull()
    const tasks = tasksOf()
    expect(tasks).toEqual([{ id: `task-${o.id.slice(4)}`, personal_owner: 'u-alice' }])
    const state = companyData.forCompany(CO).records.states([tasks[0].id])[0]
    expect(state.state).toBe('todo')
    expect(JSON.parse(state.fields)).toMatchObject({ assignee: 'u-alice', next_actor: 'u-alice', due: '2026-11-17' })
    // The run: an occurrence's, the server's, opened and closed in one go, with its events and its key.
    expect(runsOf()).toEqual([{ id: o.run_id, subject_kind: 'occurrence', record_id: o.id, step: 'job-operation', user_id: 'u-alice', state: 'done', device_id: 'server', closed_at: expect.any(String) }])
    expect((db.prepare('SELECT event, state_after, code FROM ai_run_events WHERE company_id = ? AND run_id = ? ORDER BY seq').all(CO, o.run_id) as Json[]).map(e => [e.event, e.state_after, e.code]))
      .toEqual([['claimed', 'running', null], ['finished', 'done', 'DONE']])
    expect(db.prepare('SELECT key, state, ref_kind, ref_id FROM ai_run_operations WHERE company_id = ? AND run_id = ?').all(CO, o.run_id)).toEqual([{ key: 'create_task', state: 'done', ref_kind: 'record', ref_id: tasks[0].id }])
    // 経緯 (as alice reads it): the job as actor, cause system, the run's id.
    const history = services.recordEngine.history(alice(), tasks[0].id)
    if (!history.ok) throw new Error('history')
    expect(history.value.entries[0]).toMatchObject({ actorId: JOB_ACTOR.id, actorKind: 'external', cause: 'system', runId: o.run_id })
    // Nobody else reads it (an owner-only やること): not even the owner.
    expect((await services.records.get(owner(), tasks[0].id)).ok).toBe(false)
    // D9: no notice of success.
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = ?").get(CO)).toEqual({ n: 0 })
  })

  it('a crash mid-way leaves nothing made and the occurrence due; the next run makes exactly one', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    writer = { check: realWriter.check, create: (co, input) => { realWriter.create(co, input); throw new Error('crash') } }
    expect(occ.runDue(CO)).toBe(0)
    expect(occurrencesOf(job).map(o => o.state)).toEqual(['due'])
    expect([tasksOf(), runsOf()]).toEqual([[], []])
    writer = realWriter
    expect(occ.runDue(CO)).toBe(1)
    expect(tasksOf()).toHaveLength(1)
    expect(runsOf()).toHaveLength(1)
  })

  it('a やること the writer refuses: needs a person, told, no run left behind', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    writer = { check: realWriter.check, create: () => ({ ok: false, reason: 'exists' }) }
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['needs_person', 'TASK_NOT_CREATED']])
    expect(runsOf()).toEqual([])
    expect(noticesOf('job_failed').map(n => n.user_id)).toEqual(['u-alice', 'u-owner'])
  })

  it('records off: needs a person and told; every feature off: it still runs', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    db.prepare('UPDATE record_settings SET enabled = 0 WHERE company_id = ?').run(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['needs_person', 'RECORDS_OFF']])
    expect(noticesOf('job_failed')).toHaveLength(2)
    expect(tasksOf()).toEqual([])

    db.prepare('UPDATE record_settings SET enabled = 1 WHERE company_id = ?').run(CO)
    for (const feature of ['taskList', 'meetings', 'inbox', 'decisions', 'projects']) {
      const r = services.features.set(owner(), { feature, on: false })
      if (!r.ok) throw new Error(JSON.stringify(r.body))
    }
    nowMs = jst('2026-11-23T09:02')
    occ.makeOccurrences(CO)
    expect(occ.runDue(CO)).toBe(1)
    expect(tasksOf()).toHaveLength(1)
  })
})

describe('held, skipped and paused: nothing made', () => {
  it('the company’s stop: held when made; also after the stop is lifted', async () => {
    const job = await runnableJob()
    jobService.setStopped(owner(), { stopped: true })
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    jobService.setStopped(owner(), { stopped: false })
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['held', 'COMPANY_STOPPED']])
    expect(tasksOf()).toEqual([])
  })

  it('stopped or paused after it was made: held (also when the stop was written without holding, as a 3a build does)', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    jobService.setStopped(owner(), { stopped: true })
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['held', 'COMPANY_STOPPED']])
    jobService.setStopped(owner(), { stopped: false })

    // A build before 3b (rolled back to, then forward) stops and pauses without holding what is due:
    // the runner itself still refuses it.
    const handle = companyData.forCompany(CO)
    nowMs = jst('2026-11-23T09:02')
    occ.makeOccurrences(CO)
    handle.jobs.setStopped(true, 'u-owner', clock.now())
    occ.runDue(CO)
    handle.jobs.setStopped(false, 'u-owner', clock.now())
    nowMs = jst('2026-11-30T09:02')
    occ.makeOccurrences(CO)
    handle.jobs.setState(job, 'paused', 'ADMIN', 'u-owner', clock.now())
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([
      ['held', 'COMPANY_STOPPED'], ['held', 'COMPANY_STOPPED'], ['held', 'JOB_PAUSED'],
    ])
    expect(tasksOf()).toEqual([])
  })

  it('paused and resumed with no clock run in between: the occurrence left due is held, not run', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    jobService.pause(owner(), job)
    expect((await jobService.resume(owner(), job)).ok).toBe(true)
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['held', 'JOB_PAUSED']])
    expect(tasksOf()).toEqual([])
  })

  it('a slot that passed while paused (no clock run meanwhile) is held at resume, never made due', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T08:00')
    jobService.pause(owner(), job)
    nowMs = jst('2026-11-16T10:00')
    expect((await jobService.resume(owner(), job)).ok).toBe(true)
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.due_slot, o.state, o.outcome_code])).toEqual([['2026-11-16T09:00', 'held', 'JOB_PAUSED']])
    expect(tasksOf()).toEqual([])
    // The next week runs as usual.
    nowMs = jst('2026-11-23T09:02')
    occ.makeOccurrences(CO)
    expect(occ.runDue(CO)).toBe(1)
  })

  it('the company’s stop on and off with no clock run in between: a due one held, a slot that passed held', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    jobService.setStopped(owner(), { stopped: true })
    jobService.setStopped(owner(), { stopped: false })
    occ.runDue(CO)
    nowMs = jst('2026-11-23T08:00')
    jobService.setStopped(owner(), { stopped: true })
    nowMs = jst('2026-11-23T10:00')
    jobService.setStopped(owner(), { stopped: false })
    // Switching off again when it was not on holds nothing.
    jobService.setStopped(owner(), { stopped: false })
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.due_slot, o.state, o.outcome_code])).toEqual([
      ['2026-11-16T09:00', 'held', 'COMPANY_STOPPED'], ['2026-11-23T09:00', 'held', 'COMPANY_STOPPED'],
    ])
    expect(tasksOf()).toEqual([])
  })

  it('a pause the server made (the responsible person left) holds what was due, also after a resume', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    jobService.memberLeft(CO, 'u-alice', 'u-owner')
    expect((await jobService.resume(owner(), job)).ok).toBe(true)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['held', 'JOB_PAUSED']])
    expect(tasksOf()).toEqual([])
  })

  it('lifting a stop that was not on holds nothing', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:01')
    jobService.setStopped(owner(), { stopped: false })
    occ.makeOccurrences(CO)
    expect(occ.runDue(CO)).toBe(1)
    expect(occurrencesOf(job).map(o => o.state)).toEqual(['done'])
  })

  it('a paused job’s slot is made held; a version approved but not accepted is held', async () => {
    const paused = await runnableJob()
    jobService.pause(owner(), paused)
    const unaccepted = await runnableJob(weekly({ name: '受け取っていない' }), CO, false)
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    // Decided when made (before any run).
    expect(occurrencesOf(paused).map(o => [o.state, o.outcome_code])).toEqual([['held', 'JOB_PAUSED']])
    expect(occurrencesOf(unaccepted).map(o => [o.state, o.outcome_code])).toEqual([['held', 'NOT_ACCEPTED']])
    occ.runDue(CO)
    expect(tasksOf()).toEqual([])
  })

  it('another version approved after it was made: held, not run as pinned', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    const edited = await jobService.update(owner(), job, { definition: weekly({ name: '週の報告（新）' }) })
    if (!edited.ok) throw new Error(JSON.stringify(edited.body))
    expect((await jobService.approve(owner(), job, { version: 2 })).ok).toBe(true)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['held', 'JOB_VERSION_CHANGED']])
    expect(tasksOf()).toEqual([])
  })

  it('the runner itself refuses one whose time ran out (no clock run in between): expired, told, nothing made', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    nowMs = jst('2026-11-17T09:30')
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['expired', 'EXPIRED']])
    expect(noticesOf('job_expired')).toHaveLength(2)
    expect(tasksOf()).toEqual([])
  })

  it('the responsible person no longer a member: the job pauses (owners / admins told), held, nothing made', async () => {
    const job = await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    db.prepare("DELETE FROM memberships WHERE company_id = ? AND user_id = 'u-alice'").run(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['held', 'OWNER_LEFT']])
    expect(db.prepare('SELECT state, paused_reason FROM ai_jobs WHERE id = ?').get(job)).toEqual({ state: 'paused', paused_reason: 'OWNER_LEFT' })
    expect(noticesOf('job_paused').map(n => n.user_id)).toEqual(['u-owner'])
    expect([tasksOf(), runsOf()]).toEqual([[], []])
  })

  it('an absence that begins later does not skip today', async () => {
    const job = await runnableJob()
    db.prepare(`INSERT INTO member_absences (company_id, id, user_id, from_day, until_day, delegate_id, set_by, set_at) VALUES (?, 'abs-2', 'u-alice', '2026-11-23', '2026-11-27', 'u-bob', 'u-alice', ?)`).run(CO, TS)
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    expect(occ.runDue(CO)).toBe(1)
    expect(occurrencesOf(job).map(o => o.state)).toEqual(['done'])
  })

  it('absent that day (D5): skipped and told, no delegate runs it', async () => {
    const job = await runnableJob()
    db.prepare(`INSERT INTO member_absences (company_id, id, user_id, from_day, until_day, delegate_id, set_by, set_at) VALUES (?, 'abs-1', 'u-alice', '2026-11-16', '2026-11-16', 'u-bob', 'u-alice', ?)`).run(CO, TS)
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => [o.state, o.outcome_code])).toEqual([['skipped', 'OWNER_ABSENT']])
    expect(noticesOf('job_skipped').map(n => n.user_id)).toEqual(['u-alice', 'u-owner'])
    expect(tasksOf()).toEqual([])
    const bell = services.notifications.list(alice())
    expect(bell.ok && bell.value.items.map(i => i.text)).toEqual(['定期の仕事「週の報告」の11月16日 09:00の回は、責任者が不在のため見送りました（代わりの人は動かしません）'])
  })
})

describe('companies apart', () => {
  it('another company’s occurrences are neither listed nor run by this company’s pass; the API answers the same 404', async () => {
    const mine = await runnableJob()
    const theirs = await runnableJob(weekly(), OTHER)
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    expect(occurrencesOf(theirs, OTHER)).toEqual([])
    occ.makeOccurrences(OTHER)
    occ.runDue(CO)
    expect(occurrencesOf(theirs, OTHER).map(o => o.state)).toEqual(['due'])
    expect(occurrencesOf(mine).map(o => o.state)).toEqual(['done'])
    const cross = await as('u-owner', 'GET', `/jobs/${theirs}/occurrences`)
    const none = await as('u-owner', 'GET', `/jobs/job.${'0'.repeat(32)}/occurrences`)
    expect(cross).toEqual(none)
    expect(cross.status).toBe(404)
    // The responsible person and the owner see this company's; another member does not.
    expect((await as('u-alice', 'GET', `/jobs/${mine}/occurrences`)).body.data.occurrences.map((o: Json) => [o.dueSlot, o.state, o.ran])).toEqual([['2026-11-16T09:00', 'done', true]])
    expect((await as('u-owner', 'GET', `/jobs/${mine}/occurrences`)).status).toBe(200)
    expect((await as('u-bob', 'GET', `/jobs/${mine}/occurrences`)).status).toBe(404)
  })

  it('a slow company does not hold up another’s occurrences: made first, and run without waiting for the clock', async () => {
    const theirs = await runnableJob(weekly(), OTHER)
    let runner: Promise<number> | null = null
    const jobRunner = createJobRunner({ companyIds: () => [CO, OTHER], occurrences: occ, yieldNow: () => new Promise<void>(r => setImmediate(r)), log: () => {} })
    const serverClock = createServerClock({
      companyIds: () => [CO, OTHER], companyData, clock,
      writer: { transition: () => ({ ok: false, reason: 'stale' }) }, notifications: { sweep: () => 0 }, autoRunFor: () => false, timeZoneOf: () => 'Asia/Tokyo',
      // This company's mail never answers.
      pollInbox: co => (co === CO ? new Promise<number>(() => {}) : Promise.resolve(0)),
      makeOccurrences: co => occ.makeOccurrences(co),
      startJobRunner: () => { runner = jobRunner.runOnce() },
      yieldNow: () => new Promise<void>(r => setImmediate(r)), log: () => {},
    })
    // Pass 1 hangs on this company's mail; passes 2 and 3 (later slots) still make and run the other's.
    const job = await runnableJob(weekly({ trigger: { every: 'day', at: '09:00', businessDaysOnly: false } }), OTHER)
    for (const [i, at] of ['2026-11-16T09:02', '2026-11-17T09:02', '2026-11-18T09:02'].entries()) {
      nowMs = jst(at)
      runner = null
      void serverClock.runOnce()
      for (let n = 0; n < 50 && runner === null; n++) await new Promise<void>(r => setImmediate(r))
      expect(await runner).toBe(i === 0 ? 2 : 1)
    }
    expect(occurrencesOf(theirs, OTHER).map(o => o.state)).toEqual(['done'])
    expect(occurrencesOf(job, OTHER).map(o => [o.due_slot, o.state])).toEqual([
      ['2026-11-16T09:00', 'done'], ['2026-11-17T09:00', 'done'], ['2026-11-18T09:00', 'done'],
    ])
  })
})

describe('the runner', () => {
  it('leaves a PC job’s occurrence alone (its app claims it, PR 5)', async () => {
    db.prepare("INSERT OR IGNORE INTO scopes (id, company_id, path, kind, created_at) VALUES ('occ-doc', ?, '資料', 'folder', ?)").run(CO, TS)
    const pcJobs = createJobService({ companyData, memberships, transactions, clock, ids: randomIds, skillTree: async () => 'a'.repeat(40), hasCompanyFolder: () => true })
    const made = await pcJobs.create(owner(), { definition: {
      ...weekly(), check: { kind: 'new_files', path: '資料' }, run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'weekly-report' } }, placement: 'a',
      grant: { tools: ['files_read'], creates: [], routes: [], reads: { paths: ['資料'], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
    } })
    if (!made.ok) throw new Error(JSON.stringify(made.body))
    const job = made.value.id
    expect((await pcJobs.approve(owner(), job, { version: 1 })).ok).toBe(true)
    expect((await pcJobs.accept(alice(), job, { version: 1 })).ok).toBe(true)
    db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at)
      VALUES (?, ?, ?, 1, '2026-11-16T09:00', 'Asia/Tokyo', '2026-11-16T00:00:00.000Z', '2026-11-17T00:00:00.000Z', 'due', ?, ?)`).run(CO, `occ.${'c'.repeat(32)}`, job, TS, TS)
    nowMs = jst('2026-11-16T09:02')
    expect(occ.runDue(CO)).toBe(0)
    expect(occurrencesOf(job).map(o => o.state)).toEqual(['due'])
    expect(tasksOf()).toEqual([])
    // Not even tried (nothing failed on the way).
    expect(logged).toEqual([])
  })

  it('yields to the event loop after each occurrence of a batch', async () => {
    const job = await runnableJob(weekly({ trigger: { every: 'day', at: '09:00', businessDaysOnly: false }, missed: { policy: 'latest_only', expiresAfterMinutes: 7 * 24 * 60 } }))
    const other = await runnableJob(weekly({ name: 'もう一つ', trigger: { every: 'day', at: '09:00', businessDaysOnly: false } }))
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    let yields = 0
    const runner = createJobRunner({ companyIds: () => [CO], occurrences: occ, yieldNow: async () => { yields++ }, log: () => {} })
    expect(await runner.runOnce()).toBe(2)
    // One after each occurrence, one after the company.
    expect(yields).toBe(3)
    expect([...occurrencesOf(job), ...occurrencesOf(other)].map(o => o.state)).toEqual(['done', 'done'])
  })
})

describe('the clock’s jobs part', () => {
  it('never runs twice at once (its own guard)', async () => {
    let calls = 0
    const serverClock = createServerClock({
      companyIds: () => [CO, OTHER], companyData, clock,
      writer: { transition: () => ({ ok: false, reason: 'stale' }) }, notifications: { sweep: () => 0 }, autoRunFor: () => false, timeZoneOf: () => 'Asia/Tokyo',
      makeOccurrences: () => { calls++; return 0 },
      yieldNow: () => new Promise<void>(r => setImmediate(r)), log: () => {},
    })
    await Promise.all([serverClock.runOnce(), serverClock.runOnce()])
    expect(calls).toBe(2)
  })
})

describe('the record runs’ paths never see an occurrence’s run', () => {
  it('GET /ai-runs, a claim naming the occurrence, and the open runs: nothing of it (also what an older server would read)', async () => {
    await runnableJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    const [run] = runsOf()
    expect((await as('u-alice', 'GET', '/ai-runs')).body.data.runs).toEqual([])
    for (const step of ['task-prep', 'job-operation']) {
      const claim = await as('u-alice', 'POST', '/ai-run-claims', { recordId: run.record_id, step, deviceId: 'device-aaaa', conversationId: 'conv-1' })
      // An occurrence id is not a record id: refused before any lookup (one answer for both steps).
      expect(claim).toEqual({ status: 400, body: expect.objectContaining({ error: 'recordId is a record id' }) })
    }
    // The server's run is closed in the transaction that opened it: no open run of any kind — what the
    // open-runs list of a build before subject_kind (#667) reads, by record id or by member.
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE company_id = ? AND closed_at IS NULL').get(CO)).toEqual({ n: 0 })
    // Nothing on it is the member's to change: it is done.
    for (const path of [`/ai-runs/${run.id}/finish`, `/ai-runs/${run.id}/renew`]) {
      const r = await as('u-alice', 'POST', path, { generation: 1, outcome: 'done' })
      expect(r.status).toBeGreaterThanOrEqual(400)
    }
    expect(runsOf()).toEqual([run])
  })
})

describe('company time', () => {
  it('a slot in company time is its UTC instant (a day boundary included)', () => {
    expect(companyTimeToUtc('2026-11-16T09:00', 'Asia/Tokyo')).toBe('2026-11-16T00:00:00.000Z')
    expect(companyTimeToUtc('2027-01-01T00:00', 'Asia/Tokyo')).toBe('2026-12-31T15:00:00.000Z')
  })
})
