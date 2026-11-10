/**
 * Integration Test: scheduled jobs' definitions and approval (定期の仕事, B PR 3a, jobs.md). Nothing runs:
 * these guard who may do what, that what was approved and accepted stays pinned, and that the
 * responsible person leaving or losing rights pauses the job and tells owners / admins.
 *
 * Guards (each mutation-checked, listed in jobs.md):
 * - only owner/admin create, edit, approve and stop; a member sees only the jobs they are responsible
 *   for, and anyone else's job answers like a missing one;
 * - versions are append-only (the database refuses a rewrite), approval pins a version by its
 *   fingerprint, and an edit after approval changes nothing approved;
 * - acceptance is the responsible person's own, needed again only when who / what runs / where /
 *   the grant changed;
 * - approval (and acceptance, and an owner/admin's resume) is refused when the responsible person is no
 *   longer a member or cannot read a place the version names — the refusal names no place;
 * - a pinned Skill missing or changed since the version refuses approval;
 * - the responsible person leaving pauses the job and tells every owner/admin (removeMember); a
 *   demotion that loses a place the approved version names does too (changeRole);
 * - pause / resume: the responsible person resumes only their own pause; the company's stop switch.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

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
import { notificationsRoute } from '../../src/routes/notifications'
import { services } from '../../src/composition'
import { createJobService } from '../../src/services/jobs'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds, systemClock } from '../../src/adapters/system'

const app = new Hono()
app.route('/api/companies/:companyId', jobsRoute)
app.route('/api/companies/:companyId', notificationsRoute)

const CO = 'jobs-co'
const OTHER = 'jobs-other'
const TS = '2026-11-11T00:00:00.000Z'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function as(user: string, method: string, path: string, body?: unknown, company = CO) {
  currentUser.id = user
  const res = await app.request(`/api/companies/${company}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}

/** A server operation job (placement e): a やること for the responsible person every Monday. */
function operationJob(actingUser: string, name = '月曜のやること') {
  return {
    schema: 1, name, actingUser,
    trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 },
    check: { kind: 'none' },
    run: { kind: 'operation', operation: 'create_task', title: '週の報告を書く', dueBusinessDays: 1 },
    placement: 'e',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
    grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 1 } },
  }
}
/** A PC job (placement a) reading `path`, with a pinned company Skill. */
function procedureJob(actingUser: string, path: string, skill = 'interview-report') {
  return {
    schema: 1, name: '面談報告書の下書き', actingUser,
    trigger: { every: 'week', weekday: 'tue', at: '09:00', businessDaysBefore: 1 },
    check: { kind: 'new_files', path },
    run: { kind: 'procedure', procedure: { source: 'company_skill', skill } },
    placement: 'a',
    missed: { policy: 'latest_only', expiresAfterMinutes: 1620 },
    grant: {
      tools: ['files_read', 'records'], creates: ['task'], routes: ['POST /item'], reads: { paths: [path], calls: [] },
      writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 1 },
    },
  }
}

async function created(definition: Json): Promise<Json> {
  if (definition.procedureFor) {
    const made = await jobsWithSkill('tree-a').create({ companyId: CO, userId: 'u-owner', role: 'owner' }, { definition: procedureJob(definition.procedureFor.actingUser, definition.procedureFor.path) })
    if (!made.ok) throw new Error(JSON.stringify(made.body))
    return made.value
  }
  const r = await as('u-owner', 'POST', '/jobs', { definition })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data
}
async function approved(definition: unknown): Promise<Json> {
  const job = await created(definition)
  const r = await as('u-owner', 'POST', `/jobs/${job.id}/approve`, { version: 1, fingerprint: job.versions[0].fingerprint })
  if (r.status !== 200) throw new Error(JSON.stringify(r.body))
  return r.body.data
}
const jobRow = (id: string) => db.prepare('SELECT state, paused_reason, approved_version, approved_fingerprint, accepted_consent FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, id) as Json
const pausedNotices = (user: string) => db.prepare("SELECT dedupe_key FROM notifications WHERE company_id = ? AND user_id = ? AND kind = 'job_paused'").all(CO, user) as Json[]

function member(company: string, user: string, role: string) {
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${company}-${user}`, user, company, role, TS, TS)
}

beforeAll(() => {
  initDatabase()
  for (const c of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(c, c, c, 'u-owner', TS, TS)
    db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${c}-root`, c, TS)
    db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'everyone', NULL, 1, 1, ?)").run(`${c}-root-r`, c, `${c}-root`, TS)
    // 記録の機能 on: the bell answers.
    db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(c, TS, 'u-owner')
  }
  // 秘書室: every member reads it but u-mallory. 経理部: a private folder only u-alice reads (owner/admin always).
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('sec', ?, '秘書室', 'folder', ?)").run(CO, TS)
  db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('sec-m', ?, 'sec', 'user', 'u-mallory', 0, 0, ?)").run(CO, TS)
  db.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('priv', ?, '経理部', 'folder', 'priv-repo', ?)").run(CO, TS)
  db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('priv-e', ?, 'priv', 'everyone', NULL, 0, 0, ?)").run(CO, TS)
  db.prepare("INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('priv-a', ?, 'priv', 'user', 'u-alice', 1, 1, ?)").run(CO, TS)
  for (const [user, role] of [['u-owner', 'owner'], ['u-admin', 'admin'], ['u-alice', 'member'], ['u-bob', 'member'], ['u-mallory', 'member'], ['u-leaver', 'member'], ['u-boss', 'admin']]) member(CO, user, role)
  member(OTHER, 'u-owner', 'owner')
})

