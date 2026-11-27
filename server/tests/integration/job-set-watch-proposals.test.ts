/**
 * Integration Test: a member adds a set watch from the app (schema 5 through the member proposals' path, 4b-4 PR6b; jobs.md
 * "Member proposals" "A set watch from the app"). On a real bare repository holding department Skills.
 *
 * Guards (each mutation-checked; the results in the PR):
 * - the candidate is built by the server from the member's choices only: the responsible person is the member, no other key
 *   (a name, a responsible person, a place, limits) is taken, the combination must be an opened one, the trees and the reasons
 *   are the server's, the run Skill needs its `decision.json`;
 * - a Skill the member does not read is answered as one that is not there, and is never listed;
 * - the department it writes in (`.personal/提案書/`) must be the member's to write;
 * - one per person: not while the member has an approved, active set watch;
 * - only an app that shows schema 5 makes one;
 * - its proposal's job keeps schema 5 through an admin's edit (never made a schema 4), is approved by an owner / admin as any
 *   proposal (a console not showing 5 cannot), and the member's 受け取る is still their own press.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

import { db, initDatabase } from '../../src/db'
import { createJobService } from '../../src/services/jobs'
import { createJobProposals } from '../../src/services/job-proposals'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { departmentSkill, departmentSkills } from '../../src/lib/skill-trees'
import { companyRepoPath } from '../../src/lib/config'
import { JOB_SET_WATCH_OPENED } from '../../../shared/core/jobs'
import { makeTempDir } from '../../shared/testing/temp-dirs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const CO = 'swp-co'
const TS = '2026-11-24T00:00:00.000Z'
const READS = [1, 2, 3, 4, 5]
const READS4 = [1, 2, 3, 4]
const DEPT = '法人ソリューション'
const SALES = '営業部'
const DECISION = { reasons: [{ code: 'internal_meeting', label: '社内の会議' }, { code: 'requested', label: '提案を求められた' }] }

const m = (userId: string, role: string) => ({ companyId: CO, userId, role })
const owner = m('swp-owner', 'owner')
const alice = m('swp-alice', 'member')
const bob = m('swp-bob', 'member')
const carol = m('swp-carol', 'member')

const companyData = sqliteCompanyData(db)
const memberships = sqliteMembershipRepository(db)
const transactions = sqliteTransactions(db)
const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() }
let hasFolder = true
const jobs = createJobService({
  companyData, memberships, transactions, clock, ids: randomIds, skillTree: async (_co, name) => (name === 'company-skill' ? 'a'.repeat(40) : null), hasCompanyFolder: () => hasFolder,
  departmentSkill: (companyId, place, name) => departmentSkill(companyId, place, name),
})
const proposals = createJobProposals({
  companyData, memberships, transactions, clock, ids: randomIds, jobs, skillTree: async () => null, hasCompanyFolder: () => hasFolder,
  placeExists: async (_co, p) => [DEPT, SALES].includes(p),
  placeFolders: async (_co, p) => (p === '' ? [DEPT, SALES, '.claude'] : null),
  departmentSkills: (companyId, place) => departmentSkills(companyId, place),
})

let workDir = ''
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
}
function skill(place: string, name: string, decision: unknown | null) {
  const dir = join(workDir, place, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`)
  if (decision !== null) writeFileSync(join(dir, 'decision.json'), JSON.stringify(decision))
}
const treeOf = (place: string, name: string) => git(workDir, 'rev-parse', `HEAD:${place}/.claude/skills/${name}`)

const ok = <T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const codeOf = (r: { ok: boolean; body?: unknown }) => (r.ok ? 'OK' : (r.body as Json).code)
const opened = () => JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED[0]))
const choice = (o: Record<string, unknown> = {}): Json => ({
  trigger: opened(), skill: { place: DEPT, skill: 'sales-proposal-auto' }, readSkills: [{ place: DEPT, skill: 'sales-proposal-v1' }], ...o,
})
const latestFingerprint = (jobId: string) => (db.prepare('SELECT fingerprint FROM ai_job_versions WHERE company_id = ? AND job_id = ? ORDER BY version DESC LIMIT 1').get(CO, jobId) as Json).fingerprint
const candidateCount = () => (db.prepare('SELECT COUNT(*) AS n FROM ai_job_candidates WHERE company_id = ?').get(CO) as Json).n

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, owner.userId, TS, TS)
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('swp-root', ?, '', 'company', ?)").run(CO, TS)
  const rule = (id: string, scope: string, subject: string | null, read: number, write: number) =>
    db.prepare('INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, CO, scope, subject === null ? 'everyone' : 'user', subject, read, write, TS)
  rule('swp-root-e', 'swp-root', null, 1, 1)
  // 営業部: bob does not read it. 法人ソリューション: carol reads it but cannot write there.
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('swp-sales', ?, ?, 'folder', ?)").run(CO, SALES, TS)
  rule('swp-sales-b', 'swp-sales', bob.userId, 0, 0)
  rule('swp-sales-e', 'swp-sales', null, 1, 1)
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('swp-dept', ?, ?, 'folder', ?)").run(CO, DEPT, TS)
  rule('swp-dept-c', 'swp-dept', carol.userId, 1, 0)
  rule('swp-dept-e', 'swp-dept', null, 1, 1)
  for (const who of [owner, alice, bob, carol]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${who.userId}`, who.userId, CO, who.role, TS, TS)
  }
  const bare = companyRepoPath(CO)
  rmSync(bare, { recursive: true, force: true })
  mkdirSync(bare, { recursive: true })
  git(bare, 'init', '-q', '--bare')
  workDir = makeTempDir('acb-swp-work-')
  git(workDir, 'init', '-q')
  git(workDir, 'remote', 'add', 'origin', bare)
  skill(DEPT, 'sales-proposal-auto', DECISION)
  skill(DEPT, 'sales-proposal-v1', null)
  skill(DEPT, 'no-reasons', null)
  skill(SALES, 'secret-auto', DECISION)
  git(workDir, 'add', '-A')
  git(workDir, 'commit', '-q', '-m', 'skills')
  git(workDir, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
})

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  rmSync(companyRepoPath(CO), { recursive: true, force: true })
})

beforeEach(() => {
  for (const t of ['ai_job_proposals', 'ai_job_candidates', 'ai_job_versions', 'ai_jobs', 'notifications']) db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(CO)
  hasFolder = true
})

describe('「見張りを足す」 lists the department Skills the member reads', () => {
  it('each Skill with whether it can run a set watch (it has decision.json); a department the member does not read is never named', async () => {
    expect(ok(await proposals.setWatchSkills(alice)).skills).toEqual([
      { place: DEPT, skill: 'no-reasons', runs: false }, { place: DEPT, skill: 'sales-proposal-auto', runs: true }, { place: DEPT, skill: 'sales-proposal-v1', runs: false },
      { place: SALES, skill: 'secret-auto', runs: true },
    ])
    expect(ok(await proposals.setWatchSkills(bob)).skills.map((s: Json) => s.place)).not.toContain(SALES)
  })

  it('a company without the shared folder has none', async () => {
    hasFolder = false
    expect(ok(await proposals.setWatchSkills(alice)).skills).toEqual([])
  })
})

describe('the candidate is the server’s, from the member’s choices only', () => {
  it('the member is the responsible person; the trees and the reasons are read now; the name, the place, the limits are the server’s', async () => {
    const c = ok(await proposals.createSetWatchCandidate(alice, choice(), READS)) as Json
    expect(c.definition).toMatchObject({
      schema: 5, actingUser: alice.userId, name: 'sales-proposal-auto（会議のあと）', placement: 'a', check: { kind: 'matched_record' },
      run: { kind: 'procedure', procedure: { source: 'department_skill', place: DEPT, skill: 'sales-proposal-auto', fingerprint: treeOf(DEPT, 'sales-proposal-auto') } },
      grant: {
        creates: ['task'], outbound: 'none', reads: { paths: [], calls: [], skills: [{ place: DEPT, skill: 'sales-proposal-v1', fingerprint: treeOf(DEPT, 'sales-proposal-v1') }] },
        writes: { area: 'deliverable', place: DEPT, folder: '提案書' }, limits: { minutes: 30, runsPerDay: 10 },
      },
      missed: { policy: 'skip', expiresAfterMinutes: 1440 },
      decision: DECISION,
    })
    // Its own view reads it back (a candidate of schema 5), the member's alone.
    expect(ok(proposals.candidate(alice, c.id))).toMatchObject({ id: c.id, fingerprint: c.fingerprint, definition: { schema: 5 } })
    expect(codeOf(proposals.candidate(bob, c.id))).toBe('JOB_CANDIDATE_NOT_FOUND')
  })

  it('no other key is taken (a name, a responsible person, a place, limits) and the combination must be an opened one', async () => {
    for (const extra of [{ name: '勝手な名前' }, { actingUser: bob.userId }, { writes: { area: 'deliverable', place: SALES, folder: 'x' } }, { limits: { minutes: 120, runsPerDay: 24 } }]) {
      expect(await proposals.createSetWatchCandidate(alice, choice(extra), READS)).toMatchObject({ ok: false, body: { code: 'BAD_JOB_CANDIDATE', problems: ['UNKNOWN_KEY'] } })
    }
    expect(await proposals.createSetWatchCandidate(alice, choice({ trigger: { ...opened(), guards: ['after_acceptance'] } }), READS))
      .toMatchObject({ ok: false, body: { code: 'BAD_JOB_DEFINITION', problems: ['trigger.NOT_OPENED'] } })
    expect(await proposals.createSetWatchCandidate(alice, choice({ trigger: { every: 'day', at: '09:00' } }), READS)).toMatchObject({ ok: false, body: { code: 'BAD_JOB_CANDIDATE' } })
    expect(candidateCount()).toBe(0)
  })

  it('the Skill it runs needs its decision.json; a Skill that is not there is refused', async () => {
    expect(codeOf(await proposals.createSetWatchCandidate(alice, choice({ skill: { place: DEPT, skill: 'no-reasons' } }), READS))).toBe('JOB_SKILL_DECISION_MISSING')
    expect(codeOf(await proposals.createSetWatchCandidate(alice, choice({ readSkills: [{ place: DEPT, skill: 'no-such' }] }), READS))).toBe('JOB_SKILL_MISSING')
    expect(candidateCount()).toBe(0)
  })

  it('a Skill the member does not read is answered as one that is not there (the same words)', async () => {
    const hidden = await proposals.createSetWatchCandidate(bob, choice({ readSkills: [{ place: SALES, skill: 'secret-auto' }] }), READS) as Json
    const missing = await proposals.createSetWatchCandidate(bob, choice({ readSkills: [{ place: DEPT, skill: 'no-such' }] }), READS) as Json
    expect(hidden.ok).toBe(false)
    expect(hidden.body).toEqual(missing.body)
    expect(candidateCount()).toBe(0)
  })

  it('the department it writes in must be the member’s to write', async () => {
    expect(codeOf(await proposals.createSetWatchCandidate(carol, choice(), READS))).toBe('JOB_CANDIDATE_PLACE')
    expect(candidateCount()).toBe(0)
  })

  it('only an app that shows schema 5 makes one', async () => {
    expect(codeOf(await proposals.createSetWatchCandidate(alice, choice(), READS4))).toBe('JOB_NEEDS_NEWER_SCREEN')
    expect(candidateCount()).toBe(0)
  })

  it('a company without the shared folder makes none', async () => {
    hasFolder = false
    expect(codeOf(await proposals.createSetWatchCandidate(alice, choice(), READS))).toBe('JOB_SKILL_NOT_HERE')
  })
})

describe('its proposal goes the members’ proposal path: an admin approves, the member accepts', () => {
  async function proposed(who = alice): Promise<{ c: Json; p: Json }> {
    const c = ok(await proposals.createSetWatchCandidate(who, choice(), READS)) as Json
    const p = ok(await proposals.submit(who, c.id, { fingerprint: c.fingerprint })).proposal
    return { c, p }
  }

  it('submitted → a draft job of schema 5; a console not showing 5 cannot approve it; approved; the member’s own 受け取る', async () => {
    const { p } = await proposed()
    expect(db.prepare('SELECT schema, acting_user_id FROM ai_job_versions WHERE company_id = ? AND job_id = ?').get(CO, p.jobId)).toEqual({ schema: 5, acting_user_id: alice.userId })
    expect(codeOf(await jobs.approve(owner, p.jobId, { version: 1, fingerprint: latestFingerprint(p.jobId) }, READS4))).toBe('JOB_NEEDS_NEWER_SCREEN')
    ok(await jobs.approve(owner, p.jobId, { version: 1, fingerprint: latestFingerprint(p.jobId) }, READS))
    expect(db.prepare('SELECT state FROM ai_job_proposals WHERE company_id = ? AND id = ?').get(CO, p.id)).toEqual({ state: 'approved' })
    expect(ok(jobs.get(alice, p.jobId, READS)).you).toMatchObject({ mustAccept: true })
    ok(await jobs.accept(alice, p.jobId, { version: 1, fingerprint: latestFingerprint(p.jobId) }, READS, true))
    expect(ok(jobs.get(alice, p.jobId, READS)).waiting).toBeNull()
  })

  it('an admin’s edit keeps it schema 5; an edit making it another shape is refused', async () => {
    const { p } = await proposed()
    const d = JSON.parse((db.prepare('SELECT definition FROM ai_job_versions WHERE company_id = ? AND job_id = ? AND version = 1').get(CO, p.jobId) as Json).definition)
    const edited = ok(await jobs.update(owner, p.jobId, { definition: { ...d, name: '提案書のたたき台' }, baseVersion: 1 }, READS))
    expect(edited.changed).toBe(true)
    const asTime = {
      schema: 4, origin: 'member_proposal', name: 'x', actingUser: alice.userId, trigger: { every: 'day', at: '09:00', businessDaysOnly: true }, check: { kind: 'new_files', path: DEPT },
      run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'company-skill' } }, placement: 'a', missed: { policy: 'latest_only', expiresAfterMinutes: 60 },
      grant: { tools: ['records', 'files_read'], creates: ['task'], routes: [], reads: { paths: [DEPT], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 15, runsPerDay: 1 } },
    }
    expect(codeOf(await jobs.update(owner, p.jobId, { definition: asTime, baseVersion: 2 }, READS))).toBe('JOB_PROPOSAL_SCHEMA')
  })

  it('not while the member has an approved, active set watch (one per person)', async () => {
    const { p } = await proposed()
    ok(await jobs.approve(owner, p.jobId, { version: 1, fingerprint: latestFingerprint(p.jobId) }, READS))
    expect(codeOf(await proposals.createSetWatchCandidate(alice, choice(), READS))).toBe('JOB_SET_WATCH_ONE_PER_PERSON')
  })
})
