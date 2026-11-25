/**
 * Cross-build line check, step 2 (4b-4 A3): **a build that knows schema 5 but not the set watch's second line**
 * (.github/set-watch-line-before-commit — the commit before that line was opened) on the database step 1 wrote. Copied into a
 * worktree of that commit and run there, so it uses only what that build has. Expected (jobs.md "The set watch (schema 5)"
 * "The second line": a line a build does not know is a line taken out there): S2's combination is not opened, so its scan reads
 * nothing (a meeting bob's AI reads there makes no occurrence and no mark), its waiting occurrence is never claimed and ends
 * without running (`SET_WATCH_NOT_OPENED`, untold), it is never approved there, nobody who did not attend sees it, and the first
 * line's S1 and every mark stay as step 1 wrote them.
 */
import { CROSS_DB, manifest, saveDb } from './use-db'
import { describe, it, expect, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { jobsRoute } from '../../src/routes/jobs'
import { services } from '../../src/composition'
import { createServiceRecordWriter } from '../../src/services/record-engine'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'

const app = new Hono()
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

describe.skipIf(!CROSS_DB)('cross-build line 2: a build that knows schema 5 but not the second line', () => {
  it('reads, runs and shows nothing of it; its waiting occurrence ends untold; the rest stays', async () => {
    initDatabase()
    const m = manifest()
    const CO: string = m.CO
    const { s1, s2 } = m.jobs
    const { o5, o6 } = m.occ
    const as = async (user: string, method: string, path: string, body?: unknown) => {
      currentUser.id = user
      const res = await app.request(`/api/companies/${CO}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) as Json }
    }
    const owner = { companyId: CO, userId: 'xb-owner', role: 'owner' }
    const bob = { companyId: CO, userId: 'xb-bob', role: 'member' }
    const stateOf = (id: string) => db.prepare('SELECT state, outcome_code FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, id) as Json
    const marks = () => db.prepare('SELECT * FROM ai_job_meeting_reviews WHERE company_id = ? ORDER BY record_id').all(CO)
    const count = (job: string) => (db.prepare('SELECT COUNT(*) AS n FROM ai_job_occurrences WHERE company_id = ? AND job_id = ?').get(CO, job) as Json).n
    const notices = () => (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND kind LIKE 'job_%'").get(CO) as Json).n
    const marksBefore = marks()
    const o5Before = stateOf(o5)
    const noticesBefore = notices()

    // Nobody who did not attend sees S2's occurrence; bob is not handed it as a turn, and his claim starts no run.
    for (const user of ['xb-owner', 'xb-admin']) expect((await as(user, 'GET', `/jobs/${s2}/occurrences`)).body.data.occurrences).toEqual([])
    expect((await as('xb-bob', 'GET', '/me/job-turns?kinds=time,event&checks=matched_record')).body.data.turns).toEqual([])
    const claimed = await as('xb-bob', 'POST', '/job-run-claims', { occurrenceId: o6, deviceId: 'device-xb-6', conversationId: 'c-xb-6', checks: ['matched_record'], kinds: ['event'] })
    expect(claimed.status).not.toBe(201)
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE company_id = ? AND record_id = ?').get(CO, o6)).toEqual({ n: 0 })
    // Never approved there (this company has no shared folder, so the Skill check answers first; the line check is the
    // integration test's, job-set-watch-first-read.test.ts) — nothing approved changes.
    const approved = () => db.prepare('SELECT approved_version, approved_fingerprint FROM ai_jobs WHERE company_id = ? AND id = ?').get(CO, s2)
    const approvedBefore = approved()
    expect(await services.jobs.approve(owner, s2, { version: 1 }, [1, 2, 3, 4, 5])).toMatchObject({ ok: false })
    expect(approved()).toEqual(approvedBefore)

    // A meeting bob's AI reads there: S2's scan reads nothing — no occurrence, no mark. The clock ends the waiting one, untold.
    const roleOf = (co: string, user: string) => sqliteMembershipRepository(db).roleOf(co, user)
    const writer = createServiceRecordWriter({
      companyData: sqliteCompanyData(db), transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
      isMember: (co, user) => roleOf(co, user) !== null, roleOf, notify: () => {}, recordChanged: () => {},
    })
    const meeting3 = writer.create(CO, {
      type: 'meeting', title: 'C社 初回の商談', state: 'received', members: ['xb-bob', 'xb-alice'],
      fields: { assignee: 'xb-bob', attendees: JSON.stringify(['xb-bob', 'xb-alice']), external_count: 1, meeting_at: new Date().toISOString() },
      actor: { id: 'google', kind: 'external', source: 'google' }, quiet: true,
    })
    if (!meeting3.ok) throw new Error(meeting3.reason)
    const AI = { kind: 'ai' as const, source: 'claude' }
    const versionOf = (id: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).version
    const m3 = meeting3.record.id
    expect((await services.recordEngine.act(bob, AI, m3, 'start_reading', { expectedVersion: versionOf(m3) })).ok).toBe(true)
    expect((await services.recordEngine.act(bob, AI, m3, 'finish_reading', { expectedVersion: versionOf(m3), args: { summary_text: '見積もり' } })).ok).toBe(true)
    services.jobOccurrences.makeOccurrences(CO)
    expect(count(s2)).toBe(1)
    expect(stateOf(o6)).toMatchObject({ outcome_code: 'SET_WATCH_NOT_OPENED' })
    expect(notices()).toBe(noticesBefore)
    expect(marks()).toEqual(marksBefore)
    // The first line's S1 is untouched by any of it.
    expect(stateOf(o5)).toEqual(o5Before)
    expect(count(s1)).toBe(1)
    saveDb(db, { ...m, line: { o6: stateOf(o6), m3 } })
  })
})