describe('who may do what with a scheduled job', () => {
  it('only owner/admin create, edit, approve and stop; a member is refused before anything is read', async () => {
    expect((await as('u-bob', 'POST', '/jobs', { definition: operationJob('u-bob') })).status).toBe(403)
    expect((await as('u-admin', 'POST', '/jobs', { definition: operationJob('u-bob') })).status).toBe(201)
    const job = await created(operationJob('u-bob'))
    expect((await as('u-bob', 'PUT', `/jobs/${job.id}`, { definition: operationJob('u-bob', '別の名前') })).status).toBe(403)
    expect((await as('u-bob', 'POST', `/jobs/${job.id}/approve`, { version: 1 })).status).toBe(403)
    expect((await as('u-bob', 'PUT', '/jobs-stop', { stopped: true })).status).toBe(403)
    expect(jobRow(job.id)).toMatchObject({ approved_version: null })
  })

  it('a member sees only the jobs they are responsible for; anyone else\'s answers like a missing one', async () => {
    const bobs = await created(operationJob('u-bob', 'ボブの仕事'))
    const alices = await created(operationJob('u-alice', 'アリスの仕事'))
    const list = await as('u-bob', 'GET', '/jobs')
    expect(list.status).toBe(200)
    expect(list.body.data.jobs.map((j: Json) => j.id)).toContain(bobs.id)
    expect(list.body.data.jobs.map((j: Json) => j.id)).not.toContain(alices.id)
    expect(list.body.data.canManage).toBe(false)
    const other = await as('u-bob', 'GET', `/jobs/${alices.id}`)
    const missing = await as('u-bob', 'GET', '/jobs/job.0123456789abcdef0123456789abcdef')
    expect(other.status).toBe(404)
    expect(other.body).toEqual(missing.body)
    for (const action of ['pause', 'resume']) expect((await as('u-bob', 'POST', `/jobs/${alices.id}/${action}`)).status).toBe(404)
    expect((await as('u-bob', 'POST', `/me/jobs/${alices.id}/accept`, { version: 1 })).status).toBe(404)
    // The owner sees every job.
    expect((await as('u-owner', 'GET', '/jobs')).body.data.jobs.map((j: Json) => j.id)).toEqual(expect.arrayContaining([bobs.id, alices.id]))
  })

  it('another company\'s job is a job that does not exist, and nothing of it changes', async () => {
    const theirs = await as('u-owner', 'POST', '/jobs', { definition: operationJob('u-owner', '他社の仕事') }, OTHER)
    expect(theirs.status).toBe(201)
    const id = theirs.body.data.id
    const before = db.prepare('SELECT * FROM ai_jobs WHERE company_id = ?').all(OTHER)
    for (const [method, path, body] of [['GET', `/jobs/${id}`], ['PUT', `/jobs/${id}`, { definition: operationJob('u-owner', '乗っ取り') }], ['POST', `/jobs/${id}/approve`, { version: 1 }],
      ['POST', `/jobs/${id}/pause`], ['POST', `/jobs/${id}/resume`], ['POST', `/me/jobs/${id}/accept`, { version: 1 }]] as Array<[string, string, unknown?]>) {
      const r = await as('u-owner', method, path, body)
      expect(r.status, `${method} ${path}`).toBe(404)
    }
    expect(db.prepare('SELECT * FROM ai_jobs WHERE company_id = ?').all(OTHER)).toEqual(before)
  })
})

