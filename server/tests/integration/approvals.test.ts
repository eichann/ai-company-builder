/**
 * Approval requests with fixed content end to end (milestone 4 G6,
 * `.claude/rules/approvals.md`): the server's routes and services, the fake
 * HubSpot behind the practice redirect, a session for people and a record
 * token for their AI.
 *
 * Guards (each mutation-checked: remove the guard → this test fails):
 * - the AI cannot approve, send back or withdraw: no record-token route, and a
 *   token on the session routes is not a session;
 * - an old or wrong hash writes nothing (CONTENT_CHANGED); no reason → refused;
 * - HubSpot changed since the request (rawBefore) → stale, nothing written;
 * - only someone who qualifies approves: not the requester of a dept_manager
 *   request, not a manager of another department;
 * - used once: two approvals at the same moment → one PATCH;
 * - precedents and their count only from what the viewer may read;
 * - another company's request id is the same 404 and nothing changes (CROSS).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeHubSpot, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const KEY = 'pat-fake-NOT-REAL-approvals-0123456789'
const CO = 'ap-co'
const OTHER = 'ap-co2'
const ts = () => new Date().toISOString()
const MAPPING = `
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
  fields:
    title:      { from: dealname, write: false }
    stage:      { from: dealstage, write: true, values: { appointmentscheduled: first_meeting, qualifiedtobuy: proposal, presentationscheduled: quote, decisionmakerboughtin: final } }
    confidence: { from: juchu_kakudo, write: true, values: { high: a, medium: b, low: c } }
    next_step:  { from: hs_next_step, write: true }
    amount:     { from: amount, write: true }
    assignee:   { from: hubspot_owner_id, write: false, people: owners }
people:
  owners:
    "75123001": ap-member
`
const ACK = ['confidence', 'next_step']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let fake: FakeHubSpot
let server: ServerType
let kekDir: string, shelfDir: string
const owner = { companyId: CO, userId: 'ap-owner', role: 'owner' }

async function call(opts: { user?: string; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res: Response = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const A = `/api/companies/${CO}/approvals`
const person = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `${A}${path}`, body })

async function tokenFor(user: string): Promise<string> {
  const r = await call({ user, method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId: 'conv-ap', agent: 'claude-code', scope: 'act' } })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}
const recordOf = (externalId: string) => (db.prepare("SELECT record_id FROM plugin_external_links WHERE company_id = ? AND external_id = ? AND object = 'deal'").get(CO, externalId) as Json).record_id as string
const versionOf = (recordId: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, recordId) as Json).version as number
const stateOf = (recordId: string) => db.prepare('SELECT state, version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, recordId) as Json
const patches = () => fake.requests.filter(r => r.method === 'PATCH').length
const fixedRows = (id: string) => db.prepare('SELECT version, hash FROM fixed_payloads WHERE company_id = ? AND owner_kind = ? AND owner_id = ?').all(CO, 'approval', id) as Json[]

/** The member's AI asks to change a deal's amount: an approval request (202). */
async function aiAsksAmount(externalId: string, amount: number, note = '先方が対象を広げたいと言ったため（議事録の引用）') {
  const id = recordOf(externalId)
  await call({ user: 'ap-member', method: 'POST', path: `/api/companies/${CO}/plugins/sample-hub/records/${id}/operations/refresh_deal`, body: {} })
  const r = await call({
    token: await tokenFor('ap-member'), method: 'POST', path: `/api/records-ai/plugins/sample-hub/records/${id}/operations/update_deal`,
    body: { expectedVersion: versionOf(id), fields: { amount }, note },
  })
  expect(r.status).toBe(202)
  return { deal: id, approval: r.body.data.approval as Json, existing: r.body.data.existing as boolean }
}

