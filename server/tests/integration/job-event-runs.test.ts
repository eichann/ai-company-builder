/**
 * Integration Test: an event job run by the responsible person's PC AI (stage 4b-1, owner memo 「段4b 設計メモ」 第4版 §4 / §6
 * / §8 S1–S10, Codex review 4 #2 / #3; jobs.md "Event jobs on the PC"). The AI never runs here: the app's claim, its calls,
 * renews and finish are made as the app would, and the server's checks are what is tested.
 *
 * Guards (each mutation-checked; the results in the commit message):
 * - an app that does not name the `event` kind and the `source_record` check never lists or claims such an occurrence;
 *   a screen announcing 1,2 never makes, approves or accepts schema 3;
 * - the conditions (C1–C9) at the claim, every call, every renew, the finish and the clock: a failed one ends the run
 *   (its token fenced), refuses every later call, the finish and the やること (S1);
 * - how it ends (§4-4): nothing made outside → no occurrence notice, the chain stopped once (S2); something made →
 *   `needs_person` `MADE_THEN_STOPPED`, told, chain stopped (S3); an outside result nobody knows → `needs_person`
 *   `RESULT_UNKNOWN`, its run waiting for reconciliation, 「もう一度」 refused (S4); reconciling resumes nothing (S5);
 * - who may reconcile and press (D11, S6): the pinned responsible person while they read the record (found through
 *   `GET /me/job-occurrences`, also after a hand-over, never the job's newer versions), the current one may ask but an old
 *   occurrence answers `JOB_VERSION_CHANGED`; run-level 「もう一度」 / reconcile are missing runs for a job's run;
 * - 「もう一度」 after expiry and the time limit; refused without a change when the source changed or records are off (S7);
 * - another running occurrence of the job: wait only, without a limit, never counting itself (S8);
 * - the rewatch re-checks everything after its asynchronous Skill check (S9);
 * - rights too narrow: the occurrence is skipped, the job is never paused (S10).
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
import { createJobService } from '../../src/services/jobs'
import { createJobOccurrences } from '../../src/services/job-occurrences'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'

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
const READS_3 = [1, 2, 3]
let CO = ''

async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown; headers?: Record<string, string> }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const as = (user: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => call({ user, method, path: `/api/companies/${CO}${path}`, body, headers })
const ai = (token: string, method: string, path: string, body?: unknown) => call({ token, method, path: `/api/records-ai${path}`, body })

const member = (userId: string, role: string) => ({ companyId: CO, userId, role })
const owner = () => member('ej-owner', 'owner')
const alice = () => member('ej-alice', 'member')
const HUMAN = { kind: 'human' as const }
const companyData = sqliteCompanyData(db)

function publishSkill(text = '# 面談報告書\n下書きを作る。'): string {
  const current = (db.prepare("SELECT current_version FROM shelf_items WHERE company_id = ? AND name = 'interview-report'").get(CO) as Json)?.current_version ?? null
  const r = services.skillShelf.publish(owner(), { kind: 'skill', departmentId: null, name: 'interview-report', files: [{ path: 'SKILL.md', base64: Buffer.from(text).toString('base64') }], expectedVersion: current })
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value.item.id
}

const ok = <T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
/** A やること of alice's (assignee alice), made by her. */
function task(title: string, extra: Record<string, unknown> = {}, by = alice()): string {
  return ok(services.recordEngine.create(by, HUMAN, { type: 'task', title, fields: { assignee: 'ej-alice' }, ...extra })).record.id
}
const versionOf = (id: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).version
const complete = async (id: string) => ok(await services.recordEngine.act(alice(), HUMAN, id, 'complete', { expectedVersion: versionOf(id) }))
const reopen = async (id: string) => ok(await services.recordEngine.act(alice(), HUMAN, id, 'reopen', { expectedVersion: versionOf(id) }))
const setAssignee = (id: string, who: string) => db.prepare("UPDATE record_state SET fields = json_set(fields, '$.assignee', ?) WHERE company_id = ? AND record_id = ?").run(who, CO, id)
const linkFile = (id: string) => companyData.forCompany(CO).records.replaceLinks(id, [{ sourceId: id, name: 'files', position: 0, targetId: null, targetPath: 'drive:1AbCdEfGhIjKlMnOp' }])

/** 「見張っているやることが完了したら、責任者の PC の AI が報告書の下書きを作る」 (schema 3), alice responsible. */
function eventPcJob(startRecord: string, item: string, overrides: Record<string, unknown> = {}): Json {
  return {
    schema: 3, name: '面談のあとの報告書', actingUser: 'ej-alice',
    trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord, followMadeTask: true },
    check: { kind: 'source_record', doneMark: 'file_linked' },
    run: { kind: 'procedure', procedure: { source: 'shelf_skill', item } },
    placement: 'a',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: {
      tools: ['records'], creates: ['task'], routes: ['GET /item/:recordId', 'POST /query'],
      reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 5 },
    },
    ...overrides,
  }
}

/** Made by the owner (a screen of 4b-3: reads schema 3), approved, accepted by alice; the start record it watches. */
async function eventJob(overrides: Record<string, unknown> = {}, start = task('面談の準備')): Promise<{ job: string; start: string; item: string }> {
  const item = publishSkill()
  const made = ok(await services.jobs.create(owner(), { definition: eventPcJob(start, item, overrides) }, READS_3))
  ok(await services.jobs.approve(owner(), made.id, { version: 1 }, READS_3))
  ok(await services.jobs.accept(alice(), made.id, { version: 1 }, READS_3, true))
  return { job: made.id, start, item }
}
/** The clock's tick (the event scan, the conditions, the expiry). */
const tick = () => services.jobOccurrences.makeOccurrences(CO)
/** An event job whose start record was completed: its one occurrence, `due`. */
async function eventOccurrence(overrides: Record<string, unknown> = {}): Promise<{ job: string; start: string; occ: string; item: string }> {
  const made = await eventJob(overrides)
  await complete(made.start)
  tick()
  const occ = (db.prepare('SELECT id FROM ai_job_occurrences WHERE company_id = ? AND job_id = ?').get(CO, made.job) as Json)?.id
  if (!occ) throw new Error('no occurrence made')
  return { ...made, occ }
}

const claim = (occurrenceId: string, opts: { user?: string; device?: string; checks?: string[]; kinds?: string[] | null } = {}) =>
  as(opts.user ?? 'ej-alice', 'POST', '/job-run-claims', {
    occurrenceId, deviceId: opts.device ?? 'device-alice-1', conversationId: `conv-${opts.device ?? 'device-alice-1'}`,
    checks: opts.checks ?? ['source_record'], ...(opts.kinds === null ? {} : { kinds: opts.kinds ?? ['event'] }),
  })
