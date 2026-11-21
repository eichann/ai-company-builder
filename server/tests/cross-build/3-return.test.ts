/**
 * Cross-build check, step 3 of 3 (this build again, after the floor ran on the database): nothing 4b-1 wrote is lost,
 * what the floor held stays held and runs nothing (no occurrence made twice, no やること made twice), the stopped chain and
 * its notice are there again for alice, and what was left unknown can be reconciled — by alice on her occurrences (D11).
 */
import { CROSS_DB, manifest } from './use-db'
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
import { crossBuildSnapshot } from './snapshot'

const app = new Hono()
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

describe.skipIf(!CROSS_DB)('cross-build 3/3: this build again', () => {
  it('nothing lost, nothing ran twice, the held stays held, and what is unknown is reconciled', async () => {
    initDatabase()
    const m = manifest()
    const CO: string = m.CO
    const { j2, j3 } = m.jobs
    const { o1, o3, o4 } = m.occ
    const as = async (user: string, method: string, path: string, body?: unknown) => {
      currentUser.id = user
      const res = await app.request(`/api/companies/${CO}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) as Json }
    }
    const stateOf = (id: string) => (db.prepare('SELECT state FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, id) as Json).state
    const alice = { companyId: CO, userId: 'xb-alice', role: 'member' }

    // As 4b-1 wrote it (the floor changed states only).
    expect(crossBuildSnapshot(db, CO)).toEqual(m.before)
    // The clock runs: nothing new is made from events already fired, nothing held runs.
    services.jobOccurrences.makeOccurrences(CO)
    expect(crossBuildSnapshot(db, CO)).toEqual(m.before)
    expect([o1, o3, o4].map(stateOf)).toEqual(['held', 'held', 'needs_person'])
    expect((await as('xb-alice', 'GET', '/me/job-turns?kinds=event')).body.data.turns).toEqual([])

    // The stopped chain is there again for alice (its words), and her occurrences — with what is unknown — too.
    const stop = (db.prepare('SELECT chain_stop_at AS at FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?').get(CO, j3) as Json).at
    expect(services.jobs.chainStopNotice(alice, j3, stop)).not.toBeNull()
    const mine = (await as('xb-alice', 'GET', '/me/job-occurrences')).body.data.occurrences
    // Every occurrence 4b-1 made for her (J2's done one too), none lost.
    expect(mine.map((o: Json) => o.id).sort()).toEqual(m.before.occurrences.map((o: Json) => o.id).sort())
    expect(mine.map((o: Json) => o.id)).toEqual(expect.arrayContaining([o1, o3, o4]))
    expect(mine.find((o: Json) => o.id === o1).unknownOperations).toEqual([{ key: 'put-1', kind: 'drive-put' }])

    // Reconciled on the occurrence by alice: recorded, and nothing resumes (held stays held, the run stays stopped).
    expect((await as('xb-alice', 'POST', `/jobs/${m.jobs.j1}/occurrences/${o1}/operations/put-1/reconcile`, { done: true })).status).toBe(200)
    expect((await as('xb-alice', 'POST', `/jobs/${j3}/occurrences/${o4}/operations/put-1/reconcile`, { done: false })).status).toBe(200)
    expect(db.prepare("SELECT state FROM ai_run_operations WHERE company_id = ? AND run_id = ? AND key = 'put-1'").get(CO, m.runs.r1)).toEqual({ state: 'done' })
    expect(db.prepare('SELECT state FROM ai_runs WHERE company_id = ? AND id = ?').get(CO, m.runs.r1)).toEqual({ state: 'waiting_reconcile' })
    expect(stateOf(o1)).toBe('held')
    // The watch J2 moved to is where 4b-1 left it.
    expect((db.prepare('SELECT watch_generation AS g FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?').get(CO, j2) as Json).g)
      .toBe(m.before.watch.find((w: Json) => w.job_id === j2).watch_generation)
  })
})
