/**
 * The rollback floor (stage 4b-0.5, owner memo 「段4b 設計メモ」 第4版 §5, jobs.md "Shapes this build does not know"):
 * production may run this build again after a later one (4b-1) wrote versions of a shape this build does not know
 * (`schema: 3`, an event job run by the responsible person's PC AI) and their occurrences, runs, notices. Such an
 * occurrence is **frozen** here: never shown, counted, told, expired, run, claimed, retried or reconciled — left out in
 * SQL before every limit — and only a pause, the company's stop or a restore reaches it (held, its run ended, nothing
 * told, no chain stopped). The memo's tests F1–F4 (and F5 / F6, F10, F11 further down as the PR grows).
 *
 * Guards (each mutation-checked, the results in the commit message): the repository's frozen filter on each read and
 * move, `holdFrozen` and its call in `holdDue`, `holdDue`'s exhaustive batches, the version view's fingerprints, the
 * acceptance notice.
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
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { jobsRoute } from '../../src/routes/jobs'
import { services } from '../../src/composition'
import { createJobOccurrences } from '../../src/services/job-occurrences'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { hashCanonical } from '../../src/lib/content-hash'
import { canonicalJson } from '../../../shared/core/fixed-content'
import { JOB_PC_STEP, jobConsentCanonical, type JobDefinition } from '../../../shared/core/jobs'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const MINUTE = 60_000
let CO = ''
const companyData = sqliteCompanyData(db)
const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() }
const roleOf = (co: string, user: string) => sqliteMembershipRepository(db).roleOf(co, user)
const past = (min = 60) => new Date(Date.now() - min * MINUTE).toISOString()
const later = (min = 24 * 60) => new Date(Date.now() + min * MINUTE).toISOString()

async function call(user: string, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await app.request(`/api/companies/${CO}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const owner = () => ({ companyId: CO, userId: 'rf-owner', role: 'owner' })
const alice = () => ({ companyId: CO, userId: 'rf-alice', role: 'member' })

function serverJob(over: Record<string, unknown> = {}): Json {
  return {
    schema: 1, name: '週の報告', actingUser: 'rf-alice', trigger: { every: 'day', at: '09:00', businessDaysOnly: false }, check: { kind: 'none' },
    run: { kind: 'operation', operation: 'create_task', title: '週の報告を書く', dueBusinessDays: null }, placement: 'e',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
    ...over,
  }
}
function pcJob(item: string): Json {
  return {
    schema: 1, name: '面談報告書の下書き', actingUser: 'rf-alice', trigger: { every: 'day', at: '09:00', businessDaysOnly: false },
    check: { kind: 'new_meetings', titleWords: [] }, run: { kind: 'procedure', procedure: { source: 'shelf_skill', item } }, placement: 'a',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: { tools: ['records'], creates: ['task'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 } },
  }
}
function publishSkill(): string {
  const current = (db.prepare("SELECT current_version FROM shelf_items WHERE company_id = ? AND name = 'interview-report'").get(CO) as Json)?.current_version ?? null
  const r = services.skillShelf.publish(owner(), { kind: 'skill', departmentId: null, name: 'interview-report', files: [{ path: 'SKILL.md', base64: Buffer.from('# 面談報告書\n下書きを作る。').toString('base64') }], expectedVersion: current })
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value.item.id
}
/** What a later build (4b-1) stores: an event job run by the PC's AI — a shape this build does not know. */
const as4b1 = (d: Json): Json => ({ ...d, schema: 3, placement: 'a', trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', startRecord: 'task-0000000000000001', ai: true } })

async function approvedJob(definition: Json = serverJob()): Promise<string> {
  const made = await services.jobs.create(owner(), { definition })
  if (!made.ok) throw new Error(JSON.stringify(made.body))
  const job = made.value.id
  const approved = await services.jobs.approve(owner(), job, { version: 1 })
  if (!approved.ok) throw new Error(JSON.stringify(approved.body))
  const accepted = await services.jobs.accept(alice(), job, { version: 1 }, undefined, true)
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.body))
  return job
}