const turns = (user = 'ej-alice', kinds = 'event') => as(user, 'GET', `/me/job-turns?kinds=${kinds}`)
async function tokenFor(run: Json, device = 'device-alice-1'): Promise<string> {
  const r = await as('ej-alice', 'POST', '/me/record-tokens', { conversationId: `conv-${device}`, agent: 'claude-code', scope: 'act', run: { id: run.id, generation: run.generation } })
  if (r.status !== 201 && r.status !== 200) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}
const finish = (run: Json, body: Record<string, unknown>) => as('ej-alice', 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, ...body })
const renew = (run: Json) => as('ej-alice', 'POST', `/ai-runs/${run.id}/renew`, { generation: run.generation })

const occOf = (id: string) => db.prepare('SELECT state, outcome_code, run_id, retries, expires_at FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, id) as Json
const runOf = (id: string) => db.prepare('SELECT state, failure_code, closed_at FROM ai_runs WHERE company_id = ? AND id = ?').get(CO, id) as Json
const jobOf = (id: string) => db.prepare('SELECT state, paused_reason FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, id) as Json
const madeTasks = () => db.prepare("SELECT id FROM records WHERE company_id = ? AND type = 'task' AND id IN (SELECT 'task-' || substr(id, 5) FROM ai_job_occurrences WHERE company_id = ?)").all(CO, CO) as Json[]
const notices = (kind: string) => (db.prepare('SELECT user_id FROM notifications WHERE company_id = ? AND kind = ? ORDER BY user_id').all(CO, kind) as Json[]).map(n => n.user_id)
const occurrenceNotices = () => [...notices('job_failed'), ...notices('job_expired'), ...notices('job_skipped')]
const cursorOf = (job: string) => db.prepare('SELECT watch_record_id, watch_generation, chain_stop_code FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?').get(CO, job) as Json
function operation(runId: string, key: string, state: 'done' | 'in_progress' | 'unknown', kind = 'drive-put') {
  const at = new Date().toISOString()
  db.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, ref_kind, ref_id, created_at, updated_at)
    VALUES (?, ?, ?, 'f', ?, ?, 1, ?, ?, ?, ?)`).run(CO, runId, key, kind, state, state === 'done' ? 'drive-put' : null, state === 'done' ? `drive-put-${key}` : null, at, at)
}
const opOf = (runId: string, key: string) => db.prepare('SELECT state FROM ai_run_operations WHERE company_id = ? AND run_id = ? AND key = ?').get(CO, runId, key) as Json

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'ej-owner'
  const a = await call({ user: 'ej-owner', method: 'POST', path: '/api/companies', body: { name: 'Event Runs Co', folderKind: 'none' } })
  expect(a.status).toBe(201)
  CO = a.body.data.id
  const at = new Date().toISOString()
  for (const [user, role] of [['ej-alice', 'member'], ['ej-bob', 'member'], ['ej-admin', 'admin']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, at, at)
  }
  vi.useFakeTimers({ toFake: ['Date'] })
})

beforeEach(() => {
  for (const t of ['ai_job_occurrences', 'ai_job_event_cursors', 'ai_job_event_gaps', 'ai_job_versions', 'ai_jobs', 'notifications', 'member_absences', 'ai_job_settings', 'agent_stops']) db.prepare(`DELETE FROM ${t}`).run()
  db.prepare("DELETE FROM ai_runs WHERE subject_kind = 'occurrence'").run()
  db.prepare("UPDATE record_settings SET enabled = 1 WHERE company_id = ?").run(CO)
})

describe('old apps and screens never run, show or accept it (§7)', () => {
  it('an app that does not name the event kind and the source-record check neither lists nor claims the occurrence', async () => {
    const { occ } = await eventOccurrence()
    // Today's app: no kinds (time only), its checks.
    expect((await as('ej-alice', 'GET', '/me/job-turns')).body.data.turns).toEqual([])
    expect(await claim(occ, { kinds: null, checks: ['new_files', 'new_meetings'] })).toMatchObject({ status: 409, body: { code: 'JOB_KIND_NOT_SUPPORTED' } })
    // An app that names the kind but not the check (or the other way round) is refused too, nothing written.
    expect(await claim(occ, { checks: ['new_files', 'new_meetings'] })).toMatchObject({ status: 409, body: { code: 'JOB_CHECK_NOT_SUPPORTED' } })
    expect(await claim(occ, { kinds: ['time'] })).toMatchObject({ status: 409, body: { code: 'JOB_KIND_NOT_SUPPORTED' } })
    expect(occOf(occ)).toMatchObject({ state: 'due', run_id: null })
  })

  it('a screen that announces 1,2 (the admin console and app of 4b-1) cannot make, approve or accept schema 3', async () => {
    const item = publishSkill()
    const start = task('面談の準備')
    for (const reads of [[1], [1, 2]]) {
      expect(await services.jobs.create(owner(), { definition: eventPcJob(start, item) }, reads)).toMatchObject({ ok: false, body: { code: 'JOB_NEEDS_NEWER_SCREEN' } })
    }
    const made = ok(await services.jobs.create(owner(), { definition: eventPcJob(start, item) }, READS_3))
    expect(await services.jobs.approve(owner(), made.id, { version: 1 }, [1, 2])).toMatchObject({ ok: false, body: { code: 'JOB_NEEDS_NEWER_SCREEN' } })
    ok(await services.jobs.approve(owner(), made.id, { version: 1 }, READS_3))
    // The app of 4b-1 (announcing 1,2): no definition, its 受け取る refused with the app's words.
    const seen = await as('ej-alice', 'GET', `/jobs/${made.id}`, undefined, { 'X-ACB-Job-Schemas': '1,2', 'X-ACB-Client-Version': '1.0.0' })
    expect(seen.body.data.versions[0]).toMatchObject({ definition: null, needsUpdate: true })
    const accepted = await as('ej-alice', 'POST', `/me/jobs/${made.id}/accept`, { version: 1 }, { 'X-ACB-Job-Schemas': '1,2', 'X-ACB-Client-Version': '1.0.0' })
    expect(accepted).toMatchObject({ status: 409, body: { code: 'JOB_NEEDS_NEWER_SCREEN', error: expect.stringContaining('アプリを新しく') } })
  })

  it('the app of 4b-2 lists and claims it: the turn names the event and its record, never the delivery number', async () => {
    const { job, occ, start } = await eventOccurrence()
    const listed = (await turns()).body.data.turns
    expect(listed).toEqual([expect.objectContaining({ occurrenceId: occ, jobId: job, kind: 'event', source: { recordId: start }, check: { kind: 'source_record', doneMark: 'file_linked' } })])
    expect(listed[0].dueSlot).not.toMatch(/^ev:/)
    const r = await claim(occ)
    expect(r.status).toBe(201)
    expect(r.body.data.turn).toMatchObject({ occurrenceId: occ, kind: 'event', state: 'running' })
    expect(occOf(occ)).toMatchObject({ state: 'running', run_id: r.body.data.run.id })
  })

  it('bob (another member), the owner and an admin neither list nor claim it', async () => {
    const { occ } = await eventOccurrence()
    for (const user of ['ej-bob', 'ej-owner', 'ej-admin']) {
      expect((await turns(user)).body.data.turns).toEqual([])
      expect(await claim(occ, { user, device: `device-${user}` })).toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } })
    }
  })
})

describe('S1: a condition that fails after the claim ends the run — at the next call, renew, finish or clock', () => {
  it('the completion undone: the next call ends it (nothing, the chain stopped), every later call, renew and the finish refused, no やること', async () => {
    const { job, occ, start } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    expect((await ai(token, 'GET', `/item/${start}`)).status).toBe(200)
    await reopen(start)
    expect(await ai(token, 'GET', `/item/${start}`)).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    expect(occOf(occ)).toMatchObject({ state: 'nothing', outcome_code: 'EVENT_NOT_NEEDED' })
    expect(runOf(run.id)).toMatchObject({ state: 'waiting_person', failure_code: 'EVENT_NOT_NEEDED' })
    // Fenced: whatever comes later.
    expect((await ai(token, 'POST', '/query', { type: 'task' })).status).toBe(409)
    expect((await renew(run)).status).toBe(409)
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書の下書き' } })).status).toBe(409)
    expect(madeTasks()).toEqual([])
    expect(cursorOf(job)).toMatchObject({ chain_stop_code: 'EVENT_NOT_NEEDED' })
  })

  it('the assignee changed: the renew ends it (skipped) and answers 409, so the app stops its AI', async () => {
    const { occ, start } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    expect((await renew(run)).status).toBe(200)
    setAssignee(start, 'ej-bob')
    expect(await renew(run)).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'EVENT_NOT_ASSIGNEE' } })
    expect(occOf(occ)).toMatchObject({ state: 'skipped', outcome_code: 'EVENT_NOT_ASSIGNEE' })
    expect(runOf(run.id).state).toBe('waiting_person')
    expect(madeTasks()).toEqual([])
  })

  it('a report linked by a person (the done mark): the finish makes nothing and ends it', async () => {
    const { occ, start } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    linkFile(start)
    expect(await finish(run, { outcome: 'done', jobResult: { title: '報告書の下書き' } })).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'EVENT_DONE_MARK' } })
    expect(occOf(occ)).toMatchObject({ state: 'nothing', outcome_code: 'EVENT_DONE_MARK' })
    expect(madeTasks()).toEqual([])
  })

  it('with the done mark "none", a linked file changes nothing: the finish makes the one やること and the watch follows it', async () => {
    const { job, occ, start } = await eventOccurrence({ check: { kind: 'source_record', doneMark: 'none' } })
    const run = (await claim(occ)).body.data.run
    linkFile(start)
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書の下書き' } })).status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'done' })
    expect(madeTasks()).toHaveLength(1)
    // followMadeTask: the watch is the やること it made, a new generation; no stop.
    expect(cursorOf(job)).toMatchObject({ watch_record_id: madeTasks()[0].id, chain_stop_code: null })
  })

  it('the clock ends a run nobody renews (and a waiting one) once a condition failed', async () => {
    const { occ, start } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    await reopen(start)
    tick()
    expect(occOf(occ)).toMatchObject({ state: 'nothing', outcome_code: 'EVENT_NOT_NEEDED' })
    expect(runOf(run.id).state).toBe('waiting_person')

    const waiting = await eventOccurrence()
    setAssignee(waiting.start, 'ej-bob')
    tick()
    expect(occOf(waiting.occ)).toMatchObject({ state: 'skipped', outcome_code: 'EVENT_NOT_ASSIGNEE' })
  })

  it('the claim checks them first: undone before the claim → refused, nothing claimed', async () => {
    const { occ, start } = await eventOccurrence()
    await reopen(start)
    expect((await turns()).body.data.turns).toEqual([])
    expect(await claim(occ)).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'EVENT_NOT_NEEDED' } })
    expect(occOf(occ)).toMatchObject({ state: 'nothing', run_id: null })
  })

  it('a business plugin making the state 「AI の番」 (C6) and records off (C7) end it too', async () => {
    const { occ } = await eventOccurrence()
    const steps = new Set(['done'])
    const withPlugin = createJobOccurrences({
      companyData, transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
      timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf: (co, u) => sqliteMembershipRepository(db).roleOf(co, u),
      jobs: services.jobs, writer: { check: () => null, create: () => { throw new Error('never') } }, aiStepStates: () => steps,
    })
    expect(withPlugin.eventCondition(companyData.forCompany(CO), companyData.forCompany(CO).jobs.occurrence(occ)!, false)).toBe('EVENT_AI_TURN')
    withPlugin.makeOccurrences(CO)
    expect(occOf(occ)).toMatchObject({ state: 'skipped', outcome_code: 'EVENT_AI_TURN' })

    const off = await eventOccurrence()
    const run = (await claim(off.occ)).body.data.run
    db.prepare('UPDATE record_settings SET enabled = 0 WHERE company_id = ?').run(CO)
    expect(await renew(run)).toMatchObject({ status: 409, body: { reason: 'RECORDS_OFF' } })
    expect(occOf(off.occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RECORDS_OFF' })
  })

  it('a pause (C1) holds it and ends its run, as for a time job; the chain stops', async () => {
    const { job, occ } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    expect(services.jobs.pause(owner(), job).ok).toBe(true)
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'JOB_PAUSED' })
    expect(runOf(run.id).state).toBe('waiting_person')
    expect(cursorOf(job)).toMatchObject({ chain_stop_code: 'JOB_PAUSED' })
  })
})

describe('S1 (each condition on its own, at the renew or a call)', () => {
  it('C1 written by another build (no hold): the company’s stop, a pause, another version, a consent not accepted — held at the renew', async () => {
    const cases: Array<[string, (job: string) => void]> = [
      ['COMPANY_STOPPED', () => { db.prepare('INSERT INTO ai_job_settings (company_id, stopped, updated_by, updated_at) VALUES (?, 1, ?, ?)').run(CO, 'ej-owner', new Date().toISOString()) }],
      ['JOB_PAUSED', job => { db.prepare("UPDATE ai_jobs SET state = 'paused', paused_reason = 'ADMIN' WHERE company_id = ? AND id = ?").run(CO, job) }],
      ['JOB_VERSION_CHANGED', job => { db.prepare('UPDATE ai_jobs SET approved_version = 2 WHERE company_id = ? AND id = ?').run(CO, job) }],
      ['NOT_ACCEPTED', job => { db.prepare("UPDATE ai_jobs SET accepted_consent = 'sha256:other' WHERE company_id = ? AND id = ?").run(CO, job) }],
    ]
    for (const [code, change] of cases) {
      db.prepare('DELETE FROM ai_job_settings').run()
      const { job, occ } = await eventOccurrence()
      const run = (await claim(occ)).body.data.run
      change(job)
      expect(await renew(run), code).toMatchObject({ status: 409, body: { reason: code } })
      expect(occOf(occ), code).toMatchObject({ state: 'held', outcome_code: code })
      expect(runOf(run.id).state).toBe('waiting_person')
    }
    db.prepare('DELETE FROM ai_job_settings').run()
  })

  it('C1 holds whatever its run made (as a pause does): never MADE_THEN_STOPPED', async () => {
    const { job, occ } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    operation(run.id, 'put-1', 'done')
    db.prepare('UPDATE ai_jobs SET approved_version = 2 WHERE company_id = ? AND id = ?').run(CO, job)
    expect((await renew(run)).status).toBe(409)
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'JOB_VERSION_CHANGED' })
  })

  it('C3: the record no longer alice’s to read — the next call ends it; the claim and the run answer as missing (404)', async () => {
    const { occ, start } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    expect((await as('ej-alice', 'GET', `/ai-runs/${run.id}`)).status).toBe(200)
    db.prepare("UPDATE records SET personal_owner = 'ej-bob' WHERE company_id = ? AND id = ?").run(CO, start)
    // The run is a missing run for her now (⑥), and the next call of its token ends it.
    expect(await as('ej-alice', 'GET', `/ai-runs/${run.id}`)).toMatchObject({ status: 404, body: { code: 'RUN_NOT_FOUND' } })
    expect(await ai(token, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    expect(occOf(occ)).toMatchObject({ state: 'skipped', outcome_code: 'EVENT_RECORD_GONE' })

    const waiting = await eventOccurrence()
    db.prepare("UPDATE records SET personal_owner = 'ej-bob' WHERE company_id = ? AND id = ?").run(CO, waiting.start)
    expect(await claim(waiting.occ)).toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } })
    expect(occOf(waiting.occ)).toMatchObject({ state: 'skipped', outcome_code: 'EVENT_RECORD_GONE', run_id: null })
  })

  it('C8: another occurrence of the watch moved it on (a new generation) — this one ends, and stops nothing of the new watch', async () => {
    const { job, occ, start } = await eventOccurrence({ check: { kind: 'source_record', doneMark: 'none' } })
    const run = (await claim(occ)).body.data.run
    // A second occurrence of the same watch (as two events of one watch would leave them), waiting behind the first.
    const first = companyData.forCompany(CO).jobs.occurrence(occ)!
    const other = 'occ.dddddddddddddddddddddddddddddddd'
    const at = new Date().toISOString()
    db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at,
      event_seq, event_record_id, event_version, event_day, watch_generation) VALUES (?, ?, ?, 1, 'ev:999998', 'Asia/Tokyo', ?, ?, 'due', ?, ?, 999998, ?, ?, ?, ?)`)
      .run(CO, other, job, at, new Date(Date.now() + 60 * MINUTE).toISOString(), at, at, start, first.eventVersion, first.eventDay, first.watchGeneration)
    // The first finishes with its やること: the watch follows it (a new generation).
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書' } })).status).toBe(200)
    const watch = cursorOf(job)
    expect(watch.watch_generation).toBeGreaterThan(first.watchGeneration as number)
    expect(await claim(other, { device: 'device-alice-2' })).toMatchObject({ status: 409, body: { reason: 'EVENT_NOT_WATCHED' } })
    expect(occOf(other)).toMatchObject({ state: 'skipped', outcome_code: 'EVENT_NOT_WATCHED' })
    expect(cursorOf(job)).toEqual(watch)
  })

  it('choosing the watched やること again while it runs approves a new version: the run ends held (JOB_VERSION_CHANGED)', async () => {
    const { job, occ } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    const token = await tokenFor(run)
    const next = task('次の面談')
    ok(await services.jobs.rewatch(alice(), job, { version: 1, recordId: next }, READS_3))
    expect(await ai(token, 'POST', '/query', { type: 'task' })).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    expect(occOf(occ)).toMatchObject({ state: 'held', outcome_code: 'JOB_VERSION_CHANGED' })
    expect(cursorOf(job)).toMatchObject({ watch_record_id: next, chain_stop_code: null })
  })

  it('the deadline at a renew; a run that failed for a person stops the chain', async () => {
    const late = await eventOccurrence()
    const run = (await claim(late.occ)).body.data.run
    // Its app kept renewing (the lease is alive): the approved minutes still end it.
    db.prepare('UPDATE ai_runs SET claim_expires_at = ? WHERE company_id = ? AND id = ?').run(new Date(Date.now() + 60 * MINUTE).toISOString(), CO, run.id)
    vi.setSystemTime(Date.now() + 31 * MINUTE)
    try {
      expect(await renew(run)).toMatchObject({ status: 409, body: { code: 'JOB_TIME_LIMIT' } })
    } finally {
      vi.setSystemTime(Date.now() - 31 * MINUTE)
    }
    expect(occOf(late.occ)).toMatchObject({ state: 'needs_person', outcome_code: 'TIME_LIMIT' })
    expect(cursorOf(late.job)).toMatchObject({ chain_stop_code: 'TIME_LIMIT' })

    const failed = await eventOccurrence()
    const run2 = (await claim(failed.occ)).body.data.run
    expect((await finish(run2, { outcome: 'failed', failure: { class: 'bad-input', code: 'CHECK_NOT_POSSIBLE' } })).status).toBe(200)
    expect(occOf(failed.occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RUN_FAILED' })
    expect(cursorOf(failed.job)).toMatchObject({ chain_stop_code: 'RUN_FAILED' })

  })

  it('the AI never decides `nothing` for an event run: 400 JOB_EVENT_NOTHING_REFUSED, the run and occurrence unchanged', async () => {
    const { job, occ } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    expect(await finish(run, { outcome: 'done', jobResult: 'nothing' })).toMatchObject({ status: 400, body: { code: 'JOB_EVENT_NOTHING_REFUSED' } })
    expect(runOf(run.id)).toMatchObject({ state: 'running', closed_at: null })
    expect(occOf(occ)).toMatchObject({ state: 'running', run_id: run.id })
    expect(cursorOf(job)).toMatchObject({ chain_stop_code: null })
    // Its real finish still goes through.
    expect((await finish(run, { outcome: 'done', jobResult: { title: '報告書' } })).status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'done' })
  })

  it('a running one past its expiry with nobody holding it: expired, told, and its chain stops', async () => {
    const { job, occ } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    const past = new Date(Date.now() - MINUTE).toISOString()
    db.prepare('UPDATE ai_job_occurrences SET expires_at = ? WHERE company_id = ? AND id = ?').run(past, CO, occ)
    db.prepare('UPDATE ai_runs SET claim_expires_at = ? WHERE company_id = ? AND id = ?').run(past, CO, run.id)
    tick()
    expect(occOf(occ)).toMatchObject({ state: 'expired' })
    expect(cursorOf(job)).toMatchObject({ chain_stop_code: 'EXPIRED' })
  })
})

