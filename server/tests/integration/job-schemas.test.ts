/**
 * Shapes this build does not know (jobs.md "Shapes this build does not know", stage 4-0 of event-triggered jobs;
 * owner memo 「出来事で動く定期の仕事」 §3-11, §10-7, §11). Event-triggered jobs (4a) store `schema: 2`; production
 * may be rolled back to 4-0 after that, and an admin tab or an app from before stays open. None of them may run,
 * retry, claim, approve, accept or edit what it does not understand, and none may crash on it.
 *
 * Guards (each mutation-checked):
 * - a stored version is read only when its schema is one this server knows: the clock makes no occurrence of an
 *   unknown one, the server's runner leaves its occurrence alone, the PC never lists or claims it, 「もう一度」 is
 *   refused, approval / acceptance / resume are refused — and listing it answers (no crash) with `needsUpdate`;
 * - a definition goes to a client only in a shape the client announced (`X-ACB-Job-Schemas`; none = schema 1): a
 *   newer one comes without its definition or trigger, and approving, accepting or editing it from that client is
 *   refused (`JOB_NEEDS_NEWER_SCREEN`); schema 1 is answered exactly as stored;
 * - a PC claims an occurrence only of a kind its app says it runs (absent = `time`, every app today);
 * - an event occurrence (4a's `ev:` slot) does not exist on this build (stage 4-0.1): not listed, counted, told,
 *   retried, reconciled, run, claimed or expired; a pause or stop holds a waiting one (the one write allowed).
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
import { services } from '../../src/composition'
import { createJobOccurrences } from '../../src/services/job-occurrences'
import { createJobRetry } from '../../src/services/job-retry'
import { createJobService } from '../../src/services/jobs'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { hashCanonical } from '../../src/lib/content-hash'
import { canonicalJson } from '../../../shared/core/fixed-content'
import { isEventOccurrenceSlot, JOB_PC_STEP, jobConsentCanonical, parseJobOccurrenceKinds, parseJobSchemasHeader, storedJobDefinition, type JobDefinition } from '../../../shared/core/jobs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const MINUTE = 60_000
let CO = ''
const companyData = sqliteCompanyData(db)
const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() }
const roleOf = (co: string, user: string) => sqliteMembershipRepository(db).roleOf(co, user)

async function call(user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  currentUser.id = user
  const res = await app.request(`/api/companies/${CO}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const owner = () => ({ companyId: CO, userId: 'js-owner', role: 'owner' })
const alice = () => ({ companyId: CO, userId: 'js-alice', role: 'member' })

/** A server job (placement e) or a PC job (a, a shelf Skill) of schema 1. */
function serverJob(over: Record<string, unknown> = {}): Json {
  return {
    schema: 1, name: '週の報告', actingUser: 'js-alice', trigger: { every: 'day', at: '09:00', businessDaysOnly: false }, check: { kind: 'none' },
    run: { kind: 'operation', operation: 'create_task', title: '週の報告を書く', dueBusinessDays: null }, placement: 'e',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
    ...over,
  }
}
function pcJob(item: string): Json {
  return {
    schema: 1, name: '面談報告書の下書き', actingUser: 'js-alice', trigger: { every: 'day', at: '09:00', businessDaysOnly: false },
    check: { kind: 'new_meetings', titleWords: [] }, run: { kind: 'procedure', procedure: { source: 'shelf_skill', item } }, placement: 'a',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: { tools: ['records'], creates: ['task'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 } },
  }
}
/** The same job in the shape a later build (4a) stores: `schema: 2`, a trigger of its own. */
const asSchema2 = (d: Json): Json => ({ ...d, schema: 2, trigger: { kind: 'record', type: 'task', event: 'state', to: 'done' } })