beforeAll(async () => {
  fake = createFakeHubSpot()
  fake.addKey(KEY)
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-ap-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-ap-shelf-'))
  cpSync(join(__dirname, '../fixtures/plugins/sample-hub'), join(shelfDir, 'sample-hub@0.1.0'), { recursive: true })
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_FAKE_HUBSPOT_URL: `http://127.0.0.1:${port}`,
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/plugins')).pluginsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/approvals')).approvalsRoute)
  app.route('/api/records-ai', (await import('../../src/routes/records-ai')).recordsAiRoute)
  await services.pluginShelf.load()

  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, `${co}-x`, ts(), ts())
    ensureCompanyScope(db, co)
  }
  for (const [u, r] of [['ap-owner', 'owner'], ['ap-admin', 'admin'], ['ap-member', 'member'], ['ap-boss', 'member'], ['ap-boss2', 'member'], ['ap-reader', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-ap-x', 'ap-x', OTHER, 'owner', ts(), ts())
  for (const [id, folder] of [['ap-d-sales', '営業部'], ['ap-d-dev', '開発部']]) {
    db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, CO, folder, folder, ts(), ts())
  }
  db.prepare('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(CO, 'ap-d-sales', 'ap-boss', ts())
  db.prepare('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(CO, 'ap-d-dev', 'ap-boss2', ts())
  // 営業部: only the member, the sales manager and the dev manager read it (the dev manager manages another department).
  db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('ap-s-sales', ?, '営業部', 'folder', ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'ap-r1', 'ap-s-sales', 'everyone', NULL, 0, 0, ?)`).run(CO, ts())
  for (const [id, u] of [['ap-r2', 'ap-member'], ['ap-r3', 'ap-boss'], ['ap-r4', 'ap-boss2']]) {
    db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'ap-s-sales', 'user', ?, 1, 1, ?)`).run(CO, id, u, ts())
  }
  for (const co of [CO, OTHER]) db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(co, ts(), 'x')
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: KEY, audience })).value.keys[0].id
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
  expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING, acknowledgeAuto: ACK })).ok).toBe(true)
  expect((await services.plugins.setReadScope(owner, 'sample-hub', { userIds: ['ap-member'] })).ok).toBe(true)
  expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
  expect((await services.pluginImport.run(owner, 'sample-hub')).ok).toBe(true)
})

afterAll(async () => {
  fake.close()
  await new Promise(r => server.close(() => r(null)))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_HUBSPOT_URL']) delete process.env[k]
})

describe('making a request', () => {
  it('the AI\'s amount change becomes a request to the sales manager, with fixed content; nothing is sent; the same request is not made twice', async () => {
    const n = patches()
    const { approval, existing } = await aiAsksAmount('1000000001', 1500000)
    expect(existing).toBe(false)
    expect(approval).toMatchObject({
      state: 'pending', approver: 'ap-boss', approverRule: 'dept_manager', requestedBy: 'ap-member', requestedByAi: true,
      proposedReason: '先方が対象を広げたいと言ったため（議事録の引用）', version: 1, hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      changes: [{ field: 'amount', before: 1200000, after: 1500000, changePercent: 25 }],
      viewerMayApprove: false, viewerIsRequester: true,
    })
    expect(fixedRows(approval.id)).toEqual([{ version: 1, hash: approval.hash }])
    expect(patches()).toBe(n)
    // The approver's 「あなたの番」.
    const turn = services.records.myTurn({ companyId: CO, userId: 'ap-boss', role: 'member' })
    expect(turn.value.records.map((r: Json) => r.id)).toContain(approval.id)
    // The identical request again: the waiting one is the answer.
    const again = await aiAsksAmount('1000000001', 1500000)
    expect(again).toMatchObject({ existing: true, approval: { id: approval.id } })
  })

  it('fixed content is never rewritten (trigger); only its text may be cleared by retention', async () => {
    const { approval } = await aiAsksAmount('1000000001', 1550000)
    expect(() => db.prepare('UPDATE fixed_payloads SET canonical = ? WHERE company_id = ? AND owner_id = ?').run('{}', CO, approval.id)).toThrow(/never rewritten/)
    expect(() => db.prepare('UPDATE fixed_payloads SET hash = ? WHERE company_id = ? AND owner_id = ?').run(`sha256:${'0'.repeat(64)}`, CO, approval.id)).toThrow(/never rewritten/)
    // Retention clears the text; the hash stays, and acting on it is refused (nothing left to act on).
    expect(services.fixedPayloads.clearBodies(CO, 'approval', [approval.id])).toBe(1)
    expect(fixedRows(approval.id)).toEqual([{ version: 1, hash: approval.hash }])
    expect(services.fixedPayloads.matches(CO, 'approval', approval.id, approval.hash)).toEqual({ ok: false, reason: 'body-deleted' })
    expect(() => db.prepare('UPDATE fixed_payloads SET body_deleted_at = ? WHERE company_id = ? AND owner_id = ?').run('2030-01-01', CO, approval.id)).toThrow(/never rewritten/)
    expect(await person('ap-owner', 'POST', `/${approval.id}/approve`, { hash: approval.hash, reason: '妥当' })).toMatchObject({ status: 409, body: { code: 'CONTENT_CHANGED' } })
  })

  it('the AI emergency stop stops the AI\'s requests', async () => {
    const id = recordOf('1000000002')
    const stopped = vi.spyOn(services.agentStops, 'companyStopped').mockReturnValue(true)
    try {
      const r = await services.approvals.request({ companyId: CO, userId: 'ap-member', role: 'member' }, { kind: 'ai', source: 'claude-code' }, 'sample-hub', id, 'update_deal', { expectedVersion: versionOf(id), fields: { amount: 900000 }, note: 'x' })
      expect(r).toMatchObject({ ok: false, body: { code: 'ACB_STOPPED' } })
    } finally { stopped.mockRestore() }
  })
})

