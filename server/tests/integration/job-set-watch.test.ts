/**
 * Integration Test: the set watch's definition, consent and approval (schema 5, 4b-4 PR1; owner memo 「4b-4 商談から提案書」
 * 第6版 §2 / §3 / §4-4, T8 / T11 / T14 / T19 / T22; jobs.md "The set watch (schema 5)"). The scan that finds the
 * records and makes occurrences (PR2) is job-set-watch-scan.test.ts.
 *
 * Guards (each mutation-checked; the results in the PR):
 * - the server pins both department Skills at their trees and copies the reasons from the run's Skill's `decision.json` — never
 *   the caller's fingerprints or reasons; a Skill that is not there, or without a valid `decision.json`, is refused;
 * - a stored version whose combination is not opened is never approved, accepted or resumed (T22);
 * - one active set watch per responsible person: a second is not approved, accepted or resumed (T14);
 * - never beside a business plugin step set to run one of its Skills (§3 ④: not approved, accepted or resumed), and the approval
 *   closes the open step requests pinned to one of them whenever they were asked, waiting for none (§3 ③, T19);
 * - a changed Skill is a new version (`JOB_SKILL_CHANGED`) and a new consent;
 * - a screen or app that does not announce 5 gets no definition and makes, approves or accepts none (T11);
 * - the clock makes no occurrence of an approved, accepted set watch while no record matches (PR2's scan: job-set-watch-scan.test.ts);
 * - nobody but the minutes service writes a やること's `task_kind` (§2-2: a person's or an AI's create is refused).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
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
import { services } from '../../src/composition'
import { createJobService } from '../../src/services/jobs'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { departmentSkill } from '../../src/lib/skill-trees'
import { hashCanonical } from '../../src/lib/content-hash'
import { canonicalJson } from '../../../shared/core/fixed-content'
import { JOB_MINUTES_ROUTE, JOB_SET_WATCH_OPENED, jobConsentCanonical, type JobDefinition, type JobSetTrigger } from '../../../shared/core/jobs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const READS = [1, 2, 3, 4, 5]
const DEPT = '法人ソリューション'
const COPY = 'sales-proposal-auto'
const ORIGINAL = 'sales-proposal-v1'
const DECISION = { reasons: [{ code: 'internal_meeting', label: '社内の会議' }, { code: 'requested', label: '提案を求められた' }] }
let CO = ''
let workDir = ''
let hasFolder = true

const member = (userId: string, role: string) => ({ companyId: CO, userId, role })
const owner = () => member('sw-owner', 'owner')
const alice = () => member('sw-alice', 'member')
const companyData = sqliteCompanyData(db)
const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() }
const jobs = createJobService({
  companyData, memberships: sqliteMembershipRepository(db), transactions: sqliteTransactions(db), clock, ids: randomIds,
  skillTree: async () => null, hasCompanyFolder: () => hasFolder,
  departmentSkill: (companyId, place, name) => departmentSkill(companyId, place, name),
})

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
}
/** Write the department's two Skills (the copy with `decision`, or none) and push them; the copy's and the original's trees. */
function putSkills(opts: { decision?: string | null; original?: string } = {}): { copy: string; original: string } {
  const base = join(workDir, DEPT, '.claude', 'skills')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(join(base, COPY), { recursive: true })
  mkdirSync(join(base, ORIGINAL), { recursive: true })
  writeFileSync(join(base, COPY, 'SKILL.md'), '# 提案書のたたき台（自動）\n')
  const decision = opts.decision === undefined ? JSON.stringify(DECISION) : opts.decision
  if (decision !== null) writeFileSync(join(base, COPY, 'decision.json'), decision)
  writeFileSync(join(base, ORIGINAL, 'SKILL.md'), opts.original ?? '# 提案書\n')
  git(workDir, 'add', '-A')
  git(workDir, 'commit', '-q', '--allow-empty', '-m', 'skills')
  git(workDir, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  return { copy: git(workDir, 'rev-parse', `HEAD:${DEPT}/.claude/skills/${COPY}`), original: git(workDir, 'rev-parse', `HEAD:${DEPT}/.claude/skills/${ORIGINAL}`) }
}

const OPENED = (): JobSetTrigger => JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED[0]))
/** 「自分が担当の『議事録を確認する』を初めて完了したとき、提案書のたたき台」 as an admin sends it (no fingerprints, no reasons). */
function setWatch(actingUser = 'sw-alice', overrides: Record<string, unknown> = {}): Json {
  return {
    schema: 5, name: '提案書のたたき台', actingUser,
    trigger: OPENED(),
    check: { kind: 'matched_record' },
    run: { kind: 'procedure', procedure: { source: 'department_skill', place: DEPT, skill: COPY } },
    placement: 'a',
    missed: { policy: 'skip', expiresAfterMinutes: 1440 },
    grant: {
      tools: ['files_read', 'files_write', 'records'], creates: ['task'], routes: [JOB_MINUTES_ROUTE],
      reads: { paths: [`${DEPT}/提案書`], calls: [], skills: [{ place: DEPT, skill: ORIGINAL }] },
      writes: { area: 'deliverable', place: DEPT, folder: '提案書' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 10 },
    },
    ...overrides,
  }
}
const ok = <T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const codeOf = (r: { ok: boolean; body?: unknown }) => (r.ok ? 'OK' : (r.body as Json).code)
async function made(actingUser = 'sw-alice'): Promise<string> {
  return ok(await jobs.create(owner(), { definition: setWatch(actingUser) }, READS)).id
}
async function running(actingUser = 'sw-alice', as = alice()): Promise<string> {
  const id = await made(actingUser)
  ok(await jobs.approve(owner(), id, { version: 1 }, READS))
  ok(await jobs.accept(as, id, { version: 1 }, READS, true))
  return id
}
const versionOf = (job: string, version = 1) => db.prepare('SELECT definition, fingerprint, consent_fingerprint FROM ai_job_versions WHERE company_id = ? AND job_id = ? AND version = ?').get(CO, job, version) as Json
const jobRow = (job: string) => db.prepare('SELECT state, approved_version FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, job) as Json
/** A version 2 written as text (as if a build had saved it), approved by the owner; the job active. */
function storeVersion2(job: string, definition: Json) {
  const text = canonicalJson(definition)
  db.prepare(`INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at,
      approved_by, approved_at, accepted_by, accepted_at) VALUES (?, ?, 2, 5, ?, ?, ?, ?, 'sw-owner', ?, NULL, NULL, NULL, NULL)`)
    .run(CO, job, text, hashCanonical(text), hashCanonical(jobConsentCanonical(definition as JobDefinition)), definition.actingUser, new Date().toISOString())
  db.prepare('UPDATE ai_jobs SET latest_version = 2 WHERE company_id = ? AND id = ?').run(CO, job)
}
const at = () => new Date().toISOString()
function stepSkill(skill: string) {
  db.prepare("INSERT INTO plugin_step_skills (company_id, plugin_id, step, skill, updated_at, updated_by) VALUES (?, 'corporate-sales', 'prepare_proposal', ?, ?, 'sw-owner')").run(CO, skill, at())
}
function request(record: string, opts: { pinned?: string | null; requestedAt?: string; done?: boolean; step?: string } = {}) {
  const step = opts.step ?? 'prepare_proposal'
  db.prepare('INSERT INTO plugin_step_requests (company_id, record_id, plugin_id, step, requested_at, meeting_id, done_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .run(CO, record, 'corporate-sales', step, opts.requestedAt ?? at(), opts.done ? at() : null)
  if (opts.pinned) {
    db.prepare("INSERT INTO plugin_step_pins (company_id, record_id, plugin_id, step, source, version, skill, fingerprint, pinned_at, updated_at) VALUES (?, ?, 'corporate-sales', ?, 'company_skill', NULL, ?, ?, ?, ?)")
      .run(CO, record, step, opts.pinned, 'd'.repeat(40), at(), at())
  }
}
const requestOf = (record: string) => db.prepare('SELECT done_at, done_by_job FROM plugin_step_requests WHERE company_id = ? AND record_id = ?').get(CO, record) as Json

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'sw-owner'
  currentUser.id = 'sw-owner'
  const res = await app.request('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Set Watch Co', folderKind: 'none' }) })
  expect(res.status).toBe(201)
  CO = ((await res.json()) as Json).data.id
  for (const [user, role] of [['sw-alice', 'member'], ['sw-bob', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, at(), at())
  }
  // The company repository holding the department's Skills (read from the bare repository, as the server does).
  const { companyRepoPath } = await import('../../src/lib/config')
  const bare = companyRepoPath(CO)
  mkdirSync(bare, { recursive: true })
  git(bare, 'init', '-q', '--bare')
  workDir = mkdtempSync(join(tmpdir(), 'acb-sw-work-'))
  git(workDir, 'init', '-q')
  git(workDir, 'remote', 'add', 'origin', bare)
})

