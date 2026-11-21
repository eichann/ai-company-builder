/**
 * Cross-build check, step 1 of 3 (this build): a database as 4b-1 leaves it in production — event jobs run by the PC
 * (schema 3), a running event run with a Drive put in flight and a receipt, an occurrence whose outside result nobody
 * knows (its chain stopped, its notices written), a watch that moved to the やること a run made and a waiting occurrence of
 * the new watch. Step 2 runs the rollback floor's code on it, step 3 this build again (.github/scripts/rollback-floor-check.sh).
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

    saveDb(db, { CO, jobs: { j1: j1.job, j2: j2.job, j3: j3.job }, occ: { o1, o3, o4 }, runs: { r1: r1.id, r4: r4.id }, before: crossBuildSnapshot(db, CO) })
  })
})