describe('S2–S4: how it ends (owner memo §4-4)', () => {
  it('S2: nothing made outside, no longer needed → no occurrence notice; the stopped chain told once, to alice', async () => {
    const { occ, start } = await eventOccurrence()
    await claim(occ)
    await reopen(start)
    tick()
    tick()
    expect(occOf(occ)).toMatchObject({ state: 'nothing' })
    expect(occurrenceNotices()).toEqual([])
    // Once each: alice and the job's creator (an owner who reads the やること, D7 = A).
    expect(notices('job_chain_stopped')).toEqual(['ej-alice', 'ej-owner'])
  })

  it('S3: a Drive put done, then no longer needed → needs a person (MADE_THEN_STOPPED), told, the chain stopped', async () => {
    const { occ, start } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    operation(run.id, 'put-1', 'done')
    await reopen(start)
    tick()
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'MADE_THEN_STOPPED' })
    expect(notices('job_failed')).toEqual(['ej-alice', 'ej-owner'])
    expect(notices('job_chain_stopped')).toEqual(['ej-alice', 'ej-owner'])
  })

  it('S4: a put in flight, then undone → its result unknown: needs a person, the run waits for reconciliation, 「もう一度」 refused', async () => {
    const { job, occ, start } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    operation(run.id, 'put-1', 'in_progress')
    await reopen(start)
    tick()
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RESULT_UNKNOWN' })
    expect(opOf(run.id, 'put-1').state).toBe('unknown')
    expect(runOf(run.id).state).toBe('waiting_reconcile')
    expect(notices('job_failed')).toEqual(['ej-alice', 'ej-owner'])
    expect(await as('ej-owner', 'POST', `/jobs/${job}/occurrences/${occ}/retry`)).toMatchObject({ status: 409, body: { code: 'JOB_RESULT_UNKNOWN' } })
  })

  it('S4: no answer before its time → needs a person (RESULT_UNKNOWN), and its chain stops', async () => {
    const { job, occ } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    operation(run.id, 'put-1', 'unknown')
    db.prepare("UPDATE ai_runs SET state = 'waiting_reconcile' WHERE company_id = ? AND id = ?").run(CO, run.id)
    vi.setSystemTime(Date.now() + 31 * MINUTE)
    try {
      tick()
    } finally {
      vi.setSystemTime(Date.now() - 31 * MINUTE)
    }
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RESULT_UNKNOWN' })
    expect(cursorOf(job)).toMatchObject({ chain_stop_code: 'RESULT_UNKNOWN' })
  })

  it('the hard deadline: the clock ends it TIME_LIMIT, told, and its chain stops', async () => {
    const { job, occ } = await eventOccurrence()
    await claim(occ)
    vi.setSystemTime(Date.now() + 31 * MINUTE)
    try {
      tick()
    } finally {
      vi.setSystemTime(Date.now() - 31 * MINUTE)
    }
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'TIME_LIMIT' })
    expect(cursorOf(job)).toMatchObject({ chain_stop_code: 'TIME_LIMIT' })
  })
})

