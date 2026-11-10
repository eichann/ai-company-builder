/**
 * Integration Test: a run's subject kind (B 「実行を記録から分ける」 PR 2; ai-turns.md "Execution runs
 * on the server"). Nothing claims a run of another kind yet, so those runs are put into the database
 * directly, as B PR 3 will make them.
 *
 * Guards (each mutation-checked):
 * - the app's claim, unchanged in shape, makes a record's run;
 * - the member's list of open runs (`GET /ai-runs`, what released apps read) never shows a run of
 *   another kind, and such a run answers no record id;
 * - a run of another kind never binds a record token, and reaches no record route, whatever build calls;
 * - one run per subject: another kind's live run on the same id does not block a record's claim;
 * - each state change of a run is kept in `ai_run_events` — claim, finish, 「もう一度」, reconcile, the
 *   emergency stop's refusals (once per generation) — with short codes only.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'

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
import { recordsRoute } from '../../src/routes/records'
import { recordsAiRoute } from '../../src/routes/records-ai'
import { aiRunsRoute } from '../../src/routes/ai-runs'
import { services } from '../../src/composition'

const app = new Hono()
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/records-ai', recordsAiRoute)

const CO = 'kind-co'
const ts = () => new Date().toISOString()
const MINUTE = 60_000
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const bob = { companyId: CO, userId: 'u-bob', role: 'member' }
const owner = { companyId: CO, userId: 'u-owner', role: 'owner' }

async function call(opts: { user?: string | null; token?: string; key?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.key) headers['Idempotency-Key'] = opts.key
  const res = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const session = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `/api/companies/${CO}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown, key?: string) => call({ token, key, method, path: `/api/records-ai${path}`, body })
const claim = (recordId: string, deviceId: string, step = 'task-prep') =>
  session('u-bob', 'POST', '/ai-run-claims', { recordId, step, deviceId, conversationId: `conv-${deviceId}` })

async function preparingTask(title: string): Promise<string> {
  const r = await session('u-bob', 'POST', '/records/item', { type: 'task', title, state: 'preparing', fields: { assignee: 'u-bob' } })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.record.id
}

/** A run of another kind (a job's occurrence, B PR 3), bob's, as the database would hold it. */
function occurrenceRun(id: string, subjectId: string, opts: { step?: string; state?: string; live?: boolean } = {}) {
  const at = ts()
  db.prepare(`INSERT INTO ai_runs (company_id, id, subject_kind, record_id, step, user_id, state, generation, device_id, conversation_id,
      claim_expires_at, attempts, created_at, updated_at, closed_at) VALUES (?, ?, 'occurrence', ?, ?, 'u-bob', ?, 1, 'device-job', ?, ?, 0, ?, ?, NULL)`)
    .run(CO, id, subjectId, opts.step ?? 'job-run', opts.state ?? 'running', `conv-${id}`, opts.live === false ? null : new Date(Date.now() + 4 * MINUTE).toISOString(), at, at)
}

const eventsOf = (runId: string) => db.prepare('SELECT event, generation, state_after, code FROM ai_run_events WHERE company_id = ? AND run_id = ? ORDER BY seq')
  .all(CO, runId) as Array<{ event: string; generation: number; state_after: string | null; code: string | null }>