describe('versions are append-only and approval is pinned', () => {
  it('an edit after approval adds a version and changes nothing approved; the database refuses a rewrite', async () => {
    const job = await approved(operationJob('u-bob', '版のテスト'))
    const pinned = jobRow(job.id)
    expect(pinned).toMatchObject({ state: 'active', approved_version: 1 })
    const edit = await as('u-owner', 'PUT', `/jobs/${job.id}`, { definition: { ...operationJob('u-bob', '版のテスト'), run: { kind: 'operation', operation: 'create_task', title: '別のやること', dueBusinessDays: null } } })
    expect(edit.status).toBe(200)
    expect(edit.body.data).toMatchObject({ latestVersion: 2, approvedVersion: 1, changed: true })
    expect(jobRow(job.id)).toEqual(pinned)
    const v1 = edit.body.data.versions.find((v: Json) => v.version === 1)
    expect(v1.definition.run.title).toBe('週の報告を書く')
    // The same definition again is no new version.
    const again = await as('u-owner', 'PUT', `/jobs/${job.id}`, { definition: { ...operationJob('u-bob', '版のテスト'), run: { kind: 'operation', operation: 'create_task', title: '別のやること', dueBusinessDays: null } } })
    expect(again.body.data).toMatchObject({ latestVersion: 2, changed: false })
    expect(() => db.prepare("UPDATE ai_job_versions SET definition = '{}' WHERE company_id = ? AND job_id = ? AND version = 1").run(CO, job.id)).toThrow(/never rewritten/)
    expect(() => db.prepare("UPDATE ai_job_versions SET approved_by = 'u-admin' WHERE company_id = ? AND job_id = ? AND version = 1").run(CO, job.id)).toThrow(/approved once/)
  })

  it('approving with a fingerprint that is not the version\'s is refused', async () => {
    const job = await created(operationJob('u-bob', '指紋'))
    const r = await as('u-owner', 'POST', `/jobs/${job.id}/approve`, { version: 1, fingerprint: `sha256:${'0'.repeat(64)}` })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('JOB_VERSION_FINGERPRINT')
    expect(jobRow(job.id).approved_version).toBeNull()
  })
})

describe('the responsible person accepts', () => {
  it('only the version\'s responsible person accepts, only an approved version, and the job then waits for nothing', async () => {
    const job = await created(operationJob('u-bob', '受け取り'))
    expect((await as('u-bob', 'POST', `/me/jobs/${job.id}/accept`, { version: 1 })).body.code).toBe('JOB_NOT_APPROVED')
    await as('u-owner', 'POST', `/jobs/${job.id}/approve`, { version: 1 })
    const byOwner = await as('u-owner', 'POST', `/me/jobs/${job.id}/accept`, { version: 1 })
    expect(byOwner.status).toBe(403)
    expect(jobRow(job.id).accepted_consent).toBeNull()
    const r = await as('u-bob', 'POST', `/me/jobs/${job.id}/accept`, { version: 1 })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ accepted: true, waiting: null })
  })

  it('a new version needs acceptance again only when who, what runs, where or the grant changed', async () => {
    const def = operationJob('u-bob', '受け取り直し')
    const job = await approved(def)
    await as('u-bob', 'POST', `/me/jobs/${job.id}/accept`, { version: 1 })
    // A new name and time: approved, still accepted.
    await as('u-owner', 'PUT', `/jobs/${job.id}`, { definition: { ...def, name: '名前だけ変えた', trigger: { ...def.trigger, at: '10:00' } } })
    const renamed = await as('u-owner', 'POST', `/jobs/${job.id}/approve`, { version: 2 })
    expect(renamed.body.data).toMatchObject({ approvedVersion: 2, accepted: true, waiting: null })
    // A wider grant: approved, waiting for the responsible person again.
    await as('u-owner', 'PUT', `/jobs/${job.id}`, { definition: { ...def, grant: { ...def.grant, limits: { minutes: 10, runsPerDay: 2 } } } })
    const wider = await as('u-owner', 'POST', `/jobs/${job.id}/approve`, { version: 3 })
    expect(wider.body.data).toMatchObject({ approvedVersion: 3, accepted: false, waiting: 'NOT_ACCEPTED' })
    // Another responsible person: the earlier one's acceptance does not carry over.
    await as('u-owner', 'PUT', `/jobs/${job.id}`, { definition: { ...def, actingUser: 'u-alice' } })
    await as('u-bob', 'POST', `/me/jobs/${job.id}/accept`, { version: 3 })
    const handed = await as('u-owner', 'POST', `/jobs/${job.id}/approve`, { version: 4 })
    expect(handed.body.data).toMatchObject({ approvedVersion: 4, accepted: false, waiting: 'NOT_ACCEPTED' })
    // bob is no longer its responsible person: the job is not his to see.
    expect((await as('u-bob', 'POST', `/me/jobs/${job.id}/accept`, { version: 4 })).status).toBe(404)
    expect((await as('u-alice', 'POST', `/me/jobs/${job.id}/accept`, { version: 4 })).body.data.accepted).toBe(true)
  })
})