/** Made, approved, accepted (schema 1). */
async function approvedJob(definition: Json): Promise<string> {
  const made = await services.jobs.create(owner(), { definition })
  if (!made.ok) throw new Error(JSON.stringify(made.body))
  const job = made.value.id
  const approved = await services.jobs.approve(owner(), job, { version: 1 })
  if (!approved.ok) throw new Error(JSON.stringify(approved.body))
  const accepted = await services.jobs.accept(alice(), job, { version: 1 })
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.body))
  return job
}

/**
 * Version 2 of the job written as a later build would (schema 2), approved and accepted, the job active: what a
 * server rolled back to this build finds in its database.
 */
function storeSchema2(job: string, definition: Json, opts: { approve?: boolean } = {}) {
  const text = canonicalJson(definition)
  const consent = hashCanonical(jobConsentCanonical(definition as JobDefinition))
  const at = new Date().toISOString()
  const approve = opts.approve !== false
  db.prepare(`INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at,
      approved_by, approved_at, accepted_by, accepted_at) VALUES (?, ?, 2, 2, ?, ?, ?, 'js-alice', 'js-owner', ?, ?, ?, ?, ?)`)
    .run(CO, job, text, hashCanonical(text), consent, new Date(Date.now() - 3 * 24 * 60 * MINUTE).toISOString(),
      approve ? 'js-owner' : null, approve ? new Date(Date.now() - 3 * 24 * 60 * MINUTE).toISOString() : null, approve ? 'js-alice' : null, approve ? at : null)
  if (approve) {
    db.prepare(`UPDATE ai_jobs SET latest_version = 2, approved_version = 2, approved_fingerprint = ?, accepted_version = 2, accepted_consent = ?, state = 'active'
      WHERE company_id = ? AND id = ?`).run(hashCanonical(text), consent, CO, job)
  } else {
    db.prepare('UPDATE ai_jobs SET latest_version = 2 WHERE company_id = ? AND id = ?').run(CO, job)
  }
}

let slot = 0
function dueOccurrence(job: string, version: number, dueSlot?: string): string {
  const id = `occ.${(++slot).toString(16).padStart(32, '0')}`
  const now = Date.now()
  db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Asia/Tokyo', ?, ?, 'due', ?, ?)`).run(CO, id, job, version, dueSlot ?? `2026-11-${String(10 + (slot % 18)).padStart(2, '0')}T09:00`,
    new Date(now - MINUTE).toISOString(), new Date(now + 24 * 60 * MINUTE).toISOString(), new Date(now).toISOString(), new Date(now).toISOString())
  return id
}
const occOf = (id: string) => db.prepare('SELECT state, outcome_code, run_id FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, id) as Json
const occurrencesOf = (job: string) => (db.prepare('SELECT id FROM ai_job_occurrences WHERE company_id = ? AND job_id = ?').all(CO, job) as Json[]).length

function publishSkill(): string {
  const current = (db.prepare("SELECT current_version FROM shelf_items WHERE company_id = ? AND name = 'interview-report'").get(CO) as Json)?.current_version ?? null
  const r = services.skillShelf.publish(owner(), { kind: 'skill', departmentId: null, name: 'interview-report', files: [{ path: 'SKILL.md', base64: Buffer.from('# 面談報告書\n下書きを作る。').toString('base64') }], expectedVersion: current })
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value.item.id
}

/** The clock and the runner; what they logged (a failure there would be an occurrence it tried and broke on). */
function occurrences(logged: string[] = []) {
  return createJobOccurrences({
    companyData, transactions: sqliteTransactions(db), clock, ids: randomIds, timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf,
    jobs: services.jobs, writer: { check: () => null, create: () => { throw new Error('must not make a やること') } }, log: (line) => logged.push(line),
  })
}

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'js-owner'
  currentUser.id = 'js-owner'
  const res = await app.request('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Job Schemas Co', folderKind: 'none' }) })
  CO = ((await res.json()) as Json).data.id
  const at = new Date().toISOString()
  for (const [user, role] of [['js-alice', 'member'], ['js-admin', 'admin']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, at, at)
  }
})

