/**
 * Integration Test: execution runs of 「AI の番」 (stage 2 S10b,
 * `.claude/rules/records.md` "Execution runs"): the server stores and checks
 * who runs a record's AI step; the AI runs on the member's PC.
 *
 * Guards (each mutation-checked):
 * - two app instances claiming the same step at once → exactly one claim;
 * - after a re-claim, every call with the older generation's token is refused
 *   and writes nothing (fencing), and its renewal is refused;
 * - the same idempotency key twice → one effect (the second answers what the
 *   first made); a run-bound create without a key is refused; a key is never
 *   reused for another request;
 * - an outside result that is unknown (a lost answer, or still in flight when
 *   the claim was taken over) blocks resuming until a person reconciles it,
 *   and the key is not run again;
 * - each failure class goes to its own place; none goes back to 「AI の番」
 *   without a person (temporary: only after its wait);
 * - the ledger says who caused a change: a person, their AI in a
 *   consultation, an automated run;
 * - an automated run's entries say which procedure it used (the step, the app
 *   build that claimed, the plugins on then — read by the server), copied when
 *   written: a later re-claim under a newer app or plugin never changes an
 *   earlier entry; a person's and a consultation's entries carry none;
 * - another member's or another company's run is a missing one.
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

const CO = 'run-co'
const OTHER = 'run-other'
const ts = () => new Date().toISOString()
const MINUTE = 60_000
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function call(opts: { user?: string | null; token?: string; key?: string; method: string; path: string; body?: unknown; headers?: Record<string, string> }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.key) headers['Idempotency-Key'] = opts.key
  const res = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const session = (user: string, method: string, path: string, body?: unknown, company = CO) => call({ user, method, path: `/api/companies/${company}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown, key?: string) => call({ token, key, method, path: `/api/records-ai${path}`, body })

const claim = (user: string, recordId: string, deviceId: string, conversationId = `conv-${deviceId}`) =>
  session(user, 'POST', '/ai-run-claims', { recordId, step: 'task-prep', deviceId, conversationId, stepsVersion: 'steps-1' })

async function runToken(user: string, run: { id: string; generation: number; conversationId: string }) {
  const r = await session(user, 'POST', '/me/record-tokens', { conversationId: run.conversationId, agent: 'claude-code', scope: 'act', run: { id: run.id, generation: run.generation } })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.token as string
}

/** A task in `preparing` (the AI's turn) assigned to bob. */
async function preparingTask(title: string, company = CO): Promise<string> {
  const r = await session('u-bob', 'POST', '/records/item', { type: 'task', title, state: 'preparing', fields: { assignee: 'u-bob' } }, company)
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.record.id
}
const ledger = async (id: string) => (await session('u-bob', 'GET', `/records/item/${id}/history`)).body.data.entries as Json[]
const later = (ms: number) => vi.setSystemTime(Date.now() + ms)

