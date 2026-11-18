/**
 * Integration Test: event-triggered jobs (出来事で動く定期の仕事, stage 4a, jobs.md "Event-triggered jobs"; owner memo
 * 「出来事で動く定期の仕事」 §4 「4a の試験」 and §12; the watched-record narrowing of 2026-11-18). No AI runs anywhere here.
 *
 * Guards (each mutation-checked, listed in jobs.md):
 * - the one watched record only (its start record, then — `followMadeTask` — the やること an occurrence made), never
 *   another task of the same person, a duplicate, or a record someone tagged; a renamed target still counts;
 *   once per target (an undo and a second completion make nothing more); a trigger without one is refused;
 * - (1) who may see an event occurrence: only someone who reads its record — the list, the job's last occurrence and
 *   the notices answer an owner / admin exactly the same whether such an occurrence exists or not (another company too);
 * - (2) the record no longer the responsible person's to read after the occurrence was made → skipped, job not paused;
 * - (3) delivery order: a row written later with an earlier time is still seen;
 * - (4) a migration's row, an outside system's row and a row with no change of state make nothing;
 * - (5) paused (or the company's stop): what happens meanwhile never runs, what came before still does;
 * - (6) hundreds of rows: one tick reads a bounded number and the next goes on from there; the day's limit skips the
 *   rest, tells the responsible person once without a count, and never pauses the job;
 * - (7) an old admin console, an old app and a server that does not know schema 2: never run, never crash;
 * - (8) a run's row (a job's, an AI turn's) makes nothing; the person's own consultation AI's change does;
 * - (9) one occurrence per event over two ticks and a restart;
 * - ⑧ a state a business plugin runs as 「AI の番」: refused when saved, made nothing at the event, skipped before acting;
 *   ⑤ the assignee checked at the event and right before acting.
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
import { jobsRoute } from '../../src/routes/jobs'
import { services } from '../../src/composition'
import { createJobService, type JobService } from '../../src/services/jobs'
import { createJobOccurrences, type JobOccurrences } from '../../src/services/job-occurrences'
import { createJobRetry } from '../../src/services/job-retry'
import { EVENT_ROWS_PER_TICK } from '../../src/services/job-events'
import { createServiceRecordWriter, type ServiceRecordWriter } from '../../src/services/record-engine'
import { insertLedgerRow, insertMigrationLedgerRow } from '../../src/adapters/sqlite/record-ledger-write'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { jobConsentCanonical, type JobDefinition } from '../../../shared/core/jobs'
import { canonicalJson } from '../../../shared/core/fixed-content'

const app = new Hono()
app.route('/api/companies/:companyId', jobsRoute)

const CO = 'ev-co'
const OTHER = 'ev-other'
const TS = '2026-11-01T00:00:00.000Z'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const READS_2 = [1, 2]

async function call(user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, company = CO) {
  currentUser.id = user
  const res = await app.request(`/api/companies/${company}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}

const jst = (local: string) => Date.parse(`${local}:00+09:00`)
let nowMs = jst('2026-11-18T10:00')
const clock = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }
const companyData = sqliteCompanyData(db)
const memberships = sqliteMembershipRepository(db)
const transactions = sqliteTransactions(db)
const roleOf = (co: string, user: string) => memberships.roleOf(co, user)
/** A business plugin's 「AI の番」 states per type (the plugins' lane in composition; a fake here). */
let aiSteps: Record<string, string[]> = {}
const aiStepStates = (_co: string, type: string) => new Set(aiSteps[type] ?? [])

const writer: ServiceRecordWriter = createServiceRecordWriter({
  companyData, transactions, clock, ids: randomIds,
  featureOff: (co, type) => services.features.typeOff(co, type),
  isMember: (co, user) => roleOf(co, user) !== null, roleOf,
  notify: (co, users, change) => { if (change) services.notifications.recordChange(co, users, change) },
})
function jobServiceOf(knownSchemas?: number[]): JobService {
  return createJobService({
    companyData, memberships, transactions, clock, ids: randomIds, skillTree: async () => null, hasCompanyFolder: () => true,
    occurrenceHolds: { holdDue: (co, job, code) => occ.holdDue(co, job, code), holdPassedSlot: (co, job, code) => occ.holdPassedSlot(co, job, code) },
    aiStepStates, ...(knownSchemas ? { knownSchemas } : {}),
  })
}
const jobs = jobServiceOf()
const occurrencesService = (data: typeof companyData = companyData, log?: (line: string) => void): JobOccurrences => createJobOccurrences({
  companyData: data, transactions, clock, ids: randomIds, timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf, jobs, writer, aiStepStates,
  ...(log ? { log } : {}),
})
/** The company data as another server would see it, with the jobs repository's methods wrapped (a fault, a race). */
function wrapJobs(wrap: (jobs: ReturnType<typeof companyData.forCompany>['jobs']) => Partial<ReturnType<typeof companyData.forCompany>['jobs']>): typeof companyData {
  return {
    ...companyData,
    forCompany: (co: string) => {
      const handle = companyData.forCompany(co)
      return { ...handle, jobs: { ...handle.jobs, ...wrap(handle.jobs) } }
    },
  }
}
let occ: JobOccurrences

const m = (userId: string, role: string, co = CO) => ({ companyId: co, userId, role })
const owner = (co = CO) => m('u-owner', 'owner', co)
const alice = (co = CO) => m('u-alice', 'member', co)
const bob = (co = CO) => m('u-bob', 'member', co)
const HUMAN = { kind: 'human' as const }

/** 「見張っているやることが完了になったら、次のやることを自分に作る」 for alice. */
function chain(startRecord: string, overrides: Record<string, unknown> = {}, trigger: Record<string, unknown> = {}): Json {
  return {
    schema: 2, name: '次のやること', actingUser: 'u-alice',
    trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord, followMadeTask: true, ...trigger },
    check: { kind: 'none' },
    run: { kind: 'operation', operation: 'create_task', title: '次の一歩を書く', dueBusinessDays: null },
    placement: 'e',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 5 } },
    ...overrides,
  }
}