describe('approval checks the responsible person\'s rights now', () => {
  it('a place the responsible person cannot read refuses approval, naming no place; one they read is approved', async () => {
    const denied = await created(procedureJobFor('u-mallory', '秘書室/面談'))
    const r = await jobsWithSkill('tree-a').approve({ companyId: CO, userId: 'u-owner', role: 'owner' }, denied.id, { version: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.body.code).toBe('JOB_GRANT_EXCEEDS')
      expect(JSON.stringify(r.body)).not.toContain('秘書室')
    }
    // A private folder only u-alice reads: u-bob's job is refused, u-alice's approved.
    const bobs = await created(procedureJobFor('u-bob', '経理部/文字起こし'))
    expect((await jobsWithSkill('tree-a').approve({ companyId: CO, userId: 'u-owner', role: 'owner' }, bobs.id, { version: 1 })).ok).toBe(false)
    const alices = await created(procedureJobFor('u-alice', '経理部/文字起こし'))
    expect((await jobsWithSkill('tree-a').approve({ companyId: CO, userId: 'u-owner', role: 'owner' }, alices.id, { version: 1 })).ok).toBe(true)
  })

  it('a member who reads a version\'s draft place not at all gets the version without its definition', async () => {
    const job = await created(procedureJobFor('u-bob', '経理部/文字起こし'))
    const seen = await as('u-bob', 'GET', `/jobs/${job.id}`)
    expect(seen.status).toBe(200)
    expect(seen.body.data.versions[0].definition).toBeNull()
    expect(JSON.stringify(seen.body)).not.toContain('経理部')
  })

  it('a responsible person who left refuses approval', async () => {
    member(CO, 'u-gone', 'member')
    const job = await created(operationJob('u-gone', '抜けた人'))
    db.prepare('DELETE FROM memberships WHERE company_id = ? AND user_id = ?').run(CO, 'u-gone')
    const r = await as('u-owner', 'POST', `/jobs/${job.id}/approve`, { version: 1 })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('JOB_OWNER_NOT_MEMBER')
  })

  it('a pinned Skill missing or changed since the version refuses approval', async () => {
    const job = await created(procedureJobFor('u-alice', '経理部/文字起こし'))
    const owner = { companyId: CO, userId: 'u-owner', role: 'owner' }
    const changed = await jobsWithSkill('tree-b').approve(owner, job.id, { version: 1 })
    expect(!changed.ok && changed.body.code).toBe('JOB_SKILL_CHANGED')
    const missing = await jobsWithSkill(null).approve(owner, job.id, { version: 1 })
    expect(!missing.ok && missing.body.code).toBe('JOB_SKILL_MISSING')
    expect(jobRow(job.id).approved_version).toBeNull()
  })
})