beforeEach(() => {
  for (const t of ['ai_job_occurrences', 'ai_job_versions', 'ai_jobs', 'notifications', 'ai_job_settings', 'agent_stops']) db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(CO)
  db.prepare("DELETE FROM ai_runs WHERE company_id = ? AND subject_kind = 'occurrence'").run(CO)
})

describe('a stored version of a shape this server does not know', () => {
  it('is read as nothing: the parser of stored versions knows schema 1 only, exactly as stored', () => {
    const d = serverJob()
    expect(storedJobDefinition({ schema: 1, definition: canonicalJson(d) })).toEqual(d)
    expect(storedJobDefinition({ schema: 2, definition: canonicalJson(asSchema2(d)) })).toBeNull()
    // The column and the text must agree; a text that is no definition is nothing too.
    expect(storedJobDefinition({ schema: 1, definition: canonicalJson(asSchema2(d)) })).toBeNull()
    expect(storedJobDefinition({ schema: 1, definition: 'not json' })).toBeNull()
  })

  it('the clock makes no occurrence of it, and the runner leaves a waiting one alone (nothing made, nothing changed)', async () => {
    const job = await approvedJob(serverJob())
    storeSchema2(job, asSchema2(serverJob()))
    const occ = dueOccurrence(job, 2)
    const logged: string[] = []
    const o = occurrences(logged)
    o.makeOccurrences(CO)
    expect(occurrencesOf(job)).toBe(1)
    expect(o.dueIds(CO)).toEqual([])
    expect(o.runOccurrence(CO, occ)).toBeNull()
    expect(occOf(occ)).toMatchObject({ state: 'due', outcome_code: null, run_id: null })
    expect(db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'task'").get(CO)).toEqual({ n: 0 })
    // Left alone on purpose, never tried and broken on.
    expect(logged).toEqual([])
  })

  it('the PC never lists or claims its occurrence', async () => {
    const job = await approvedJob(pcJob(publishSkill()))
    storeSchema2(job, asSchema2(pcJob(publishSkill())))
    const occ = dueOccurrence(job, 2)
    expect((await call('js-alice', 'GET', '/me/job-turns')).body.data.turns).toEqual([])
    const r = await call('js-alice', 'POST', '/job-run-claims', { occurrenceId: occ, deviceId: 'device-alice-1', conversationId: 'conv-1', checks: ['new_files', 'new_meetings'], kinds: ['time', 'event'] })
    expect(r).toMatchObject({ status: 404 })
    expect(occOf(occ)).toMatchObject({ state: 'due', run_id: null })
  })

  it('「もう一度」 is refused with its own reason', async () => {
    const job = await approvedJob(serverJob())
    storeSchema2(job, asSchema2(serverJob()))
    const occ = dueOccurrence(job, 2)
    db.prepare("UPDATE ai_job_occurrences SET state = 'needs_person' WHERE company_id = ? AND id = ?").run(CO, occ)
    const retry = createJobRetry({
      companyData, transactions: sqliteTransactions(db), clock, jobs: services.jobs, roleOf, aiStops: () => ({ all: false, tools: [] }),
      reconcileFor: () => { throw new Error('unused') },
    })
    expect(retry.retry(owner(), job, occ)).toMatchObject({ ok: false, body: { code: 'JOB_SCHEMA_UNKNOWN' } })
    expect(occOf(occ)).toMatchObject({ state: 'needs_person' })
  })

  it('approval, acceptance and resume are refused; listing and reading answer without crashing, marked needsUpdate', async () => {
    const job = await approvedJob(serverJob())
    storeSchema2(job, asSchema2(serverJob()), { approve: false })
    expect(await call('js-owner', 'POST', `/jobs/${job}/approve`, { version: 2 })).toMatchObject({ status: 409, body: { code: 'JOB_SCHEMA_UNKNOWN' } })
    // Nor written over, even by a screen that says it reads schema 2: this server cannot read what it would replace.
    expect(await call('js-owner', 'PUT', `/jobs/${job}`, { definition: serverJob({ name: '上書き' }) }, { 'X-ACB-Job-Schemas': '1,2' })).toMatchObject({ status: 409, body: { code: 'JOB_SCHEMA_UNKNOWN' } })
    expect(db.prepare('SELECT latest_version FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, job)).toEqual({ latest_version: 2 })
    storeSchema2Approved(job)
    expect(await call('js-alice', 'POST', `/me/jobs/${job}/accept`, { version: 2 })).toMatchObject({ status: 409, body: { code: 'JOB_SCHEMA_UNKNOWN' } })
    expect(await call('js-owner', 'POST', `/jobs/${job}/pause`)).toMatchObject({ status: 200 })
    expect(await call('js-owner', 'POST', `/jobs/${job}/resume`)).toMatchObject({ status: 409, body: { code: 'JOB_SCHEMA_UNKNOWN' } })
    // An admin announcing schema 2 still gets no definition: this server cannot vouch for a shape it does not know.
    for (const headers of [{}, { 'X-ACB-Job-Schemas': '1,2' }]) {
      const list = await call('js-owner', 'GET', '/jobs', undefined, headers)
      expect(list.status).toBe(200)
      const view = list.body.data.jobs.find((j: Json) => j.id === job)
      expect(view).toMatchObject({ needsUpdate: true })
      expect(view.trigger).toBeUndefined()
      const one = await call('js-owner', 'GET', `/jobs/${job}`, undefined, headers)
      expect(one.body.data.versions[0]).toMatchObject({ version: 2, definition: null, needsUpdate: true })
      expect(one.body.data.versions[1].needsUpdate).toBeUndefined()
    }
    // The responsible person's own view does not crash either.
    expect(await call('js-alice', 'GET', `/jobs/${job}`)).toMatchObject({ status: 200 })
  })

  it('a role change does not pause it for a reason this server cannot judge', async () => {
    const job = await approvedJob(serverJob())
    storeSchema2(job, asSchema2(serverJob()))
    services.jobs.roleChanged(CO, 'js-alice', 'js-owner')
    expect(db.prepare('SELECT state, paused_reason FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, job)).toEqual({ state: 'active', paused_reason: null })
  })
})

/** Make version 2 the approved one (after a refused approval left it a draft). */
function storeSchema2Approved(job: string) {
  const v = db.prepare('SELECT fingerprint, consent_fingerprint FROM ai_job_versions WHERE company_id = ? AND job_id = ? AND version = 2').get(CO, job) as Json
  db.prepare(`UPDATE ai_job_versions SET approved_by = 'js-owner', approved_at = ? WHERE company_id = ? AND job_id = ? AND version = 2`).run(new Date().toISOString(), CO, job)
  db.prepare(`UPDATE ai_jobs SET approved_version = 2, approved_fingerprint = ?, state = 'active' WHERE company_id = ? AND id = ?`).run(v.fingerprint, CO, job)
}

describe('a definition goes to a client only in a shape it announced', () => {
  /** A server of a later build (it knows schema 2), with the same rules (a fixture: no schema 2 exists in this build). */
  const later = () => createJobService({
    companyData, memberships: sqliteMembershipRepository(db), transactions: sqliteTransactions(db), clock, ids: randomIds,
    skillTree: async () => null, hasCompanyFolder: () => false, knownSchemas: [1, 2],
  })

  it('the header is read as schema 1 plus what it names; nothing readable means schema 1', () => {
    expect(parseJobSchemasHeader(undefined)).toEqual([1])
    expect(parseJobSchemasHeader('2, 1')).toEqual([1, 2])
    expect(parseJobSchemasHeader('x, -3, 0, 1000')).toEqual([1])
  })

  it('a client naming no schema gets a newer version without its definition or trigger, and may not approve, accept or edit it', async () => {
    const job = await approvedJob(serverJob())
    storeSchema2(job, asSchema2(serverJob()), { approve: false })
    const s = later()
    const old = s.get(owner(), job)
    expect(old.ok && old.value.versions?.[0]).toMatchObject({ version: 2, definition: null, needsUpdate: true })
    const newer = s.get(owner(), job, [1, 2])
    expect(newer.ok && newer.value.versions?.[0]).toMatchObject({ version: 2, definition: { schema: 2 } })
    expect(newer.ok && newer.value.versions?.[0].needsUpdate).toBeUndefined()
    expect(await s.approve(owner(), job, { version: 2 })).toMatchObject({ ok: false, body: { code: 'JOB_NEEDS_NEWER_SCREEN' } })
    expect(await s.update(owner(), job, { definition: serverJob({ name: '上書き' }) })).toMatchObject({ ok: false, body: { code: 'JOB_NEEDS_NEWER_SCREEN' } })
    expect(db.prepare('SELECT latest_version FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, job)).toEqual({ latest_version: 2 })
    expect(await s.approve(owner(), job, { version: 2 }, [1, 2])).toMatchObject({ ok: true })
    // Approved now: its trigger is not handed to an older screen (it would read `trigger.at`), the acceptance not taken from one.
    const listed = s.list(owner())
    const view = listed.ok ? listed.value.jobs.find(j => j.id === job) : null
    expect(view).toMatchObject({ needsUpdate: true })
    expect(view?.trigger).toBeUndefined()
    expect(await s.accept(alice(), job, { version: 2 })).toMatchObject({ ok: false, body: { code: 'JOB_NEEDS_NEWER_SCREEN' } })
    expect(await s.accept(alice(), job, { version: 2 }, [1, 2])).toMatchObject({ ok: true })
  })

  it('schema 1 is answered exactly as stored, header or not (byte for byte as before)', async () => {
    const job = await approvedJob(serverJob())
    const stored = (db.prepare('SELECT definition FROM ai_job_versions WHERE company_id = ? AND job_id = ? AND version = 1').get(CO, job) as Json).definition
    for (const headers of [{}, { 'X-ACB-Job-Schemas': '1' }, { 'X-ACB-Job-Schemas': '1,2' }]) {
      const one = await call('js-owner', 'GET', `/jobs/${job}`, undefined, headers)
      expect(canonicalJson(one.body.data.versions[0].definition)).toBe(stored)
      expect(one.body.data.versions[0].needsUpdate).toBeUndefined()
      expect(one.body.data.needsUpdate).toBeUndefined()
      expect(one.body.data.trigger).toEqual(serverJob().trigger)
    }
  })
})

describe('a PC claims only the kinds of occurrence its app runs', () => {
  it('apps list and claim time occurrences as before, with or without kinds; an event one is never handed out (it does not exist here)', async () => {
    const job = await approvedJob(pcJob(publishSkill()))
    const time = dueOccurrence(job, 1)
    const event = dueOccurrence(job, 1, 'ev:42')
    expect((await call('js-alice', 'GET', '/me/job-turns')).body.data.turns.map((t: Json) => t.occurrenceId)).toEqual([time])
    // Stage 4-0.1: naming `event` adds nothing on this build ("Event occurrences do not exist on this build").
    expect((await call('js-alice', 'GET', '/me/job-turns?kinds=time,event')).body.data.turns.map((t: Json) => t.occurrenceId)).toEqual([time])
    expect(await call('js-alice', 'GET', '/me/job-turns?kinds=Time!')).toMatchObject({ status: 400 })
    const body = (occurrenceId: string, extra: Record<string, unknown> = {}) => ({ occurrenceId, deviceId: 'device-alice-1', conversationId: `conv-${occurrenceId}`, checks: ['new_files', 'new_meetings'], ...extra })
    for (const extra of [{}, { kinds: ['time'] }, { kinds: ['time', 'event'] }]) {
      expect(await call('js-alice', 'POST', '/job-run-claims', body(event, extra))).toMatchObject({ status: 404 })
    }
    expect(occOf(event)).toMatchObject({ state: 'due', run_id: null })
    expect(await call('js-alice', 'POST', '/job-run-claims', body(time))).toMatchObject({ status: 201 })
    expect(parseJobOccurrenceKinds(undefined)).toEqual(['time'])
    expect(parseJobOccurrenceKinds('')).toEqual(['time'])
    expect(parseJobOccurrenceKinds(['time', 'later_kind'])).toEqual(['time'])
    expect(parseJobOccurrenceKinds(['later_kind'])).toBeNull()
    expect(await call('js-alice', 'POST', '/job-run-claims', body(time, { kinds: [] }))).toMatchObject({ status: 400 })
  })
})

/**
 * Stage 4-0.1 (jobs.md "Event occurrences do not exist on this build"): 4a stores event occurrences (`ev:<delivery
 * number>` slots) that only readers of their source record may see. After a rollback to this build they must be as
 * if they were not there — for owners and admins too — because this build cannot check the record.
 */
describe('an event occurrence (stage 4a) does not exist on this build', () => {
  const PAST = () => new Date(Date.now() - 60 * MINUTE).toISOString()
  /** An event occurrence in `state`, its slot sorting before every time slot (`ev:` > `2026-…`). */
  function eventOccurrence(job: string, state: string, opts: { expired?: boolean; seq?: number } = {}): string {
    const id = dueOccurrence(job, 1, `ev:${opts.seq ?? 900 + slot}`)
    db.prepare('UPDATE ai_job_occurrences SET state = ?, expires_at = COALESCE(?, expires_at) WHERE company_id = ? AND id = ?')
      .run(state, opts.expired ? PAST() : null, CO, id)
    return id
  }
  const noticeRows = (occ: string) => (db.prepare('SELECT user_id FROM notifications WHERE company_id = ? AND dedupe_key LIKE ?').all(CO, `%:${occ}:%`) as Json[]).length
  const missing = 'occ.ffffffffffffffffffffffffffffffff'

  it('is not listed, not the job\'s last occurrence, and no answer carries an `ev:` slot (owner and admin alike)', async () => {
    const job = await approvedJob(serverJob())
    const time = dueOccurrence(job, 1, '2026-11-10T09:00')
    db.prepare("UPDATE ai_job_occurrences SET state = 'done' WHERE company_id = ? AND id = ?").run(CO, time)
    for (const state of ['due', 'running', 'done', 'skipped', 'needs_person', 'expired']) eventOccurrence(job, state)
    for (const user of ['js-owner', 'js-admin']) {
      const listed = await call(user, 'GET', `/jobs/${job}/occurrences`)
      expect(listed.status).toBe(200)
      expect(listed.body.data.occurrences.map((o: Json) => o.id)).toEqual([time])
      const jobs = await call(user, 'GET', '/jobs')
      expect(jobs.body.data.jobs.find((j: Json) => j.id === job).lastOccurrence).toMatchObject({ dueSlot: '2026-11-10T09:00', state: 'done' })
      expect(JSON.stringify([listed.body, jobs.body, (await call(user, 'GET', `/jobs/${job}`)).body])).not.toContain('ev:')
    }
  })

  it('a notice written for it (by 4a) is not shown or counted, and the clock writes none when it runs out of time', async () => {
    const job = await approvedJob(serverJob())
    const due = eventOccurrence(job, 'due', { expired: true })
    const running = eventOccurrence(job, 'running', { expired: true })
    const failed = eventOccurrence(job, 'needs_person')
    const before = services.notifications.list(owner() as Json)
    const at = new Date().toISOString()
    companyData.forCompany(CO).notifications.insert(['js-owner', 'js-alice'].map((userId, n) => ({
      id: `n-ev-${n}-${failed}`, userId, kind: 'job_failed', recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
      dedupeKey: `job_failed:${job}:${failed}:0:RUN_FAILED`, createdAt: at, readAt: null,
    })))
    for (const m of [owner(), alice()]) {
      const bell = services.notifications.list(m as Json)
      expect(bell.ok && bell.value.items.filter((i: Json) => i.kind === 'job_failed')).toEqual([])
      if (m.userId === 'js-owner') expect(bell.ok && bell.value.unread).toBe(before.ok && before.value.unread)
    }
    occurrences().makeOccurrences(CO)
    // Left as it was (4a, rolled forward again, settles it with its reader check), and nobody told.
    expect(occOf(due)).toMatchObject({ state: 'due', outcome_code: null })
    expect(occOf(running)).toMatchObject({ state: 'running', outcome_code: null })
    expect(noticeRows(due) + noticeRows(running)).toBe(0)
  })

  it('the runner never runs it', async () => {
    const job = await approvedJob(serverJob())
    const due = eventOccurrence(job, 'due')
    const o = occurrences()
    expect(o.dueIds(CO)).toEqual([])
    expect(o.runOccurrence(CO, due)).toBeNull()
    expect(o.runDue(CO)).toBe(0)
    expect(occOf(due)).toMatchObject({ state: 'due', outcome_code: null, run_id: null })
  })

  it('a pause, the company stop and a restore hold a waiting one (back on 4a it never runs), still hidden and untold', async () => {
    const job = await approvedJob(serverJob())
    const other = await approvedJob(serverJob({ name: '別の仕事' }))
    const paused = eventOccurrence(job, 'due')
    const otherDue = eventOccurrence(other, 'due')
    const done = eventOccurrence(job, 'done')
    expect(await call('js-owner', 'POST', `/jobs/${job}/pause`)).toMatchObject({ status: 200 })
    expect(occOf(paused)).toMatchObject({ state: 'held', outcome_code: 'JOB_PAUSED', run_id: null })
    // Only that job's waiting ones; a finished one keeps its state.
    expect(occOf(otherDue)).toMatchObject({ state: 'due', outcome_code: null })
    expect(occOf(done)).toMatchObject({ state: 'done' })
    expect((await call('js-owner', 'GET', `/jobs/${job}/occurrences`)).body.data.occurrences).toEqual([])
    expect(await call('js-owner', 'PUT', '/jobs-stop', { stopped: true })).toMatchObject({ status: 200 })
    expect(occOf(otherDue)).toMatchObject({ state: 'held', outcome_code: 'COMPANY_STOPPED' })
    expect(await call('js-owner', 'PUT', '/jobs-stop', { stopped: false })).toMatchObject({ status: 200 })
    const afterRestore = eventOccurrence(other, 'due')
    services.restorePause.pauseAfterRestore(CO)
    expect(occOf(afterRestore)).toMatchObject({ state: 'held', outcome_code: 'COMPANY_STOPPED' })
    expect(noticeRows(paused) + noticeRows(otherDue) + noticeRows(afterRestore)).toBe(0)
  })

  it('a PC run on one is a missing run: no get, renew, finish, retry or reconcile', async () => {
    const job = await approvedJob(pcJob(publishSkill()))
    const ev = eventOccurrence(job, 'running')
    const time = dueOccurrence(job, 1)
    const at = new Date().toISOString()
    const runOf = (occ: string) => {
      const id = `run-${occ.slice(-8)}`
      companyData.forCompany(CO).aiRuns.insert({
        id, subject: { kind: 'occurrence', id: occ }, step: JOB_PC_STEP, userId: 'js-alice', state: 'running', generation: 1, deviceId: 'device-alice-1',
        conversationId: 'conv-ev', claimExpiresAt: new Date(Date.now() + 10 * MINUTE).toISOString(), failureClass: null, failureCode: null, retryAt: null,
        attempts: 0, pluginVersion: null, stepsVersion: null, procedure: null, createdAt: at, updatedAt: at, closedAt: null,
      })
      return id
    }
    const evRun = runOf(ev)
    // The same run on a time occurrence answers (the refusal is about the event occurrence, not the run).
    expect(await call('js-alice', 'GET', `/ai-runs/${runOf(time)}`)).toMatchObject({ status: 200 })
    const missing = 'run-does-not-exist'
    for (const [method, path, body] of [
      ['GET', '', undefined], ['POST', '/renew', { generation: 1 }], ['POST', '/finish', { generation: 1, outcome: 'done' }],
      ['POST', '/retry', undefined], ['POST', '/operations/k/reconcile', { done: true }],
    ] as const) {
      const none = await call('js-alice', method, `/ai-runs/${missing}${path}`, body)
      expect(none.status).toBe(404)
      expect(await call('js-alice', method, `/ai-runs/${evRun}${path}`, body)).toEqual(none)
    }
    expect(db.prepare('SELECT state, claim_expires_at FROM ai_runs WHERE company_id = ? AND id = ?').get(CO, evRun)).toMatchObject({ state: 'running' })
    expect(occOf(ev)).toMatchObject({ state: 'running' })
  })

  it('「もう一度」 and reconcile answer exactly as for an occurrence that does not exist', async () => {
    const job = await approvedJob(serverJob())
    const ev = eventOccurrence(job, 'needs_person')
    for (const user of ['js-owner', 'js-admin']) {
      const retryMissing = await call(user, 'POST', `/jobs/${job}/occurrences/${missing}/retry`)
      expect(retryMissing.status).toBe(404)
      expect(await call(user, 'POST', `/jobs/${job}/occurrences/${ev}/retry`)).toEqual(retryMissing)
      const reconcileMissing = await call(user, 'POST', `/jobs/${job}/occurrences/${missing}/operations/create_task/reconcile`, { done: true })
      expect(reconcileMissing.status).toBe(404)
      expect(await call(user, 'POST', `/jobs/${job}/occurrences/${ev}/operations/create_task/reconcile`, { done: true })).toEqual(reconcileMissing)
    }
    expect(occOf(ev)).toMatchObject({ state: 'needs_person' })
  })

  it('the job repository neither reads, moves, sends back nor inserts one (every method)', async () => {
    const job = await approvedJob(serverJob())
    const ev = eventOccurrence(job, 'needs_person')
    const running = eventOccurrence(job, 'running')
    const repo = companyData.forCompany(CO).jobs
    expect(repo.occurrence(ev)).toBeNull()
    expect(repo.occurrences(job, 100)).toEqual([])
    expect(repo.runningOccurrences(100)).toEqual([])
    expect(repo.dueOccurrences(100)).toEqual([])
    const at = new Date().toISOString()
    expect(repo.moveOccurrence(running, ['running'], 'expired', { outcomeCode: 'EXPIRED' }, at)).toBe(false)
    expect(repo.retryOccurrence(ev, ['needs_person'], new Date(Date.now() + 60 * MINUTE).toISOString(), 'js-owner', at)).toBe(false)
    expect(occOf(running)).toMatchObject({ state: 'running', outcome_code: null })
    expect(db.prepare('SELECT state, retries FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, ev)).toEqual({ state: 'needs_person', retries: 0 })
    const fresh = 'occ.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    expect(repo.insertOccurrence({ id: fresh, jobId: job, jobVersion: 1, dueSlot: 'ev:7', timeZone: 'Asia/Tokyo', dueAt: at, expiresAt: at, state: 'due', runId: null, outcomeCode: null, createdAt: at, updatedAt: at })).toBe(false)
    expect(occOf(fresh)).toBeUndefined()
    // The one write allowed: a waiting event occurrence held; a time one is not its business (holdDue moves those itself).
    const evDue = eventOccurrence(job, 'due')
    const timeDue = dueOccurrence(job, 1)
    repo.holdEventOccurrences(null, 'JOB_PAUSED', at)
    expect(occOf(evDue)).toMatchObject({ state: 'held', outcome_code: 'JOB_PAUSED' })
    expect(occOf(timeDue)).toMatchObject({ state: 'due', outcome_code: null })
    expect(isEventOccurrenceSlot('ev:7')).toBe(true)
    expect(isEventOccurrenceSlot('2026-11-10T09:00')).toBe(false)
  })
})