/** Made by the owner, approved, accepted by alice (a 4a client: reads schema 2). */
async function runnableJob(definition: Json, co = CO): Promise<string> {
  const made = await jobs.create(owner(co), { definition }, READS_2)
  if (!made.ok) throw new Error(JSON.stringify(made.body))
  const approved = await jobs.approve(owner(co), made.value.id, { version: 1 }, READS_2)
  if (!approved.ok) throw new Error(JSON.stringify(approved.body))
  const accepted = await jobs.accept(alice(co), made.value.id, { version: 1 }, READS_2)
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.body))
  return made.value.id
}

const ok = <T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
/** A やること alice (by default) is the assignee of, made by `by` (a person). */
function task(title: string, extra: Record<string, unknown> = {}, by = alice()): string {
  return ok(services.recordEngine.create(by, HUMAN, { type: 'task', title, fields: { assignee: 'u-alice' }, ...extra })).record.id
}
const versionOf = (id: string, co = CO) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(co, id) as { version: number }).version
async function complete(id: string, who = alice(), actor: Json = HUMAN) {
  return ok(await services.recordEngine.act(who, actor, id, 'complete', { expectedVersion: versionOf(id, who.companyId) }))
}
async function reopen(id: string, who = alice()) {
  return ok(await services.recordEngine.act(who, HUMAN, id, 'reopen', { expectedVersion: versionOf(id, who.companyId) }))
}
const occurrencesOf = (jobId: string, co = CO) => db.prepare(`SELECT id, due_slot, state, outcome_code, event_seq, event_record_id, event_day FROM ai_job_occurrences
  WHERE company_id = ? AND job_id = ? ORDER BY event_seq`).all(co, jobId) as Json[]
/** The やること the job's occurrences made (each one's id comes from its occurrence), oldest first. */
const madeTasks = (jobId: string, co = CO) => db.prepare(`SELECT r.id, r.personal_owner FROM records r JOIN ai_job_occurrences o
  ON o.company_id = r.company_id AND r.id = 'task-' || substr(o.id, 5) WHERE r.company_id = ? AND o.job_id = ? ORDER BY o.event_seq`).all(co, jobId) as Json[]
const cursorOf = (jobId: string, co = CO) => db.prepare('SELECT seen_seq, watch_record_id, watch_fired FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?').get(co, jobId) as Json
const jobState = (jobId: string, co = CO) => (db.prepare('SELECT state FROM ai_jobs WHERE company_id = ? AND id = ?').get(co, jobId) as Json).state
/** A clock tick and the runner, as the server clock does. */
function tick(co = CO) {
  const made = occ.makeOccurrences(co)
  occ.runDue(co)
  return made
}