/** Version 2 as 4b-1 writes it (schema 3), approved and accepted: what a server rolled back to this build finds. */
function store4b1(job: string, definition: Json = as4b1(serverJob())) {
  const text = canonicalJson(definition)
  const consent = hashCanonical(jobConsentCanonical(definition as JobDefinition))
  const at = past(3 * 24 * 60)
  db.prepare(`INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at,
      approved_by, approved_at, accepted_by, accepted_at) VALUES (?, ?, 2, 3, ?, ?, ?, 'rf-alice', 'rf-owner', ?, 'rf-owner', ?, 'rf-alice', ?)`)
    .run(CO, job, text, hashCanonical(text), consent, at, at, at)
  db.prepare(`UPDATE ai_jobs SET latest_version = 2, approved_version = 2, approved_fingerprint = ?, accepted_version = 2, accepted_consent = ?, state = 'active'
    WHERE company_id = ? AND id = ?`).run(hashCanonical(text), consent, CO, job)
}

let slot = 0
const nextId = () => `occ.${(++slot).toString(16).padStart(32, '0')}`
/** An occurrence of `version` in `state` (event-shaped when `record` is given). */
function occurrence(job: string, version: number, state: string, opts: { expires?: string; dueAt?: string; record?: string; runId?: string | null; code?: string | null } = {}): string {
  const id = nextId()
  const now = new Date().toISOString()
  const event = opts.record !== undefined
  db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, run_id, outcome_code, created_at, updated_at,
      event_seq, event_record_id, event_version, event_day) VALUES (?, ?, ?, ?, ?, 'Asia/Tokyo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(CO, id, job, version, event ? `ev:${slot}` : `2025-01-01T00:00+${slot}`, opts.dueAt ?? past(), opts.expires ?? later(), state, opts.runId ?? null, opts.code ?? null,
      now, now, event ? slot : null, event ? opts.record : null, event ? 1 : null, event ? now.slice(0, 10) : null)
  return id
}
const occOf = (id: string) => db.prepare('SELECT state, outcome_code, run_id FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, id) as Json
const runOf = (id: string) => db.prepare('SELECT state, failure_code, device_id, closed_at FROM ai_runs WHERE company_id = ? AND id = ?').get(CO, id) as Json
const noticeCount = () => (db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE company_id = ?').get(CO) as Json).n as number

/** A PC run on an occurrence (as 4b-1's claim made it), optionally with an outside operation in flight. */
function pcRun(occ: string, opts: { inFlight?: boolean; state?: string } = {}): string {
  const id = `run-${occ.slice(-12)}`
  const at = new Date().toISOString()
  const h = companyData.forCompany(CO).aiRuns
  h.insert({
    id, subject: { kind: 'occurrence', id: occ }, step: JOB_PC_STEP, userId: 'rf-alice', state: (opts.state ?? 'running') as 'running', generation: 1, deviceId: 'device-alice-1',
    conversationId: 'conv-1', claimExpiresAt: later(5), failureClass: null, failureCode: null, retryAt: null,
    attempts: 0, pluginVersion: null, stepsVersion: null, procedure: null, createdAt: past(5), updatedAt: at, closedAt: null,
  })
  if (opts.inFlight) {
    h.insertOperation({ runId: id, key: 'drive-1', fingerprint: 'f', kind: 'drive-put', state: 'in_progress', generation: 1, refKind: null, refId: null, status: null, reconciledBy: null, createdAt: at, updatedAt: at })
  }
  db.prepare('UPDATE ai_job_occurrences SET run_id = ? WHERE company_id = ? AND id = ?').run(id, CO, occ)
  return id
}

/** The clock and the runner (a writer that makes nothing real: the server runner's やること is not what these tests look at). */
function occurrences(made: string[] = []) {
  return createJobOccurrences({
    companyData, transactions: sqliteTransactions(db), clock, ids: randomIds, timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf,
    jobs: services.jobs,
    writer: { check: () => null, create: (_co: string, input: Json) => { made.push(input.id); return { ok: true, record: { id: input.id } } as Json } },
    log: () => {},
  })
}

/** Alice's own やること (owner-only): what an event occurrence's record would be. */
const alicesTask = () => {
  const r = services.recordEngine.create(alice() as Json, { kind: 'human' }, { type: 'task', title: 'アリスのやること', personal: true, fields: { assignee: 'rf-alice' } })
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value.record.id
}
/** The job's event cursor as 4a / 4b-1 keep it (a watch on `record`, fired). */
function cursor(job: string, record: string) {
  db.prepare(`INSERT INTO ai_job_event_cursors (company_id, job_id, seen_seq, watch_record_id, watch_start, watch_fired, updated_at) VALUES (?, ?, 0, ?, ?, 1, ?)`)
    .run(CO, job, record, record, new Date().toISOString())
}
const chainStop = (job: string) => (db.prepare('SELECT chain_stop_code FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?').get(CO, job) as Json)?.chain_stop_code ?? null

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'rf-owner'
  currentUser.id = 'rf-owner'
  const res = await app.request('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Rollback Floor Co', folderKind: 'none' }) })
  CO = ((await res.json()) as Json).data.id
  const at = new Date().toISOString()
  for (const [user, role] of [['rf-alice', 'member'], ['rf-admin', 'admin']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, at, at)
  }
})