describe('S5 / S6: reconciling and 「もう一度」 — who (D11)', () => {
  /** An occurrence ended with an outside result nobody knows (the completion undone while a put was in flight). */
  async function unknownAfterUndo(overrides: Record<string, unknown> = {}) {
    const made = await eventOccurrence(overrides)
    const run = (await claim(made.occ)).body.data.run
    operation(run.id, 'put-1', 'in_progress')
    await reopen(made.start)
    tick()
    return { ...made, run }
  }
  const reconcile = (user: string, job: string, occ: string, done = true) => as(user, 'POST', `/jobs/${job}/occurrences/${occ}/operations/put-1/reconcile`, { done })
  const retry = (user: string, job: string, occ: string) => as(user, 'POST', `/jobs/${job}/occurrences/${occ}/retry`)

  it('S5: the pinned responsible person reconciles after the undo; it resumes nothing; S6: run-level routes are missing runs', async () => {
    const { job, occ, run } = await unknownAfterUndo()
    // The run-level 「もう一度」 and reconcile are not for a job's run (the occurrence's are the only ones).
    expect(await as('ej-alice', 'POST', `/ai-runs/${run.id}/operations/put-1/reconcile`, { done: true })).toMatchObject({ status: 404, body: { code: 'RUN_NOT_FOUND' } })
    expect(await as('ej-alice', 'POST', `/ai-runs/${run.id}/retry`)).toMatchObject({ status: 404, body: { code: 'RUN_NOT_FOUND' } })
    // Alice finds it among hers, with what is unknown.
    const mine = (await as('ej-alice', 'GET', '/me/job-occurrences')).body.data.occurrences
    expect(mine).toEqual([expect.objectContaining({ id: occ, jobId: job, name: '面談のあとの報告書', state: 'needs_person', unknownOperations: [{ key: 'put-1', kind: 'drive-put' }] })])
    expect((await reconcile('ej-alice', job, occ)).status).toBe(200)
    expect(opOf(run.id, 'put-1').state).toBe('done')
    expect(runOf(run.id).state).toBe('waiting_reconcile')
    expect(occOf(occ)).toMatchObject({ state: 'needs_person' })
    // Bob (no relation) and the job's view without rights: forbidden, whatever exists.
    expect(await reconcile('ej-bob', job, occ)).toMatchObject({ status: 403 })
    expect(await retry('ej-bob', job, occ)).toMatchObject({ status: 403 })
  })

  it('S5: a held occurrence (paused while a put was in flight) is reconciled by alice; resuming runs nothing', async () => {
    const { job, occ } = await eventOccurrence()
    const run = (await claim(occ)).body.data.run
    operation(run.id, 'put-1', 'in_progress')
    expect(services.jobs.pause(owner(), job).ok).toBe(true)
    expect(occOf(occ)).toMatchObject({ state: 'held' })
    expect((await reconcile('ej-alice', job, occ, false)).status).toBe(200)
    expect((await services.jobs.resume(owner(), job)).ok).toBe(true)
    expect(occOf(occ)).toMatchObject({ state: 'held' })
    expect(runOf(run.id).state).toBe('waiting_reconcile')
  })

  it('S6: handed to bob — alice still finds and reconciles her occurrence, never sees the new version, and her 「もう一度」 is JOB_VERSION_CHANGED', async () => {
    const { job, occ, run, start, item } = await unknownAfterUndo()
    // Version 2 names bob (approved, accepted by bob): what alice ran stays pinned to version 1.
    const v2 = eventPcJob(start, item, { actingUser: 'ej-bob', name: 'ボブの新しい名前' })
    setAssignee(start, 'ej-bob')
    ok(await services.jobs.update(owner(), job, { definition: v2 }, READS_3))
    ok(await services.jobs.approve(owner(), job, { version: 2 }, READS_3))
    ok(await services.jobs.accept(member('ej-bob', 'member'), job, { version: 2 }, READS_3, true))
    setAssignee(start, 'ej-alice')
    // Alice no longer sees the job itself…
    expect((await as('ej-alice', 'GET', `/jobs/${job}`)).status).toBe(404)
    // …but finds the occurrence she ran, with her version's name (never version 2's), and may reconcile it.
    const mine = (await as('ej-alice', 'GET', '/me/job-occurrences')).body.data.occurrences
    expect(mine).toEqual([expect.objectContaining({ id: occ, jobId: job, name: '面談のあとの報告書', jobVersion: 1 })])
    expect(JSON.stringify(mine)).not.toContain('ボブの新しい名前')
    expect(mine[0].retry).toMatchObject({ allowed: false, why: 'JOB_VERSION_CHANGED' })
    expect((await reconcile('ej-alice', job, occ)).status).toBe(200)
    // Asking is allowed, running is not: pinned to version 1, whoever asks.
    expect(await retry('ej-alice', job, occ)).toMatchObject({ status: 409, body: { code: 'JOB_VERSION_CHANGED' } })
    // Bob, responsible now, may ask (and gets the same answer) but cannot reconcile what alice's run sent.
    expect(await retry('ej-bob', job, occ)).toMatchObject({ status: 409, body: { code: 'JOB_VERSION_CHANGED' } })
    expect(await reconcile('ej-bob', job, occ)).toMatchObject({ status: 403 })
    expect((await as('ej-bob', 'GET', '/me/job-occurrences')).body.data.occurrences).toEqual([])
    // Bob's own occurrence of the same record (version 2 names him) is his; alice's stays hers alone.
    const at = new Date().toISOString()
    db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at,
      event_seq, event_record_id, event_version, event_day) VALUES (?, 'occ.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', ?, 2, 'ev:999997', 'Asia/Tokyo', ?, ?, 'nothing', ?, ?, 999997, ?, 1, '2026-11-22')`)
      .run(CO, job, at, at, at, at, start)
    expect((await as('ej-bob', 'GET', '/me/job-occurrences')).body.data.occurrences.map((o: Json) => o.id)).toEqual(['occ.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'])
    expect((await as('ej-alice', 'GET', '/me/job-occurrences')).body.data.occurrences.map((o: Json) => o.id)).toEqual([occ])
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', retries: 0 })
    expect(run.id).toBeTruthy()
  })

  it('S6: an owner-only やること — an admin who does not read it gets the one 404; alice, once she cannot read it, nothing', async () => {
    const start = task('自分だけの面談')
    const made = await eventJob({}, start)
    // Made alice's alone after the job was saved (an owner cannot save one on a record they do not read).
    db.prepare("UPDATE records SET personal_owner = 'ej-alice' WHERE company_id = ? AND id = ?").run(CO, start)
    await complete(start)
    tick()
    const occ = (db.prepare('SELECT id FROM ai_job_occurrences WHERE company_id = ? AND job_id = ?').get(CO, made.job) as Json).id
    const run = (await claim(occ)).body.data.run
    operation(run.id, 'put-1', 'in_progress')
    await reopen(start)
    tick()
    expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'RESULT_UNKNOWN' })
    // The owner and the admin do not read alice's owner-only やること: the occurrence does not exist for them.
    for (const user of ['ej-owner', 'ej-admin']) {
      expect(await reconcile(user, made.job, occ)).toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } })
      expect((await as(user, 'GET', `/jobs/${made.job}/occurrences`)).body.data.occurrences).toEqual([])
    }
    // Alice, who does, is the one who can say what happened.
    expect((await as('ej-alice', 'GET', '/me/job-occurrences')).body.data.occurrences.map((o: Json) => o.id)).toEqual([occ])
    // Once she no longer reads it (the record taken from her), neither the list nor the press is there for her.
    db.prepare("UPDATE records SET personal_owner = 'ej-bob' WHERE company_id = ? AND id = ?").run(CO, start)
    expect((await as('ej-alice', 'GET', '/me/job-occurrences')).body.data.occurrences).toEqual([])
    expect(await reconcile('ej-alice', made.job, occ)).toMatchObject({ status: 403 })
    expect(opOf(run.id, 'put-1').state).toBe('unknown')
  })

  it('S6: the responsible person’s view of the job carries what she may press; a time job’s responsible person gets none of it', async () => {
    const { job, occ } = await unknownAfterUndo()
    const listed = (await as('ej-alice', 'GET', `/jobs/${job}/occurrences`)).body.data.occurrences
    expect(listed).toEqual([expect.objectContaining({ id: occ, retry: { allowed: false, why: 'JOB_RESULT_UNKNOWN' }, unknownOperations: [{ key: 'put-1', kind: 'drive-put' }] })])
  })
})

describe('S7: 「もう一度」 of an event occurrence', () => {
  it('after its expiry it is sent back (a new deadline) and claimed again; after the time limit too', async () => {
    const { job, occ } = await eventOccurrence()
    db.prepare('UPDATE ai_job_occurrences SET expires_at = ? WHERE company_id = ? AND id = ?').run(new Date(Date.now() - MINUTE).toISOString(), CO, occ)
    tick()
    expect(occOf(occ)).toMatchObject({ state: 'expired' })
    const pressed = await as('ej-alice', 'POST', `/jobs/${job}/occurrences/${occ}/retry`)
    expect(pressed.status).toBe(200)
    expect(occOf(occ)).toMatchObject({ state: 'due', retries: 1 })
    expect(Date.parse(occOf(occ).expires_at)).toBeGreaterThan(Date.now())
    expect((await claim(occ)).status).toBe(201)
    vi.setSystemTime(Date.now() + 31 * MINUTE)
    try {
      tick()
      expect(occOf(occ)).toMatchObject({ state: 'needs_person', outcome_code: 'TIME_LIMIT' })
      expect((await as('ej-owner', 'POST', `/jobs/${job}/occurrences/${occ}/retry`)).status).toBe(200)
    } finally {
      vi.setSystemTime(Date.now() - 31 * MINUTE)
    }
  })

  it('refused without changing anything when the completion was undone, or records are off', async () => {
    const { job, occ, start } = await eventOccurrence()
    db.prepare('UPDATE ai_job_occurrences SET expires_at = ? WHERE company_id = ? AND id = ?').run(new Date(Date.now() - MINUTE).toISOString(), CO, occ)
    tick()
    const before = occOf(occ)
    db.prepare('UPDATE record_settings SET enabled = 0 WHERE company_id = ?').run(CO)
    expect(await as('ej-owner', 'POST', `/jobs/${job}/occurrences/${occ}/retry`)).toMatchObject({ status: 409, body: { code: 'RECORDS_OFF' } })
    expect(occOf(occ)).toEqual(before)
    db.prepare('UPDATE record_settings SET enabled = 1 WHERE company_id = ?').run(CO)
    await reopen(start)
    expect(await as('ej-alice', 'POST', `/jobs/${job}/occurrences/${occ}/retry`)).toMatchObject({ status: 409, body: { code: 'SOURCE_CHANGED' } })
    expect(occOf(occ)).toEqual(before)
  })
})

describe('S8: another running occurrence of the job — wait only', () => {
  /** A second event occurrence of the same job and watch (as two events of one watch would leave them). */
  function second(job: string, start: string, older: boolean, of: string): string {
    const first = companyData.forCompany(CO).jobs.occurrence(of)!
    const id = `occ.${'b'.repeat(31)}${older ? '1' : '2'}`
    const at = new Date().toISOString()
    db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at,
      event_seq, event_record_id, event_version, event_day, watch_generation) VALUES (?, ?, ?, 1, ?, 'Asia/Tokyo', ?, ?, 'due', ?, ?, ?, ?, ?, ?, ?)`)
      .run(CO, id, job, `ev:${older ? 1 : 999999}`, at, new Date(Date.now() + 60 * MINUTE).toISOString(), at, at, older ? 1 : 999999, start, first.eventVersion, first.eventDay, first.watchGeneration)
    return id
  }

  it('both orders, behind 60 finished ones: waits without a notice; claimable once the other finished; never counts itself', async () => {
    for (const older of [false, true]) {
      db.prepare('DELETE FROM ai_job_occurrences').run()
      db.prepare('DELETE FROM notifications').run()
      const { job, occ, start } = await eventOccurrence({ check: { kind: 'source_record', doneMark: 'none' } })
      // 60 finished occurrences of the job, newer than both (history beyond any short look-back).
      for (let i = 0; i < 60; i++) {
        const at = new Date(Date.now() + i).toISOString()
        db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at, event_seq, event_record_id)
          VALUES (?, ?, ?, 1, ?, 'Asia/Tokyo', ?, ?, 'done', ?, ?, ?, ?)`).run(CO, `occ.${'c'.repeat(28)}${String(i).padStart(4, '0')}`, job, `ev:${5000 + i}`, at, at, at, at, 5000 + i, start)
      }
      expect((await claim(occ)).status).toBe(201)
      const other = second(job, start, older, occ)
      expect(await claim(other, { device: 'device-alice-2' })).toMatchObject({ status: 409, body: { code: 'JOB_EARLIER_RUNNING' } })
      expect(occOf(other)).toMatchObject({ state: 'due', run_id: null })
      expect(occurrenceNotices()).toEqual([])
      // Its own re-claim (the same occurrence running) is not "another".
      const again = await claim(occ)
      expect(again).toMatchObject({ status: 200 })
      // Ended (for a person: the watch stays this generation, so the other is still its watch's), the other may go.
      expect((await finish(again.body.data.run, { outcome: 'failed', failure: { class: 'bad-input', code: 'CHECK_NOT_POSSIBLE' } })).status).toBe(200)
      expect(await claim(other, { device: 'device-alice-2' })).toMatchObject({ status: 201 })
    }
  })
})

describe('S9: choosing the watched やること again re-checks everything after its asynchronous check', () => {
  /** A job service whose Skill check runs `during` once, after being armed (the asynchronous stretch of the rewatch). */
  function serviceWith(during: { armed: boolean; run: () => void }, placeLive = () => true) {
    return createJobService({
      companyData, memberships: sqliteMembershipRepository(db), transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() },
      ids: randomIds, skillTree: async () => null, hasCompanyFolder: () => false,
      shelfSkill: (who, itemId, version) => {
        if (during.armed) { during.armed = false; during.run() }
        return services.skillShelf.jobSkill(who, itemId, version)
      },
      places: { live: () => (placeLive() ? { name: 'f', expiresAt: new Date(Date.now() + 60 * MINUTE).toISOString() } : null) },
    })
  }
  async function stoppedChain() {
    const made = await eventOccurrence()
    await claim(made.occ)
    await reopen(made.start)
    tick()
    expect(cursorOf(made.job)).toMatchObject({ chain_stop_code: 'EVENT_NOT_NEEDED' })
    return { ...made, next: task('次の面談') }
  }
  const versionsOf = (job: string) => (db.prepare('SELECT latest_version FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, job) as Json).latest_version

  it('without interference it goes through (the baseline)', async () => {
    const { job, next } = await stoppedChain()
    const s = serviceWith({ armed: true, run: () => {} })
    expect(await s.rewatch(alice(), job, { version: 1, recordId: next }, READS_3)).toMatchObject({ ok: true })
    expect(cursorOf(job)).toMatchObject({ watch_record_id: next, chain_stop_code: null })
  })

  const cases: Array<[string, (c: { job: string; next: string; item: string; start: string }) => void, string]> = [
    ['the job retired', c => { db.prepare("UPDATE ai_jobs SET state = 'retired' WHERE company_id = ? AND id = ?").run(CO, c.job) }, 'JOB_RETIRED'],
    ['the record made someone else’s to read', c => { db.prepare("UPDATE records SET personal_owner = 'ej-bob' WHERE company_id = ? AND id = ?").run(CO, c.next) }, 'BAD_JOB_DEFINITION'],
    ['its assignee changed', c => { setAssignee(c.next, 'ej-bob') }, 'BAD_JOB_DEFINITION'],
    ['alice left the company', () => { db.prepare("DELETE FROM memberships WHERE company_id = ? AND user_id = 'ej-alice'").run(CO) }, 'JOB_OWNER_NOT_MEMBER'],
    ['another content approved', c => {
      const repo = companyData.forCompany(CO).jobs
      const v1 = repo.version(c.job, 1)!
      const at = new Date().toISOString()
      repo.addVersion({ ...v1, version: 2, definition: v1.definition.replace('面談のあとの報告書', '別の内容'), fingerprint: 'sha256:other', createdAt: at }, at)
      repo.approve(c.job, 2, 'sha256:other', 'ej-owner', at, 'active')
    }, 'JOB_VERSION_FINGERPRINT'],
  ]
  for (const [what, change, code] of cases) {
    it(`refused when meanwhile ${what}`, async () => {
      const c = await stoppedChain()
      const s = serviceWith({ armed: true, run: () => change(c) })
      try {
        expect(await s.rewatch(alice(), c.job, { version: 1, recordId: c.next }, READS_3)).toMatchObject({ ok: false, body: { code } })
        expect(cursorOf(c.job)).toMatchObject({ watch_record_id: c.start, chain_stop_code: 'EVENT_NOT_NEEDED' })
      } finally {
        db.prepare('INSERT OR IGNORE INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-ej-alice`, 'ej-alice', CO, 'member', new Date().toISOString(), new Date().toISOString())
      }
    })
  }

  it('refused when the Skill changed since the version was pinned, and when the place outside is not usable', async () => {
    const { job, next } = await stoppedChain()
    publishSkill('# 面談報告書\n変わった手順。')
    const before = versionsOf(job)
    expect(await serviceWith({ armed: false, run: () => {} }).rewatch(alice(), job, { version: 1, recordId: next }, READS_3)).toMatchObject({ ok: false, body: { code: 'JOB_SKILL_CHANGED' } })
    expect(versionsOf(job)).toBe(before)
  })

  it('a job with a place outside: refused when the chosen place is not usable at the write', async () => {
    const item = publishSkill()
    const start = task('面談の準備')
    const definition = eventPcJob(start, item, {
      grant: {
        tools: ['records', 'files_write'], creates: ['task'], routes: ['GET /item/:recordId'], reads: { paths: [], calls: [] },
        writes: { area: 'deliverable', place: '人事部', folder: 'reports' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 5 },
        deliverTo: { connector: 'google', kind: 'drive_folder', ref: null },
      },
    })
    let live = true
    const s = serviceWith({ armed: false, run: () => {} }, () => live)
    const made = ok(await s.create(owner(), { definition }, READS_3))
    ok(await s.approve(owner(), made.id, { version: 1 }, READS_3))
    ok(await s.accept(alice(), made.id, { version: 1, place: { connector: 'google', kind: 'drive_folder', ref: 'folder-1' } }, READS_3, true))
    const next = task('次の面談')
    live = false
    expect(await s.rewatch(alice(), made.id, { version: 1, recordId: next }, READS_3)).toMatchObject({ ok: false, body: { code: 'JOB_PLACE_NOT_USABLE' } })
    live = true
    expect(await s.rewatch(alice(), made.id, { version: 1, recordId: next }, READS_3)).toMatchObject({ ok: true })
  })
})

