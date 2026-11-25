/**
 * Cross-build line check, step 3 (4b-4 A3; this build again, after a build that knows schema 5 but not the set watch's second
 * line ran on the database): S2's occurrence that build ended stays ended (never claimed or run late), the meeting read there
 * never runs late (its cursor followed that build's now) and gets no mark, the mark of step 1 is as it was — and the line works
 * again from now on: a meeting bob's AI reads now makes one occurrence, once.
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
import { jobsRoute } from '../../src/routes/jobs'
import { services } from '../../src/composition'
import { createServiceRecordWriter } from '../../src/services/record-engine'
import { meetingOutputId } from '../../src/services/meeting-outputs'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds, sha256TokenDigest } from '../../src/adapters/system'
import { MINUTES_REVIEW_KEY } from '../../../shared/core/core-types'

const app = new Hono()
app.route('/api/companies/:companyId', jobsRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

describe.skipIf(!CROSS_DB)('cross-build line 3: this build again', () => {
  it('nothing ended there runs, nothing read there runs late, and the line works again', async () => {
    initDatabase()
    const m = manifest()
    const CO: string = m.CO
    const { s2 } = m.jobs
    const { o6 } = m.occ
    const as = async (user: string, method: string, path: string) => {
      currentUser.id = user
      const res = await app.request(`/api/companies/${CO}${path}`, { method, headers: { 'Content-Type': 'application/json' } })
      return { status: res.status, body: await res.json().catch(() => null) as Json }
    }
    const stateOf = (id: string) => db.prepare('SELECT state, outcome_code FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, id) as Json
    const occurrences = () => db.prepare('SELECT id, event_record_id FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? ORDER BY created_at').all(CO, s2) as Json[]
    const markOf = (meetingId: string) => db.prepare('SELECT outcome, occurrence_id FROM ai_job_meeting_reviews WHERE company_id = ? AND record_id = ?')
      .get(CO, `${meetingOutputId(sha256TokenDigest, 'task', meetingId, MINUTES_REVIEW_KEY)}#xb-bob`) as Json

    services.jobOccurrences.makeOccurrences(CO)
    // Ended there, ended here: never handed to bob's app again.
    expect(stateOf(o6)).toEqual(m.line.o6)
    expect((await as('xb-bob', 'GET', '/me/job-turns?kinds=time,event&checks=matched_record')).body.data.turns).toEqual([])
    // The meeting read there never runs late, and has no mark; step 1's meeting keeps its one mark.
    expect(occurrences().map(o => o.id)).toEqual([o6])
    expect(markOf(m.line.m3)).toBeUndefined()
    expect(markOf(m.meetings.m2)).toEqual({ outcome: 'made', occurrence_id: o6 })

    // From now on the line works: a meeting bob's AI reads now makes one occurrence, once.
    const roleOf = (co: string, user: string) => sqliteMembershipRepository(db).roleOf(co, user)
    const writer = createServiceRecordWriter({
      companyData: sqliteCompanyData(db), transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
      isMember: (co, user) => roleOf(co, user) !== null, roleOf, notify: () => {}, recordChanged: () => {},
    })
    const made = writer.create(CO, {
      type: 'meeting', title: 'D社 初回の商談', state: 'received', members: ['xb-bob', 'xb-alice'],
      fields: { assignee: 'xb-bob', attendees: JSON.stringify(['xb-bob', 'xb-alice']), external_count: 1, meeting_at: new Date().toISOString() },
      actor: { id: 'google', kind: 'external', source: 'google' }, quiet: true,
    })
    if (!made.ok) throw new Error(made.reason)
    const m4 = made.record.id
    const bob = { companyId: CO, userId: 'xb-bob', role: 'member' }
    const AI = { kind: 'ai' as const, source: 'claude' }
    const versionOf = (id: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).version
    expect((await services.recordEngine.act(bob, AI, m4, 'start_reading', { expectedVersion: versionOf(m4) })).ok).toBe(true)
    expect((await services.recordEngine.act(bob, AI, m4, 'finish_reading', { expectedVersion: versionOf(m4), args: { summary_text: '見積もり' } })).ok).toBe(true)
    services.jobOccurrences.makeOccurrences(CO)
    services.jobOccurrences.makeOccurrences(CO)
    expect(occurrences().map(o => o.event_record_id)).toEqual([m.meetings.m2, m4])
    expect(markOf(m4)).toMatchObject({ outcome: 'made' })
  })
})
