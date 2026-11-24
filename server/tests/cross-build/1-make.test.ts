/**
 * Cross-build check, step 1 of 3 (this build): a database as 4b-1 leaves it in production — event jobs run by the PC
 * (schema 3), a running event run with a Drive put in flight and a receipt, an occurrence whose outside result nobody
 * knows (its chain stopped, its notices written), a watch that moved to the やること a run made and a waiting occurrence of
 * the new watch; and a server event job (schema 2) whose chain stopped days ago and whose stop notice this build brought
 * back once (its reminder). Step 2 runs the rollback floor's code on it, step 3 this build again (.github/scripts/rollback-floor-check.sh).
 * Skipped unless `ACB_CROSS_BUILD_DB` names the file.
 */
import { CROSS_DB, saveDb } from './use-db'
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
import { companiesRoute } from '../../src/routes/companies'
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { jobsRoute } from '../../src/routes/jobs'
import { services } from '../../src/composition'
import { crossBuildSnapshot } from './snapshot'
import { createServiceRecordWriter } from '../../src/services/record-engine'
import { meetingOutputId } from '../../src/services/meeting-outputs'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { randomIds, sha256TokenDigest } from '../../src/adapters/system'
import { hashCanonical } from '../../src/lib/content-hash'
import { canonicalJson } from '../../../shared/core/fixed-content'
import { MINUTES_REVIEW_KEY } from '../../../shared/core/core-types'
import { JOB_MINUTES_ROUTE, JOB_SET_WATCH_OPENED, jobConsentCanonical, parseJobDefinition, type JobDefinition } from '../../../shared/core/jobs'
import { setWatchProposalDefinition } from '../../../shared/core/job-proposals'
import { versionRow } from '../../src/services/jobs'

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', jobsRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const READS_3 = [1, 2, 3]
const HUMAN = { kind: 'human' as const }