beforeEach(() => {
  for (const t of ['ai_job_event_cursors', 'ai_job_event_gaps', 'ai_job_occurrences', 'ai_job_versions', 'ai_jobs', 'notifications', 'ai_job_settings', 'agent_stops']) db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(CO)
  db.prepare("DELETE FROM ai_runs WHERE company_id = ? AND subject_kind = 'occurrence'").run(CO)
})

describe('F1: a frozen occurrence is not there for anyone', () => {
  it('not listed, not the last occurrence, no fingerprint of its version — owners and admins included', async () => {
    const job = await approvedJob()
    const known = occurrence(job, 1, 'done', { dueAt: past(3 * 24 * 60) })
    store4b1(job)
    const record = alicesTask()
    const frozen = ['due', 'running', 'needs_person', 'done', 'held'].map(state => occurrence(job, 2, state, { record }))
    // A time slot of it too, and one pinned to a version whose column says a known schema but whose text does not.
    frozen.push(occurrence(job, 2, 'done'))
    const text = canonicalJson(as4b1(serverJob()))
    db.prepare(`INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at)
      VALUES (?, ?, 3, 1, ?, 'f', 'c', 'rf-alice', 'rf-owner', ?)`).run(CO, job, text, past())
    frozen.push(occurrence(job, 3, 'done'))
    for (const user of ['rf-owner', 'rf-admin', 'rf-alice']) {
      const listed = await call(user, 'GET', `/jobs/${job}/occurrences`)
      expect(listed.body.data.occurrences.map((o: Json) => o.id)).toEqual([known])
      const one = await call(user, 'GET', `/jobs/${job}`)
      expect(one.body.data.lastOccurrence).toMatchObject({ state: 'done' })
      for (const v of one.body.data.versions.slice(0, 2)) expect(v).toMatchObject({ definition: null, fingerprint: null, consentFingerprint: null, needsUpdate: true })
      const all = await call(user, 'GET', '/jobs')
      expect(all.body.data.jobs.find((j: Json) => j.id === job).lastOccurrence).toMatchObject({ state: 'done' })
      expect(JSON.stringify([listed.body, one.body, all.body])).not.toMatch(new RegExp(frozen.join('|')))
    }
    // The repository answers none of them, to any caller.
    const repo = companyData.forCompany(CO).jobs
    for (const id of frozen) expect(repo.occurrence(id)).toBeNull()
    expect(repo.occurrences(job, 100).map(o => o.id)).toEqual([known])
    expect(repo.eventRecordsOf(job, 100)).toEqual([])
    for (const id of frozen) expect(repo.isHiddenOccurrence(id)).toBe(true)
    // Nor moves or sends one back (only `holdFrozen` writes them).
    const at = new Date().toISOString()
    expect(repo.moveOccurrence(frozen[0], ['due'], 'expired', { outcomeCode: 'EXPIRED' }, at)).toBe(false)
    expect(repo.retryOccurrence(frozen[2], ['needs_person'], later(), 'rf-owner', at)).toBe(false)
    expect(occOf(frozen[0])).toMatchObject({ state: 'due' })
    expect(occOf(frozen[2])).toMatchObject({ state: 'needs_person' })
    expect(repo.isHiddenOccurrence(known)).toBe(false)
  })

  it('no notice of it is shown, also one written before: an occurrence’s, a stopped chain’s, an acceptance’s', async () => {
    const job = await approvedJob()
    const record = alicesTask()
    store4b1(job)
    cursor(job, record)
    const failed = occurrence(job, 2, 'needs_person', { record, code: 'RUN_FAILED' })
    const at = new Date().toISOString()
    db.prepare(`UPDATE ai_job_event_cursors SET chain_stop_code = 'DAY_LIMIT', chain_stop_record = ?, chain_stop_at = ? WHERE company_id = ? AND job_id = ?`).run(record, at, CO, job)
    db.prepare("UPDATE ai_jobs SET accepted_version = 1, accepted_consent = 'other' WHERE company_id = ? AND id = ?").run(CO, job)
    companyData.forCompany(CO).notifications.insert(['rf-owner', 'rf-alice'].flatMap((userId, n) => [
      { id: `n-f-${n}`, userId, kind: 'job_failed' as const, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null, dedupeKey: `job_failed:${job}:${failed}:0:RUN_FAILED`, createdAt: at, readAt: null },
      { id: `n-c-${n}`, userId, kind: 'job_chain_stopped' as const, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null, dedupeKey: `job_chain_stopped:${job}:${at}`, createdAt: at, readAt: null },
      { id: `n-a-${n}`, userId, kind: 'job_accept_needed' as const, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null, dedupeKey: `job_accept_needed:${job}:2`, createdAt: at, readAt: null },
    ]))
    for (const m of [owner(), alice()]) {
      const bell = services.notifications.list(m as Json)
      expect(bell.ok && bell.value.items.filter((i: Json) => i.kind.startsWith('job_'))).toEqual([])
      expect(bell.ok && bell.value.unread).toBe(0)
    }
  })
})