describe('who reads and who approves', () => {
  it('requester, approver and owners read it; a manager of another department and others get the same 404 as a missing one', async () => {
    const { approval } = await aiAsksAmount('1000000001', 1500000)
    expect((await person('ap-member', 'GET', `/${approval.id}`)).status).toBe(200)
    expect((await person('ap-boss', 'GET', `/${approval.id}`)).body.data.approval.viewerMayApprove).toBe(true)
    expect((await person('ap-owner', 'GET', `/${approval.id}`)).status).toBe(200)
    const missing = await person('ap-boss2', 'GET', '/approval-0000000000000000')
    for (const u of ['ap-boss2', 'ap-reader']) expect(await person(u, 'GET', `/${approval.id}`)).toEqual(missing)
    expect(missing).toMatchObject({ status: 404, body: { code: 'APPROVAL_NOT_FOUND' } })
    // The AI reads it with its token (read only).
    expect((await call({ token: await tokenFor('ap-member'), method: 'GET', path: `/api/records-ai/approvals/${approval.id}` })).status).toBe(200)
    // Lists: the approver's to-me has it, the requester's mine has it, the dev manager sees nothing.
    expect((await person('ap-boss', 'GET', '?scope=to-me')).body.data.approvals.map((a: Json) => a.id)).toContain(approval.id)
    expect((await person('ap-member', 'GET', '?scope=mine')).body.data.approvals.map((a: Json) => a.id)).toContain(approval.id)
    expect((await person('ap-boss2', 'GET', '?scope=to-me&state=any')).body.data).toEqual({ approvals: [], total: 0 })
  })

  it('the AI cannot approve, send back or withdraw: no route for its token, and its token is no session', async () => {
    const { approval } = await aiAsksAmount('1000000001', 1500000)
    const token = await tokenFor('ap-boss')
    const n = patches()
    for (const action of ['approve', 'send-back', 'withdraw']) {
      const body = { hash: approval.hash, reason: 'AI が承認' }
      expect((await call({ token, method: 'POST', path: `/api/records-ai/approvals/${approval.id}/${action}`, body })).status).toBe(404)
      expect((await call({ token, method: 'POST', path: `${A}/${approval.id}/${action}`, body })).status).toBe(401)
    }
    expect(stateOf(approval.id).state).toBe('pending')
    expect(patches()).toBe(n)
  })

  it('a dept_manager request: not the requester, not a manager of another department; no reason or a wrong hash writes nothing', async () => {
    const { approval } = await aiAsksAmount('1000000001', 1500000)
    const n = patches()
    const body = { hash: approval.hash, reason: '前例どおりの増額' }
    expect(await person('ap-member', 'POST', `/${approval.id}/approve`, body)).toMatchObject({ status: 403, body: { code: 'NOT_APPROVER' } })
    expect((await person('ap-boss2', 'POST', `/${approval.id}/approve`, body)).status).toBe(404)
    expect(await person('ap-boss', 'POST', `/${approval.id}/approve`, { hash: approval.hash, reason: '  ' })).toMatchObject({ status: 400, body: { code: 'REASON_REQUIRED' } })
    expect(await person('ap-boss', 'POST', `/${approval.id}/approve`, { hash: `sha256:${'a'.repeat(64)}`, reason: '前例どおり' }))
      .toMatchObject({ status: 409, body: { code: 'CONTENT_CHANGED', error: '内容が変わりました。もう一度確かめてください' } })
    expect(await person('ap-boss', 'POST', `/${approval.id}/send-back`, { reason: '' })).toMatchObject({ status: 400, body: { code: 'REASON_REQUIRED' } })
    expect(stateOf(approval.id).state).toBe('pending')
    expect(patches()).toBe(n)
  })
})