function member(co: string, user: string, role: string) {
  db.prepare('INSERT OR REPLACE INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${user}`, user, co, role, TS, TS)
}
const PEOPLE: Array<[string, string]> = [['u-owner', 'owner'], ['u-admin', 'admin'], ['u-alice', 'member'], ['u-bob', 'member']]

beforeAll(async () => {
  initDatabase()
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', TS, TS)
    db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${co}-root`, co, TS)
    db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'everyone', NULL, 1, 1, ?)").run(`${co}-root-r`, co, `${co}-root`, TS)
    for (const [user, role] of PEOPLE) member(co, user, role)
    db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(co, TS, 'u-owner')
    await services.records.refreshIndex(owner(co))
  }
})

beforeEach(() => {
  for (const t of ['ai_job_occurrences', 'ai_job_event_cursors', 'ai_job_event_gaps', 'ai_job_versions', 'ai_jobs', 'notifications', 'ai_job_settings']) db.prepare(`DELETE FROM ${t}`).run()
  db.prepare("DELETE FROM ai_runs WHERE subject_kind = 'occurrence'").run()
  aiSteps = {}
  nowMs = jst('2026-11-18T10:00')
  occ = occurrencesService()
})

describe('the watched record (the narrowing every event trigger needs)', () => {
  it('a trigger without a watched record is refused when saved, in plain words; a 4a client is needed to make one', async () => {
    const start = task('最初のやること')
    const without = { ...chain(start).trigger }
    delete without.startRecord
    const refused = await jobs.create(owner(), { definition: chain(start, { trigger: without }) }, READS_2)
    expect(refused).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'BAD_JOB_DEFINITION', problems: ['trigger.startRecord.REQUIRED'] } })
    expect((refused as Json).body.error).toContain('見張るやること')
    // A screen that did not say it reads schema 2 makes none (an old admin console).
    expect(await jobs.create(owner(), { definition: chain(start) })).toMatchObject({ ok: false, body: { code: 'JOB_NEEDS_NEWER_SCREEN' } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get()).toEqual({ n: 0 })
  })

  it('the start record must be one both the saver and the responsible person read — one answer whatever fails', async () => {
    const bobsOwn = task('ボブだけのやること', { personal: true, fields: { assignee: 'u-bob' } }, bob())
    const alicesOwn = task('アリスだけのやること', { personal: true })
    for (const start of [bobsOwn, alicesOwn, 'task-0000000000000000']) {
      expect(await jobs.create(owner(), { definition: chain(start) }, READS_2)).toMatchObject({ ok: false, body: { code: 'BAD_JOB_DEFINITION', problems: ['trigger.startRecord.NOT_FOUND'] } })
    }
  })

  it('a version naming a start record a viewer cannot read is hidden from them, owners and admins too', async () => {
    const start = task('二人だけ', { members: ['u-owner'] })
    const job = await runnableJob(chain(start))
    const forAdmin = await call('u-admin', 'GET', `/jobs/${job}`, undefined, { 'X-ACB-Job-Schemas': '1,2' })
    expect(forAdmin.body.data.versions[0]).toMatchObject({ definition: null, fingerprint: null })
    expect(forAdmin.body.data.trigger).toBeUndefined()
    const forOwner = await call('u-owner', 'GET', `/jobs/${job}`, undefined, { 'X-ACB-Job-Schemas': '1,2' })
    expect(forOwner.body.data.versions[0].definition.trigger.startRecord).toBe(start)
  })

  it('approval checks the trigger again: a state a business plugin now runs as 「AI の番」 is refused', async () => {
    const start = task('承認の前に変わる')
    const made = ok(await jobs.create(owner(), { definition: chain(start, {}, { to: 'review' }) }, READS_2))
    aiSteps = { task: ['review'] }
    expect(await jobs.approve(owner(), made.id, { version: 1 }, READS_2)).toMatchObject({ ok: false, body: { code: 'JOB_TRIGGER_NOT_ALLOWED' } })
  })

  it('only the watched record fires: another task of the same person, a duplicate, a tag on another record make nothing; once per target', async () => {
    const start = task('報告を出す')
    const job = await runnableJob(chain(start))
    // Bob asked alice for it: he may tag it.
    const other = task('別のやること', {}, bob())
    const duplicate = task('報告を出す')
    // Bob tags another record and completes it: nothing moves the watch.
    ok(await services.recordEngine.act(bob(), HUMAN, other, 'set_tags', { expectedVersion: versionOf(other), args: { tags: ['報告を出す'] } }))
    await complete(other)
    await complete(duplicate)
    expect(tick()).toBe(0)
    expect(occurrencesOf(job)).toEqual([])
    // The watched one, completed by someone else (the requester is not the assignee): it counts.
    await complete(start, alice())
    expect(tick()).toBe(1)
    // Undone and completed again: nothing more for this target.
    await reopen(start, alice())
    await complete(start, alice())
    expect(tick()).toBe(0)
    expect(occurrencesOf(job)).toEqual([expect.objectContaining({ state: 'done', event_record_id: start })])
  })

  it('completed, undone and completed again before any tick: one occurrence', async () => {
    const start = task('すぐに取り消して完了')
    const job = await runnableJob(chain(start, {}, { followMadeTask: false }))
    await complete(start)
    await reopen(start)
    await complete(start)
    expect(tick()).toBe(1)
    // Still the watched one (it follows nothing): undone and completed again in a later tick, still nothing more.
    await reopen(start)
    await complete(start)
    expect(tick()).toBe(0)
    expect(occurrencesOf(job)).toHaveLength(1)
  })

  it('follows what it made: the made やること (owner-only for alice) is watched next — also after a rename; the start record no more', async () => {
    const start = task('最初')
    const job = await runnableJob(chain(start))
    await complete(start)
    tick()
    const [made] = madeTasks(job)
    expect(made).toMatchObject({ personal_owner: 'u-alice' })
    expect(cursorOf(job)).toMatchObject({ watch_record_id: made.id, watch_fired: 0 })
    // A rename never matters (the title is not compared).
    db.prepare("UPDATE records SET title = '名前を変えた' WHERE company_id = ? AND id = ?").run(CO, made.id)
    await complete(made.id)
    expect(tick()).toBe(1)
    expect(madeTasks(job)).toHaveLength(2)
    // Without following: one occurrence, then nothing.
    const start2 = task('一度だけ')
    const once = await runnableJob(chain(start2, { name: '一度だけ' }, { followMadeTask: false }))
    await complete(start2)
    tick()
    expect(cursorOf(once)).toMatchObject({ watch_record_id: start2, watch_fired: 1 })
  })
})

describe('(1) an event occurrence of a record the viewer cannot read does not exist for them', () => {
  /** What an owner, an admin and another company's owner get: the list, the job's newest occurrence, the bell. */
  async function seen(job: string) {
    const out: Json = {}
    for (const [who, co] of [['u-owner', CO], ['u-admin', CO], ['u-owner', OTHER]] as const) {
      const list = await call(who, 'GET', `/jobs/${job}/occurrences`, undefined, {}, co)
      const view = await call(who, 'GET', `/jobs/${job}`, undefined, { 'X-ACB-Job-Schemas': '1,2' }, co)
      const listed = await call(who, 'GET', '/jobs', undefined, { 'X-ACB-Job-Schemas': '1,2' }, co)
      const bell = services.notifications.list(m(who, who === 'u-admin' ? 'admin' : 'owner', co))
      out[`${who}@${co}`] = {
        list: list.status === 200 ? list.body.data.occurrences.map((o: Json) => [o.id, o.state, o.dueSlot]) : list,
        last: view.status === 200 ? view.body.data.lastOccurrence : view,
        updatedAt: view.status === 200 ? view.body.data.updatedAt : null,
        jobs: listed.body.data.jobs.map((j: Json) => [j.id, j.lastOccurrence, j.waiting, j.state]),
        bell: bell.ok ? [bell.value.unread, bell.value.items.map(i => i.text)] : bell,
      }
    }
    return out
  }

  it('owners, admins and another company answer the same with or without it; alice sees it', async () => {
    const start = task('みんなに見えるやること')
    const job = await runnableJob(chain(start))
    await complete(start)
    tick()
    const before = await seen(job)
    // The next one is alice's own (owner-only): its event and its occurrence — expired, so a notice is written too.
    const [made] = madeTasks(job)
    await complete(made.id)
    occ.makeOccurrences(CO)
    nowMs += 2 * 24 * 60 * 60_000
    occ.makeOccurrences(CO)
    const hidden = occurrencesOf(job).find((o: Json) => o.event_record_id === made.id)
    expect(hidden).toMatchObject({ state: 'expired' })
    expect(await seen(job)).toEqual(before)
    // Not even a row for the owner (the job's creator): never written to someone who does not read the record.
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'job_expired' AND user_id = 'u-owner'").get()).toEqual({ n: 0 })
    // Alice reads her own やること: she sees the occurrence and its notice.
    const hers = await call('u-alice', 'GET', `/jobs/${job}/occurrences`)
    expect(hers.body.data.occurrences.map((o: Json) => o.id)).toContain(hidden.id)
    expect(hers.body.data.occurrences.find((o: Json) => o.id === hidden.id)).toMatchObject({ kind: 'event' })
    expect(hers.body.data.occurrences.every((o: Json) => !String(o.dueSlot).startsWith('ev:'))).toBe(true)
    const bell = ok(services.notifications.list(alice()))
    expect(bell.items.some(i => i.kind === 'job_expired')).toBe(true)
    // 「もう一度」 by the owner: the same 404 as an occurrence that does not exist.
    const retry = createJobRetry({ companyData, transactions, clock, roleOf, jobs, aiStops: () => ({ stopped: false }) as Json, reconcileFor: () => ({ ok: false }) as Json })
    expect(retry.retry(owner(), job, hidden.id)).toEqual(retry.retry(owner(), job, `occ.${'0'.repeat(32)}`))
  })
})

describe('(2) the record no longer the responsible person\'s to read', () => {
  it('the responsible person gone after the occurrence was made: only the occurrence is skipped, the job is not paused', async () => {
    const start = task('いなくなる前')
    const job = await runnableJob(chain(start))
    await complete(start)
    occ.makeOccurrences(CO)
    db.prepare("DELETE FROM memberships WHERE company_id = ? AND user_id = 'u-alice'").run(CO)
    occ.runDue(CO)
    member(CO, 'u-alice', 'member')
    expect(occurrencesOf(job)).toEqual([expect.objectContaining({ state: 'skipped', outcome_code: 'OWNER_LEFT' })])
    expect(jobState(job)).toBe('active')
  })

  it('a notice of an occurrence is gone for someone who no longer reads its record (and never written to one who does not)', async () => {
    const start = task('二人だけ・知らせ', { members: ['u-owner'] })
    const job = await runnableJob(chain(start))
    await complete(start)
    occ.makeOccurrences(CO)
    nowMs += 2 * 24 * 60 * 60_000
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job)).toEqual([expect.objectContaining({ state: 'expired' })])
    const ownersBell = () => ok(services.notifications.list(owner())).items.filter(i => i.kind === 'job_expired')
    expect(ownersBell()).toHaveLength(1)
    // The owner taken off the list: the notice is not there for them any more.
    db.prepare("DELETE FROM record_viewers WHERE company_id = ? AND record_id = ? AND user_id = 'u-owner'").run(CO, start)
    expect(ownersBell()).toHaveLength(0)
    // The admin, who never read it, was never written to.
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'job_expired' AND user_id = 'u-admin'").get()).toEqual({ n: 0 })
  })

  it('after the occurrence was made: skipped, the job not paused, nobody told', async () => {
    const start = task('二人だけのやること', { members: ['u-owner'] })
    const job = await runnableJob(chain(start))
    await complete(start)
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job)).toEqual([expect.objectContaining({ state: 'due' })])
    // Alice is taken off the list (as a change of who reads it would).
    db.prepare("DELETE FROM record_viewers WHERE company_id = ? AND record_id = ? AND user_id = 'u-alice'").run(CO, start)
    occ.runDue(CO)
    expect(occurrencesOf(job)).toEqual([expect.objectContaining({ state: 'skipped', outcome_code: 'EVENT_RECORD_GONE' })])
    expect(jobState(job)).toBe('active')
    expect(madeTasks(job)).toEqual([])
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind IN ('job_expired', 'job_skipped', 'job_failed', 'job_paused')").get()).toEqual({ n: 0 })
  })

  it('at the event: nothing made', async () => {
    const start = task('二人だけのやること', { members: ['u-owner'] })
    const job = await runnableJob(chain(start))
    await complete(start)
    db.prepare("DELETE FROM record_viewers WHERE company_id = ? AND record_id = ? AND user_id = 'u-alice'").run(CO, start)
    expect(tick()).toBe(0)
    expect(occurrencesOf(job)).toEqual([])
  })
})

describe('(3) delivery order, never time', () => {
  it('a row written later with an earlier time is still seen', async () => {
    const start = task('時刻の古い行')
    const job = await runnableJob(chain(start))
    // Something else first, looked at by a tick: the cursor passes it.
    await complete(task('ほかのやること'))
    tick()
    const seen = cursorOf(job).seen_seq
    // The watched record's completion arrives now with a time from before (as a migration or a slow writer leaves it).
    const v = versionOf(start)
    transactions.run(() => {
      db.prepare("UPDATE record_state SET state = 'done', version = version + 1 WHERE company_id = ? AND record_id = ?").run(CO, start)
      insertLedgerRow(db, CO, ledgerRow(start, v + 1, 'todo', 'done', { at: '2026-01-01T00:00:00.000Z' }))
    })
    expect(tick()).toBe(1)
    expect(occurrencesOf(job)[0].event_seq).toBeGreaterThan(seen)
  })
})

/** A ledger row as the engine writes it, for the rows no route makes (a migration, an outside system, a run). */
function ledgerRow(recordId: string, version: number, from: string, to: string, over: Record<string, unknown> = {}): Json {
  return {
    recordId, version, action: 'complete', fromState: from, toState: to, actorId: 'u-alice', actorKind: 'human', actorSource: null, at: clock.now(), note: '',
    changes: JSON.stringify([{ field: 'state', before: from, after: to }]), attachments: '[]', decision: null, isDecision: 0, typeVersion: null,
    reversesVersion: null, proposedBy: null, conversationId: null, receipt: null, onBehalfOf: null, runId: null, skills: null, via: null, origin: null, ...over,
  }
}
/** The watched record moved to `done` by a row written directly. */
function moved(start: string, over: Record<string, unknown>, migration = false) {
  const v = versionOf(start)
  transactions.run(() => {
    db.prepare("UPDATE record_state SET state = 'done', version = version + 1 WHERE company_id = ? AND record_id = ?").run(CO, start)
    if (migration) {
      insertMigrationLedgerRow(db, CO, { recordId: start, version: v + 1, action: 'carry', fromState: 'todo', toState: 'done', actorId: 'acb:migration', actorKind: 'external', actorSource: 'ACB', at: clock.now(), changes: '[]', typeVersion: 13 })
    } else {
      insertLedgerRow(db, CO, ledgerRow(start, v + 1, 'todo', 'done', over))
    }
  })
}

describe('(4) what is never an event', () => {
  it('a migration\'s row, an outside system\'s row, the server\'s own row, a row with no change of state', async () => {
    for (const [what, over, migration] of [
      ['migration', {}, true],
      ['plugin import', { actorId: 'hubspot', actorKind: 'external', actorSource: 'hubspot' }, false],
      ['the clock', { actorId: 'acb:clock', actorKind: 'external', origin: 'system' }, false],
      ['no change of state', { fromState: 'done', toState: 'done' }, false],
    ] as Array<[string, Json, boolean]>) {
      const start = task(`見張る：${what}`)
      const job = await runnableJob(chain(start, { name: what }))
      moved(start, over, migration)
      tick()
      expect(occurrencesOf(job), what).toEqual([])
    }
  })
})

describe('(5) paused or stopped', () => {
  it('what happens while paused never runs; what came before it and was not looked at yet still does', async () => {
    const before = task('止める前に完了')
    const job = await runnableJob(chain(before, {}, { followMadeTask: false }))
    await complete(before) // no tick yet
    nowMs += 60_000
    expect(ok(jobs.pause(owner(), job))).toMatchObject({ state: 'paused' })
    // A tick while paused looks at nothing: what came before is still there after the resume.
    expect(tick()).toBe(0)
    nowMs += 60_000
    ok(await jobs.resume(owner(), job))
    expect(tick()).toBe(1)
    expect(occurrencesOf(job)).toEqual([expect.objectContaining({ state: 'done' })])

    const during = task('止めている間に完了')
    const job2 = await runnableJob(chain(during, { name: '二つめ' }, { followMadeTask: false }))
    ok(jobs.pause(alice(), job2))
    await complete(during)
    ok(await jobs.resume(alice(), job2))
    expect(tick()).toBe(0)
    expect(occurrencesOf(job2)).toEqual([])

    // After the resume, what happens runs again.
    const after = task('再開のあとに完了')
    const job3 = await runnableJob(chain(after, { name: '三つめ' }, { followMadeTask: false }))
    ok(jobs.pause(owner(), job3))
    ok(await jobs.resume(owner(), job3))
    await complete(after)
    expect(tick()).toBe(1)
  })

  it('a new consent not accepted yet: what happens before its 受け取る never runs', async () => {
    const start = task('受け取り直しの前')
    const job = await runnableJob(chain(start))
    // A new title changes what alice accepts: approved, not accepted yet.
    ok(await jobs.update(owner(), job, { definition: chain(start, { run: { ...chain('x').run, title: '別の名前で作る' } }) }, READS_2))
    ok(await jobs.approve(owner(), job, { version: 2 }, READS_2))
    await complete(start)
    expect(tick()).toBe(0)
    ok(await jobs.accept(alice(), job, { version: 2 }, READS_2))
    expect(tick()).toBe(0)
    expect(occurrencesOf(job)).toEqual([])
  })

  it('a pause or a stop made by the build before 4a (a rollback: no gap) never lets what happened meanwhile run', async () => {
    const older = (sql: string, ...args: unknown[]) => { nowMs += 60_000; db.prepare(sql).run(...args) }
    // Paused and resumed, both by the older build.
    const a = task('前の版で止めて再開')
    const jobA = await runnableJob(chain(a, { name: 'A' }))
    older("UPDATE ai_jobs SET state = 'paused', paused_reason = 'ADMIN', updated_at = ? WHERE company_id = ? AND id = ?", clock.now(), CO, jobA)
    await complete(a)
    older("UPDATE ai_jobs SET state = 'active', paused_reason = NULL, updated_at = ? WHERE company_id = ? AND id = ?", clock.now(), CO, jobA)
    // Paused by the older build, resumed by this one.
    const b = task('前の版で止めてこの版で再開')
    const jobB = await runnableJob(chain(b, { name: 'B' }))
    older("UPDATE ai_jobs SET state = 'paused', paused_reason = 'ADMIN', updated_at = ? WHERE company_id = ? AND id = ?", clock.now(), CO, jobB)
    await complete(b)
    ok(await jobs.resume(owner(), jobB))
    expect(tick()).toBe(0)
    // The company's stop, set and lifted by the older build: every event job finds it, not only the first one scanned.
    const c = task('前の版で全部止めた')
    const jobC = await runnableJob(chain(c, { name: 'C' }))
    const c2 = task('前の版で全部止めた・二つめ')
    const jobC2 = await runnableJob(chain(c2, { name: 'C2' }))
    older("INSERT INTO ai_job_settings (company_id, stopped, updated_by, updated_at) VALUES (?, 1, 'u-owner', ?) ON CONFLICT(company_id) DO UPDATE SET stopped = 1, updated_at = excluded.updated_at", CO, clock.now())
    await complete(c)
    await complete(c2)
    older('UPDATE ai_job_settings SET stopped = 0, updated_at = ? WHERE company_id = ?', clock.now(), CO)
    expect(tick()).toBe(0)
    expect(tick()).toBe(0)
    for (const job of [jobA, jobB, jobC, jobC2]) expect(occurrencesOf(job)).toEqual([])
    // After that, this build's own events run as always.
    const d = task('そのあと')
    const jobD = await runnableJob(chain(d, { name: 'D' }))
    await complete(d)
    expect(tick()).toBe(1)
    expect(occurrencesOf(jobD)).toHaveLength(1)
  })

  it('accepting the same version again loses nothing that happened before', async () => {
    const start = task('二度受け取る')
    const job = await runnableJob(chain(start))
    await complete(start)
    ok(await jobs.accept(alice(), job, { version: 1 }, READS_2))
    expect(tick()).toBe(1)
  })

  it('two pauses keep both stretches; the company\'s stop is one too', async () => {
    const a = task('一つめの止め')
    const job = await runnableJob(chain(a))
    ok(jobs.pause(owner(), job))
    await complete(a)
    ok(await jobs.resume(owner(), job))
    ok(jobs.pause(owner(), job))
    ok(await jobs.resume(owner(), job))
    expect(tick()).toBe(0)

    const b = task('会社の止め')
    const job2 = await runnableJob(chain(b, { name: '会社' }))
    ok(jobs.setStopped(owner(), { stopped: true }))
    await complete(b)
    ok(jobs.setStopped(owner(), { stopped: false }))
    expect(tick()).toBe(0)
    expect(occurrencesOf(job2)).toEqual([])
  })
})

describe('(6) many rows and the day\'s limit', () => {
  it('one tick reads a bounded number of the watched record\'s rows; the next goes on from there', async () => {
    const start = task('たくさんの後ろ')
    const job = await runnableJob(chain(start))
    // Hundreds of changes of the watched record itself (a bulk edit), then its completion.
    const v = versionOf(start)
    transactions.run(() => {
      for (let i = 1; i <= EVENT_ROWS_PER_TICK + 200; i++) insertLedgerRow(db, CO, ledgerRow(start, v + i, 'todo', 'todo', { action: 'set_tags', changes: '[]' }))
      db.prepare('UPDATE record_state SET version = ? WHERE company_id = ? AND record_id = ?').run(v + EVENT_ROWS_PER_TICK + 200, CO, start)
    })
    await complete(start)
    const from = cursorOf(job).seen_seq
    expect(tick()).toBe(0)
    expect(cursorOf(job).seen_seq).toBe(from + EVENT_ROWS_PER_TICK)
    expect(tick()).toBe(1)
  })

  it('rows of other records move the cursor up to now at once; a job paused while thousands came delays no other job', async () => {
    const paused = task('長く止める')
    const pausedJob = await runnableJob(chain(paused, { name: '長く止める' }))
    ok(jobs.pause(owner(), pausedJob))
    const busy = task('ほかで大量に変わる')
    const v = versionOf(busy)
    transactions.run(() => {
      for (let i = 1; i <= 3000; i++) insertLedgerRow(db, CO, ledgerRow(busy, v + i, 'todo', 'todo', { action: 'set_tags', changes: '[]' }))
      db.prepare('UPDATE record_state SET version = ? WHERE company_id = ? AND record_id = ?').run(v + 3000, CO, busy)
    })
    ok(await jobs.resume(owner(), pausedJob))
    const start = task('すぐに動くはず')
    const job = await runnableJob(chain(start, { name: 'もう一つ' }))
    await complete(start)
    expect(tick()).toBe(1)
    expect(occurrencesOf(job)).toHaveLength(1)
    // The resumed job's cursor is at now too: nothing of other records is ever read for it again.
    expect(cursorOf(pausedJob).seen_seq).toBe(cursorOf(job).seen_seq)
  })

  it('a job whose scan throws holds no other job back, and is logged once while it keeps failing', async () => {
    const broken = task('壊れた仕事')
    const brokenJob = await runnableJob(chain(broken, { name: '壊れた' }))
    const start = task('動く仕事')
    const job = await runnableJob(chain(start, { name: '動く' }))
    const lines: string[] = []
    occ = occurrencesService(wrapJobs(j => ({
      eventCursor: (id: string) => { if (id === brokenJob) throw new TypeError('broken'); return j.eventCursor(id) },
    })), line => lines.push(line))
    await complete(broken)
    await complete(start)
    expect(tick()).toBe(1)
    expect(occurrencesOf(job)).toHaveLength(1)
    tick()
    expect(lines.filter(l => l.includes(brokenJob))).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('壊れた')
  })

  it('two clocks at once: a pass whose cursor another clock moved meanwhile keeps nothing; the next does it once', async () => {
    const start = task('二つの時計')
    const job = await runnableJob(chain(start))
    let raced = false
    occ = occurrencesService(wrapJobs(j => ({
      watchedEvents: (...a: Parameters<typeof j.watchedEvents>) => {
        const rows = j.watchedEvents(...a)
        // Meanwhile another server's clock moved the cursor (it made what it made).
        if (!raced) { raced = true; db.prepare('UPDATE ai_job_event_cursors SET seen_seq = seen_seq + 1 WHERE company_id = ? AND job_id = ?').run(CO, job) }
        return rows
      },
    })))
    await complete(start)
    expect(occ.makeOccurrences(CO)).toBe(0)
    expect(occurrencesOf(job)).toEqual([])
    expect(occ.makeOccurrences(CO)).toBe(1)
    expect(occurrencesOf(job)).toHaveLength(1)
  })

  it('a target skipped for the day\'s limit is done with: undone and completed again the next day, still nothing', async () => {
    const start = task('上限で見送られた')
    const job = await runnableJob(chain(start, { grant: { ...chain('x').grant, limits: { minutes: 5, runsPerDay: 1 } } }))
    // Today's one occurrence is used already (another target of the job earlier today).
    db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at,
      event_seq, event_record_id, event_day) VALUES (?, ?, ?, 1, 'ev:1', 'Asia/Tokyo', ?, ?, 'done', ?, ?, 1, 'task-0000000000000001', '2026-11-18')`)
      .run(CO, `occ.${'f'.repeat(32)}`, job, clock.now(), clock.now(), clock.now(), clock.now())
    await complete(start)
    expect(tick()).toBe(0)
    nowMs += 24 * 60 * 60_000
    await reopen(start)
    await complete(start)
    expect(tick()).toBe(0)
    expect(occurrencesOf(job).filter((o: Json) => o.event_record_id === start)).toEqual([])
  })

  it('the limit\'s notice is shown to the responsible person only (a row someone else has says nothing)', async () => {
    const start = task('上限の知らせ')
    const job = await runnableJob(chain(start))
    for (const user of ['u-alice', 'u-owner']) {
      db.prepare(`INSERT INTO notifications (id, company_id, user_id, kind, record_id, record_version, action, actor_id, actor_kind, dedupe_key, created_at, read_at)
        VALUES (?, ?, ?, 'job_events_skipped', '', 0, '', NULL, NULL, ?, ?, NULL)`).run(`n-${user}`, CO, user, `job_events_skipped:${job}:2026-11-18`, clock.now())
    }
    expect(ok(services.notifications.list(alice())).items.some(i => i.kind === 'job_events_skipped')).toBe(true)
    expect(ok(services.notifications.list(owner())).items.some(i => i.kind === 'job_events_skipped')).toBe(false)
  })

  it('beyond the day\'s limit nothing is made, the responsible person is told once without a count, the job keeps running', async () => {
    const start = task('上限の始まり')
    const job = await runnableJob(chain(start, { grant: { ...chain('x').grant, limits: { minutes: 5, runsPerDay: 1 } } }))
    await complete(start)
    tick()
    const [made] = madeTasks(job)
    await complete(made.id)
    expect(tick()).toBe(0)
    expect(occurrencesOf(job)).toHaveLength(1)
    expect(jobState(job)).toBe('active')
    const told = db.prepare("SELECT user_id FROM notifications WHERE kind = 'job_events_skipped'").all()
    expect(told).toEqual([{ user_id: 'u-alice' }])
    const text = ok(services.notifications.list(alice())).items.find(i => i.kind === 'job_events_skipped')?.text ?? ''
    expect(text).toContain('いくつかの出来事を見送りました')
    expect(text).not.toMatch(/[0-9０-９]+件/)
    // Nobody else hears of it.
    expect(ok(services.notifications.list(owner())).items.some(i => i.kind === 'job_events_skipped')).toBe(false)
  })
})

