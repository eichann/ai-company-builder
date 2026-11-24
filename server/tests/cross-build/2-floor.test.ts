/**
 * Cross-build check, step 2 of 3: **the rollback floor's code** (.github/rollback-floor-commit, deployment.md "Rolling back
 * production") on the database step 1 wrote. This file is copied into a worktree of that commit and run there, so it uses
 * only what the floor build has (its routes and services as of 4b-0.5). Expected (jobs.md "Shapes this build does not
 * know"): nothing of the schema-3 jobs is listed, told, claimed, run or expired — also when the clock runs two days later;
 * a pause, the company's stop and a restore hold what waits or runs and end the running run (its put in flight unknown),
 * telling nobody; a stop notice step 1 brought back once (its reminder) is shown as the stop notice it always was; and
 * everything step 3 needs stays as step 1 wrote it.
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
import { createJobOccurrences } from '../../src/services/job-occurrences'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds } from '../../src/adapters/system'
import { crossBuildSnapshot } from './snapshot'

const app = new Hono()
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const DAY = 24 * 60 * 60_000

describe.skipIf(!CROSS_DB)('cross-build 2/3: the rollback floor on it', () => {
  it('shows, tells, runs and expires nothing of it; a pause, the stop and a restore hold it; the data stays', async () => {
    initDatabase()
    const m = manifest()
    const CO: string = m.CO
    const { j1, j2, j3 } = m.jobs
    const { o1, o3, o4, o5 } = m.occ
    const { s1 } = m.jobs
    const as = async (user: string, method: string, path: string, body?: unknown) => {
      currentUser.id = user
      const res = await app.request(`/api/companies/${CO}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) as Json }
    }
    const member = (userId: string, role: string) => ({ companyId: CO, userId, role })
    const owner = member('xb-owner', 'owner')
    const alice = member('xb-alice', 'member')
    const stateOf = (id: string) => db.prepare('SELECT state, outcome_code FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, id) as Json
    const noticeCount = () => (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND kind LIKE 'job_%'").get(CO) as Json).n
    const madeCount = () => (db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'task'").get(CO) as Json).n
    const states = () => [o1, o3, o4, o5].map(stateOf)

    // Nothing listed or shown — owners and admins included.
    for (const user of ['xb-owner', 'xb-admin', 'xb-alice']) {
      for (const job of [j1, j2, j3, s1]) {
        const listed = await as(user, 'GET', `/jobs/${job}/occurrences`)
        expect(listed.status).toBe(200)
        expect(listed.body.data.occurrences).toEqual([])
        const seen = await as(user, 'GET', `/jobs/${job}`)
        expect(seen.body.data.lastOccurrence).toBeNull()
        for (const v of seen.body.data.versions) expect(v).toMatchObject({ definition: null, fingerprint: null, consentFingerprint: null })
      }
    }
    // Nothing told: no notice of an occurrence or of the stopped chain is worded for anyone.
    for (const who of [owner, alice]) {
      for (const [job, occ] of [[j1, o1], [j2, o3], [j3, o4], [s1, o5]]) expect(services.jobs.occurrenceNotice(who, job, occ)).toBeNull()
      const stop = (db.prepare('SELECT chain_stop_at AS at FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?').get(CO, j3) as Json).at
      expect(services.jobs.chainStopNotice(who, j3, stop)).toBeNull()
    }
    // A stop notice this build brought back once (J4, schema 2: the floor runs it): the floor shows alice that row as the
    // stop notice it always was — unread, on top, its own words — and nobody anything new; the creator's is as it was.
    const stops = (who: { companyId: string; userId: string; role: string }) => {
      const listed = services.notifications.list(who) as Json
      expect(listed.ok).toBe(true)
      return listed.value.items.filter((i: Json) => i.kind === 'job_chain_stopped').map((i: Json) => ({ text: i.text, read: i.read }))
    }
    expect(stops(alice)).toEqual([{ read: false, text: expect.stringContaining('定期の仕事「日程の次」が止まっています（一時停止している間に完了したため、止まりました）') }])
    expect(stops(owner)).toEqual([{ read: false, text: expect.stringContaining('が止まっています') }])
    expect(stops(member('xb-bob', 'member'))).toEqual([])
    expect(stops(member('xb-admin', 'admin'))).toEqual([])
    // She reads it there.
    expect((services.notifications.markRead(alice, { all: true }) as Json).ok).toBe(true)

    // Nothing claimed, its run a missing run.
    expect((await as('xb-alice', 'GET', '/me/job-turns?kinds=time,event')).body.data.turns).toEqual([])
    expect((await as('xb-alice', 'POST', '/job-run-claims', { occurrenceId: o3, deviceId: 'device-xb-9', conversationId: 'c-9', checks: ['new_files', 'new_meetings', 'source_record'], kinds: ['time', 'event'] })).status).toBe(404)
    // The set watch's (schema 5) neither, whatever the app names.
    expect((await as('xb-alice', 'GET', '/me/job-turns?kinds=time,event&checks=matched_record')).body.data.turns).toEqual([])
    expect((await as('xb-alice', 'POST', '/job-run-claims', { occurrenceId: o5, deviceId: 'device-xb-9', conversationId: 'c-9', checks: ['new_files', 'new_meetings', 'source_record', 'matched_record'], kinds: ['time', 'event'] })).status).toBe(404)
    // Its run claimed by step 1 (alice's app went on while production went back): its report — with an update count (4b-4
    // PR3b) or without — is a missing run's answer here, and nothing is made or kept of it.
    const before5 = { state: stateOf(o5), made: madeCount(), notices: noticeCount() }
    for (const jobResult of [{ decision: 'decline', reason: 'requested', confidence: 0.5, updates: 2 }, { decision: 'proceed', reason: 'requested', confidence: 0.5 }]) {
      expect((await as('xb-alice', 'POST', `/ai-runs/${m.runs.r5.id}/finish`, { generation: m.runs.r5.generation, outcome: 'done', jobResult })).status).toBe(404)
    }
    expect({ state: stateOf(o5), made: madeCount(), notices: noticeCount() }).toEqual(before5)
    expect((await as('xb-alice', 'GET', `/ai-runs/${m.runs.r1}`)).status).toBe(404)
    expect((await as('xb-owner', 'POST', `/jobs/${j3}/occurrences/${o4}/operations/put-1/reconcile`, { done: true })).status).toBe(404)

    // The clock two days later: nothing expired, ended, told or run.
    const before = { states: states(), notices: noticeCount(), made: madeCount() }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * DAY)
    try {
      const occurrences = createJobOccurrences({
        companyData: sqliteCompanyData(db), transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() },
        ids: randomIds, timeZoneOf: () => 'Asia/Tokyo', holidaysOf: () => [], roleOf: (co, u) => sqliteMembershipRepository(db).roleOf(co, u),
        jobs: services.jobs, writer: { check: () => null, create: () => { throw new Error('the floor must make nothing') } }, log: () => {},
      })
      occurrences.makeOccurrences(CO)
      occurrences.runDue(CO)
    } finally {
      vi.useRealTimers()
    }
    expect({ states: states(), notices: noticeCount(), made: madeCount() }).toEqual(before)

    // Stopping reaches it: the pause holds the running one and ends its run (the put in flight becomes unknown), the
    // company's stop and a restore hold the waiting one; nobody is told; lifting them brings nothing back.
    expect(services.jobs.pause(owner, j1).ok).toBe(true)
    expect(stateOf(o1)).toEqual({ state: 'held', outcome_code: 'JOB_PAUSED' })
    expect(db.prepare('SELECT state FROM ai_runs WHERE company_id = ? AND id = ?').get(CO, m.runs.r1)).toEqual({ state: 'waiting_reconcile' })
    expect(db.prepare("SELECT state FROM ai_run_operations WHERE company_id = ? AND run_id = ? AND key = 'put-1'").get(CO, m.runs.r1)).toEqual({ state: 'unknown' })
    expect(services.jobs.setStopped(owner, { stopped: true }).ok).toBe(true)
    services.restorePause.pauseAfterRestore(CO)
    expect(stateOf(o3)).toMatchObject({ state: 'held' })
    expect(stateOf(o4)).toEqual({ state: 'needs_person', outcome_code: 'RESULT_UNKNOWN' })
    expect(services.jobs.setStopped(owner, { stopped: false }).ok).toBe(true)
    // A resume cannot check a shape the floor does not know: it stays paused there (its own build resumes it).
    expect(await services.jobs.resume(owner, j1)).toMatchObject({ ok: false, body: { code: 'JOB_SCHEMA_UNKNOWN' } })
    expect(states().map(s => s.state)).toEqual(['held', 'held', 'needs_person', 'held'])
    expect(noticeCount()).toBe(before.notices)
    expect(madeCount()).toBe(before.made)

    // The proposals' jobs (schema 4, which the floor does not know): their names only, never a definition or a fingerprint;
    // editing, approving and accepting refused; nothing made of them by the clock (above) and no proposal notice shown.
    const { p1, p2, p3 } = m.proposals
    for (const p of [p1, p2, p3]) {
      const seen = await as('xb-owner', 'GET', `/jobs/${p.jobId}`)
      expect(seen.status).toBe(200)
      expect(seen.body.data.name).toMatch(/^interview-report（/)
      for (const v of seen.body.data.versions) expect(v).toMatchObject({ definition: null, fingerprint: null, consentFingerprint: null })
      expect(await services.jobs.approve(owner, p.jobId, { version: 1 }, [1, 2, 3, 4])).toMatchObject({ ok: false, body: { code: 'JOB_SCHEMA_UNKNOWN' } })
      expect((await services.jobs.update(owner, p.jobId, { definition: { schema: 1 } }, [1, 2, 3, 4])).ok).toBe(false)
      expect((db.prepare('SELECT COUNT(*) AS n FROM ai_job_occurrences WHERE company_id = ? AND job_id = ?').get(CO, p.jobId) as Json).n).toBe(0)
    }
    expect(await services.jobs.accept(member('xb-bob', 'member'), p3.jobId, { version: 1 }, [1, 2, 3, 4], true)).toMatchObject({ ok: false, body: { code: 'JOB_SCHEMA_UNKNOWN' } })
    for (const who of [owner, member('xb-admin', 'admin'), member('xb-bob', 'member')]) {
      const listed = services.notifications.list(who) as Json
      expect(listed.ok).toBe(true)
      expect(listed.value.items.filter((i: Json) => i.kind === 'job_proposal' || i.kind === 'job_proposal_returned')).toEqual([])
    }

    // What 4b-1 needs to go on is as it wrote it.
    expect(crossBuildSnapshot(db, CO)).toEqual(m.before)
    saveDb(db, m)
  })
})