describe('F2: the clock leaves a frozen occurrence alone', () => {
  it('a waiting or running one past its time is not expired, told or ended, and its chain is not stopped', async () => {
    const job = await approvedJob()
    store4b1(job)
    const record = alicesTask()
    cursor(job, record)
    const due = occurrence(job, 2, 'due', { record, expires: past(10) })
    const running = occurrence(job, 2, 'running', { record, expires: past(10) })
    const run = pcRun(running)
    db.prepare("UPDATE ai_runs SET claim_expires_at = ? WHERE company_id = ? AND id = ?").run(past(1), CO, run)
    const made: string[] = []
    const o = occurrences(made)
    o.makeOccurrences(CO)
    o.runDue(CO)
    expect(occOf(due)).toMatchObject({ state: 'due', outcome_code: null })
    expect(occOf(running)).toMatchObject({ state: 'running', outcome_code: null })
    expect(runOf(run)).toMatchObject({ state: 'running' })
    expect(db.prepare("SELECT kind, dedupe_key FROM notifications WHERE company_id = ? AND kind <> 'job_accept_needed'").all(CO)).toEqual([])
    expect(chainStop(job)).toBeNull()
    expect(made).toEqual([])
  })

  it('the PC neither lists nor claims it, and a run on it is a missing run', async () => {
    const job = await approvedJob()
    store4b1(job)
    const due = occurrence(job, 2, 'due')
    const running = occurrence(job, 2, 'running')
    const run = pcRun(running)
    expect((await call('rf-alice', 'GET', '/me/job-turns?kinds=time,event')).body.data.turns).toEqual([])
    expect(await call('rf-alice', 'POST', '/job-run-claims', { occurrenceId: due, deviceId: 'device-alice-1', conversationId: 'c-1', checks: ['new_files', 'new_meetings'], kinds: ['time', 'event'] })).toMatchObject({ status: 404 })
    const missing = await call('rf-alice', 'POST', '/ai-runs/run-nowhere/renew', { generation: 1 })
    expect(await call('rf-alice', 'POST', `/ai-runs/${run}/renew`, { generation: 1 })).toEqual(missing)
    expect(occOf(due)).toMatchObject({ state: 'due', run_id: null })
  })

  it('「もう一度」 and reconcile answer exactly as for an occurrence that does not exist', async () => {
    const job = await approvedJob()
    store4b1(job)
    const occ = occurrence(job, 2, 'needs_person', { code: 'RESULT_UNKNOWN' })
    pcRun(occ, { inFlight: true, state: 'waiting_reconcile' })
    const none = 'occ.ffffffffffffffffffffffffffffffff'
    for (const user of ['rf-owner', 'rf-admin']) {
      expect(await call(user, 'POST', `/jobs/${job}/occurrences/${occ}/retry`)).toEqual(await call(user, 'POST', `/jobs/${job}/occurrences/${none}/retry`))
      expect(await call(user, 'POST', `/jobs/${job}/occurrences/${occ}/operations/drive-1/reconcile`, { done: true }))
        .toEqual(await call(user, 'POST', `/jobs/${job}/occurrences/${none}/operations/drive-1/reconcile`, { done: true }))
    }
    expect(occOf(occ)).toMatchObject({ state: 'needs_person' })
  })
})