describe('the watched record across versions, and the order of a job\'s occurrences', () => {
  it('accepting again with the same start record keeps the chain where it is (the start record does not fire again)', async () => {
    const start = task('同じ始まり')
    const job = await runnableJob(chain(start))
    await complete(start)
    tick()
    const [made] = madeTasks(job)
    // A new title: alice accepts again, the start record is the same.
    ok(await jobs.update(owner(), job, { definition: chain(start, { run: { ...chain('x').run, title: '題だけ変える' } }) }, READS_2))
    ok(await jobs.approve(owner(), job, { version: 2 }, READS_2))
    ok(await jobs.accept(alice(), job, { version: 2 }, READS_2))
    expect(cursorOf(job)).toMatchObject({ watch_record_id: made.id })
    await reopen(start)
    await complete(start)
    expect(tick()).toBe(0)
    await complete(made.id)
    expect(tick()).toBe(1)
  })

  it('an occurrence whose record is no longer the one watched is skipped (a defence: only the runner moves the watch, after it acted)', async () => {
    const start = task('前の見張り先')
    const job = await runnableJob(chain(start))
    await complete(start)
    occ.makeOccurrences(CO)
    db.prepare("UPDATE ai_job_event_cursors SET watch_record_id = 'task-0000000000000002' WHERE company_id = ? AND job_id = ?").run(CO, job)
    occ.runDue(CO)
    expect(occurrencesOf(job)).toEqual([expect.objectContaining({ state: 'skipped', outcome_code: 'EVENT_NOT_WATCHED' })])
  })

  it('acceptance checks the trigger again (a state a business plugin now runs as 「AI の番」)', async () => {
    const start = task('受け取る前に変わる')
    const made = ok(await jobs.create(owner(), { definition: chain(start, {}, { to: 'review' }) }, READS_2))
    ok(await jobs.approve(owner(), made.id, { version: 1 }, READS_2))
    aiSteps = { task: ['review'] }
    expect(await jobs.accept(alice(), made.id, { version: 1 }, READS_2)).toMatchObject({ ok: false, body: { code: 'JOB_TRIGGER_NOT_ALLOWED' } })
    expect(cursorOf(made.id)).toBeUndefined()
  })

  it('newest first: events by delivery number (ev:10 before ev:9), and a time slot that came later before older events', async () => {
    const start = task('並び')
    const job = await runnableJob(chain(start))
    const insert = (id: string, slot: string, dueAt: string, createdAt: string, seq: number | null) => db.prepare(`INSERT INTO ai_job_occurrences
      (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at, event_seq, event_record_id, event_day)
      VALUES (?, ?, ?, 1, ?, 'Asia/Tokyo', ?, ?, 'done', ?, ?, ?, ?, ?)`).run(CO, id, job, slot, dueAt, dueAt, createdAt, createdAt, seq, seq === null ? null : start, seq === null ? null : '2026-11-18')
    const occId = (n: number) => `occ.${n.toString(16).padStart(32, '0')}`
    insert(occId(9), 'ev:9', '2026-11-18T01:00:00.000Z', '2026-11-18T01:05:00.000Z', 9)
    insert(occId(10), 'ev:10', '2026-11-18T00:59:00.000Z', '2026-11-18T01:05:00.000Z', 10)
    expect(companyData.forCompany(CO).jobs.occurrences(job, 2).map(o => o.id)).toEqual([occId(10), occId(9)])
    // The trigger changed to a time of day later: its newer slot comes first, also for the job's last occurrence.
    insert(occId(11), '2026-11-19T09:00', '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z', null)
    expect(companyData.forCompany(CO).jobs.occurrences(job, 3).map(o => o.id)).toEqual([occId(11), occId(10), occId(9)])
    const view = await call('u-owner', 'GET', `/jobs/${job}`, undefined, { 'X-ACB-Job-Schemas': '1,2' })
    expect(view.body.data.lastOccurrence.dueSlot).toBe('2026-11-19T09:00')
  })
})