describe('S10: rights too narrow for the grant — the occurrence alone is skipped', () => {
  it('a read place alice no longer reads: skipped (OWNER_RIGHTS_CHANGED), the job stays active, nobody is paused', async () => {
    const item = publishSkill()
    const r = await as('ej-owner', 'PUT', '/permissions/scopes/by-path', { path: '人事部', rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'user', subjectId: 'ej-alice', canRead: true, canWrite: true }] })
    expect(r.status).toBe(200)
    const start = task('面談の準備')
    const made = await eventJob({
      grant: {
        tools: ['records', 'files_read'], creates: ['task'], routes: ['GET /item/:recordId'], reads: { paths: ['人事部'], calls: [] },
        writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 5 },
      },
    }, start)
    void item
    await complete(start)
    tick()
    const occ = (db.prepare('SELECT id FROM ai_job_occurrences WHERE company_id = ? AND job_id = ?').get(CO, made.job) as Json).id
    const narrowed = await as('ej-owner', 'PUT', '/permissions/scopes/by-path', { path: '人事部', rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }] })
    expect(narrowed.status).toBe(200)
    expect(await claim(occ)).toMatchObject({ status: 409, body: { code: 'JOB_EVENT_ENDED', reason: 'OWNER_RIGHTS_CHANGED' } })
    expect(occOf(occ)).toMatchObject({ state: 'skipped', outcome_code: 'OWNER_RIGHTS_CHANGED' })
    expect(jobOf(made.job)).toMatchObject({ state: 'active', paused_reason: null })
    expect(notices('job_paused')).toEqual([])
    // Skipped for a record-side reason: no occurrence notice (4a's rule).
    expect(occurrenceNotices()).toEqual([])
  })
})

describe('absent on the event’s day (D5)', () => {
  it('skipped and told at the claim — by the event’s day, never the delivery number read as a date', async () => {
    const { occ } = await eventOccurrence()
    db.prepare(`INSERT INTO member_absences (company_id, id, user_id, from_day, until_day, delegate_id, set_by, set_at) VALUES (?, 'abs-ej', 'ej-alice', '2000-01-01', '2999-12-31', 'ej-bob', 'ej-alice', ?)`).run(CO, new Date().toISOString())
    expect(await claim(occ)).toMatchObject({ status: 409, body: { reason: 'OWNER_ABSENT' } })
    expect(occOf(occ)).toMatchObject({ state: 'skipped', outcome_code: 'OWNER_ABSENT' })
    expect(notices('job_skipped')).toEqual(['ej-alice', 'ej-owner'])
  })
})
