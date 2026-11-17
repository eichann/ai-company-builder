/**
 * Integration Test: after a restore, the company's automatic work stays stopped (services/restore-pause.ts,
 * deployment.md "After a restore: automatic work stays stopped").
 *
 * A database put back from a copy taken before a scheduled job's occurrence ran no longer has that occurrence: the
 * UNIQUE (company, job, slot) key protects only rows that exist, so the clock would make the slot again and the job
 * would do its work a second time. Guards (each mutation-checked):
 * - the company's jobs are stopped and what is waiting is held — the slot made again after the restore is held, and
 *   lifting the stop later still makes nothing (「再開しても動かさない」);
 * - the company-wide emergency stop of the whole AI is in force (no AI run can be claimed), added once;
 * - every owner / admin is told in plain words; a member is not.
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

import { db, initDatabase } from '../../src/db'
import { services } from '../../src/composition'
import { createJobService, type JobService } from '../../src/services/jobs'
import { createJobOccurrences, type JobOccurrences } from '../../src/services/job-occurrences'
import { createRestorePause, RESTORE_ACTOR } from '../../src/services/restore-pause'
import { COMPANY_RESTORED_TEXT } from '../../src/services/notifications'
import { createServiceRecordWriter } from '../../src/services/record-engine'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteAgentStopRepository } from '../../src/adapters/sqlite/agent-stops'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'

const CO = 'restored-co'
const TS = '2026-11-01T00:00:00.000Z'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const jst = (local: string) => Date.parse(`${local}:00+09:00`)
let nowMs = jst('2026-11-13T10:00')
const clock = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }
const companyData = sqliteCompanyData(db)
const memberships = sqliteMembershipRepository(db)
const agentStops = sqliteAgentStopRepository(db)
const transactions = sqliteTransactions(db)
const roleOf = (co: string, user: string) => memberships.roleOf(co, user)

const writer = createServiceRecordWriter({
  companyData, transactions, clock, ids: randomIds,
  featureOff: (co, type) => services.features.typeOff(co, type),
  isMember: (co, user) => roleOf(co, user) !== null, roleOf,
  notify: () => {},
})
const jobService: JobService = createJobService({
  companyData, memberships, transactions, clock, ids: randomIds,
  skillTree: async () => null, hasCompanyFolder: () => true,
  occurrenceHolds: { holdDue: (co, job, code) => occ.holdDue(co, job, code), holdPassedSlot: (co, job, code) => occ.holdPassedSlot(co, job, code) },
})
const occ: JobOccurrences = createJobOccurrences({
  companyData, transactions, clock, ids: randomIds, timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf, jobs: jobService, writer,
  log: () => {},
})
// As composition.ts binds it.
const restorePause = createRestorePause({
  companyData, transactions, clock, ids: randomIds, memberships, agentStops,
  holdDue: co => occ.holdDue(co, null, 'COMPANY_STOPPED'),
})

const owner = { companyId: CO, userId: 'u-owner', role: 'owner' }
const alice = { companyId: CO, userId: 'u-alice', role: 'member' }

async function weeklyJob(): Promise<string> {
  const made = await jobService.create(owner, { definition: {
    schema: 1, name: '週の報告', actingUser: 'u-alice',
    trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 },
    check: { kind: 'none' },
    run: { kind: 'operation', operation: 'create_task', title: '週の報告を書く', dueBusinessDays: 1 },
    placement: 'e',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
  } })
  if (!made.ok) throw new Error(JSON.stringify(made.body))
  expect((await jobService.approve(owner, made.value.id, { version: 1 })).ok).toBe(true)
  expect((await jobService.accept(alice, made.value.id, { version: 1 })).ok).toBe(true)
  return made.value.id
}

const occurrencesOf = (jobId: string) => db.prepare('SELECT due_slot, state, outcome_code FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? ORDER BY due_slot').all(CO, jobId) as Json[]
const tasks = () => (db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'task'").get(CO) as Json).n as number
const companyStop = () => agentStops.active(CO).filter(s => s.userId === null && s.tool === null)

beforeAll(async () => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', TS, TS)
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${CO}-root`, CO, TS)
  db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'everyone', NULL, 1, 1, ?)").run(`${CO}-root-r`, CO, `${CO}-root`, TS)
  for (const [user, role] of [['u-owner', 'owner'], ['u-admin', 'admin'], ['u-alice', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${user}`, user, CO, role, TS, TS)
  }
  db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(CO, TS, 'u-owner')
  await services.records.refreshIndex(owner)
})

beforeEach(() => {
  for (const t of ['ai_job_occurrences', 'ai_job_versions', 'ai_jobs', 'notifications', 'ai_job_settings', 'agent_stops']) db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(CO)
  db.prepare("DELETE FROM ai_runs WHERE company_id = ? AND subject_kind = 'occurrence'").run(CO)
  db.prepare("DELETE FROM record_state WHERE company_id = ? AND record_id IN (SELECT id FROM records WHERE type = 'task')").run(CO)
  db.prepare("DELETE FROM records WHERE company_id = ? AND type = 'task'").run(CO)
  nowMs = jst('2026-11-13T10:00')
})

describe('after a restore', () => {
  it('a slot that ran before the copy was put back is never run again — also after the stop is lifted', async () => {
    const job = await weeklyJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    expect(tasks()).toBe(1)
    // The backup was taken before that run: its occurrence and run are gone, the task it made is outside (a person has it).
    db.prepare('DELETE FROM ai_job_occurrences WHERE company_id = ?').run(CO)
    db.prepare("DELETE FROM ai_runs WHERE company_id = ? AND subject_kind = 'occurrence'").run(CO)
    db.prepare("DELETE FROM record_state WHERE company_id = ? AND record_id IN (SELECT id FROM records WHERE type = 'task')").run(CO)
    db.prepare("DELETE FROM records WHERE company_id = ? AND type = 'task'").run(CO)

    const r = restorePause.pauseAfterRestore(CO)
    expect(r).toEqual({ aiStopAdded: true, told: 2 })
    nowMs = jst('2026-11-16T09:30')
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job)).toEqual([{ due_slot: '2026-11-16T09:00', state: 'held', outcome_code: 'COMPANY_STOPPED' }])
    expect(tasks()).toBe(0)
    // An owner lifts it after checking: the slot stays held; the next slot runs as usual.
    expect(jobService.setStopped(owner, { stopped: false }).ok).toBe(true)
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    expect(tasks()).toBe(0)
    nowMs = jst('2026-11-23T09:02')
    occ.makeOccurrences(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job).map(o => o.state)).toEqual(['held', 'done'])
    expect(tasks()).toBe(1)
  })

  it('an occurrence waiting when the restore is noticed is held, not run', async () => {
    const job = await weeklyJob()
    nowMs = jst('2026-11-16T09:02')
    occ.makeOccurrences(CO)
    restorePause.pauseAfterRestore(CO)
    occ.runDue(CO)
    expect(occurrencesOf(job)).toEqual([{ due_slot: '2026-11-16T09:00', state: 'held', outcome_code: 'COMPANY_STOPPED' }])
    expect(tasks()).toBe(0)
    expect((db.prepare('SELECT stopped, updated_by FROM ai_job_settings WHERE company_id = ?').get(CO) as Json)).toEqual({ stopped: 1, updated_by: RESTORE_ACTOR })
  })

  it('the whole AI is stopped company-wide (once); owners and admins are told in plain words, members are not', async () => {
    expect(restorePause.pauseAfterRestore(CO).aiStopAdded).toBe(true)
    expect(companyStop()).toHaveLength(1)
    expect(companyStop()[0]).toMatchObject({ stoppedBy: RESTORE_ACTOR, reason: expect.stringContaining('バックアップから戻した') })
    // The server's own check that refuses AI runs' claims and the relay.
    expect(services.agentStops.companyStopped(CO)).toBe(true)
    // Again: no second stop, told again.
    nowMs += 60_000
    expect(restorePause.pauseAfterRestore(CO).aiStopAdded).toBe(false)
    expect(companyStop()).toHaveLength(1)
    for (const m of [owner, { companyId: CO, userId: 'u-admin', role: 'admin' }]) {
      const bell = services.notifications.list(m)
      expect(bell.ok && bell.value.items.map(i => [i.kind, i.text])).toEqual([['company_restored', COMPANY_RESTORED_TEXT], ['company_restored', COMPANY_RESTORED_TEXT]])
    }
    const members = services.notifications.list(alice)
    expect(members.ok && members.value.items).toEqual([])
    // Shown only while the member is an owner / admin.
    const demoted = services.notifications.list({ companyId: CO, userId: 'u-admin', role: 'member' })
    expect(demoted.ok && demoted.value.items).toEqual([])
  })

  it('composition wires it: the jobs stopped and the AI stopped through the server\'s own services', () => {
    services.restorePause.pauseAfterRestore(CO)
    expect(companyData.forCompany(CO).jobs.stopped()).toBe(true)
    expect(services.agentStops.companyStopped(CO)).toBe(true)
  })
})