describe('F3: frozen occurrences never take a batch’s place', () => {
  it('with more frozen ones than any limit ahead of them, the known ones behind are run, expired, listed for the PC and held', async () => {
    const job = await approvedJob()
    const serverJobId = await approvedJob(serverJob({ name: '別の仕事' }))
    const pcJobId = await approvedJob(pcJob(publishSkill()))
    store4b1(job)
    const insert = db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at)
      VALUES (?, ?, ?, 2, ?, 'Asia/Tokyo', ?, ?, ?, ?, ?)`)
    const old = new Date(Date.now() - 400 * 24 * 60 * MINUTE).toISOString()
    let frozen = 0
    // More than every limit (the clock's and the runner's 10,000, the PC list's 10,000) of each, all due long before.
    db.transaction(() => {
      for (let i = 0; i < 10_050; i++) for (const state of ['due', 'running']) {
        insert.run(CO, nextId(), job, `f-${state}-${i}`, old, i % 2 === 0 ? past(5) : later(), state, old, old)
        frozen++
      }
    })()
    // Behind them (a later due time): a server occurrence to run, one whose time ran out, a running one left by its app, a PC turn.
    const toRun = occurrence(serverJobId, 1, 'due')
    const toExpire = occurrence(serverJobId, 1, 'due', { expires: past(1) })
    const leftRunning = occurrence(serverJobId, 1, 'running', { expires: past(1) })
    const pcTurn = occurrence(pcJobId, 1, 'due')
    const o = occurrences()
    expect(o.dueIds(CO)).toEqual([toRun, toExpire])
    expect((await call('rf-alice', 'GET', '/me/job-turns')).body.data.turns.map((t: Json) => t.occurrenceId)).toEqual([pcTurn])
    o.makeOccurrences(CO)
    expect(occOf(toExpire)).toMatchObject({ state: 'expired' })
    expect(occOf(leftRunning)).toMatchObject({ state: 'expired' })
    expect(o.runOccurrence(CO, toRun)).toBe('done')
    // The stop reaches every one, frozen or not, beyond any limit: nothing left waiting or running.
    expect(await call('rf-owner', 'PUT', '/jobs-stop', { stopped: true })).toMatchObject({ status: 200 })
    expect(occOf(pcTurn)).toMatchObject({ state: 'held', outcome_code: 'COMPANY_STOPPED' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM ai_job_occurrences WHERE company_id = ? AND state IN ('due', 'running')").get(CO)).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? AND state = 'held' AND outcome_code = 'COMPANY_STOPPED'").get(CO, job)).toEqual({ n: frozen })
    // The known occurrences that expired, each to its two recipients; nothing of the frozen ones.
    const told = (db.prepare("SELECT dedupe_key FROM notifications WHERE company_id = ? AND kind <> 'job_accept_needed'").all(CO) as Json[]).map(r => r.dedupe_key.split(':')[2])
    expect(told.sort()).toEqual([toExpire, toExpire, leftRunning, leftRunning].sort())
  })

  it('a pause holds more than one batch of the job’s own waiting and running occurrences, and only that job’s', async () => {
    const job = await approvedJob()
    const other = await approvedJob(serverJob({ name: '別の仕事' }))
    const insert = db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, 'Asia/Tokyo', ?, ?, 'due', ?, ?)`)
    const at = new Date().toISOString()
    db.transaction(() => {
      for (let i = 0; i < 10_010; i++) insert.run(CO, nextId(), job, `k-${i}`, at, later(), at, at)
      for (let i = 0; i < 10_010; i++) insert.run(CO, nextId(), job, `r-${i}`, at, later(), at, at)
    })()
    db.prepare("UPDATE ai_job_occurrences SET state = 'running' WHERE company_id = ? AND job_id = ? AND due_slot LIKE 'r-%'").run(CO, job)
    const others = occurrence(other, 1, 'due')
    const othersRunning = occurrence(other, 1, 'running')
    expect(await call('rf-owner', 'POST', `/jobs/${job}/pause`)).toMatchObject({ status: 200 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? AND state IN ('due', 'running')").get(CO, job)).toEqual({ n: 0 })
    expect(occOf(others)).toMatchObject({ state: 'due' })
    expect(occOf(othersRunning)).toMatchObject({ state: 'running' })
  })
})