describe('(7) old screens, old apps, a server before 4a', () => {
  it('an old admin console and an old app get no definition and change nothing; the app is told to update the app', async () => {
    const start = task('古い画面')
    const job = await runnableJob(chain(start))
    const old = await call('u-owner', 'GET', `/jobs/${job}`)
    expect(old.body.data).toMatchObject({ needsUpdate: true })
    expect(old.body.data.trigger).toBeUndefined()
    expect(old.body.data.versions[0]).toMatchObject({ definition: null, needsUpdate: true })
    const app = await call('u-alice', 'POST', `/me/jobs/${job}/accept`, { version: 1 }, { 'X-ACB-Client-Version': '0.9.0+abc1234.20261101' })
    expect(app).toMatchObject({ status: 409, body: { code: 'JOB_NEEDS_NEWER_SCREEN' } })
    expect(app.body.error).toContain('アプリを新しく')
    const screen = await call('u-owner', 'POST', `/jobs/${job}/approve`, { version: 1 })
    expect(screen.body.error).toContain('画面を新しく')
  })

  it('a server that knows schema 1 only reads it as nothing: no crash, nothing approved', async () => {
    const start = task('前の版のサーバー')
    const job = await runnableJob(chain(start))
    const before = jobServiceOf([1])
    expect(before.list(owner(), READS_2)).toMatchObject({ ok: true })
    expect(await before.approve(owner(), job, { version: 1 }, READS_2)).toMatchObject({ ok: false, body: { code: 'JOB_SCHEMA_UNKNOWN' } })
    expect(before.runnerRefusal(CO, companyData.forCompany(CO).jobs.version(job, 1)!)).toBe('OWNER_RIGHTS_CHANGED')
  })
})