async function call(user: string, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const ok = <T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

describe.skipIf(!CROSS_DB)('cross-build 1/3: a database as 4b-1 leaves it', () => {
  it('is made by this build and handed on', async () => {
    initDatabase()
    process.env.OPERATOR_USER_IDS = 'xb-owner'
    const made = await call('xb-owner', 'POST', '/api/companies', { name: 'Cross Build Co', folderKind: 'none' })
    expect(made.status).toBe(201)
    const CO: string = made.body.data.id
    const at = new Date().toISOString()
    for (const [user, role] of [['xb-alice', 'member'], ['xb-bob', 'member'], ['xb-admin', 'admin']]) {
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, at, at)
    }
    const owner = { companyId: CO, userId: 'xb-owner', role: 'owner' }
    const alice = { companyId: CO, userId: 'xb-alice', role: 'member' }
    const as = (user: string, method: string, path: string, body?: unknown) => call(user, method, `/api/companies/${CO}${path}`, body)
    const item = ok(services.skillShelf.publish(owner, { kind: 'skill', departmentId: null, name: 'interview-report', files: [{ path: 'SKILL.md', base64: Buffer.from('# 面談報告書\n下書きを作る。').toString('base64') }], expectedVersion: null })).item.id
    const task = (title: string) => ok(services.recordEngine.create(alice, HUMAN, { type: 'task', title, fields: { assignee: 'xb-alice' } })).record.id
    const versionOf = (id: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).version
    const complete = async (id: string) => ok(await services.recordEngine.act(alice, HUMAN, id, 'complete', { expectedVersion: versionOf(id) }))
    const reopen = async (id: string) => ok(await services.recordEngine.act(alice, HUMAN, id, 'reopen', { expectedVersion: versionOf(id) }))
    const tick = () => services.jobOccurrences.makeOccurrences(CO)
    async function eventJob(name: string): Promise<{ job: string; start: string }> {
      const start = task(`${name}の面談`)
      const definition = {
        schema: 3, name, actingUser: 'xb-alice',
        trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: start, followMadeTask: true },
        check: { kind: 'source_record', doneMark: 'none' },
        run: { kind: 'procedure', procedure: { source: 'shelf_skill', item } },
        placement: 'a', missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
        grant: { tools: ['records'], creates: ['task'], routes: ['GET /item/:recordId'], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 5 } },
      }
      const job = ok(await services.jobs.create(owner, { definition }, READS_3)).id
      ok(await services.jobs.approve(owner, job, { version: 1 }, READS_3))
      ok(await services.jobs.accept(alice, job, { version: 1 }, READS_3, true))
      await complete(start)
      tick()
      return { job, start }
    }
    const occurrenceOf = (job: string, state: string) => (db.prepare('SELECT id FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? AND state = ?').get(CO, job, state) as Json).id as string
    const claim = async (occ: string, device: string) => {
      const r = await as('xb-alice', 'POST', '/job-run-claims', { occurrenceId: occ, deviceId: device, conversationId: `conv-${device}`, checks: ['source_record'], kinds: ['event'] })
      expect(r.status).toBe(201)
      return r.body.data.run as Json
    }
    const op = (runId: string, key: string, state: string, ref: string | null) => {
      const now = new Date().toISOString()
      db.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, ref_kind, ref_id, created_at, updated_at)
        VALUES (?, ?, ?, 'f', 'drive-put', ?, 1, ?, ?, ?, ?)`).run(CO, runId, key, state, ref ? 'drive-put' : null, ref, now, now)
    }

    // J4: a server event job (schema 2, which the floor runs too) whose chain stopped four days ago (completed while
    // paused); alice read the stop notice. This build's clock brings her notice back once (the reminder) — the floor
    // must show that row as the stop notice it always was, and nothing reminds it twice.
    const DAY = 24 * 60 * 60_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() - 4 * DAY)
    let j4: string
    let j4Stop: string
    try {
      const start = task('面談の日程')
      const definition = {
        schema: 2, name: '日程の次', actingUser: 'xb-alice',
        trigger: { kind: 'record', type: 'task', event: 'state', to: 'done', assignee: 'responsible', startRecord: start, followMadeTask: true },
        check: { kind: 'none' }, run: { kind: 'operation', operation: 'create_task', title: '次の日程を決める', dueBusinessDays: null },
        placement: 'e', missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
        grant: { tools: [], creates: ['task'], routes: [], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 5, runsPerDay: 5 } },
      }
      j4 = ok(await services.jobs.create(owner, { definition }, READS_3)).id
      ok(await services.jobs.approve(owner, j4, { version: 1 }, READS_3))
      ok(await services.jobs.accept(alice, j4, { version: 1 }, READS_3, true))
      ok(services.jobs.pause(owner, j4))
      await complete(start)
      ok(await services.jobs.resume(owner, j4))
      tick()
      j4Stop = (db.prepare('SELECT chain_stop_at AS at FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?').get(CO, j4) as Json).at
      expect(j4Stop).not.toBeNull()
      ok(services.notifications.markRead(alice, { all: true }))
    } finally {
      vi.useRealTimers()
    }
    tick()
    const j4Rows = () => db.prepare("SELECT user_id, action, read_at IS NULL AS unread FROM notifications WHERE company_id = ? AND dedupe_key = ? ORDER BY user_id")
      .all(CO, `job_chain_stopped:${j4}:${j4Stop}`)
    // Alice's is back (unread, marked); the creator's (the owner reads the record) is as it was.
    expect(j4Rows()).toEqual([{ user_id: 'xb-alice', action: 'reminded', unread: 1 }, { user_id: 'xb-owner', action: '', unread: 1 }])

    // J1: running, a put done (its receipt) and another in flight.
    const j1 = await eventJob('報告書A')
    const o1 = occurrenceOf(j1.job, 'due')
    const r1 = await claim(o1, 'device-xb-1')
    op(r1.id, 'put-0', 'done', 'drive-put-xb-0')
    op(r1.id, 'put-1', 'in_progress', null)
    db.prepare(`INSERT INTO google_drive_puts (id, company_id, user_id, request_key, actor_kind, conversation_id, run_id, folder_id, folder_name, name, mime_type, bytes, sha256,
      state, file_id, revision_id, link, reason, created_at, finished_at) VALUES ('drive-put-xb-0', ?, 'xb-alice', 'key-xb-0', 'ai', 'conv-device-xb-1', ?, 'folder-1', '報告書',
      '面談報告書.docx', 'application/vnd.google-apps.document', 1200, 'sha', 'done', 'file-1', 'rev-1', 'https://docs.example/file-1', NULL, ?, ?)`).run(CO, r1.id, at, at)

    // J2: done with its やること (the watch moved to it), and that やること completed: a waiting occurrence of the new watch.
    const j2 = await eventJob('報告書B')
    const r2 = await claim(occurrenceOf(j2.job, 'due'), 'device-xb-2')
    expect((await as('xb-alice', 'POST', `/ai-runs/${r2.id}/finish`, { generation: r2.generation, outcome: 'done', jobResult: { title: '次の報告' } })).status).toBe(200)
    const t2 = (db.prepare('SELECT watch_record_id AS w FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?').get(CO, j2.job) as Json).w as string
    await complete(t2)
    tick()
    const o3 = occurrenceOf(j2.job, 'due')

    // J3: undone while a put was in flight — its result unknown, the chain stopped, the notices written.
    const j3 = await eventJob('報告書C')
    const o4 = occurrenceOf(j3.job, 'due')
    const r4 = await claim(o4, 'device-xb-4')
    op(r4.id, 'put-1', 'in_progress', null)
    await reopen(j3.start)
    tick()
    expect(db.prepare('SELECT state, outcome_code FROM ai_job_occurrences WHERE company_id = ? AND id = ?').get(CO, o4)).toEqual({ state: 'needs_person', outcome_code: 'RESULT_UNKNOWN' })
    expect((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND kind IN ('job_failed', 'job_chain_stopped')").get(CO) as Json).n).toBeGreaterThan(0)

    expect(j4Rows()).toEqual([{ user_id: 'xb-alice', action: 'reminded', unread: 1 }, { user_id: 'xb-owner', action: '', unread: 1 }])

    // P1–P3: alice's proposals of a time job from her AI chat (jobs.md "Member proposals", schema 4) — one waiting for the
    // owner / admins (their notices written), one she withdrew (its job retired), one approved (not accepted yet). The floor
    // knows no schema 4: it must show their names only, refuse to edit, approve or accept them and run nothing; back here, the
    // withdrawn one stays withdrawn and a resend adds nothing.
    const bob = { companyId: CO, userId: 'xb-bob', role: 'member' }
    const proposal = async (who: typeof alice) => {
      const c = ok(await services.jobProposals.createCandidate(who, null, {
        skill: item, trigger: { every: 'month', day: 28, at: '03:00', ifHoliday: 'as_is' }, check: { kind: 'new_meetings' }, reads: [], deliverable: null,
        readRecords: true, mailDrafts: false, minutes: 15, missed: { policy: 'latest_only', expiresAfterMinutes: 1440 },
      }))
      return { candidate: c.id, fingerprint: c.fingerprint as string, ...ok(await services.jobProposals.submit(who, c.id, { fingerprint: c.fingerprint })).proposal }
    }
    const p1 = await proposal(alice)
    const p2 = await proposal(alice)
    ok(services.jobProposals.withdraw(alice, p2.id))
    const p3 = await proposal(bob)
    const fp3 = (db.prepare('SELECT fingerprint FROM ai_job_versions WHERE company_id = ? AND job_id = ? AND version = 1').get(CO, p3.jobId) as Json).fingerprint
    ok(await services.jobs.approve(owner, p3.jobId, { version: 1, fingerprint: fp3 }, [1, 2, 3, 4]))
    // P4: bob's, returned by the owner — its proposer is told (`job_proposal_returned`, a kind the floor does not know).
    const p4 = await proposal(bob)
    ok(services.jobProposals.returnProposal(owner, p4.id, { reason: 'TOO_BROAD' }))
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND kind = 'job_proposal'").get(CO)).toEqual({ n: 8 })
    expect(db.prepare("SELECT user_id FROM notifications WHERE company_id = ? AND kind = 'job_proposal_returned'").all(CO)).toEqual([{ user_id: 'xb-bob' }])
    const proposals = { p1, p2, p3, p4 }

    // S1: alice's set watch (schema 5, 4b-4 PR2: 「自分が担当の『議事録を確認する』を初めて完了したとき」) whose scan made an occurrence
    // for a meeting she read and reviewed, its 「使った」 mark written. Written as this build stores it (a company without the
    // shared folder cannot pin a department Skill through the API: the version is inserted as the API would have made it). The
    // floor knows no schema 5: it must show, tell, claim, run and expire nothing of it; a stop holds it; back here the mark and
    // the occurrence are as they were, and nothing is made twice.
    const now = new Date().toISOString()
    const tree = (c: string) => c.repeat(40)
    const setDefinition = {
      schema: 5, name: '提案書のたたき台', actingUser: 'xb-alice', trigger: JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED[0])), check: { kind: 'matched_record' },
      run: { kind: 'procedure', procedure: { source: 'department_skill', place: '法人ソリューション', skill: 'sales-proposal-auto', fingerprint: tree('a') } },
      placement: 'a', missed: { policy: 'skip', expiresAfterMinutes: 1440 },
      grant: {
        tools: ['records'], creates: ['task'], routes: [JOB_MINUTES_ROUTE],
        reads: { paths: [], calls: [], skills: [{ place: '法人ソリューション', skill: 'sales-proposal-v1', fingerprint: tree('b') }] },
        writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 10 },
      },
      decision: { reasons: [{ code: 'requested', label: '提案を求められた' }] },
    }
    const s1 = `job.${'5'.repeat(32)}`
    const text = canonicalJson(setDefinition)
    const consent = hashCanonical(jobConsentCanonical(setDefinition as unknown as JobDefinition))
    db.prepare(`INSERT INTO ai_jobs (company_id, id, name, state, acting_user_id, latest_version, approved_version, approved_fingerprint, accepted_version, accepted_consent,
        created_by, created_at, updated_at) VALUES (?, ?, '提案書のたたき台', 'active', 'xb-alice', 1, 1, ?, 1, ?, 'xb-owner', ?, ?)`).run(CO, s1, hashCanonical(text), consent, now, now)
    db.prepare(`INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at,
        approved_by, approved_at, accepted_by, accepted_at) VALUES (?, ?, 1, 5, ?, ?, ?, 'xb-alice', 'xb-owner', ?, 'xb-owner', ?, 'xb-alice', ?)`)
      .run(CO, s1, text, hashCanonical(text), consent, now, now, now)
    sqliteCompanyData(db).forCompany(CO).jobs.startSetCursor(s1, now)
    const roleOf = (co: string, user: string) => sqliteMembershipRepository(db).roleOf(co, user)
    const writer = createServiceRecordWriter({
      companyData: sqliteCompanyData(db), transactions: sqliteTransactions(db), clock: { now: () => new Date().toISOString(), nowMs: () => Date.now() }, ids: randomIds,
      isMember: (co, user) => roleOf(co, user) !== null, roleOf, notify: () => {}, recordChanged: () => {},
    })
    const meeting = writer.create(CO, {
      type: 'meeting', title: 'A社 初回の商談', state: 'received', members: ['xb-alice', 'xb-bob'],
      fields: { assignee: 'xb-alice', attendees: JSON.stringify(['xb-alice', 'xb-bob']), external_count: 1, meeting_at: now },
      actor: { id: 'google', kind: 'external', source: 'google' }, quiet: true,
    })
    if (!meeting.ok) throw new Error(meeting.reason)
    const AI = { kind: 'ai' as const, source: 'claude' }
    ok(await services.recordEngine.act(alice, AI, meeting.record.id, 'start_reading', { expectedVersion: versionOf(meeting.record.id) }))
    ok(await services.recordEngine.act(alice, AI, meeting.record.id, 'finish_reading', { expectedVersion: versionOf(meeting.record.id), args: { summary_text: '提案書を送る' } }))
    const review = meetingOutputId(sha256TokenDigest, 'task', meeting.record.id, MINUTES_REVIEW_KEY)
    await complete(review)
    tick()
    const o5 = occurrenceOf(s1, 'due')
    expect(db.prepare('SELECT outcome FROM ai_job_meeting_reviews WHERE company_id = ? AND record_id = ?').get(CO, review)).toEqual({ outcome: 'made' })
    // Alice's app (PR5) claims it here: its run is held when production goes back to the floor, which must refuse its report —
    // also one with an update count (4b-4 PR3b) — and make nothing of it.
    const c5 = await as('xb-alice', 'POST', '/job-run-claims', { occurrenceId: o5, deviceId: 'device-xb-5', conversationId: 'c-xb-5', checks: ['matched_record'], kinds: ['event'] })
    expect(c5.status).toBe(201)
    const r5 = c5.body.data.run

    // P5: bob's set watch proposed from the app (schema 5 through the proposals' path, 4b-4 PR6b), waiting for an owner / admin.
    // Written as this build stores it (this company has no shared folder to pin department Skills from): its candidate, the
    // draft job and the proposal. The floor knows no schema 5 and no proposals: it must show its name only and approve nothing;
    // back here the candidate reads back as schema 5 and a resend adds nothing.
    const p5Def = setWatchProposalDefinition({ trigger: JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED[0])), skill: { place: '法人ソリューション', skill: 'sales-proposal-auto' }, readSkills: [] }, 'xb-bob')
    ;(p5Def.run as Json).procedure.fingerprint = tree('c')
    p5Def.decision = { reasons: [{ code: 'requested', label: '提案を求められた' }] }
    const p5Parsed = parseJobDefinition(p5Def)
    if (!p5Parsed.ok) throw new Error(p5Parsed.problems.join(','))
    const p5Text = canonicalJson(p5Parsed.definition)
    const p5 = { candidate: `jc.${'c5'.repeat(16)}`, id: `jp.${'d5'.repeat(16)}`, jobId: `job.${'e5'.repeat(16)}`, fingerprint: hashCanonical(p5Text) }
    const handle = sqliteCompanyData(db).forCompany(CO)
    handle.jobs.insertCandidate({ id: p5.candidate, createdBy: 'xb-bob', definition: p5Text, fingerprint: p5.fingerprint, createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    handle.jobs.create({
      id: p5.jobId, name: p5Parsed.definition.name, state: 'draft', actingUserId: 'xb-bob', latestVersion: 1, approvedVersion: null, approvedFingerprint: null,
      acceptedVersion: null, acceptedConsent: null, acceptedPlace: null, pausedReason: null, pausedBy: null, pausedAt: null, createdBy: 'xb-bob', createdAt: now, updatedAt: now,
    }, versionRow(p5.jobId, 1, p5Parsed.definition, p5Text, 'xb-bob', now))
    handle.jobs.insertProposal({
      id: p5.id, jobId: p5.jobId, proposerId: 'xb-bob', candidateId: p5.candidate, submittedVersion: 1, submittedFingerprint: p5.fingerprint,
      state: 'submitted', returnReason: null, decidedBy: null, decidedAt: null, createdAt: now, updatedAt: now,
    })
    expect(ok(services.jobProposals.candidate(bob, p5.candidate)).definition.schema).toBe(5)

    saveDb(db, { CO, j4: { job: j4, stop: j4Stop }, jobs: { j1: j1.job, j2: j2.job, j3: j3.job, s1 }, occ: { o1, o3, o4, o5 }, runs: { r1: r1.id, r4: r4.id, r5: { id: r5.id, generation: r5.generation } }, proposals: { ...proposals, p5 }, before: crossBuildSnapshot(db, CO) })
  })
})