describe('the responsible person leaves or loses rights', () => {
  it('removing the member pauses their jobs and tells every owner and admin, not the others', async () => {
    const job = await approved(operationJob('u-leaver', '辞める人の仕事'))
    const r = services.companies.removeMember({ companyId: CO, userId: 'u-admin', role: 'admin' }, 'u-leaver')
    expect(r.ok).toBe(true)
    expect(jobRow(job.id)).toMatchObject({ state: 'paused', paused_reason: 'OWNER_LEFT' })
    for (const admin of ['u-owner', 'u-admin', 'u-boss']) expect(pausedNotices(admin).map(n => n.dedupe_key.split(':')[1])).toContain(job.id)
    expect(pausedNotices('u-bob')).toEqual([])
    // The owner's bell says it, by the job's name; a member's never shows it.
    const bell = await as('u-owner', 'GET', '/me/notifications')
    expect(bell.body.data.items.map((i: Json) => i.text)).toContain('定期の仕事「辞める人の仕事」を止めました：責任者が会社を離れました。新しい責任者を決めてください')
    // The responsible person is gone: resuming is refused until another is chosen.
    expect((await as('u-owner', 'POST', `/jobs/${job.id}/resume`)).body.code).toBe('JOB_OWNER_NOT_MEMBER')
  })

  it('a demotion that loses a place the approved version names pauses the job; one that keeps it does not', async () => {
    const lost = await jobsWithSkill('tree-a').create({ companyId: CO, userId: 'u-owner', role: 'owner' }, { definition: procedureJob('u-boss', '経理部/文字起こし') })
    const kept = await jobsWithSkill('tree-a').create({ companyId: CO, userId: 'u-owner', role: 'owner' }, { definition: procedureJob('u-boss', '総務/文字起こし') })
    if (!lost.ok || !kept.ok) throw new Error('create')
    for (const j of [lost.value, kept.value]) {
      const a = await jobsWithSkill('tree-a').approve({ companyId: CO, userId: 'u-owner', role: 'owner' }, j.id, { version: 1 })
      if (!a.ok) throw new Error(JSON.stringify(a.body))
    }
    const r = services.companies.changeRole({ companyId: CO, userId: 'u-owner', role: 'owner' }, 'u-boss', 'member')
    expect(r.ok).toBe(true)
    expect(jobRow(lost.value.id)).toMatchObject({ state: 'paused', paused_reason: 'OWNER_RIGHTS_CHANGED' })
    expect(jobRow(kept.value.id)).toMatchObject({ state: 'active', paused_reason: null })
    expect(pausedNotices('u-owner').map(n => n.dedupe_key.split(':')[1])).toContain(lost.value.id)
    // u-boss was told as an admin; demoted, their bell no longer shows a job's notice (owner / admin only, judged when read).
    expect(pausedNotices('u-boss').length).toBeGreaterThan(0)
    const bell = await as('u-boss', 'GET', '/me/notifications')
    expect(bell.status).toBe(200)
    expect(bell.body.data.items.filter((i: Json) => i.kind === 'job_paused')).toEqual([])
  })
})

describe('pause, resume and the company\'s stop', () => {
  it('the responsible person pauses their own job and resumes only their own pause', async () => {
    const job = await approved(operationJob('u-bob', '止める'))
    expect((await as('u-bob', 'POST', `/jobs/${job.id}/pause`)).body.data).toMatchObject({ state: 'paused', pausedReason: 'BY_RESPONSIBLE' })
    expect((await as('u-bob', 'POST', `/jobs/${job.id}/resume`)).body.data).toMatchObject({ state: 'active', pausedReason: null })
    await as('u-owner', 'POST', `/jobs/${job.id}/pause`)
    const r = await as('u-bob', 'POST', `/jobs/${job.id}/resume`)
    expect(r.status).toBe(403)
    expect(jobRow(job.id)).toMatchObject({ state: 'paused', paused_reason: 'ADMIN' })
    expect((await as('u-owner', 'POST', `/jobs/${job.id}/resume`)).body.data.state).toBe('active')
  })

  it('「定期の仕事をすべて止める」: every job of the company waits, and only this company\'s', async () => {
    const job = await approved(operationJob('u-bob', '会社で止める'))
    await as('u-bob', 'POST', `/me/jobs/${job.id}/accept`, { version: 1 })
    expect((await as('u-owner', 'PUT', '/jobs-stop', { stopped: 'yes' })).status).toBe(400)
    expect((await as('u-owner', 'PUT', '/jobs-stop', { stopped: true })).status).toBe(200)
    const list = await as('u-owner', 'GET', '/jobs')
    expect(list.body.data.stopped).toBe(true)
    expect(list.body.data.jobs.find((j: Json) => j.id === job.id).waiting).toBe('COMPANY_STOPPED')
    expect((await as('u-owner', 'GET', '/jobs', undefined, OTHER)).body.data.stopped).toBe(false)
    await as('u-owner', 'PUT', '/jobs-stop', { stopped: false })
    expect((await as('u-owner', 'GET', `/jobs/${job.id}`)).body.data.waiting).toBeNull()
  })
})

/** A job service on the same database whose company Skill reads `tree` (null: none). */
function jobsWithSkill(tree: string | null) {
  return createJobService({
    companyData: sqliteCompanyData(db), memberships: sqliteMembershipRepository(db), transactions: sqliteTransactions(db),
    clock: systemClock, ids: randomIds, skillTree: async () => (tree === null ? null : `${tree.replace(/[^0-9a-f]/g, '')}${'0'.repeat(40)}`.slice(0, 40)),
  })
}
/** A PC job made through a service whose Skill reads 'tree-a' (the HTTP route's company has no repository here). */
function procedureJobFor(actingUser: string, path: string) {
  return { procedureFor: { actingUser, path } }
}