describe('(8) runs never make events; the person\'s own consultation AI does', () => {
  it('a run\'s row (a job\'s or an AI turn\'s) makes nothing', async () => {
    const start = task('AI の番が変えた')
    const job = await runnableJob(chain(start))
    moved(start, { actorId: 'u-alice', actorKind: 'ai', actorSource: 'claude-code', runId: 'run-anything' })
    tick()
    expect(occurrencesOf(job)).toEqual([])
  })

  it('alice\'s own AI in her consultation (no run) asking for review: an event', async () => {
    const start = task('相談の AI が進めた')
    const job = await runnableJob(chain(start, {}, { to: 'review' }))
    ok(await services.recordEngine.act(alice(), { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }, start, 'request_review',
      { expectedVersion: versionOf(start), args: { reviewer: 'u-bob' } }))
    expect(tick()).toBe(1)
    expect(occurrencesOf(job)).toEqual([expect.objectContaining({ state: 'done' })])
  })
})

describe('(9) one occurrence per event', () => {
  it('two ticks and a restart make one', async () => {
    const start = task('一回だけ')
    const job = await runnableJob(chain(start))
    await complete(start)
    expect(occ.makeOccurrences(CO)).toBe(1)
    expect(occ.makeOccurrences(CO)).toBe(0)
    expect(occurrencesService().makeOccurrences(CO)).toBe(0)
    // Even with the cursor put back (a crash between): the unique event makes nothing twice.
    db.prepare('UPDATE ai_job_event_cursors SET seen_seq = 0, watch_fired = 0 WHERE company_id = ? AND job_id = ?').run(CO, job)
    occ.makeOccurrences(CO)
    expect(occurrencesOf(job)).toHaveLength(1)
  })
})