describe('F4: a pause, the company stop and a restore hold frozen ones and end their runs, telling nobody', () => {
  it.each([
    ['a pause', (job: string) => call('rf-owner', 'POST', `/jobs/${job}/pause`), 'JOB_PAUSED'],
    ['the company stop', () => call('rf-owner', 'PUT', '/jobs-stop', { stopped: true }), 'COMPANY_STOPPED'],
    ['a restore', async () => { services.restorePause.pauseAfterRestore(CO); return { status: 200 } }, 'COMPANY_STOPPED'],
  ] as const)('%s', async (_name, stop, code) => {
    const job = await approvedJob()
    store4b1(job)
    const record = alicesTask()
    cursor(job, record)
    const due = occurrence(job, 2, 'due', { record })
    const running = occurrence(job, 2, 'running', { record })
    const run = pcRun(running)
    const sending = occurrence(job, 2, 'running', { record })
    const sendingRun = pcRun(sending, { inFlight: true })
    const done = occurrence(job, 2, 'done', { record })
    // Another job's frozen one: a pause of this job leaves it as it is.
    const other = await approvedJob(serverJob({ name: '別の仕事' }))
    db.prepare(`INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at)
      SELECT company_id, ?, 2, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at FROM ai_job_versions WHERE company_id = ? AND job_id = ? AND version = 2`).run(other, CO, job)
    const othersFrozen = occurrence(other, 2, 'due')
    const before = noticeCount()
    expect(await stop(job)).toMatchObject({ status: 200 })
    for (const id of [due, running, sending]) expect(occOf(id)).toMatchObject({ state: 'held', outcome_code: code })
    expect(occOf(done)).toMatchObject({ state: 'done' })
    expect(occOf(othersFrozen)).toMatchObject(code === 'JOB_PAUSED' ? { state: 'due' } : { state: 'held', outcome_code: code })
    // Its run ended there and then: its token and renew are refused (waiting for a person, or to reconcile what was in flight).
    expect(runOf(run)).toMatchObject({ state: 'waiting_person', failure_code: code, device_id: null })
    expect(runOf(sendingRun)).toMatchObject({ state: 'waiting_reconcile', failure_code: code })
    expect(db.prepare("SELECT state FROM ai_run_operations WHERE company_id = ? AND run_id = ?").get(CO, sendingRun)).toEqual({ state: 'unknown' })
    // Nobody told of the frozen ones (a restore tells owners / admins of the restore itself only), no chain stopped.
    const told = db.prepare("SELECT kind FROM notifications WHERE company_id = ?").all(CO) as Json[]
    expect(told.filter(n => n.kind !== 'company_restored').length).toBe(before)
    expect(chainStop(job)).toBeNull()
  })
})