beforeAll(async () => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', ts(), ts())
  for (const [user, role] of [['u-owner', 'owner'], ['u-bob', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${CO}-${user}`, user, CO, role, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  currentUser.id = 'u-owner'
  await app.request(`/api/companies/${CO}/records/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
  await services.records.refreshIndex(owner)
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => { vi.setSystemTime(Date.now()) })

describe('a run\'s subject kind', () => {
  it('the app\'s claim, unchanged in shape, makes a record\'s run', async () => {
    const id = await preparingTask('対象の種類')
    const r = await claim(id, 'device-aaaa')
    expect(r.status).toBe(201)
    expect(r.body.data.run).toMatchObject({ recordId: id, subject: { kind: 'record', id } })
    expect(db.prepare('SELECT subject_kind, record_id FROM ai_runs WHERE company_id = ? AND id = ?').get(CO, r.body.data.run.id)).toEqual({ subject_kind: 'record', record_id: id })
  })

  it('the member\'s list of open runs never shows a run of another kind, and such a run answers no record id', async () => {
    const id = await preparingTask('一覧には記録だけ')
    const record = (await claim(id, 'device-list')).body.data.run
    occurrenceRun('run-occ-list', 'occ-0001')
    const listed = (await session('u-bob', 'GET', '/ai-runs')).body.data.runs as Json[]
    expect(listed.map(r => r.id)).toContain(record.id)
    expect(listed.map(r => r.id)).not.toContain('run-occ-list')
    expect(listed.every(r => r.subject.kind === 'record')).toBe(true)
    const own = await session('u-bob', 'GET', '/ai-runs/run-occ-list')
    expect(own.body.data.run).toMatchObject({ recordId: '', subject: { kind: 'occurrence', id: 'occ-0001' } })
  })

  it('a run of another kind binds no record token and reaches no record route, whatever build calls', async () => {
    const id = await preparingTask('記録の道具には届かない')
    // Even an id that is a record in the AI's turn: the kind decides, not the id.
    occurrenceRun('run-occ-token', id, { step: 'job-token' })
    const bound = await session('u-bob', 'POST', '/me/record-tokens', { conversationId: 'conv-run-occ-token', agent: 'claude-code', scope: 'act', run: { id: 'run-occ-token', generation: 1 } })
    expect(bound).toMatchObject({ status: 404, body: { code: 'RUN_NOT_FOUND' } })
    for (const build of [null, '0.0.1+abc1234.20261101000000', '0.0.1+abc1234.20991231000000']) {
      expect(services.aiRuns.routeRefusal(bob, 'run-occ-token', 'GET /types', {}, build)).toMatchObject({ ok: false, body: { code: 'NOT_IN_STEP' } })
    }
    // The control: a record's run of a released app is not scoped.
    const record = (await claim(id, 'device-token')).body.data.run
    expect(services.aiRuns.routeRefusal(bob, record.id, 'GET /types', {}, null)).toBeNull()
  })

  it('one run per subject: another kind\'s live run on the same id does not block a record\'s claim', async () => {
    const id = await preparingTask('ほかの種類とは別')
    occurrenceRun('run-occ-same-id', id, { step: 'job-same' })
    const r = await claim(id, 'device-same')
    expect(r.status).toBe(201)
    expect(r.body.data.run.subject).toEqual({ kind: 'record', id })
  })
})

describe('ai_run_events: each state change of a run, short codes only', () => {
  const stop = (body: { userId?: string }) => {
    const before = new Set(services.agentStops.get(owner).value!.active.map(s => s.id))
    const after = services.agentStops.stop(owner, body)
    if (!after.ok) throw new Error(JSON.stringify(after.body))
    return () => { for (const s of after.value.active) if (!before.has(s.id)) services.agentStops.release(owner, s.id) }
  }

  it('claim, finish, 「もう一度」, re-claim and finish are kept in order', async () => {
    const id = await preparingTask('経緯を残す')
    const run = (await claim(id, 'device-ev01')).body.data.run
    expect((await session('u-bob', 'POST', `/ai-runs/${run.id}/finish`, { generation: 1, outcome: 'failed', failure: { class: 'bad-input', code: 'NO_DATE' } })).status).toBe(200)
    expect((await session('u-bob', 'POST', `/ai-runs/${run.id}/retry`)).status).toBe(200)
    expect((await claim(id, 'device-ev02')).status).toBe(200)
    expect((await session('u-bob', 'POST', `/ai-runs/${run.id}/finish`, { generation: 2, outcome: 'done' })).status).toBe(200)
    expect(eventsOf(run.id)).toEqual([
      { event: 'claimed', generation: 1, state_after: 'running', code: null },
      { event: 'finished', generation: 1, state_after: 'waiting_person', code: 'NO_DATE' },
      { event: 'given_back', generation: 1, state_after: 'open', code: 'RETRY' },
      { event: 'claimed', generation: 2, state_after: 'running', code: null },
      { event: 'finished', generation: 2, state_after: 'done', code: null },
    ])
  })

  it('a person asking for the step anew (［AI に読ませる］) gives a waiting run back, and that is kept', async () => {
    const id = await preparingTask('もう一度読ませる')
    const run = (await claim(id, 'device-ev07')).body.data.run
    expect((await session('u-bob', 'POST', `/ai-runs/${run.id}/finish`, { generation: 1, outcome: 'failed', failure: { class: 'bad-input', code: 'NO_TEXT' } })).status).toBe(200)
    services.aiRuns.askedAgain(CO, id, 'task-prep')
    expect(eventsOf(run.id).at(-1)).toEqual({ event: 'given_back', generation: 1, state_after: 'open', code: 'ASKED_AGAIN' })
  })

  it('a key of unknown result: the re-claim that finds it and the person\'s reconciliation are kept', async () => {
    const id = await preparingTask('結果が分からない')
    const run = (await claim(id, 'device-ev03')).body.data.run
    db.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, created_at, updated_at)
      VALUES (?, ?, 'k-1', 'fp', 'record-create', 'in_progress', 1, ?, ?)`).run(CO, run.id, ts(), ts())
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    expect(await claim(id, 'device-ev04')).toMatchObject({ status: 409, body: { code: 'RUN_NEEDS_RECONCILE' } })
    expect((await session('u-bob', 'POST', `/ai-runs/${run.id}/operations/k-1/reconcile`, { done: true })).status).toBe(200)
    expect(eventsOf(run.id).slice(1)).toEqual([
      { event: 'claimed', generation: 1, state_after: 'waiting_reconcile', code: 'RESULT_UNKNOWN' },
      { event: 'reconciled', generation: 1, state_after: 'open', code: 'DONE' },
    ])
  })

  it('the emergency stop: a running run\'s token refused (kept once per generation) and a refused re-claim of a waiting run', async () => {
    const id = await preparingTask('止められた')
    const run = (await claim(id, 'device-ev05')).body.data.run
    const token = (await session('u-bob', 'POST', '/me/record-tokens', { conversationId: run.conversationId, agent: 'claude-code', scope: 'act', run: { id: run.id, generation: 1 } })).body.data.token as string
    const release = stop({ userId: 'u-bob' })
    try {
      expect((await ai(token, 'GET', `/item/${id}`)).status).toBe(503)
      expect((await ai(token, 'GET', `/item/${id}`)).status).toBe(503)
    } finally { release() }
    expect((await session('u-bob', 'POST', `/ai-runs/${run.id}/finish`, { generation: 1, outcome: 'failed', failure: { class: 'temporary' } })).status).toBe(200)
    vi.setSystemTime(Date.now() + 6 * MINUTE)
    const again = stop({})
    try {
      // The app's runner asks again on every pass: kept once for this generation, not once per pass.
      expect((await claim(id, 'device-ev06')).status).toBe(503)
      expect((await claim(id, 'device-ev06')).status).toBe(503)
      expect((await claim(id, 'device-ev06')).status).toBe(503)
    } finally { again() }
    expect(eventsOf(run.id)).toEqual([
      { event: 'claimed', generation: 1, state_after: 'running', code: null },
      { event: 'refused_stopped', generation: 1, state_after: null, code: 'AI_STOPPED' },
      { event: 'finished', generation: 1, state_after: 'retry_later', code: null },
      { event: 'refused_stopped', generation: 1, state_after: null, code: 'AI_STOPPED' },
    ])
  })

  it('every event holds only short codes (no text column exists to hold a reason)', () => {
    const columns = (db.prepare('SELECT name FROM pragma_table_info(?)').all('ai_run_events') as Array<{ name: string }>).map(c => c.name)
    expect(columns).toEqual(['company_id', 'run_id', 'seq', 'at', 'event', 'generation', 'state_after', 'code'])
    const codes = (db.prepare('SELECT code FROM ai_run_events WHERE code IS NOT NULL').all() as Array<{ code: string }>).map(r => r.code)
    expect(codes.length).toBeGreaterThan(0)
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9_]{1,60}$/)
    const runId = (db.prepare('SELECT run_id FROM ai_run_events LIMIT 1').get() as { run_id: string }).run_id
    expect(() => db.prepare(`INSERT INTO ai_run_events (company_id, run_id, seq, at, event, generation, code) VALUES (?, ?, 999, ?, 'finished', 1, ?)`)
      .run(CO, runId, ts(), '顧客の名前')).toThrow(/CHECK/)
  })
})
