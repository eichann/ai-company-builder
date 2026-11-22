/**
 * Integration Test: a member proposes a time job from the AI chat (「AIへの相談」から定期の仕事, PR A, jobs.md "Member
 * proposals"; owner memo 2026-11-22 §9 / §11 / 第5版 acceptance conditions).
 *
 * Guards (each mutation-checked, listed in jobs.md "Member proposals"):
 * - a candidate: only from a consultation's token (any run-bound token refused, before anything is read); the responsible
 *   person is the signed-in member (no key sets it), the Skill read as theirs and pinned by the server; no free text (an
 *   unknown key, a name, a folder, title words refused); places only existing folders they read (write: the deliverable's),
 *   one answer for missing / unreadable; their own alone (another member's, another company's: the one 404); never a job;
 *   at most 20 kept;
 * - the submit: the session's, by candidate id + the fingerprint shown, never resolved again; rights / Skill checked again
 *   inside the write; at most 5 waiting and 10 a day, counted atomically (6 at once → 5); idempotent by the permanent record,
 *   also after the content's 24 hours (nothing added);
 * - one of approve (first) / withdraw / return wins, only from `submitted`, also in a race; withdrawn / returned → never
 *   edited or approved; later versions: the newest with its fingerprint, an edit naming its base; schema 4 stays 4 and only
 *   a proposal makes it; an old admin tab (announcing 1,2,3) neither approves nor edits; approving never accepts;
 * - notices: one per proposal and owner / admin, read state each their own, nothing more on a resend, gone once decided.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { recordsRoute } from '../../src/routes/records'
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { jobsRoute } from '../../src/routes/jobs'
import { jobProposalsAiRoute, jobProposalsRoute } from '../../src/routes/job-proposals'
import { recordsAiRoute } from '../../src/routes/records-ai'
import { services } from '../../src/composition'
import { createJobService, versionRow } from '../../src/services/jobs'
import { canonicalJson } from '../../../shared/core/fixed-content'
import { createJobProposals } from '../../src/services/job-proposals'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { JOB_MINUTES_ROUTE } from '../../../shared/core/jobs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const CO = 'jp-co'
const OTHER = 'jp-other'
const TS = '2026-11-11T00:00:00.000Z'
const READS4 = [1, 2, 3, 4]
const OLD_TAB = [1, 2, 3]
const HOUR = 60 * 60_000

const m = (userId: string, role: string, companyId = CO) => ({ companyId, userId, role })
const owner = m('u-owner', 'owner')
const admin = m('u-admin', 'admin')
const admin2 = m('u-admin2', 'admin')
const alice = m('u-alice', 'member')
const bob = m('u-bob', 'member')
const mallory = m('u-mallory', 'member')
const carol = m('u-carol', 'member')
const dave = m('u-dave', 'member')

// The server's clock, moved by the tests (24 hours later…).
let shift = 0
const clock = { now: () => new Date(Date.now() + shift).toISOString(), nowMs: () => Date.now() + shift }
// The Skill's tree now; `between` runs while the server reads it (something changing during an await).
let tree: string | null = 'a'.repeat(40)
let between: (() => void) | null = null
const skillTree = async () => { const t = tree; const b = between; between = null; await Promise.resolve(); b?.(); return t }
// The company's folders (the repository's view; 経理部 a private folder only alice reads).
const EXISTS = new Set(['営業部', '営業部/週報', '秘書室', '経理部', '総務', '議事録'])
const FOLDERS: Record<string, string[]> = { '': ['営業部', '秘書室', '経理部', '総務', '議事録', '.claude'], '営業部': ['週報'], '経理部': [], '総務': [], '秘書室': [], '議事録': [] }
const pushed: string[][] = []

const companyData = sqliteCompanyData(db)
const memberships = sqliteMembershipRepository(db)
const transactions = sqliteTransactions(db)
// The shelf Skill's place: readable by everyone but bob, and by nobody while `shelfHidden`.
let shelfHidden = false
const shelfFake = (who: { userId: string }, item: string) => (item === 'shelf-1' ? { name: 'shelf-skill', current: 'b'.repeat(64), kept: true, readable: who.userId !== 'u-bob' && !shelfHidden } : null)
const jobs = createJobService({ companyData, memberships, transactions, clock, ids: randomIds, skillTree, hasCompanyFolder: () => true, shelfSkill: shelfFake })
const shelfCalls: string[] = []
function proposalsWith(opts: { folder?: boolean } = {}) {
  return createJobProposals({
    companyData, memberships, transactions, clock, ids: randomIds, jobs, skillTree, hasCompanyFolder: () => opts.folder ?? true,
    shelfSkill: (who, item) => { shelfCalls.push(who.userId); return shelfFake(who, item) },
    placeExists: async (_co, p) => EXISTS.has(p), placeFolders: async (_co, p) => FOLDERS[p] ?? null,
    noticesChanged: (_co, users) => { pushed.push(users) },
  })
}
const proposals = proposalsWith()

const input = (o: Record<string, unknown> = {}): Json => ({
  skill: 'weekly-minutes', trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 }, check: { kind: 'new_meetings' },
  reads: ['営業部'], deliverable: '営業部/週報', readRecords: true, mailDrafts: false, minutes: 15, missed: { policy: 'latest_only', expiresAfterMinutes: 1440 }, ...o,
})
const ok = <T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
async function candidate(who = alice, o: Record<string, unknown> = {}): Promise<Json> { return ok(await proposals.createCandidate(who, null, input(o))) }
async function submitted(who = alice, o: Record<string, unknown> = {}): Promise<{ c: Json; p: Json }> {
  const c = await candidate(who, o)
  const p = ok(await proposals.submit(who, c.id, { fingerprint: c.fingerprint })).proposal
  return { c, p }
}
const jobCount = () => (db.prepare('SELECT COUNT(*) AS n FROM ai_jobs WHERE company_id = ?').get(CO) as Json).n
const proposalNotices = (id: string) => db.prepare("SELECT id, user_id, read_at FROM notifications WHERE company_id = ? AND kind = 'job_proposal' AND dedupe_key = ? ORDER BY user_id").all(CO, `job_proposal:${id}`) as Json[]
const latestFingerprint = (jobId: string) => (db.prepare('SELECT fingerprint FROM ai_job_versions WHERE company_id = ? AND job_id = ? ORDER BY version DESC LIMIT 1').get(CO, jobId) as Json).fingerprint
const versionDef = (jobId: string, v: number) => JSON.parse((db.prepare('SELECT definition FROM ai_job_versions WHERE company_id = ? AND job_id = ? AND version = ?').get(CO, jobId, v) as Json).definition)
const jobState = (jobId: string) => (db.prepare('SELECT state FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, jobId) as Json).state
const proposalState = (id: string) => (db.prepare('SELECT state FROM ai_job_proposals WHERE company_id = ? AND id = ?').get(CO, id) as Json).state
/** A fresh member each (the per-member limits count everything they ever submitted today). */
let fresh = 0
function newMember(): { companyId: string; userId: string; role: string } {
  const userId = `u-fresh-${++fresh}`
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${userId}`, userId, CO, 'member', TS, TS)
  return m(userId, 'member')
}

beforeAll(() => {
  initDatabase()
  for (const c of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(c, c, c, 'u-owner', TS, TS)
    db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${c}-root`, c, TS)
    db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'everyone', NULL, 1, 1, ?)").run(`${c}-root-r`, c, `${c}-root`, TS)
    db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(c, TS, 'u-owner')
  }
  const rule = (id: string, scope: string, subject: string | null, read: number, write: number) =>
    db.prepare(`INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, CO, scope, subject === null ? 'everyone' : 'user', subject, read, write, TS)
  // 秘書室: every member reads it but mallory. 経理部: a private folder only alice reads. 総務: mallory reads, cannot write.
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('jp-sec', ?, '秘書室', 'folder', ?)").run(CO, TS)
  rule('jp-sec-m', 'jp-sec', 'u-mallory', 0, 0)
  rule('jp-sec-e', 'jp-sec', null, 1, 1)
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('jp-priv', ?, '経理部', 'folder', 'jp-priv-repo', ?)").run(CO, TS)
  rule('jp-priv-e', 'jp-priv', null, 0, 0)
  rule('jp-priv-a', 'jp-priv', 'u-alice', 1, 1)
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('jp-gen', ?, '総務', 'folder', ?)").run(CO, TS)
  rule('jp-gen-m', 'jp-gen', 'u-mallory', 1, 0)
  rule('jp-gen-e', 'jp-gen', null, 1, 1)
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('jp-sales', ?, '営業部', 'folder', ?)").run(CO, TS)
  for (const [user, role] of [['u-owner', 'owner'], ['u-admin', 'admin'], ['u-admin2', 'admin'], ['u-alice', 'member'], ['u-bob', 'member'], ['u-mallory', 'member'], ['u-carol', 'member'], ['u-dave', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, TS, TS)
  }
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${OTHER}-u-alice`, 'u-alice', OTHER, 'member', TS, TS)
})