describe('approving', () => {
  it('used once: two approvals at the same moment make one PATCH; approved, the operation id, and a decision by the approver', async () => {
    const { approval, deal } = await aiAsksAmount('1000000001', 1500000)
    const decided = vi.spyOn(services.decisions, 'record')
    const n = patches()
    const [a, b] = await Promise.all([
      person('ap-boss', 'POST', `/${approval.id}/approve`, { hash: approval.hash, reason: '対象拡大のため妥当' }),
      call({ user: 'ap-owner', method: 'POST', path: `${A}/${approval.id}/approve`, body: { hash: approval.hash, reason: '妥当' } }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect([a, b].find(r => r.status === 409)!.body.code).toBe('NOT_PENDING')
    expect(patches()).toBe(n + 1)
    expect(fake.deal('1000000001')!.properties.amount).toBe('1500000')
    const won = [a, b].find(r => r.status === 200)!.body.data
    expect(won.approval).toMatchObject({ state: 'approved', outcome: { resultOperationId: won.operation.id } })
    expect(won.operation).toMatchObject({ state: 'applied', approvedBy: expect.any(String) })
    // The ledger of the deal: the requester's AI did it, with the approver's reason.
    const entry = services.recordEngine.history({ companyId: CO, userId: 'ap-member', role: 'member' }, deal).value.entries.at(-1)
    expect(entry).toMatchObject({ actorId: 'ap-member', actorKind: 'ai', isDecision: true, changes: [{ field: 'amount', before: 1200000, after: 1500000 }] })
    expect(decided).toHaveBeenCalledTimes(1)
    const [by, actor, body] = decided.mock.calls[0] as Json[]
    expect(actor).toEqual({ kind: 'human' })
    expect(by.userId).toBe(won.operation.approvedBy)
    expect(body).toMatchObject({ folder: '営業部', important: true, title: '金額の変更を承認', links: { approval: approval.id, deal } })
    expect(body.title).not.toContain('サンプル')
    decided.mockRestore()
  })

  it('HubSpot changed since the request: stale, nothing written', async () => {
    const { approval } = await aiAsksAmount('1000000002', 1000000)
    fake.changeDealOutside('1000000002', { amount: '850000' })
    const n = patches()
    const r = await person('ap-boss', 'POST', `/${approval.id}/approve`, { hash: approval.hash, reason: '妥当' })
    expect(r).toMatchObject({ status: 409, body: { code: 'CHANGED_OUTSIDE', error: 'HubSpot 側で変わっています。もう一度お願いし直してください', approval: { state: 'stale' } } })
    expect(patches()).toBe(n)
    expect(fake.deal('1000000002')!.properties.amount).toBe('850000')
  })

  it('a stopped plugin refuses at approval time and the request stays pending; it can be approved after resuming', async () => {
    const { approval } = await aiAsksAmount('1000000007', 5000000)
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: false })).ok).toBe(true)
    const n = patches()
    expect(await person('ap-boss', 'POST', `/${approval.id}/approve`, { hash: approval.hash, reason: '妥当' })).toMatchObject({ status: 409, body: { code: 'PLUGIN_NOT_ACTIVE' } })
    expect(stateOf(approval.id).state).toBe('pending')
    expect(patches()).toBe(n)
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
    expect((await person('ap-boss', 'POST', `/${approval.id}/approve`, { hash: approval.hash, reason: '妥当' })).body.data.approval.state).toBe('approved')
  })

  it('sent back with a reason: the requester\'s turn again; they withdraw it', async () => {
    const { approval } = await aiAsksAmount('1000000010', 700000)
    const back = await person('ap-boss', 'POST', `/${approval.id}/send-back`, { reason: '見積書の版が古い' })
    expect(back.body.data.approval).toMatchObject({ state: 'sent_back', outcome: { note: '見積書の版が古い', by: 'ap-boss' } })
    const turn = services.records.myTurn({ companyId: CO, userId: 'ap-member', role: 'member' })
    expect(turn.value.records.map((r: Json) => r.id)).toContain(approval.id)
    expect(await person('ap-boss', 'POST', `/${approval.id}/withdraw`)).toMatchObject({ status: 403, body: { code: 'NOT_REQUESTER' } })
    expect((await person('ap-member', 'POST', `/${approval.id}/withdraw`)).body.data.approval.state).toBe('withdrawn')
  })
})