afterAll(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

beforeEach(() => {
  for (const t of ['ai_job_occurrences', 'ai_job_versions', 'ai_jobs', 'notifications', 'plugin_step_skills', 'plugin_step_pins', 'plugin_step_requests']) db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(CO)
  hasFolder = true
  putSkills()
})

describe('the server pins both department Skills and the reasons, never the caller', () => {
  it('the trees read now and the copy’s decision.json are stored, whatever the caller sent', async () => {
    const trees = putSkills()
    const sent = setWatch('sw-alice', { decision: { reasons: [{ code: 'anything', label: '勝手な理由' }] } })
    sent.run.procedure.fingerprint = 'e'.repeat(40)
    sent.grant.reads.skills[0].fingerprint = 'e'.repeat(40)
    const job = ok(await jobs.create(owner(), { definition: sent }, READS)).id
    const stored = JSON.parse(versionOf(job).definition)
    expect(stored.run.procedure.fingerprint).toBe(trees.copy)
    expect(stored.grant.reads.skills[0].fingerprint).toBe(trees.original)
    expect(stored.decision).toEqual(DECISION)
  })

  it('a Skill that is not there, a copy without a valid decision.json, a company without the shared folder: refused, nothing made', async () => {
    expect(codeOf(await jobs.create(owner(), { definition: setWatch('sw-alice', { run: { kind: 'procedure', procedure: { source: 'department_skill', place: DEPT, skill: 'no-such-skill' } } }) }, READS))).toBe('JOB_SKILL_MISSING')
    const other = setWatch()
    other.grant.reads.skills = [{ place: '営業部', skill: ORIGINAL }]
    expect(codeOf(await jobs.create(owner(), { definition: other }, READS))).toBe('JOB_SKILL_MISSING')
    putSkills({ decision: null })
    expect(codeOf(await jobs.create(owner(), { definition: setWatch() }, READS))).toBe('JOB_SKILL_DECISION_MISSING')
    putSkills({ decision: '{"reasons":[{"code":"Bad","label":"x"}]}' })
    expect(codeOf(await jobs.create(owner(), { definition: setWatch() }, READS))).toBe('JOB_SKILL_DECISION_MISSING')
    putSkills()
    hasFolder = false
    expect(codeOf(await jobs.create(owner(), { definition: setWatch() }, READS))).toBe('JOB_SKILL_NOT_HERE')
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_jobs WHERE company_id = ?').get(CO) as Json).n).toBe(0)
  })

  it('a combination that is not opened is never saved', async () => {
    const d = setWatch()
    d.trigger.guards = d.trigger.guards.slice(1)
    const r = await jobs.create(owner(), { definition: d }, READS)
    expect(r).toMatchObject({ ok: false, body: { code: 'BAD_JOB_DEFINITION', problems: ['trigger.NOT_OPENED'] } })
  })
})

describe('older screens and apps never see, make, approve or accept it (T11)', () => {
  it('a client announcing 1–4 gets no definition, and its create, approval and acceptance are refused', async () => {
    expect(codeOf(await jobs.create(owner(), { definition: setWatch() }, [1, 2, 3, 4]))).toBe('JOB_NEEDS_NEWER_SCREEN')
    const job = await made()
    const seen = ok(jobs.get(owner(), job, [1, 2, 3, 4]))
    expect(seen.versions?.[0]).toMatchObject({ definition: null, needsUpdate: true })
    expect(seen.trigger).toBeUndefined()
    expect(codeOf(await jobs.approve(owner(), job, { version: 1 }, [1, 2, 3, 4]))).toBe('JOB_NEEDS_NEWER_SCREEN')
    ok(await jobs.approve(owner(), job, { version: 1 }, READS))
    expect(codeOf(await jobs.accept(alice(), job, { version: 1 }, [1, 2, 3, 4], true))).toBe('JOB_NEEDS_NEWER_SCREEN')
  })

  it('approved and accepted, it makes no occurrence while no record matches (the scan: job-set-watch-scan.test.ts)', async () => {
    const job = await running()
    expect(jobRow(job)).toMatchObject({ state: 'active', approved_version: 1 })
    services.jobOccurrences.makeOccurrences(CO)
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_job_occurrences WHERE company_id = ? AND job_id = ?').get(CO, job) as Json).n).toBe(0)
  })
})

describe('a combination no longer opened is never approved, accepted or resumed (T22)', () => {
  it('a stored version whose trigger is not exactly an opened one', async () => {
    const job = await running()
    const stored = JSON.parse(versionOf(job).definition)
    storeVersion2(job, { ...stored, trigger: { ...stored.trigger, guards: [...stored.trigger.guards].reverse() } })
    expect(codeOf(await jobs.approve(owner(), job, { version: 2 }, READS))).toBe('JOB_SET_WATCH_NOT_OPENED')
    // Approved by a build that took it (written as such): this build neither accepts nor resumes it.
    db.prepare("UPDATE ai_job_versions SET approved_by = 'sw-owner', approved_at = ? WHERE company_id = ? AND job_id = ? AND version = 2").run(at(), CO, job)
    db.prepare('UPDATE ai_jobs SET approved_version = 2, approved_fingerprint = ? WHERE company_id = ? AND id = ?').run(versionOf(job, 2).fingerprint, CO, job)
    expect(codeOf(await jobs.accept(alice(), job, { version: 2 }, READS, true))).toBe('JOB_SET_WATCH_NOT_OPENED')
    ok(jobs.pause(owner(), job, READS))
    expect(codeOf(await jobs.resume(owner(), job, READS))).toBe('JOB_SET_WATCH_NOT_OPENED')
    expect(jobRow(job).state).toBe('paused')
  })

  it('a line taken out of the opened list stops the jobs of it', async () => {
    const job = await made()
    const removed = (JOB_SET_WATCH_OPENED as JobSetTrigger[]).splice(0, 1)
    try {
      expect(codeOf(await jobs.approve(owner(), job, { version: 1 }, READS))).toBe('JOB_SET_WATCH_NOT_OPENED')
    } finally {
      (JOB_SET_WATCH_OPENED as JobSetTrigger[]).unshift(...removed)
    }
    ok(await jobs.approve(owner(), job, { version: 1 }, READS))
  })
})

describe('one set watch per responsible person (T14)', () => {
  it('a second is not approved while the first is active; it is once the first is paused; the first is then neither resumed nor accepted', async () => {
    const first = await running()
    const second = await made()
    expect(codeOf(await jobs.approve(owner(), second, { version: 1 }, READS))).toBe('JOB_SET_WATCH_ONE_PER_PERSON')
    expect(jobRow(second).state).toBe('draft')
    // Someone else's is theirs to have.
    ok(await jobs.approve(owner(), await made('sw-bob'), { version: 1 }, READS))
    ok(jobs.pause(owner(), first, READS))
    ok(await jobs.approve(owner(), second, { version: 1 }, READS))
    expect(codeOf(await jobs.resume(owner(), first, READS))).toBe('JOB_SET_WATCH_ONE_PER_PERSON')
    expect(jobRow(first).state).toBe('paused')
    ok(await jobs.accept(alice(), second, { version: 1 }, READS, true))
    // A new version of the first (another consent) is not taken while the second runs.
    const stored = JSON.parse(versionOf(first).definition)
    storeVersion2(first, { ...stored, name: '提案書（2）', grant: { ...stored.grant, limits: { minutes: 20, runsPerDay: 10 } } })
    expect(codeOf(await jobs.approve(owner(), first, { version: 2 }, READS))).toBe('JOB_SET_WATCH_ONE_PER_PERSON')
  })

  it('an approved one whose acceptance waits counts too, and its own approval again is not refused', async () => {
    const first = await made()
    ok(await jobs.approve(owner(), first, { version: 1 }, READS))
    ok(await jobs.approve(owner(), first, { version: 1 }, READS))
    const second = await made()
    expect(codeOf(await jobs.approve(owner(), second, { version: 1 }, READS))).toBe('JOB_SET_WATCH_ONE_PER_PERSON')
    // Approved by a build that did not check (written as such): its acceptance is refused here.
    db.prepare("UPDATE ai_job_versions SET approved_by = 'sw-owner', approved_at = ? WHERE company_id = ? AND job_id = ? AND version = 1").run(at(), CO, second)
    db.prepare("UPDATE ai_jobs SET approved_version = 1, approved_fingerprint = ?, state = 'active' WHERE company_id = ? AND id = ?").run(versionOf(second).fingerprint, CO, second)
    expect(codeOf(await jobs.accept(alice(), second, { version: 1 }, READS, true))).toBe('JOB_SET_WATCH_ONE_PER_PERSON')
  })
})

describe('business plugin steps and the set watch run the same Skill one way only (§3 ③ ④, T19)', () => {
  it('a step set to run one of its Skills keeps it from being approved, accepted or resumed', async () => {
    const job = await made()
    stepSkill(ORIGINAL)
    expect(codeOf(await jobs.approve(owner(), job, { version: 1 }, READS))).toBe('JOB_SET_WATCH_STEP_SKILL')
    db.prepare('DELETE FROM plugin_step_skills WHERE company_id = ?').run(CO)
    stepSkill(COPY)
    expect(codeOf(await jobs.approve(owner(), job, { version: 1 }, READS))).toBe('JOB_SET_WATCH_STEP_SKILL')
    db.prepare('DELETE FROM plugin_step_skills WHERE company_id = ?').run(CO)
    ok(await jobs.approve(owner(), job, { version: 1 }, READS))
    stepSkill(ORIGINAL)
    expect(codeOf(await jobs.accept(alice(), job, { version: 1 }, READS, true))).toBe('JOB_SET_WATCH_STEP_SKILL')
    db.prepare('DELETE FROM plugin_step_skills WHERE company_id = ?').run(CO)
    ok(await jobs.accept(alice(), job, { version: 1 }, READS, true))
    ok(jobs.pause(owner(), job, READS))
    stepSkill(ORIGINAL)
    expect(codeOf(await jobs.resume(owner(), job, READS))).toBe('JOB_SET_WATCH_STEP_SKILL')
    // Another Skill on a step is not this one.
    db.prepare('DELETE FROM plugin_step_skills WHERE company_id = ?').run(CO)
    stepSkill('interview-report')
    ok(await jobs.resume(owner(), job, READS))
  })

  it('the approval closes every open request pinned to one of its Skills, whenever asked; others stay; it waits for none', async () => {
    const job = await made()
    const later = new Date(Date.now() + 60 * 60_000).toISOString()
    request('deal-000001', { pinned: ORIGINAL })
    request('deal-000002', { pinned: COPY, requestedAt: later })
    request('deal-000003', { pinned: 'interview-report' })
    request('deal-000004', { pinned: null })
    request('deal-000005', { pinned: ORIGINAL, done: true })
    const doneBefore = requestOf('deal-000005').done_at
    ok(await jobs.approve(owner(), job, { version: 1 }, READS))
    expect(requestOf('deal-000001')).toMatchObject({ done_by_job: job })
    expect(requestOf('deal-000001').done_at).not.toBeNull()
    // Asked after the approval's own time too (a later meeting reopened it): closed, no time condition.
    expect(requestOf('deal-000002')).toMatchObject({ done_by_job: job })
    expect(requestOf('deal-000003')).toEqual({ done_at: null, done_by_job: null })
    expect(requestOf('deal-000004')).toEqual({ done_at: null, done_by_job: null })
    expect(requestOf('deal-000005')).toEqual({ done_at: doneBefore, done_by_job: null })
  })

  it('an approval refused for another reason closes nothing', async () => {
    await running()
    const second = await made()
    request('deal-000006', { pinned: ORIGINAL })
    expect(codeOf(await jobs.approve(owner(), second, { version: 1 }, READS))).toBe('JOB_SET_WATCH_ONE_PER_PERSON')
    expect(requestOf('deal-000006')).toEqual({ done_at: null, done_by_job: null })
  })
})

describe('a changed Skill is a new version and a new consent (O5, T8)', () => {
  it('approval refuses the version pinned before; the new version asks for a new acceptance', async () => {
    const job = await running()
    putSkills({ original: '# 提案書（直した）\n' })
    expect(codeOf(await jobs.approve(owner(), job, { version: 1 }, READS))).toBe('JOB_SKILL_CHANGED')
    ok(jobs.pause(owner(), job, READS))
    expect(codeOf(await jobs.resume(owner(), job, READS))).toBe('JOB_SKILL_CHANGED')
    const updated = ok(await jobs.update(owner(), job, { definition: setWatch() }, READS))
    expect(updated.changed).toBe(true)
    expect(versionOf(job, 2).consent_fingerprint).not.toBe(versionOf(job, 1).consent_fingerprint)
    expect(updated.latestConsentAccepted).toBe(false)
  })
})

describe('a Skill the responsible person cannot read tells them nothing about it (independent review)', () => {
  it('changed or not, an unreadable department Skill answers as missing at acceptance and resume', async () => {
    const job = await made()
    ok(await jobs.approve(owner(), job, { version: 1 }, READS))
    db.prepare('INSERT OR IGNORE INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`d-${CO}-sales`, CO, DEPT, DEPT, at(), at())
    currentUser.id = 'sw-owner'
    const put = await app.request(`/api/companies/${CO}/permissions/scopes/by-path`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: DEPT, rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'user', subjectId: 'sw-bob', canRead: true, canWrite: true }] }),
    })
    expect(put.status).toBe(200)
    try {
      expect(codeOf(await jobs.accept(alice(), job, { version: 1 }, READS, true))).toBe('JOB_SKILL_MISSING')
      putSkills({ original: '# 提案書（直した）\n' })
      expect(codeOf(await jobs.accept(alice(), job, { version: 1 }, READS, true))).toBe('JOB_SKILL_MISSING')
    } finally {
      db.prepare('DELETE FROM scope_rules WHERE company_id = ? AND scope_id IN (SELECT id FROM scopes WHERE company_id = ? AND path = ?)').run(CO, CO, DEPT)
    }
    // Readable again, the change is said as such.
    expect(codeOf(await jobs.accept(alice(), job, { version: 1 }, READS, true))).toBe('JOB_SKILL_CHANGED')
  })
})

describe('nobody but the minutes service makes a やること of the 「議事録を確認する」 kind (§2-2)', () => {
  it('a person’s and an AI’s create naming task_kind is refused, nothing written', () => {
    const human = services.recordEngine.create(alice(), { kind: 'human' }, { type: 'task', title: '議事録を確認する', fields: { assignee: 'sw-alice', task_kind: 'minutes_review' } })
    expect(human).toMatchObject({ ok: false, body: { code: 'BAD_VALUE' } })
    const byAi = services.recordEngine.create(alice(), { kind: 'ai' }, { type: 'task', title: '議事録を確認する', fields: { assignee: 'sw-alice', task_kind: 'minutes_review' } })
    expect(byAi).toMatchObject({ ok: false, body: { code: 'BAD_VALUE' } })
    expect((db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'task'").get(CO) as Json).n).toBe(0)
  })
})