describe('a candidate: the member’s own, built by the server from list values only', () => {
  it('the responsible person is the member, the Skill pinned by the server, the name and the folder the server’s', async () => {
    const c = await candidate()
    expect(c.definition).toMatchObject({
      schema: 4, origin: 'member_proposal', actingUser: 'u-alice', name: 'weekly-minutes（毎週月曜 09:00）', placement: 'a',
      check: { kind: 'new_meetings', titleWords: [] },
      run: { kind: 'procedure', procedure: { source: 'company_skill', skill: 'weekly-minutes', fingerprint: 'a'.repeat(40) } },
      grant: { creates: ['task'], writes: { area: 'deliverable', place: '営業部/週報', folder: `job-${c.id.slice(3, 11)}` }, limits: { minutes: 15, runsPerDay: 1 } },
    })
    expect(c.definition.grant.routes).toContain(JOB_MINUTES_ROUTE)
    expect(c.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    // Never a job: no row, and not in any owner's / admin's list.
    expect(jobCount()).toBe(0)
    expect(ok(jobs.list(owner, READS4)).jobs).toEqual([])
    expect(ok(proposals.list(owner, undefined)).proposals).toEqual([])
  })

  it('no key names the responsible person, a name, a folder or title words: refused', async () => {
    for (const extra of [{ actingUser: 'u-bob' }, { name: '経理部の給与まとめ' }, { folder: 'secret-folder' }, { titleWords: ['極秘'] }]) {
      expect(await proposals.createCandidate(alice, null, { ...input(), ...extra })).toMatchObject({ ok: false, body: { code: 'BAD_JOB_CANDIDATE', problems: ['UNKNOWN_KEY'] } })
    }
    expect(await proposals.createCandidate(alice, null, input({ check: { kind: 'new_meetings', titleWords: ['極秘'] } }))).toMatchObject({ ok: false, body: { problems: ['check.BAD'] } })
    // A hidden folder is never a place (`.claude`, …): the listing never offers one, the input never takes one.
    expect(await proposals.createCandidate(alice, null, input({ reads: ['.claude'] }))).toMatchObject({ ok: false, body: { problems: ['reads.BAD'] } })
    expect(await proposals.createCandidate(alice, null, input({ deliverable: '営業部/.secret' }))).toMatchObject({ ok: false, body: { problems: ['deliverable.BAD'] } })
    expect(await proposals.createCandidate(alice, null, input({ check: { kind: 'new_files', path: '営業部/.git' } }))).toMatchObject({ ok: false, body: { problems: ['check.BAD'] } })
    // A trigger of another shape (an event) is not a time: the definition's own parser refuses it.
    expect(await proposals.createCandidate(alice, null, input({ trigger: { kind: 'record', type: 'task' } }))).toMatchObject({ ok: false, body: { code: 'BAD_JOB_CANDIDATE' } })
  })

  it('a Skill that is not there: 「先に Skill を作る」; a shelf Skill is read as the member', async () => {
    tree = null
    expect(await proposals.createCandidate(alice, null, input())).toMatchObject({ ok: false, body: { code: 'JOB_SKILL_MISSING' } })
    tree = 'a'.repeat(40)
    const shelf = proposalsWith({ folder: false })
    shelfCalls.length = 0
    const c = ok(await shelf.createCandidate(alice, null, input({ skill: 'shelf-1' })))
    expect(c.definition.run.procedure).toEqual({ source: 'shelf_skill', item: 'shelf-1', skill: 'shelf-skill', fingerprint: 'b'.repeat(64) })
    expect(shelfCalls).toEqual(['u-alice'])
    // Bob does not read its place: the same answer as a Skill that is not there.
    expect(await shelf.createCandidate(bob, null, input({ skill: 'shelf-1' }))).toMatchObject({ ok: false, body: { code: 'JOB_SKILL_MISSING' } })
  })

  it('a token bound to an execution run (a job’s run, an 「AI の番」) makes nothing and lists nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM ai_job_candidates').get()
    expect(await proposals.createCandidate(alice, { id: 'run-1', generation: 1 }, input())).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_NOT_IN_RUN' } })
    expect(await proposals.places(alice, { id: 'run-1', generation: 1 }, '')).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_NOT_IN_RUN' } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_job_candidates').get()).toEqual(before)
  })

  it('places: only existing folders the member reads, a private folder they do not read never named', async () => {
    expect(ok(await proposals.places(bob, null, '')).folders).toEqual([
      { path: '営業部', write: true }, { path: '秘書室', write: true }, { path: '総務', write: true }, { path: '議事録', write: true },
    ])
    expect(ok(await proposals.places(alice, null, '')).folders.map((f: Json) => f.path)).toContain('経理部')
    expect(ok(await proposals.places(mallory, null, '')).folders).toEqual([{ path: '営業部', write: true }, { path: '総務', write: false }, { path: '議事録', write: true }])
    expect(ok(await proposals.places(bob, null, '営業部')).folders).toEqual([{ path: '営業部/週報', write: true }])
    // Under an unreadable private folder and under nothing: the same answer.
    const hidden = await proposals.places(bob, null, '経理部')
    const none = await proposals.places(bob, null, 'ない部')
    expect(hidden).toMatchObject({ ok: false, body: { code: 'JOB_PLACE_NOT_FOUND' } })
    expect(hidden).toEqual(none)
  })

  it('a place that does not exist, one the member cannot read, a deliverable they cannot write: one answer, nothing kept', async () => {
    const answers = [
      await proposals.createCandidate(bob, null, input({ reads: ['経理部'] })),
      await proposals.createCandidate(bob, null, input({ reads: ['ない部'] })),
      await proposals.createCandidate(mallory, null, input({ reads: ['秘書室'] })),
      await proposals.createCandidate(mallory, null, input({ deliverable: '総務', reads: [] })),
      await proposals.createCandidate(bob, null, input({ deliverable: '経理部' })),
      await proposals.createCandidate(bob, null, input({ check: { kind: 'new_files', path: '経理部' } })),
    ]
    for (const a of answers) expect(a).toEqual(answers[0])
    expect(answers[0]).toMatchObject({ ok: false, body: { code: 'JOB_CANDIDATE_PLACE' } })
    expect(JSON.stringify(answers[0])).not.toContain('経理部')
    // The check's place is read too (it joins the reads).
    const c = await candidate(alice, { check: { kind: 'new_files', path: '経理部' }, reads: ['営業部'] })
    expect(c.definition.grant.reads.paths).toEqual(['営業部', '経理部'])
  })

  it('the member’s own: another member’s, another company’s and a missing one answer the same; read by the session', async () => {
    const c = await candidate()
    expect(ok(proposals.candidate(alice, c.id))).toMatchObject({ id: c.id, fingerprint: c.fingerprint, proposal: null })
    const missing = proposals.candidate(bob, `jc.${'0'.repeat(32)}`)
    expect(proposals.candidate(bob, c.id)).toEqual(missing)
    expect(proposals.candidate(m('u-alice', 'member', OTHER), c.id)).toEqual(missing)
    expect(await proposals.submit(bob, c.id, { fingerprint: c.fingerprint })).toEqual(await proposals.submit(bob, `jc.${'0'.repeat(32)}`, { fingerprint: c.fingerprint }))
    expect(await proposals.submit(m('u-alice', 'member', OTHER), c.id, { fingerprint: c.fingerprint })).toMatchObject({ ok: false, body: { code: 'JOB_CANDIDATE_NOT_FOUND' } })
  })

  it('read again when read: a place (or the shelf Skill’s place) no longer theirs withholds it; the submit is refused', async () => {
    const c = await candidate(alice, { reads: ['経理部'] })
    db.prepare("UPDATE scope_rules SET can_read = 0, can_write = 0 WHERE id = 'jp-priv-a'").run()
    try {
      const got = proposals.candidate(alice, c.id)
      expect(got).toEqual(proposals.candidate(alice, `jc.${'0'.repeat(32)}`))
      expect(JSON.stringify(got)).not.toContain(c.fingerprint)
      expect(JSON.stringify(got)).not.toContain('経理部')
      expect(await proposals.submit(alice, c.id, { fingerprint: c.fingerprint })).toMatchObject({ ok: false, body: { code: 'JOB_CANDIDATE_PLACE' } })
    } finally {
      db.prepare("UPDATE scope_rules SET can_read = 1, can_write = 1 WHERE id = 'jp-priv-a'").run()
    }
    expect(ok(proposals.candidate(alice, c.id)).fingerprint).toBe(c.fingerprint)
    // Not submitted yet: lost access answers the same refusal for the right fingerprint and for a guess (no oracle).
    db.prepare("UPDATE scope_rules SET can_read = 0, can_write = 0 WHERE id = 'jp-priv-a'").run()
    try {
      const right = await proposals.submit(alice, c.id, { fingerprint: c.fingerprint })
      expect(right).toMatchObject({ ok: false, body: { code: 'JOB_CANDIDATE_PLACE' } })
      expect(await proposals.submit(alice, c.id, { fingerprint: `sha256:${'0'.repeat(64)}` })).toEqual(right)
    } finally {
      db.prepare("UPDATE scope_rules SET can_read = 1, can_write = 1 WHERE id = 'jp-priv-a'").run()
    }
    // A shelf Skill whose place she no longer reads.
    const s = ok(await proposalsWith({ folder: false }).createCandidate(alice, null, input({ skill: 'shelf-1' })))
    shelfHidden = true
    try {
      expect(proposals.candidate(alice, s.id)).toMatchObject({ ok: false, body: { code: 'JOB_CANDIDATE_NOT_FOUND' } })
      const shelfProposals = proposalsWith({ folder: false })
      const right = await shelfProposals.submit(alice, s.id, { fingerprint: s.fingerprint })
      expect(right).toMatchObject({ ok: false })
      expect(await shelfProposals.submit(alice, s.id, { fingerprint: `sha256:${'0'.repeat(64)}` })).toEqual(right)
    } finally { shelfHidden = false }
    expect(ok(proposals.candidate(alice, s.id)).id).toBe(s.id)
  })

  it('at most 20 kept a member; after 24 hours a candidate is gone', async () => {
    const who = newMember()
    for (let i = 0; i < 20; i++) await candidate(who)
    expect(await proposals.createCandidate(who, null, input())).toMatchObject({ ok: false, body: { code: 'JOB_CANDIDATES_LIMIT' } })
    const old = (db.prepare('SELECT id FROM ai_job_candidates WHERE company_id = ? AND created_by = ? LIMIT 1').get(CO, who.userId) as Json).id
    shift = 25 * HOUR
    try {
      // Past its time it is gone for its creator, before anything deletes its row.
      expect(proposals.candidate(who, old)).toMatchObject({ ok: false, body: { code: 'JOB_CANDIDATE_NOT_FOUND' } })
      const c = await candidate(who)
      expect(db.prepare('SELECT COUNT(*) AS n FROM ai_job_candidates WHERE company_id = ? AND created_by = ?').get(CO, who.userId)).toEqual({ n: 1 })
      expect(ok(proposals.candidate(who, c.id)).id).toBe(c.id)
    } finally { shift = 0 }
  })
})