describe('precedents and materials', () => {
  it('earlier approvals of the same field in the department, only as far as the viewer may read (counts too)', async () => {
    const { approval } = await aiAsksAmount('1000000010', 650000)
    const boss = (await person('ap-boss', 'GET', `/${approval.id}`)).body.data.approval
    // Approved on deals 1 and 7, sent back on 10 (withdrawn later: no longer a precedent) — amount, 営業部.
    expect(boss.precedents.total).toBe(2)
    expect(boss.precedents.items[0]).toMatchObject({ state: 'approved', fields: [{ label: '金額' }], reason: '妥当' })
    expect(boss.materials).toEqual([{ kind: 'record', recordId: recordOf('1000000010'), title: expect.any(String), version: expect.any(Number) }])
    // A place only the manager reads.
    db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('ap-s-secret', ?, '営業部/特別', 'folder', ?)`).run(CO, ts())
    db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'ap-r5', 'ap-s-secret', 'user', 'ap-member', 0, 0, ?)`).run(CO, ts())
    db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'ap-r6', 'ap-s-secret', 'user', 'ap-boss', 1, 1, ?)`).run(CO, ts())
    const deal7 = recordOf('1000000007')
    const old7 = (db.prepare("SELECT source_id FROM record_links WHERE company_id = ? AND name = 'about' AND target_id = ?").all(CO, deal7) as Json[]).map(r => r.source_id)
    const moveTo = (ids: string[], folder: string) => { for (const id of ids) db.prepare('UPDATE records SET folder = ? WHERE company_id = ? AND id = ?').run(folder, CO, id) }
    const seen = async (user: string) => (await person(user, 'GET', `/${approval.id}`)).body.data.approval.precedents
    // Only the deal it was about moves there: the member no longer sees (or counts) that precedent.
    moveTo([deal7], '営業部/特別')
    expect((await seen('ap-member')).total).toBe(1)
    expect((await seen('ap-member')).items.map((p: Json) => p.approvalId)).not.toEqual(expect.arrayContaining(old7))
    expect((await seen('ap-boss')).total).toBe(2)
    // Only the earlier request itself moves there: the same.
    moveTo([deal7], '営業部')
    moveTo(old7, '営業部/特別')
    expect((await seen('ap-member')).total).toBe(1)
    expect((await seen('ap-boss')).total).toBe(2)
  })
})

describe('another company (CROSS)', () => {
  it('another company\'s request id is the same 404 there, and nothing changes', async () => {
    const { approval } = await aiAsksAmount('1000000001', 1600000)
    const there = (path: string, method = 'GET', body?: unknown) => call({ user: 'ap-x', method, path: `/api/companies/${OTHER}/approvals/${path}`, body })
    const missing = await there('approval-0000000000000000')
    expect(missing).toMatchObject({ status: 404, body: { code: 'APPROVAL_NOT_FOUND' } })
    expect(await there(approval.id)).toEqual(missing)
    expect(await there(`${approval.id}/approve`, 'POST', { hash: approval.hash, reason: 'x' })).toEqual(missing)
    expect(await there(`${approval.id}/send-back`, 'POST', { reason: 'x' })).toEqual(missing)
    expect(await there(`${approval.id}/withdraw`, 'POST')).toEqual(missing)
    expect(stateOf(approval.id)).toMatchObject({ state: 'pending', version: 1 })
  })
})