beforeAll(async () => {
  initDatabase()
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', ts(), ts())
    for (const [user, role] of [['u-owner', 'owner'], ['u-bob', 'member'], ['u-carol', 'member']]) {
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${user}`, user, co, role, ts(), ts())
    }
    const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
    ensureCompanyScope(db, co)
    currentUser.id = 'u-owner'
    await app.request(`/api/companies/${co}/records/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    await services.records.refreshIndex({ companyId: co, userId: 'u-owner', role: 'owner' })
  }
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => { later(0) })

describe('claiming a record’s AI step', () => {
  it('two app instances at once → exactly one claim; the other is told someone is running it', async () => {
    const id = await preparingTask('見積の下ごしらえ')
    const answers = await Promise.all([claim('u-bob', id, 'device-aaaa'), claim('u-bob', id, 'device-bbbb')])
    expect(answers.map(a => a.status).sort()).toEqual([201, 409])
    expect(answers.find(a => a.status === 409)!.body.code).toBe('RUN_CLAIMED')
    expect(answers.find(a => a.status === 201)!.body.data.run).toMatchObject({ state: 'running', generation: 1, stepsVersion: 'steps-1' })
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE company_id = ? AND record_id = ?').get(CO, id) as { n: number }).n).toBe(1)
  })

  it('only a record in the member’s 「AI の番」: someone else’s or one not in the AI’s turn cannot be claimed', async () => {
    const id = await preparingTask('段取りを考える')
    expect(await claim('u-carol', id, 'device-cccc')).toMatchObject({ status: 409, body: { code: 'NOT_AI_TURN' } })
    const todo = await session('u-bob', 'POST', '/records/item', { type: 'task', title: '人の番', fields: { assignee: 'u-bob' } })
    expect(await claim('u-bob', todo.body.data.record.id, 'device-aaaa')).toMatchObject({ status: 409, body: { code: 'NOT_AI_TURN' } })
  })
})

describe('one run per record', () => {
  it('a live claim of one step refuses another step of the same record, naming neither; once that claim expired, the other step may run', async () => {
    const id = await preparingTask('ひとつの記録に二つの手順')
    expect((await claim('u-bob', id, 'device-aaaa')).status).toBe(201)
    const core = (deviceId: string) => session('u-bob', 'POST', '/ai-run-claims', { recordId: id, step: 'task-other', deviceId, conversationId: `conv-${deviceId}` })
    // The same PC or another: refused while the first claim lives (a plugin's step goes through the same check).
    for (const answer of [await core('device-aaaa'), await core('device-bbbb')]) {
      expect(answer).toMatchObject({ status: 409, body: { code: 'RUN_CLAIMED' } })
      expect(answer.body).not.toHaveProperty('run')
      expect(JSON.stringify(answer.body)).not.toContain('task-prep')
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE company_id = ? AND record_id = ?').get(CO, id) as { n: number }).n).toBe(1)
    later(6 * MINUTE)
    expect((await core('device-bbbb')).status).toBe(201)
  })
})

describe('a task whose wait is over (the PC\'s task-wait-over step)', () => {
  it('only a task the clock put in 準備中 is listed as such and claimable by that step; one a consultation made in 準備中 is not', async () => {
    const made = await preparingTask('相談で作った下ごしらえ')
    const t = await session('u-bob', 'POST', '/records/item', { type: 'task', title: '見積の返事', fields: { assignee: 'u-bob' } })
    const id = t.body.data.record.id as string
    // Task version 12: the 見込み goes with the wait (one action).
    expect((await session('u-bob', 'POST', `/records/item/${id}/actions/wait`, { expectedVersion: 1, args: { waiting_on: '先方の見積', wait_until: '2020-01-06' } })).status).toBe(200)
    // 自動で進める is on by default: the clock moves it to the AI's turn.
    await services.serverClock.runOnce()
    const list = (await session('u-bob', 'GET', '/records/ai-turn')).body.data.records as Json[]
    expect(list.find(r => r.id === id)).toMatchObject({ state: 'preparing', waitOver: true })
    expect(list.find(r => r.id === made)).not.toHaveProperty('waitOver')

    const wait = (recordId: string, deviceId: string) => session('u-bob', 'POST', '/ai-run-claims', { recordId, step: 'task-wait-over', deviceId, conversationId: `conv-${deviceId}` })
    expect(await wait(made, 'device-wwww')).toMatchObject({ status: 409, body: { code: 'NOT_AI_TURN' } })
    expect((await wait(id, 'device-wwww')).status).toBe(201)
  })
})

describe('fencing: a re-claim refuses the older generation', () => {
  it('after the claim expired and another PC took it over, the first PC’s token reaches nothing and writes nothing', async () => {
    const id = await preparingTask('お礼状の下ごしらえ')
    const a = (await claim('u-bob', id, 'device-aaaa')).body.data.run
    const tokenA = await runToken('u-bob', a)
    expect((await ai(tokenA, 'GET', `/item/${id}`)).status).toBe(200)
    // Still claimed: B cannot take it.
    expect(await claim('u-bob', id, 'device-bbbb')).toMatchObject({ status: 409, body: { code: 'RUN_CLAIMED' } })

    later(6 * MINUTE)
    const b = await claim('u-bob', id, 'device-bbbb')
    expect(b).toMatchObject({ status: 200, body: { data: { run: { generation: 2, deviceId: 'device-bbbb' } } } })
    const before = await ledger(id)
    expect(await ai(tokenA, 'POST', `/item/${id}/actions/hand_over`, { expectedVersion: 1, note: '情報が足りない' })).toMatchObject({ status: 409, body: { code: 'RUN_SUPERSEDED' } })
    expect(await ai(tokenA, 'GET', `/item/${id}`)).toMatchObject({ status: 409, body: { code: 'RUN_SUPERSEDED' } })
    expect(await ledger(id)).toEqual(before)
    expect(await session('u-bob', 'POST', `/ai-runs/${a.id}/renew`, { generation: 1 })).toMatchObject({ status: 409, body: { code: 'RUN_SUPERSEDED' } })
    expect(await session('u-bob', 'POST', `/ai-runs/${a.id}/finish`, { generation: 1, outcome: 'done' })).toMatchObject({ status: 409, body: { code: 'RUN_SUPERSEDED' } })
    // An old generation cannot even get a new token.
    expect((await session('u-bob', 'POST', '/me/record-tokens', { conversationId: a.conversationId, agent: 'claude-code', scope: 'act', run: { id: a.id, generation: 1 } })).body.code).toBe('RUN_SUPERSEDED')

    // The new holder works, and its change is in the ledger as an automated run's.
    const tokenB = await runToken('u-bob', b.body.data.run)
    expect((await ai(tokenB, 'POST', `/item/${id}/actions/hand_over`, { expectedVersion: 1, note: '期限が近い' })).status).toBe(200)
    expect((await ledger(id)).at(-1)).toMatchObject({ action: 'hand_over', actorKind: 'ai', runId: a.id, cause: 'run' })
  })

  it('the ledger tells a person’s click, their AI in a consultation and an automated run apart', async () => {
    const id = await preparingTask('提案の下ごしらえ')
    const consult = await session('u-bob', 'POST', '/me/record-tokens', { conversationId: 'consult-1', agent: 'claude-code', scope: 'act' })
    expect((await ai(consult.body.data.token, 'POST', `/item/${id}/actions/set_tags`, { expectedVersion: 1, args: { tags: ['急ぎ'] } })).status).toBe(200)
    const run = (await claim('u-bob', id, 'device-aaaa')).body.data.run
    expect((await ai(await runToken('u-bob', run), 'POST', `/item/${id}/actions/set_tags`, { expectedVersion: 2, args: { tags: ['見積'] } })).status).toBe(200)
    expect((await session('u-bob', 'POST', `/records/item/${id}/actions/take_over`, { expectedVersion: 3 })).status).toBe(200)
    expect((await ledger(id)).map(e => [e.action, e.cause])).toEqual([['create', 'person'], ['set_tags', 'ai'], ['set_tags', 'run'], ['take_over', 'person']])
  })
})

describe('which procedure an automated run used', () => {
  const plugin = (version: string, enabled = true) => db.prepare(`
    INSERT INTO plugin_installs (company_id, plugin_id, version, fingerprint, service, connection_id, account_id, enabled, managed_since, key_id, mapping_version, updated_at, updated_by)
    VALUES (?, 'corporate-sales', ?, 'fp', 'hubspot', 'conn-1', NULL, ?, NULL, NULL, 1, ?, 'u-owner')
    ON CONFLICT(company_id, plugin_id) DO UPDATE SET version = excluded.version, enabled = excluded.enabled`).run(CO, version, enabled ? 1 : 0, ts())
  const claimAs = (app: string, recordId: string, deviceId: string) => call({
    user: 'u-bob', method: 'POST', path: `/api/companies/${CO}/ai-run-claims`, headers: { 'X-ACB-Client-Version': app },
    body: { recordId, step: 'task-prep', deviceId, conversationId: `conv-${deviceId}` },
  })

  it('each entry names the step, the app build and the plugins of its claim; a re-claim never rewrites earlier entries', async () => {
    plugin('0.3.0')
    const id = await preparingTask('見積の下ごしらえ（手順）')
    const consult = await session('u-bob', 'POST', '/me/record-tokens', { conversationId: 'consult-proc', agent: 'claude-code', scope: 'act' })
    expect((await ai(consult.body.data.token, 'POST', `/item/${id}/actions/set_tags`, { expectedVersion: 1, args: { tags: ['相談'] } })).status).toBe(200)

    const a = (await claimAs('0.0.1+abc1234.20261101120000', id, 'device-pppp')).body.data.run
    expect(a.procedure).toEqual({ step: 'task-prep', app: '0.0.1+abc1234.20261101120000', plugins: [{ id: 'corporate-sales', version: '0.3.0' }] })
    expect((await ai(await runToken('u-bob', a), 'POST', `/item/${id}/actions/set_tags`, { expectedVersion: 2, args: { tags: ['見積'] } })).status).toBe(200)

    // The plugin is updated, the claim expires, a newer app takes it over.
    plugin('0.4.0')
    later(6 * MINUTE)
    const b = (await claimAs('0.0.2+def5678.20261102120000', id, 'device-qqqq')).body.data.run
    expect((await ai(await runToken('u-bob', b), 'POST', `/item/${id}/actions/hand_over`, { expectedVersion: 3, note: '情報が足りない' })).status).toBe(200)

    const entries = await ledger(id)
    expect(entries.map(e => [e.action, e.cause, e.procedure ?? null])).toEqual([
      ['create', 'person', null],
      ['set_tags', 'ai', null],
      ['set_tags', 'run', { step: 'task-prep', app: '0.0.1+abc1234.20261101120000', plugins: [{ id: 'corporate-sales', version: '0.3.0' }] }],
      ['hand_over', 'run', { step: 'task-prep', app: '0.0.2+def5678.20261102120000', plugins: [{ id: 'corporate-sales', version: '0.4.0' }] }],
    ])
  })

  it('a plugin turned off is not part of it; an app build that does not parse is not kept', async () => {
    plugin('0.4.0', false)
    const id = await preparingTask('お礼状（手順）')
    const run = (await claimAs('not a version; DROP', id, 'device-rrrr')).body.data.run
    expect(run.procedure).toEqual({ step: 'task-prep', app: null, plugins: [] })
  })
})

describe('idempotency keys on outside operations within a run', () => {
  it('the same key twice → one effect; no key → refused; a key is never reused for another request', async () => {
    const id = await preparingTask('下書きの準備')
    const run = (await claim('u-bob', id, 'device-aaaa')).body.data.run
    const token = await runToken('u-bob', run)
    const body = { type: 'task', title: '先方に資料を送る', fields: { assignee: 'u-bob' } }
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'task' AND created_at IS NOT NULL").get(CO) as { n: number }).n
    const n0 = count()
    expect(await ai(token, 'POST', '/item', body)).toMatchObject({ status: 400, body: { code: 'OPERATION_KEY_REQUIRED' } })
    const first = await ai(token, 'POST', '/item', body, 'create-followup-1')
    expect(first.status).toBe(201)
    const again = await ai(token, 'POST', '/item', body, 'create-followup-1')
    expect(again).toMatchObject({ status: 200, body: { data: { replayed: true, operationKey: 'create-followup-1', ref: { kind: 'record', id: first.body.data.record.id } } } })
    expect(count()).toBe(n0 + 1)
    expect(await ai(token, 'POST', '/item', { ...body, title: '別の用件' }, 'create-followup-1')).toMatchObject({ status: 409, body: { code: 'OPERATION_KEY_REUSED' } })
    // A refused request had no effect: its key may be used again.
    expect((await ai(token, 'POST', '/item', { type: 'nope', title: 'x' }, 'create-2')).status).toBe(400)
    expect((await ai(token, 'POST', '/item', body, 'create-2')).status).toBe(201)
    expect(count()).toBe(n0 + 2)
  })
})

describe('「結果が分からない」 blocks resuming until reconciled', () => {
  it('an operation in flight when another PC takes over: no resume, no second send, until a person says what happened', async () => {
    const id = await preparingTask('HubSpot に記録する')
    const a = (await claim('u-bob', id, 'device-aaaa')).body.data.run
    const callerA = { companyId: CO, userId: 'u-bob', runId: a.id, generation: 1 }
    const request = { method: 'POST', path: '/x', body: { meeting: 1 } }
    let sends = 0
    let answerLate!: (v: { status: number; body: unknown }) => void
    const inFlight = services.aiRuns.keyed(callerA, 'log-meeting-1', request, 'plugin-operation', () => {
      sends++
      return new Promise(resolve => { answerLate = resolve })
    })
    later(6 * MINUTE)
    const b = await claim('u-bob', id, 'device-bbbb')
    expect(b).toMatchObject({ status: 409, body: { code: 'RUN_NEEDS_RECONCILE', run: { state: 'waiting_reconcile', needsPerson: true } } })
    expect(await session('u-bob', 'POST', `/ai-runs/${a.id}/retry`)).toMatchObject({ status: 409, body: { code: 'RUN_NEEDS_RECONCILE' } })
    answerLate({ status: 502, body: null })
    await inFlight
    expect(await claim('u-bob', id, 'device-bbbb')).toMatchObject({ status: 409, body: { code: 'RUN_NEEDS_RECONCILE' } })

    // The person looked in HubSpot: it was made. The run may go on; the key never sends again.
    const reconciled = await session('u-bob', 'POST', `/ai-runs/${a.id}/operations/log-meeting-1/reconcile`, { done: true })
    expect(reconciled).toMatchObject({ status: 200, body: { data: { run: { state: 'open' } } } })
    const resumed = await claim('u-bob', id, 'device-bbbb')
    expect(resumed).toMatchObject({ status: 200, body: { data: { run: { generation: 2 } } } })
    const replay = await services.aiRuns.keyed({ ...callerA, generation: 2 }, 'log-meeting-1', request, 'plugin-operation', async () => { sends++; return { status: 200, body: {} } })
    expect(replay.body).toMatchObject({ data: { replayed: true } })
    expect(sends).toBe(1)
  })

  it('a lost answer makes the run wait for reconciliation even when the app says it is done', async () => {
    const id = await preparingTask('お礼メールの下書き')
    const run = (await claim('u-bob', id, 'device-aaaa')).body.data.run
    const caller = { companyId: CO, userId: 'u-bob', runId: run.id, generation: 1 }
    let sends = 0
    await services.aiRuns.keyed(caller, 'k1', { method: 'POST', path: '/x', body: {} }, 'plugin-operation', async () => { sends++; return { status: 500, body: null } })
    const again = await services.aiRuns.keyed(caller, 'k1', { method: 'POST', path: '/x', body: {} }, 'plugin-operation', async () => { sends++; return { status: 200, body: {} } })
    expect(again).toMatchObject({ status: 409, body: { code: 'OPERATION_RESULT_UNKNOWN' } })
    expect(sends).toBe(1)
    expect(await session('u-bob', 'POST', `/ai-runs/${run.id}/finish`, { generation: 1, outcome: 'done' }))
      .toMatchObject({ status: 200, body: { data: { run: { state: 'waiting_reconcile', failure: { class: 'unknown-result' } } } } })
    // Not done after all: the key may run again once the run is resumed.
    expect((await session('u-bob', 'POST', `/ai-runs/${run.id}/operations/k1/reconcile`, { done: false })).body.data.run.state).toBe('open')
    expect((await claim('u-bob', id, 'device-aaaa')).status).toBe(200)
    await services.aiRuns.keyed({ ...caller, generation: 2 }, 'k1', { method: 'POST', path: '/x', body: {} }, 'plugin-operation', async () => { sends++; return { status: 200, body: {} } })
    expect(sends).toBe(2)
  })
})

describe('each failure goes to its own place', () => {
  it('permission → waiting for setup, bad input → waiting for a person: neither comes back without 「もう一度」; temporary → after its wait', async () => {
    const id = await preparingTask('段取りの確認')
    const finish = async (deviceId: string, failure: Json) => {
      const run = (await claim('u-bob', id, deviceId)).body.data.run
      return session('u-bob', 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, outcome: 'failed', failure })
    }
    const perm = await finish('device-aaaa', { class: 'permission', code: 'MISSING_SCOPES' })
    expect(perm.body.data.run).toMatchObject({ state: 'waiting_setup', needsPerson: true, failure: { class: 'permission', code: 'MISSING_SCOPES' } })
    later(24 * 60 * MINUTE)
    expect(await claim('u-bob', id, 'device-aaaa')).toMatchObject({ status: 409, body: { code: 'RUN_WAITING' } })
    expect((await session('u-bob', 'POST', `/ai-runs/${perm.body.data.run.id}/retry`)).body.data.run.state).toBe('open')

    const bad = await finish('device-aaaa', { class: 'bad-input' })
    expect(bad.body.data.run).toMatchObject({ state: 'waiting_person', needsPerson: true })
    later(24 * 60 * MINUTE)
    expect(await claim('u-bob', id, 'device-aaaa')).toMatchObject({ status: 409, body: { code: 'RUN_WAITING' } })
    expect((await session('u-bob', 'POST', `/ai-runs/${bad.body.data.run.id}/retry`)).status).toBe(200)

    const temp = await finish('device-aaaa', { class: 'temporary', code: 'RATE_LIMITED' })
    expect(temp.body.data.run).toMatchObject({ state: 'retry_later', attempts: 1, needsPerson: false })
    expect(await claim('u-bob', id, 'device-aaaa')).toMatchObject({ status: 409, body: { code: 'RUN_WAITING' } })
    later(6 * MINUTE)
    expect((await claim('u-bob', id, 'device-aaaa')).status).toBe(200)
  })

  it('a temporary failure again and again goes to a person, not round and round', async () => {
    const id = await preparingTask('何度も失敗する')
    let last: Json
    for (let i = 0; i < 3; i++) {
      later(2 * 60 * MINUTE)
      const run = (await claim('u-bob', id, 'device-aaaa')).body.data.run
      last = await session('u-bob', 'POST', `/ai-runs/${run.id}/finish`, { generation: run.generation, outcome: 'failed', failure: { class: 'temporary' } })
    }
    expect(last.body.data.run).toMatchObject({ state: 'waiting_person', failure: { code: 'REPEATED_TEMPORARY' } })
  })
})

describe('a run is its member’s, inside its company', () => {
  it('another member, another company’s owner and a missing id get the same answer; nothing changes', async () => {
    const id = await preparingTask('他の人には見えない')
    const run = (await claim('u-bob', id, 'device-aaaa')).body.data.run
    const missing = await session('u-carol', 'POST', '/ai-runs/no-such-run/retry')
    expect(missing.status).toBe(404)
    expect(await session('u-carol', 'POST', `/ai-runs/${run.id}/retry`)).toEqual(missing)
    expect(await session('u-carol', 'GET', `/ai-runs/${run.id}`)).toEqual(await session('u-carol', 'GET', '/ai-runs/no-such-run'))
    // The other company's member (same user id, other company) cannot reach it through their company.
    expect(await session('u-bob', 'POST', `/ai-runs/${run.id}/finish`, { generation: 1, outcome: 'done' }, OTHER))
      .toEqual(await session('u-bob', 'POST', '/ai-runs/no-such-run/finish', { generation: 1, outcome: 'done' }, OTHER))
    expect((await session('u-bob', 'POST', '/me/record-tokens', { conversationId: run.conversationId, agent: 'claude-code', scope: 'act', run: { id: run.id, generation: 1 } }, OTHER)).status).toBe(404)
    expect((await session('u-bob', 'GET', `/ai-runs/${run.id}`)).body.data.run).toMatchObject({ state: 'running', generation: 1 })
  })
})

describe('the emergency stop refuses a run with nobody present (agent-stop.md "No person present")', () => {
  const owner = (company = CO) => ({ companyId: company, userId: 'u-owner', role: 'owner' })
  /** Stops and answers how to release exactly that stop. */
  const stop = (body: { userId?: string; tool?: string }, company = CO) => {
    const before = new Set(services.agentStops.get(owner(company)).value!.active.map(s => s.id))
    const after = services.agentStops.stop(owner(company), body)
    if (!after.ok) throw new Error(JSON.stringify(after.body))
    return () => { for (const s of after.value.active) if (!before.has(s.id)) services.agentStops.release(owner(company), s.id) }
  }
  const runsOf = (recordId: string, company = CO) =>
    (db.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE company_id = ? AND record_id = ?').get(company, recordId) as { n: number }).n
  const STOPPED = { status: 503, body: { code: 'AI_STOPPED', error: '管理者が AI の利用を一時停止しています。再開されるまで AI の番は進みません。' } }

  it('a company-wide stop: the claim is refused and nothing is made; another company goes on; released, it claims', async () => {
    const id = await preparingTask('止めている間の下ごしらえ')
    const elsewhere = await preparingTask('ほかの会社の下ごしらえ', OTHER)
    const release = stop({})
    try {
      expect(await claim('u-bob', id, 'device-aaaa')).toMatchObject(STOPPED)
      expect(runsOf(id)).toBe(0)
      // Still the AI's turn: nothing about the record moved.
      expect((await session('u-bob', 'GET', '/records/ai-turn')).body.data.records.map((r: Json) => r.id)).toContain(id)
      const other = await session('u-bob', 'POST', '/ai-run-claims', { recordId: elsewhere, step: 'task-prep', deviceId: 'device-aaaa', conversationId: 'conv-o' }, OTHER)
      expect(other.status).toBe(201)
    } finally { release() }
    expect((await claim('u-bob', id, 'device-aaaa')).status).toBe(201)
    expect(runsOf(id)).toBe(1)
  })

  it('a stop of one member refuses that member only', async () => {
    const bobs = await preparingTask('ボブの下ごしらえ')
    const c = await session('u-carol', 'POST', '/records/item', { type: 'task', title: 'キャロルの下ごしらえ', state: 'preparing', fields: { assignee: 'u-carol' } })
    const carols = c.body.data.record.id as string
    const release = stop({ userId: 'u-bob' })
    try {
      expect(await claim('u-bob', bobs, 'device-aaaa')).toMatchObject(STOPPED)
      expect(runsOf(bobs)).toBe(0)
      expect((await claim('u-carol', carols, 'device-cccc')).status).toBe(201)
    } finally { release() }
  })

  it('a stop of a kind an unattended run can reach (write, web, external MCP) refuses; a stop of commands does not', async () => {
    for (const tool of ['write', 'web', 'mcp-external']) {
      const id = await preparingTask(`止めた種類 ${tool}`)
      const release = stop({ tool })
      try {
        expect(await claim('u-bob', id, 'device-aaaa')).toMatchObject(STOPPED)
        expect(runsOf(id)).toBe(0)
      } finally { release() }
    }
    const id = await preparingTask('コマンドだけ止めた')
    const release = stop({ tool: 'command' })
    try {
      expect((await claim('u-bob', id, 'device-aaaa')).status).toBe(201)
    } finally { release() }
  })

  it('a renew while stopped is refused without touching the run (same lease and generation, still finishable); released, it renews', async () => {
    const id = await preparingTask('走っている間に止める')
    const run = (await claim('u-bob', id, 'device-aaaa')).body.data.run
    later(MINUTE)
    const release = stop({})
    try {
      expect(await session('u-bob', 'POST', `/ai-runs/${run.id}/renew`, { generation: 1 })).toMatchObject(STOPPED)
      expect((await session('u-bob', 'GET', `/ai-runs/${run.id}`)).body.data.run).toMatchObject({ state: 'running', generation: 1, claimExpiresAt: run.claimExpiresAt })
    } finally { release() }
    const renewed = await session('u-bob', 'POST', `/ai-runs/${run.id}/renew`, { generation: 1 })
    expect(renewed.status).toBe(200)
    expect(Date.parse(renewed.body.data.run.claimExpiresAt)).toBeGreaterThan(Date.parse(run.claimExpiresAt))
    // Ending a run is never refused: the app that holds it finishes it as usual.
    const releaseBob = stop({ userId: 'u-bob' })
    try {
      expect((await session('u-bob', 'POST', `/ai-runs/${run.id}/finish`, { generation: 1, outcome: 'done' })).body.data.run.state).toBe('done')
    } finally { releaseBob() }
  })
})