describe('the submit: the candidate as stored, by its id and the fingerprint shown', () => {
  it('makes the draft job (schema 4, by the member), its proposal and one notice per owner / admin; a repeat adds nothing', async () => {
    pushed.length = 0
    const c = await candidate()
    const r = ok(await proposals.submit(alice, c.id, { fingerprint: c.fingerprint }))
    expect(r.created).toBe(true)
    expect(r.proposal).toMatchObject({ proposerId: 'u-alice', candidateId: c.id, submittedVersion: 1, submittedFingerprint: c.fingerprint, state: 'submitted' })
    const job = ok(jobs.get(owner, r.proposal.jobId, READS4))
    expect(job).toMatchObject({ state: 'draft', createdBy: 'u-alice', actingUserId: 'u-alice', latestVersion: 1, approvedVersion: null, proposal: { id: r.proposal.id, proposerId: 'u-alice', submittedVersion: 1, state: 'submitted' } })
    expect(job.versions?.[0]).toMatchObject({ fingerprint: c.fingerprint, definition: c.definition })
    expect(proposalNotices(r.proposal.id).map(n => n.user_id)).toEqual(['u-admin', 'u-admin2', 'u-owner'])
    expect(new Set(proposalNotices(r.proposal.id).map(n => n.id)).size).toBe(3)
    expect(pushed.map(u => [...u].sort())).toEqual([['u-admin', 'u-admin2', 'u-owner']])
    const again = ok(await proposals.submit(alice, c.id, { fingerprint: c.fingerprint }))
    expect(again).toEqual({ proposal: r.proposal, created: false })
    // The first result is answered only for the fingerprint it was submitted with.
    expect(await proposals.submit(alice, c.id, { fingerprint: `sha256:${'0'.repeat(64)}` })).toMatchObject({ ok: false, body: { code: 'JOB_VERSION_FINGERPRINT' } })
    expect(proposalNotices(r.proposal.id)).toHaveLength(3)
    expect(pushed).toHaveLength(1)
    expect(ok(proposals.candidate(alice, c.id)).proposal).toEqual(r.proposal)
  })

  it('the same candidate submitted twice at once: one job, one proposal, the second answered with the first', async () => {
    const c = await candidate(dave)
    pushed.length = 0
    const [a, b] = await Promise.all([proposals.submit(dave, c.id, { fingerprint: c.fingerprint }), proposals.submit(dave, c.id, { fingerprint: c.fingerprint })])
    expect([ok(a).created, ok(b).created].sort()).toEqual([false, true])
    expect(ok(a).proposal.id).toBe(ok(b).proposal.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_job_proposals WHERE company_id = ? AND candidate_id = ?').get(CO, c.id)).toEqual({ n: 1 })
    expect(proposalNotices(ok(a).proposal.id)).toHaveLength(3)
    // The owners / admins are signalled once (the second submit made nothing).
    expect(pushed).toHaveLength(1)
  })

  it('a submitted version’s fingerprint only while the proposer reads what it names (owners / admins always); no guess confirmed', async () => {
    const { c, p } = await submitted(alice, { reads: ['経理部'] })
    const mineOf = () => ok(proposals.mine(alice)).proposals.find((x: Json) => x.id === p.id)
    expect(mineOf().submittedFingerprint).toBe(c.fingerprint)
    db.prepare("UPDATE scope_rules SET can_read = 0, can_write = 0 WHERE id = 'jp-priv-a'").run()
    try {
      expect(mineOf().submittedFingerprint).toBeNull()
      expect(ok(proposals.list(admin, undefined)).proposals.find((x: Json) => x.id === p.id).submittedFingerprint).toBe(c.fingerprint)
      // A resend with the right fingerprint and with a guess: the same refusal, nothing told.
      const right = await proposals.submit(alice, c.id, { fingerprint: c.fingerprint })
      const guess = await proposals.submit(alice, c.id, { fingerprint: `sha256:${'0'.repeat(64)}` })
      expect(right).toMatchObject({ ok: false, body: { code: 'JOB_CANDIDATE_PLACE' } })
      expect(guess).toEqual(right)
      expect(JSON.stringify(ok(proposals.withdraw(alice, p.id)))).not.toContain(c.fingerprint)
    } finally {
      db.prepare("UPDATE scope_rules SET can_read = 1, can_write = 1 WHERE id = 'jp-priv-a'").run()
    }
    expect(mineOf().submittedFingerprint).toBe(c.fingerprint)
  })

  it('an owner / admin proposing: the others are told, never themself', async () => {
    const { p } = await submitted(admin)
    expect(proposalNotices(p.id).map(n => n.user_id)).toEqual(['u-admin2', 'u-owner'])
  })

  it('an old fingerprint is refused, nothing made', async () => {
    const c = await candidate()
    const before = jobCount()
    expect(await proposals.submit(alice, c.id, { fingerprint: `sha256:${'0'.repeat(64)}` })).toMatchObject({ ok: false, body: { code: 'JOB_VERSION_FINGERPRINT' } })
    expect(await proposals.submit(alice, c.id, { fingerprint: c.fingerprint, extra: 1 })).toMatchObject({ ok: false, body: { code: 'BAD_REQUEST' } })
    expect(jobCount()).toBe(before)
  })

  it('never resolved again: a Skill changed since refuses it (a new candidate), rights lost meanwhile refuse it inside the write', async () => {
    const c = await candidate()
    tree = 'c'.repeat(40)
    expect(await proposals.submit(alice, c.id, { fingerprint: c.fingerprint })).toMatchObject({ ok: false, body: { code: 'JOB_SKILL_CHANGED' } })
    tree = 'a'.repeat(40)
    // Her right to read 営業部 taken away while the Skill is read (the rights were fine before).
    const before = jobCount()
    between = () => {
      db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('jp-sales-a', ?, 'jp-sales', 'user', 'u-alice', 0, 0, ?)").run(CO, TS)
    }
    try {
      expect(await proposals.submit(alice, c.id, { fingerprint: c.fingerprint })).toMatchObject({ ok: false, body: { code: 'JOB_GRANT_EXCEEDS' } })
      expect(jobCount()).toBe(before)
      // Before the submit: the places check refuses it with its one answer.
      expect(await proposals.submit(alice, c.id, { fingerprint: c.fingerprint })).toMatchObject({ ok: false, body: { code: 'JOB_CANDIDATE_PLACE' } })
    } finally {
      db.prepare("DELETE FROM scope_rules WHERE id = 'jp-sales-a'").run()
    }
    expect(ok(await proposals.submit(alice, c.id, { fingerprint: c.fingerprint })).created).toBe(true)
  })

  it('six at once: five waiting, the sixth refused; a withdrawal frees a place', async () => {
    const who = newMember()
    const cs = await Promise.all(Array.from({ length: 6 }, () => candidate(who)))
    const results = await Promise.all(cs.map(c => proposals.submit(who, c.id, { fingerprint: c.fingerprint })))
    expect(results.filter(r => r.ok)).toHaveLength(5)
    expect(results.filter(r => !r.ok)).toEqual([expect.objectContaining({ body: expect.objectContaining({ code: 'JOB_PROPOSALS_WAITING_LIMIT' }) })])
    const refused = cs[results.findIndex(r => !r.ok)]
    const first = results.find(r => r.ok) as Json
    ok(proposals.withdraw(who, first.value.proposal.id))
    expect(ok(await proposals.submit(who, refused.id, { fingerprint: refused.fingerprint })).created).toBe(true)
  })

  it('ten a company day, withdrawals counted too; the next day again', async () => {
    const who = newMember()
    for (let i = 0; i < 10; i++) {
      const { p } = await submitted(who)
      ok(proposals.withdraw(who, p.id))
    }
    const c = await candidate(who)
    expect(await proposals.submit(who, c.id, { fingerprint: c.fingerprint })).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSALS_DAY_LIMIT' } })
    shift = 24 * HOUR
    try {
      const next = await candidate(who)
      expect(ok(await proposals.submit(who, next.id, { fingerprint: next.fingerprint })).created).toBe(true)
    } finally { shift = 0 }
  })

  it('a resend after the content’s 24 hours answers the first result and adds nothing', async () => {
    const { c, p } = await submitted(carol)
    const before = { jobs: jobCount(), notices: proposalNotices(p.id).length, proposals: db.prepare('SELECT COUNT(*) AS n FROM ai_job_proposals').get() }
    shift = 25 * HOUR
    try {
      await candidate(dave) // the content of every expired candidate goes
      expect(db.prepare('SELECT COUNT(*) AS n FROM ai_job_candidates WHERE id = ?').get(c.id)).toEqual({ n: 0 })
      expect(ok(await proposals.submit(carol, c.id, { fingerprint: c.fingerprint }))).toEqual({ proposal: p, created: false })
      expect({ jobs: jobCount(), notices: proposalNotices(p.id).length, proposals: db.prepare('SELECT COUNT(*) AS n FROM ai_job_proposals').get() }).toEqual(before)
    } finally { shift = 0 }
  })
})

describe('approve, withdraw, return: one wins, only from submitted', () => {
  it('the three at once: exactly one wins, the others are told it is decided', async () => {
    const { p } = await submitted(bob)
    const fp = latestFingerprint(p.jobId)
    const [approved, withdrawn, returned] = await Promise.all([
      jobs.approve(owner, p.jobId, { version: 1, fingerprint: fp }, READS4),
      Promise.resolve(proposals.withdraw(bob, p.id)),
      Promise.resolve(proposals.returnProposal(admin, p.id, { reason: 'TOO_BROAD' })),
    ])
    expect([approved, withdrawn, returned].filter(r => r.ok)).toHaveLength(1)
    expect(withdrawn.ok).toBe(true)
    expect(approved).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_CLOSED' } })
    expect(returned).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_DECIDED', state: 'withdrawn' } })
    expect(proposalState(p.id)).toBe('withdrawn')
    expect(db.prepare('SELECT approved_version FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, p.jobId)).toEqual({ approved_version: null })
  })

  it('a return while the approval reads the Skill: the return wins', async () => {
    const { p } = await submitted(bob)
    const fp = latestFingerprint(p.jobId)
    between = () => { ok(proposals.returnProposal(admin, p.id, { reason: 'TALK_FIRST' })) }
    expect(await jobs.approve(owner, p.jobId, { version: 1, fingerprint: fp }, READS4)).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_CLOSED' } })
    expect(db.prepare('SELECT state, return_reason, decided_by FROM ai_job_proposals WHERE company_id = ? AND id = ?').get(CO, p.id)).toEqual({ state: 'returned', return_reason: 'TALK_FIRST', decided_by: 'u-admin' })
    expect(jobState(p.jobId)).toBe('retired')
  })

  it('approved first: no withdrawal or return after it; approving never accepts', async () => {
    const { p } = await submitted(bob)
    const view = ok(await jobs.approve(owner, p.jobId, { version: 1, fingerprint: latestFingerprint(p.jobId) }, READS4))
    expect(view).toMatchObject({ state: 'active', approvedVersion: 1, accepted: false, waiting: 'NOT_ACCEPTED', proposal: { state: 'approved' } })
    expect(proposals.withdraw(bob, p.id)).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_DECIDED', state: 'approved' } })
    expect(proposals.returnProposal(admin, p.id, { reason: 'OTHER' })).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_DECIDED' } })
    // The proposer is asked to accept (the acceptance notice), and accepts by a press of her own.
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND user_id = 'u-bob' AND kind = 'job_accept_needed'").get(CO)).toEqual({ n: 1 })
    expect(ok(await jobs.accept(bob, p.jobId, { version: 1, fingerprint: latestFingerprint(p.jobId) }, READS4, true))).toMatchObject({ accepted: true, waiting: null })
  })

  it('who: withdraw is the proposer’s (anyone else, another company: the one 404); return an owner / admin’s, a fixed reason only', async () => {
    const { p } = await submitted(bob)
    const missing = proposals.withdraw(alice, `jp.${'0'.repeat(32)}`)
    expect(proposals.withdraw(alice, p.id)).toEqual(missing)
    expect(proposals.withdraw(owner, p.id)).toEqual(missing)
    expect(proposals.withdraw(m('u-bob', 'member', OTHER), p.id)).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_NOT_FOUND' } })
    expect(proposals.returnProposal(alice, p.id, { reason: 'OTHER' })).toMatchObject({ ok: false, body: { error: 'Only owners and admins can manage scheduled jobs' } })
    expect(proposals.returnProposal(admin, p.id, { reason: '経理部の件なので' })).toMatchObject({ ok: false, body: { code: 'BAD_REQUEST' } })
    expect(proposals.returnProposal(admin, p.id, { reason: 'OTHER', note: 'x' })).toMatchObject({ ok: false, body: { code: 'BAD_REQUEST' } })
    expect(proposals.returnProposal(m('u-owner', 'owner', OTHER), p.id, { reason: 'OTHER' })).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_NOT_FOUND' } })
    expect(proposalState(p.id)).toBe('submitted')
    expect(proposals.list(alice, undefined)).toMatchObject({ ok: false })
    expect(ok(proposals.list(admin, 'submitted')).proposals.map((x: Json) => x.id)).toContain(p.id)
    expect(ok(proposals.mine(bob)).proposals.map((x: Json) => x.id)).toContain(p.id)
    expect(ok(proposals.mine(alice)).proposals.map((x: Json) => x.id)).not.toContain(p.id)
  })
})

describe('the job of a proposal: schema 4 for good, only the newest version, never once withdrawn or returned', () => {
  const edit = (jobId: string, base: number | undefined, change: (d: Json) => Json, reads = READS4) => {
    const d = change(versionDef(jobId, base ?? 1))
    return jobs.update(owner, jobId, base === undefined ? { definition: d } : { definition: d, baseVersion: base }, reads)
  }

  it('an old admin tab (announcing 1,2,3) neither approves nor edits it', async () => {
    const { p } = await submitted(bob)
    expect(await jobs.approve(owner, p.jobId, { version: 1, fingerprint: latestFingerprint(p.jobId) }, OLD_TAB)).toMatchObject({ ok: false, body: { code: 'JOB_NEEDS_NEWER_SCREEN' } })
    expect(await edit(p.jobId, 1, d => ({ ...d, name: '直した名前' }), OLD_TAB)).toMatchObject({ ok: false, body: { code: 'JOB_NEEDS_NEWER_SCREEN' } })
    // Its list shows the job without the definition (a shape it cannot show).
    const listed = ok(jobs.list(owner, OLD_TAB)).jobs.find(j => j.id === p.jobId)
    expect(listed).toMatchObject({ needsUpdate: true })
    expect(proposalState(p.id)).toBe('submitted')
  })

  it('approval needs the newest version and its fingerprint; an edit names its base; schema 4 stays 4', async () => {
    const { p } = await submitted(bob)
    expect(await jobs.approve(owner, p.jobId, { version: 1 }, READS4)).toMatchObject({ ok: false, body: { code: 'BAD_REQUEST' } })
    expect(await edit(p.jobId, undefined, d => ({ ...d, name: '直した名前' }))).toMatchObject({ ok: false, body: { code: 'BAD_REQUEST' } })
    expect(await edit(p.jobId, 1, d => { const rest = { ...d, schema: 1 }; delete rest.origin; return rest })).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_SCHEMA' } })
    expect(ok(await edit(p.jobId, 1, d => ({ ...d, check: { kind: 'new_meetings', titleWords: ['週報'] } })))).toMatchObject({ latestVersion: 2, changed: true })
    // A tab that still shows version 1: its edit and its approval of version 1 are refused.
    expect(await edit(p.jobId, 1, d => ({ ...d, name: '古い画面から' }))).toMatchObject({ ok: false, body: { code: 'JOB_VERSION_NOT_LATEST' } })
    expect(await jobs.approve(owner, p.jobId, { version: 1, fingerprint: versionFp(p.jobId, 1) }, READS4)).toMatchObject({ ok: false, body: { code: 'JOB_VERSION_NOT_LATEST' } })
    // The first approval (of the admin's version): the proposal approved.
    ok(await jobs.approve(owner, p.jobId, { version: 2, fingerprint: latestFingerprint(p.jobId) }, READS4))
    expect(proposalState(p.id)).toBe('approved')
    // A newer version made while an approval reads the Skill: the approval is refused inside the write.
    between = () => {
      const d = { ...versionDef(p.jobId, 2), name: '承認の最中に直した' }
      companyData.forCompany(CO).jobs.addVersion(versionRow(p.jobId, 3, d, canonicalJson(d), 'u-admin', clock.now()), clock.now())
    }
    expect(await jobs.approve(owner, p.jobId, { version: 2, fingerprint: versionFp(p.jobId, 2) }, READS4)).toMatchObject({ ok: false, body: { code: 'JOB_VERSION_NOT_LATEST' } })
    // A later version: ordinary approval of the newest, with its fingerprint.
    ok(await edit(p.jobId, 3, d => ({ ...d, name: 'さらに直した' })))
    expect(await jobs.approve(owner, p.jobId, { version: 4, fingerprint: `sha256:${'0'.repeat(64)}` }, READS4)).toMatchObject({ ok: false, body: { code: 'JOB_VERSION_FINGERPRINT' } })
    expect(ok(await jobs.approve(owner, p.jobId, { version: 4, fingerprint: latestFingerprint(p.jobId) }, READS4))).toMatchObject({ approvedVersion: 4, proposal: { state: 'approved', submittedVersion: 1 } })
    // A newer version made while this edit reads the Skill: refused inside the write.
    between = () => {
      const d = { ...versionDef(p.jobId, 4), name: '先に直した' }
      companyData.forCompany(CO).jobs.addVersion(versionRow(p.jobId, 5, d, canonicalJson(d), 'u-admin', clock.now()), clock.now())
    }
    expect(await edit(p.jobId, 4, d => ({ ...d, name: '同時に直した' }))).toMatchObject({ ok: false, body: { code: 'JOB_VERSION_NOT_LATEST' } })
    expect(db.prepare('SELECT latest_version FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, p.jobId)).toEqual({ latest_version: 5 })
  })

  it('its responsible person stays the proposer: an edit naming someone else is refused, nothing added', async () => {
    const who = newMember()
    const { p } = await submitted(who)
    expect(await edit(p.jobId, 1, d => ({ ...d, actingUser: 'u-alice' }))).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_RESPONSIBLE_FIXED' } })
    // Also after its first approval (a later version), and also when the edit names an owner / admin.
    ok(await jobs.approve(owner, p.jobId, { version: 1, fingerprint: latestFingerprint(p.jobId) }, READS4))
    expect(await edit(p.jobId, 1, d => ({ ...d, actingUser: 'u-admin' }))).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_RESPONSIBLE_FIXED', error: expect.stringContaining('新しく定期の仕事を作ってください') } })
    expect(db.prepare('SELECT latest_version, acting_user_id FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, p.jobId)).toEqual({ latest_version: 1, acting_user_id: who.userId })
    // Any other change of it is an ordinary edit.
    expect(ok(await edit(p.jobId, 1, d => ({ ...d, name: '名前だけ直した' })))).toMatchObject({ latestVersion: 2, actingUserId: who.userId })
  })

  it('no other job becomes schema 4, and an admin never makes one', async () => {
    const { c } = await submitted(bob)
    expect(await jobs.create(owner, { definition: { ...c.definition } }, READS4)).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_ONLY' } })
    const plain = { ...c.definition, schema: 1 }
    delete plain.origin
    const made = ok(await jobs.create(owner, { definition: plain }, READS4))
    expect(await jobs.update(owner, made.id, { definition: { ...c.definition, name: '案のふり' } }, READS4)).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_SCHEMA' } })
  })

  it('withdrawn or returned: never edited or approved, also by an edit or an approval already under way', async () => {
    const { p } = await submitted(bob)
    ok(proposals.withdraw(bob, p.id))
    expect(jobState(p.jobId)).toBe('retired')
    expect(await edit(p.jobId, 1, d => ({ ...d, name: '取り下げのあと' }))).toMatchObject({ ok: false })
    expect(await jobs.approve(owner, p.jobId, { version: 1, fingerprint: latestFingerprint(p.jobId) }, READS4)).toMatchObject({ ok: false })
    expect(db.prepare('SELECT latest_version, approved_version FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, p.jobId)).toEqual({ latest_version: 1, approved_version: null })
    // An edit whose Skill read is under way when the proposal is returned.
    const q = (await submitted(bob)).p
    between = () => { ok(proposals.returnProposal(admin, q.id, { reason: 'NOT_NEEDED' })) }
    expect(await edit(q.jobId, 1, d => ({ ...d, name: '差し戻しの最中' }))).toMatchObject({ ok: false, body: { code: 'JOB_PROPOSAL_CLOSED' } })
    expect(db.prepare('SELECT latest_version FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, q.jobId)).toEqual({ latest_version: 1 })
  })
})

describe('the proposer’s notice of a return', () => {
  const returned = () => db.prepare("SELECT id, user_id, dedupe_key FROM notifications WHERE company_id = ? AND kind = 'job_proposal_returned'").all(CO) as Json[]
  it('to the proposer alone, once per proposal, in fixed words with the fixed reason; nothing for a withdrawal', async () => {
    const { p } = await submitted(carol)
    const before = returned().length
    pushed.length = 0
    ok(proposals.returnProposal(admin, p.id, { reason: 'SKILL_NOT_READY' }))
    expect(returned().filter(n => n.dedupe_key === `job_proposal_returned:${p.id}`).map(n => n.user_id)).toEqual(['u-carol'])
    expect(pushed).toEqual([['u-carol']])
    // A second return is refused and writes nothing more.
    expect(proposals.returnProposal(admin2, p.id, { reason: 'OTHER' })).toMatchObject({ ok: false })
    expect(returned()).toHaveLength(before + 1)
    const items = (who: Json) => (ok(services.notifications.list(who)) as Json).items.filter((i: Json) => i.kind === 'job_proposal_returned')
    expect(items(carol)).toEqual([expect.objectContaining({ read: false, text: '出した定期の仕事の案「weekly-minutes（毎週月曜 09:00）」は差し戻されました（理由：先に Skill を直したい）。必要なら、AI にもう一度頼んでください' })])
    // Anyone else holding such a row (it is never written to them) sees nothing.
    db.prepare(`INSERT INTO notifications (company_id, id, user_id, kind, record_id, record_version, action, actor_id, actor_kind, dedupe_key, created_at, read_at)
      VALUES (?, 'n-forged-returned', 'u-dave', 'job_proposal_returned', '', 0, '', 'u-admin', 'human', ?, ?, NULL)`).run(CO, `job_proposal_returned:${p.id}`, TS)
    expect(items(dave)).toEqual([])
    // A withdrawal tells nobody.
    const w = (await submitted(carol)).p
    ok(proposals.withdraw(carol, w.id))
    expect(returned().filter(n => n.dedupe_key === `job_proposal_returned:${w.id}`)).toEqual([])
    // A row naming a proposal that was not returned shows nothing, also to its proposer.
    db.prepare(`INSERT INTO notifications (company_id, id, user_id, kind, record_id, record_version, action, actor_id, actor_kind, dedupe_key, created_at, read_at)
      VALUES (?, 'n-forged-withdrawn', 'u-carol', 'job_proposal_returned', '', 0, '', 'u-admin', 'human', ?, ?, NULL)`).run(CO, `job_proposal_returned:${w.id}`, TS)
    expect(items(carol)).toHaveLength(1)
  })
})

describe('the owners’ and admins’ notice', () => {
  it('each owner / admin has their own, read on their own; built when read, with no free text; gone once decided', async () => {
    const { p } = await submitted(bob)
    const before = proposalNotices(p.id)
    expect(before.map(n => n.user_id)).toEqual(['u-admin', 'u-admin2', 'u-owner'])
    const items = (who: Json) => (ok(services.notifications.list(who)) as Json).items.filter((i: Json) => i.kind === 'job_proposal' && i.id === proposalNotices(p.id).find(n => n.user_id === who.userId)?.id)
    expect(items(admin)).toEqual([expect.objectContaining({ read: false, text: expect.stringContaining('定期の仕事の案「weekly-minutes（毎週月曜 09:00）」が届いています') })])
    ok(services.notifications.markRead(admin, { ids: [before.find(n => n.user_id === 'u-admin').id] }))
    expect(items(admin)).toEqual([expect.objectContaining({ read: true })])
    expect(items(admin2)).toEqual([expect.objectContaining({ read: false })])
    // Nobody else is written one; an admin who became a member no longer sees theirs.
    expect((ok(services.notifications.list(bob)) as Json).items.filter((i: Json) => i.kind === 'job_proposal')).toEqual([])
    db.prepare("UPDATE memberships SET role = 'member' WHERE company_id = ? AND user_id = 'u-admin2'").run(CO)
    try {
      expect(items(m('u-admin2', 'member'))).toEqual([])
    } finally {
      db.prepare("UPDATE memberships SET role = 'admin' WHERE company_id = ? AND user_id = 'u-admin2'").run(CO)
    }
    ok(proposals.returnProposal(admin, p.id, { reason: 'OTHER' }))
    expect(items(admin2)).toEqual([])
  })
})

// The routes with the server's own wiring: a company without the shared folder (its Skill from the shelf).
describe('the routes: the AI’s token makes a candidate, never a run’s; the session submits', () => {
  const app = new Hono()
  app.route('/api/companies', companiesRoute)
  app.route('/api/companies/:companyId', recordsRoute)
  app.route('/api/companies/:companyId', aiRunsRoute)
  app.route('/api/companies/:companyId', jobsRoute)
  app.route('/api/companies/:companyId', jobProposalsRoute)
  app.route('/api/records-ai/job-proposals-ai', jobProposalsAiRoute)
  app.route('/api/records-ai', recordsAiRoute)
  async function call(opts: { user?: string | null; token?: string; method: string; path: string; body?: unknown }) {
    currentUser.id = opts.user ?? null
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    const res = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) as Json }
  }

  it('a consultation’s token makes one; a job run’s token is refused; a record token never submits', async () => {
    process.env.OPERATOR_USER_IDS = 'jq-owner'
    const made = await call({ user: 'jq-owner', method: 'POST', path: '/api/companies', body: { name: 'Proposal Routes Co', folderKind: 'none' } })
    expect(made.status).toBe(201)
    const co: string = made.body.data.id
    const at = new Date().toISOString()
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-jq-alice`, 'jq-alice', co, 'member', at, at)
    const own = { companyId: co, userId: 'jq-owner', role: 'owner' }
    const al = { companyId: co, userId: 'jq-alice', role: 'member' }
    const as = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `/api/companies/${co}${path}`, body })
    const item = ok(services.skillShelf.publish(own, { kind: 'skill', departmentId: null, name: 'weekly-minutes', files: [{ path: 'SKILL.md', base64: Buffer.from('# 週報\nまとめる。').toString('base64') }], expectedVersion: null })).item.id
    const tokenOf = async (run?: Json) => {
      const r = await as('jq-alice', 'POST', '/me/record-tokens', { conversationId: 'conv-jq', agent: 'claude-code', scope: 'act', ...(run ? { run: { id: run.id, generation: run.generation } } : {}) })
      expect([200, 201]).toContain(r.status)
      return r.body.data.token as string
    }
    const body = input({ skill: item, reads: [], deliverable: null })
    const consultation = await tokenOf()
    expect((await call({ token: consultation, method: 'GET', path: '/api/records-ai/job-proposals-ai/places' })).status).toBe(200)
    const created = await call({ token: consultation, method: 'POST', path: '/api/records-ai/job-proposals-ai/candidates', body })
    expect(created.status).toBe(201)
    expect(created.body.data.definition).toMatchObject({ actingUser: 'jq-alice', run: { procedure: { source: 'shelf_skill', item, skill: 'weekly-minutes' } } })

    // Without the shared folder a place exists only as a department or a place set up inside one — never text below one.
    const placed = (reads: string[]) => call({ token: consultation, method: 'POST', path: '/api/records-ai/job-proposals-ai/candidates', body: input({ skill: item, reads, deliverable: null }) })
    expect(await placed(['人事部/でっちあげの評価メモ'])).toMatchObject({ status: 409, body: { code: 'JOB_CANDIDATE_PLACE' } })
    expect(await placed(['人事部/面談'])).toMatchObject({ status: 409, body: { code: 'JOB_CANDIDATE_PLACE' } })
    expect((await placed(['人事部'])).status).toBe(201)
    db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('jq-interviews', ?, '人事部/面談', 'folder', ?)").run(co, at)
    db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('jq-interviews-e', ?, 'jq-interviews', 'everyone', NULL, 1, 1, ?)").run(co, at)
    expect((await call({ token: consultation, method: 'GET', path: `/api/records-ai/job-proposals-ai/places?under=${encodeURIComponent('人事部')}` })).body.data.folders).toEqual([{ path: '人事部/面談', write: true }])
    expect((await placed(['人事部/面談'])).status).toBe(201)

    // A job's run token (alice's PC job, claimed): refused, nothing kept.
    const pc = {
      schema: 1, name: '週報', actingUser: 'jq-alice', trigger: { every: 'day', at: '09:00', businessDaysOnly: false }, check: { kind: 'new_meetings', titleWords: [] },
      run: { kind: 'procedure', procedure: { source: 'shelf_skill', item } }, placement: 'a', missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
      grant: { tools: ['records'], creates: ['task'], routes: [JOB_MINUTES_ROUTE, 'GET /job-proposals-ai/places', 'POST /job-proposals-ai/candidates'], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 } },
    }
    const jobId = ok(await services.jobs.create(own, { definition: pc })).id
    ok(await services.jobs.approve(own, jobId, { version: 1 }))
    ok(await services.jobs.accept(al, jobId, { version: 1 }, undefined, true))
    const occ = `occ.${'f'.repeat(32)}`
    db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, created_at, updated_at)
      VALUES (?, ?, ?, 1, '2026-11-20T09:00', 'Asia/Tokyo', ?, ?, 'due', ?, ?)`).run(co, occ, jobId, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + HOUR).toISOString(), at, at)
    const claimed = await as('jq-alice', 'POST', '/job-run-claims', { occurrenceId: occ, deviceId: 'device-jq', conversationId: 'conv-jq', checks: ['new_files', 'new_meetings'] })
    expect(claimed.status).toBe(201)
    const runToken = await tokenOf(claimed.body.data.run)
    const before = db.prepare('SELECT COUNT(*) AS n FROM ai_job_candidates WHERE company_id = ?').get(co)
    expect((await call({ token: runToken, method: 'POST', path: '/api/records-ai/job-proposals-ai/candidates', body })).status).toBe(403)
    expect((await call({ token: runToken, method: 'GET', path: '/api/records-ai/job-proposals-ai/places' })).status).toBe(403)
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_job_candidates WHERE company_id = ?').get(co)).toEqual(before)

    // A token bound to a record's 「AI の番」 run claimed by an older app (no build: the step's route scope does not apply, as for
    // a business plugin's step) — only the service's own check stands: refused, nothing kept.
    expect((await as('jq-owner', 'PUT', '/records/settings', { enabled: true })).status).toBe(200)
    const task = await as('jq-alice', 'POST', '/records/item', { type: 'task', title: '下ごしらえ', state: 'preparing', fields: { assignee: 'jq-alice' } })
    expect(task.status).toBe(201)
    const turn = await as('jq-alice', 'POST', '/ai-run-claims', { recordId: task.body.data.record.id, step: 'task-prep', deviceId: 'device-jq-2', conversationId: 'conv-jq-2' })
    expect(turn.status).toBe(201)
    const turnToken = (await as('jq-alice', 'POST', '/me/record-tokens', { conversationId: turn.body.data.run.conversationId, agent: 'claude-code', scope: 'act', run: { id: turn.body.data.run.id, generation: turn.body.data.run.generation } })).body.data.token as string
    expect(await call({ token: turnToken, method: 'POST', path: '/api/records-ai/job-proposals-ai/candidates', body })).toMatchObject({ status: 403, body: { code: 'JOB_PROPOSAL_NOT_IN_RUN' } })
    expect(await call({ token: turnToken, method: 'GET', path: '/api/records-ai/job-proposals-ai/places' })).toMatchObject({ status: 403, body: { code: 'JOB_PROPOSAL_NOT_IN_RUN' } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_job_candidates WHERE company_id = ?').get(co)).toEqual(before)

    // The submit is the session's: a record token alone is not signed in.
    const submitPath = `/api/companies/${co}/me/job-candidates/${created.body.data.id}/submit`
    expect((await call({ token: consultation, method: 'POST', path: submitPath, body: { fingerprint: created.body.data.fingerprint } })).status).toBe(401)
    const submittedR = await as('jq-alice', 'POST', `/me/job-candidates/${created.body.data.id}/submit`, { fingerprint: created.body.data.fingerprint })
    expect(submittedR.status).toBe(201)
    expect((await as('jq-alice', 'POST', `/me/job-candidates/${created.body.data.id}/submit`, { fingerprint: created.body.data.fingerprint })).status).toBe(200)
    expect((await as('jq-owner', 'GET', '/job-proposals?state=submitted')).body.data.proposals.map((x: Json) => x.id)).toEqual([submittedR.body.data.proposal.id])
    expect((await as('jq-owner', 'POST', `/job-proposals/${submittedR.body.data.proposal.id}/return`, { reason: 'NOT_NEEDED' })).status).toBe(200)

    // A member who leaves: their waiting proposals are withdrawn and their jobs retired (nobody could approve or accept them).
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-jq-leaver`, 'jq-leaver', co, 'member', at, at)
    const leaver = { companyId: co, userId: 'jq-leaver', role: 'member' }
    const lc = ok(await services.jobProposals.createCandidate(leaver, null, body))
    const lp = ok(await services.jobProposals.submit(leaver, lc.id, { fingerprint: lc.fingerprint })).proposal
    expect((await call({ user: 'jq-owner', method: 'DELETE', path: `/api/companies/${co}/members/jq-leaver` })).status).toBe(200)
    expect(db.prepare('SELECT state, decided_by FROM ai_job_proposals WHERE company_id = ? AND id = ?').get(co, lp.id)).toEqual({ state: 'withdrawn', decided_by: 'jq-owner' })
    expect(db.prepare('SELECT state FROM ai_jobs WHERE company_id = ? AND id = ?').get(co, lp.jobId)).toEqual({ state: 'retired' })
    // …and not paused-and-told as a job of someone who left (it is retired first).
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND kind = 'job_paused' AND dedupe_key LIKE ?").get(co, `job_paused:${lp.jobId}:%`)).toEqual({ n: 0 })
  })
})

function versionFp(jobId: string, v: number): string {
  return (db.prepare('SELECT fingerprint FROM ai_job_versions WHERE company_id = ? AND job_id = ? AND version = ?').get(CO, jobId, v) as Json).fingerprint
}