describe('⑧ the AI\'s turn, ⑤ the assignee', () => {
  it('a state a business plugin runs as 「AI の番」: refused when saved; nothing at the event; skipped right before acting', async () => {
    const start = task('AI の番の状態')
    aiSteps = { task: ['review'] }
    expect(await jobs.create(owner(), { definition: chain(start, {}, { to: 'review' }) }, READS_2)).toMatchObject({ ok: false, body: { problems: ['trigger.to.AI_TURN'] } })
    aiSteps = {}
    const job = await runnableJob(chain(start, {}, { to: 'review' }))
    aiSteps = { task: ['review'] }
    ok(await services.recordEngine.act(alice(), HUMAN, start, 'request_review', { expectedVersion: versionOf(start), args: { reviewer: 'u-bob' } }))
    expect(tick()).toBe(0)

    aiSteps = {}
    const second = task('あとから AI の番')
    const job2 = await runnableJob(chain(second, { name: 'あとから' }, { to: 'review' }))
    ok(await services.recordEngine.act(alice(), HUMAN, second, 'request_review', { expectedVersion: versionOf(second), args: { reviewer: 'u-bob' } }))
    occ.makeOccurrences(CO)
    aiSteps = { task: ['review'] }
    occ.runDue(CO)
    expect(occurrencesOf(job2)).toEqual([expect.objectContaining({ state: 'skipped', outcome_code: 'EVENT_AI_TURN' })])
    expect(occurrencesOf(job)).toEqual([])
  })

  it('the assignee: someone else\'s at the event makes nothing; changed before acting → skipped', async () => {
    const bobs = task('ボブの担当', { fields: { assignee: 'u-bob' } })
    const job = await runnableJob(chain(bobs))
    await complete(bobs, bob())
    expect(tick()).toBe(0)
    expect(occurrencesOf(job)).toEqual([])

    const start = task('あとで担当が変わる')
    const job2 = await runnableJob(chain(start, { name: '担当' }))
    await complete(start)
    occ.makeOccurrences(CO)
    db.prepare("UPDATE record_state SET fields = json_set(fields, '$.assignee', 'u-bob') WHERE company_id = ? AND record_id = ?").run(CO, start)
    occ.runDue(CO)
    expect(occurrencesOf(job2)).toEqual([expect.objectContaining({ state: 'skipped', outcome_code: 'EVENT_NOT_ASSIGNEE' })])
  })
})

describe('the consent', () => {
  it('a time job\'s is byte for byte what it was; an event job\'s includes what it watches', () => {
    const time = { schema: 1, actingUser: 'u-alice', run: chain('x').run, placement: 'e', grant: chain('x').grant, trigger: { every: 'day', at: '09:00', businessDaysOnly: false } } as unknown as JobDefinition
    expect(jobConsentCanonical(time)).toBe(canonicalJson({ actingUser: 'u-alice', run: time.run, placement: 'e', grant: time.grant }))
    const a = chain('task-aaaaaaaaaaaaaaaa') as JobDefinition
    const b = chain('task-bbbbbbbbbbbbbbbb') as JobDefinition
    expect(jobConsentCanonical(a)).not.toBe(jobConsentCanonical(b))
    expect(jobConsentCanonical({ ...a, name: '別の名前' })).toBe(jobConsentCanonical(a))
  })
})
