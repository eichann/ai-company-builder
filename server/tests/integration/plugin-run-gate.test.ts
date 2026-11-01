/**
 * The business × operation gate (plan C4 「業務×操作の関所」, plugins.md "The gate
 * of a step's run"): an AI whose token is bound to an execution run of a
 * business plugin's step (`<pluginId>__<step>`) may call only that plugin's
 * declared operations its step allows, and only the connector roles the step
 * declares; anything else gets one answer (403 `NOT_IN_STEP`) that names
 * nothing, and nothing is asked outside.
 *
 * Guards (each mutation-checked):
 * - a step without `plugin_operations` calls no operation;
 * - another plugin's operation (one not installed here — another company's —
 *   or not the run's) is refused with the same answer;
 * - an operation that asks first (creates a record / reaches outside) needs
 *   the step's `approvals` and then only becomes an approval request;
 * - the connector roles are the step's (`mail.read` is not `mail.send`);
 * - the plugin switched off, or stopped by the operator: nothing passes;
 * - a consultation keeps what it had; a core step (minutes reading) only reads a business plugin
 *   (plan C5: what a まとまり gets from a meeting is the plugin's own step);
 * - an operation that moves money (`moves_money`) asks first like one reaching
 *   outside: never direct, in a step only with `approvals` and then only a
 *   request;
 * - a write whose policy is `prior` (a money field, any prior field or create)
 *   of an operation that does not ask first becomes a request in a step only
 *   with the step's `approvals`; otherwise the same `NOT_IN_STEP`;
 * - the AI's tool list of a step's run is that step's operations only;
 * - `role:<name>` in an operation's `who` is held through C3's assignment (the
 *   company's, a まとまり's override, an absent holder's delegate).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeHubSpot, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'
import { enableSampleSales, putSampleHub } from '../helpers/plugin-packages'

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
const KEY = 'pat-fake-NOT-REAL-run-gate-0123456789'
const CO = 'rg-co'
const ts = () => new Date().toISOString()
const MAPPING = `
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
  fields:
    title:      { from: dealname, write: false }
    next_step:  { from: hs_next_step, write: true }
    assignee:   { from: hubspot_owner_id, write: false, people: owners }
people:
  owners:
    "75123001": rg-member
`
const ROLES = `
roles:
  deal_reviewer: { label: 案件の確認者 }
`
const STEPS = `
steps:
  work:
    label: 案件を進める
    for: { type: deal, state: open }
    start: ai_turn
    procedure: { default: steps/work.md }
    tools: [records, plugin_operations]
    connector_roles: [mail.read]
  ask:
    label: 案件を作るお願い
    for: { type: deal, state: open }
    start: ai_turn
    procedure: { default: steps/ask.md }
    tools: [plugin_operations, approvals]
    connector_roles: [calendar]
  plain:
    label: 記録だけ
    for: { type: deal, state: open }
    start: ai_turn
    procedure: { default: steps/plain.md }
    tools: [records]
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any, companyData: any
let fake: FakeHubSpot
let server: ServerType
let kekDir: string, shelfDir: string
const member = { companyId: CO, userId: 'rg-member', role: 'member' }
const owner = { companyId: CO, userId: 'rg-owner', role: 'owner' }

async function call(opts: { user?: string; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res: Response = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const recordOf = (externalId: string) => (db.prepare("SELECT record_id FROM plugin_external_links WHERE company_id = ? AND external_id = ? AND object = 'deal'").get(CO, externalId) as Json).record_id as string
const approvalCount = () => (db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'approval'").get(CO) as Json).n as number
const outsideCalls = () => fake.requests.length

/** The execution run of `step` on the deal, held by this test's app (as a claim would make it); returns its id. */
const runs = new Map<string, string>()
function runOf(step: string): string {
  const known = runs.get(step)
  if (known) return known
  const id = `rg-run-${runs.size + 1}`
  runs.set(step, id)
  const at = ts()
  companyData.forCompany(CO).aiRuns.insert({
    id, recordId: recordOf('1000000001'), step, userId: member.userId, state: 'running', generation: 1, deviceId: 'device-rg-0001',
    conversationId: `conv-${id}`, claimExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), failureClass: null, failureCode: null,
    retryAt: null, attempts: 0, pluginVersion: null, stepsVersion: null, procedure: null, createdAt: at, updatedAt: at, closedAt: null,
  })
  return id
}
const aiIn = (runId: string | null) => ({ kind: 'ai' as const, source: 'claude-code', conversationId: 'conv-rg', runId })
const refresh = (runId: string | null, pluginId = 'sample-sales') =>
  services.pluginOperations.run(member, aiIn(runId), pluginId, recordOf('1000000001'), 'refresh_deal', {})
const role = (runId: string | null, r: string) => services.pluginRunGate.allowsConnectorRole(member, runId, r)
const NOT_IN_STEP = { ok: false, kind: 'forbidden', body: { code: 'NOT_IN_STEP', error: 'この手順では使えない操作です' } }

beforeAll(async () => {
  fake = createFakeHubSpot()
  fake.addKey(KEY)
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-rg-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-rg-shelf-'))
  putSampleHub(shelfDir)
  // The business plugin as contract 2 with three steps.
  const pkg = join(shelfDir, 'sample-sales@0.1.0')
  // update_deal moves money (so no field it writes may default to auto); add_note is the deal reviewer's (a business role).
  const manifest = readFileSync(join(pkg, 'plugin.yaml'), 'utf8').replace('contract: 1', 'contract: 2')
    .replace('    note: optional\n    decision: true\n', '    note: optional\n    decision: true\n    moves_money: true\n')
    .replace(/^( {2}[a-z_]+): auto$/gm, '$1: prior')
    .replace('  add_note:\n    who: [assignee, dept_manager, admin, ai]', '  add_note:\n    who: [role:deal_reviewer]\n    via: [screen]')
  expect(manifest).toContain('moves_money: true')
  expect(manifest).toContain('who: [role:deal_reviewer]\n    via: [screen]')
  writeFileSync(join(pkg, 'plugin.yaml'), manifest + ROLES + STEPS)
  mkdirSync(join(pkg, 'steps'))
  for (const s of ['work', 'ask', 'plain']) writeFileSync(join(pkg, 'steps', `${s}.md`), `# ${s}\n`)
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
  companyData = (await import('../../src/adapters/sqlite/company-data')).sqliteCompanyData(db)
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/records-ai', (await import('../../src/routes/records-ai')).recordsAiRoute)
  const loaded = await services.pluginShelf.load()
  expect(loaded.loaded, JSON.stringify(loaded.refused)).toContain('sample-sales@0.1.0')

  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'rg-owner', ts(), ts())
  ensureCompanyScope(db, CO)
  for (const [u, r] of [['rg-owner', 'owner'], ['rg-member', 'member'], ['rg-lead', 'member'], ['rg-cover', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('rg-d-sales', CO, '営業部', '営業部', ts(), ts())
  db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(CO, ts(), 'x')
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: KEY, audience })).value.keys[0].id
  await enableSampleSales(services.plugins, owner)
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
  const saved = await services.plugins.saveMapping(owner, 'sample-sales', { text: MAPPING })
  expect(saved.ok, JSON.stringify(saved)).toBe(true)
  expect((await services.plugins.setReadScope(owner, 'sample-hub', { userIds: ['rg-member'] })).ok).toBe(true)
  expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
  expect((await services.pluginImport.run(owner, 'sample-sales')).ok).toBe(true)
})

afterAll(async () => {
  fake.close()
  await new Promise(r => server.close(() => r(null)))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_HUBSPOT_URL']) delete process.env[k]
})

describe("a step's run calls only its plugin's declared operations its step allows", () => {
  it('a consultation and a core step keep what they had; the step with plugin_operations runs it', async () => {
    expect((await refresh(null)).ok).toBe(true)
    expect((await refresh(runOf('minutes-reading'))).ok).toBe(true)
    expect((await refresh(runOf('sample-sales__work'))).ok).toBe(true)
    expect(await role(null, 'mail.send')).toBe(true)
    expect(await role(runOf('minutes-reading'), 'mail.send')).toBe(true)
  })

  it('a step without plugin_operations: refused over the run-bound token, nothing asked outside', async () => {
    const runId = runOf('sample-sales__plain')
    const run = companyData.forCompany(CO).aiRuns.byId(runId)
    currentUser.id = member.userId
    const t = await call({ user: member.userId, method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId: run.conversationId, agent: 'claude-code', scope: 'act', run: { id: runId, generation: 1 } } })
    expect(t.status, JSON.stringify(t.body)).toBe(201)
    const before = outsideCalls()
    const r = await call({ token: t.body.data.token, method: 'POST', path: `/api/records-ai/plugins/sample-sales/records/${recordOf('1000000001')}/operations/refresh_deal`, body: {} })
    expect(r).toMatchObject({ status: 403, body: { code: 'NOT_IN_STEP' } })
    expect(outsideCalls()).toBe(before)
  })

  it("another plugin's operation (not installed here: another company's, or not the run's) gets the same answer", async () => {
    const before = outsideCalls()
    expect(await refresh(runOf('sample-sales__work'), 'sample-leads')).toEqual(NOT_IN_STEP)
    expect(await refresh(runOf('sample-leads__work'))).toEqual(NOT_IN_STEP)
    expect(outsideCalls()).toBe(before)
  })

  it('an operation that asks first needs the step\'s approvals, and then is only an approval request', async () => {
    const body = { title: '新しい案件（株式会社ゲート）', fields: { next_step: '初回の打合せ' } }
    const approvals = approvalCount()
    const before = outsideCalls()
    expect(await services.approvals.createOrRequest(member, aiIn(runOf('sample-sales__work')), 'sample-sales', 'create_deal', body)).toEqual(NOT_IN_STEP)
    expect(approvalCount()).toBe(approvals)
    const asked = await services.approvals.createOrRequest(member, aiIn(runOf('sample-sales__ask')), 'sample-sales', 'create_deal', body)
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, value: { outcome: 'approval-requested' } })
    expect(approvalCount()).toBe(approvals + 1)
    expect(fake.requests.slice(before).filter(q => q.method !== 'GET' && !q.path.includes('/search'))).toEqual([])
  })
})

describe("a step's run uses only the connector roles its step declares", () => {
  it('the declared role (or the bare role) only', async () => {
    const work = runOf('sample-sales__work')
    expect(await role(work, 'mail.read')).toBe(true)
    expect(await role(work, 'mail.send')).toBe(false)
    expect(await role(work, 'calendar.read')).toBe(false)
    expect(await role(runOf('sample-sales__ask'), 'calendar.read')).toBe(true)
    expect(await role(runOf('sample-leads__work'), 'mail.read')).toBe(false)
  })
})

describe('a stopped plugin passes nothing', () => {
  it('switched off by the company', async () => {
    const work = runOf('sample-sales__work')
    expect((await services.plugins.setEnabled(owner, 'sample-sales', { enabled: false })).ok).toBe(true)
    try {
      expect(await refresh(work)).toEqual(NOT_IN_STEP)
      expect(await role(work, 'mail.read')).toBe(false)
    } finally {
      expect((await services.plugins.setEnabled(owner, 'sample-sales', { enabled: true })).ok).toBe(true)
    }
    expect(await role(work, 'mail.read')).toBe(true)
  })

  it("stopped by the operator (read on the next call)", async () => {
    const work = runOf('sample-sales__work')
    writeFileSync(join(shelfDir, 'stopped'), 'sample-sales\n')
    try {
      expect(await refresh(work)).toEqual(NOT_IN_STEP)
      expect(await role(work, 'mail.read')).toBe(false)
    } finally {
      rmSync(join(shelfDir, 'stopped'))
    }
    expect(await role(work, 'mail.read')).toBe(true)
  })
})

/** A token bound to `runId` (or a consultation's, without one), as the app gets it. */
async function tokenFor(runId: string | null): Promise<string> {
  const conversationId = runId ? companyData.forCompany(CO).aiRuns.byId(runId).conversationId : 'conv-rg-consult'
  const t = await call({ user: member.userId, method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId, agent: 'claude-code', scope: 'act', ...(runId ? { run: { id: runId, generation: 1 } } : {}) } })
  expect(t.status, JSON.stringify(t.body)).toBe(201)
  return t.body.data.token as string
}
const toolNames = async (runId: string | null) => {
  const r = await call({ token: await tokenFor(runId), method: 'GET', path: '/api/records-ai/plugins' })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return (r.body.data.plugins as Json[]).flatMap(p => p.operations.map((o: Json) => `${p.id}.${o.name}`)).sort()
}

describe('an operation that moves money asks first, like one reaching outside', () => {
  const versionOf = (id: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).version as number
  const body = () => ({ expectedVersion: versionOf(recordOf('1000000001')), fields: { next_step: '見積の送付' }, note: '先方の依頼' })
  const update = (actor: Json) => services.pluginOperations.run(member, actor, 'sample-sales', recordOf('1000000001'), 'update_deal', body())

  it("never direct: a person (or a consultation's AI) is told to ask for approval; the company cannot make its fields auto", async () => {
    const autoNext = await services.plugins.saveMapping(owner, 'sample-sales', { text: `${MAPPING}policy:\n  next_step: auto\n`, acknowledgeAuto: ['next_step'] })
    expect(autoNext, JSON.stringify(autoNext)).toMatchObject({ ok: false })
    expect(JSON.stringify(autoNext)).toContain('お金が動く操作で書かれる欄は「自動」にできません')
    const before = outsideCalls()
    expect(await update({ kind: 'human' })).toMatchObject({ ok: false, body: { code: 'APPROVAL_REQUIRED' } })
    expect(await update(aiIn(null))).toMatchObject({ ok: false, body: { code: 'APPROVAL_REQUIRED' } })
    expect(fake.requests.slice(before).filter(q => q.method !== 'GET')).toEqual([])
  })

  it("in a step's run: refused without the step's approvals; with them only an approval request", async () => {
    const before = outsideCalls()
    expect(await update(aiIn(runOf('sample-sales__work')))).toEqual(NOT_IN_STEP)
    const approvals = approvalCount()
    const asked = await services.approvals.request(member, aiIn(runOf('sample-sales__ask')), 'sample-sales', recordOf('1000000001'), 'update_deal', body())
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, value: { outcome: 'approval-requested' } })
    expect(approvalCount()).toBe(approvals + 1)
    expect(fake.requests.slice(before).filter(q => q.method !== 'GET' && !q.path.includes('/search'))).toEqual([])
  })
})

describe("a write whose policy is prior becomes a request in a step's run only with the step's approvals", () => {
  // log_meeting does not ask first (internal, no money), but its policy is `prior` (as a money field's write is).
  const meeting = { title: '打合せ（株式会社ゲート）', at: '2026-11-05T15:00:00+09:00' }
  const direct = (runId: string | null) => services.pluginOperations.run(member, aiIn(runId), 'sample-sales', recordOf('1000000001'), 'log_meeting', meeting)
  const ask = (runId: string | null) => services.approvals.request(member, aiIn(runId), 'sample-sales', recordOf('1000000001'), 'log_meeting', meeting)

  it("without approvals: the gate's one answer, nothing asked or sent; with them (or in a consultation) a request", async () => {
    const before = outsideCalls()
    const approvals = approvalCount()
    const work = runOf('sample-sales__work')
    expect(await direct(work)).toEqual(NOT_IN_STEP)
    expect(await ask(work)).toEqual(NOT_IN_STEP)
    expect(approvalCount()).toBe(approvals)
    expect(await direct(null)).toMatchObject({ ok: false, body: { code: 'APPROVAL_REQUIRED' } })
    const inStep = await ask(runOf('sample-sales__ask'))
    expect(inStep, JSON.stringify(inStep)).toMatchObject({ ok: true, value: { outcome: 'approval-requested' } })
    expect(approvalCount()).toBe(approvals + 1)
    expect(fake.requests.slice(before).filter(q => q.method !== 'GET' && !q.path.includes('/search'))).toEqual([])
  })
})

describe("the AI's tool list of a step's run is its step's operations", () => {
  it("a consultation lists them all; a step what its step allows; a step without plugin_operations, another plugin's none", async () => {
    const all = await toolNames(null)
    expect(all).toEqual(expect.arrayContaining(['sample-sales.create_deal', 'sample-sales.refresh_deal', 'sample-sales.update_deal']))
    // A core step lists a business plugin's reads only.
    expect(await toolNames(runOf('minutes-reading'))).toEqual(['sample-sales.refresh_deal'])
    // work: plugin_operations without approvals — nothing that asks first (money, a new record).
    const work = await toolNames(runOf('sample-sales__work'))
    expect(work).toContain('sample-sales.refresh_deal')
    expect(work).not.toContain('sample-sales.update_deal')
    expect(work).not.toContain('sample-sales.create_deal')
    expect(await toolNames(runOf('sample-sales__ask'))).toEqual(expect.arrayContaining(['sample-sales.create_deal', 'sample-sales.update_deal']))
    expect(await toolNames(runOf('sample-sales__plain'))).toEqual([])
    expect(await toolNames(runOf('sample-leads__work'))).toEqual([])
  })
})

describe("role:<name> in an operation's who is held through the role assignment", () => {
  const P = 'sample-sales'
  const note = (userId: string) => services.pluginOperations.run({ companyId: CO, userId, role: 'member' }, { kind: 'human' }, P, recordOf('1000000001'), 'add_note', { body: '確認しました', at: '2026-11-05T15:00:00+09:00' })
  const code = async (userId: string) => ((await note(userId)) as Json).body?.code ?? 'OK'

  it("nobody assigned: nobody; the company's holder; a まとまり override wins for that deal; an absent holder's delegate", async () => {
    const before = outsideCalls()
    expect(await code('rg-lead')).toBe('NOT_ALLOWED')
    expect(services.pluginRoles.assign(owner, P, 'deal_reviewer', { userIds: ['rg-lead'] }).ok).toBe(true)
    expect(await code('rg-lead')).toBe('APPROVAL_REQUIRED')
    expect(await code('rg-member')).toBe('NOT_ALLOWED')
    expect(await code('rg-cover')).toBe('NOT_ALLOWED')
    // The deal's own holder replaces the company's (never merged).
    const deal = recordOf('1000000001')
    expect(services.pluginRoles.setBundleOverride(owner, P, 'deal_reviewer', deal, { userIds: ['rg-member'] }).ok).toBe(true)
    expect(await code('rg-member')).toBe('APPROVAL_REQUIRED')
    expect(await code('rg-lead')).toBe('NOT_ALLOWED')
    expect(services.pluginRoles.setBundleOverride(owner, P, 'deal_reviewer', deal, { userIds: null }).ok).toBe(true)
    // rg-lead away: rg-cover stands in.
    const today = services.absences.view(owner, 'rg-lead').value.today as string
    const absence = services.absences.create(owner, { userId: 'rg-lead', from: today, until: today, delegateId: 'rg-cover' }).value.absence.id as string
    try {
      expect(await code('rg-cover')).toBe('APPROVAL_REQUIRED')
    } finally {
      expect(services.absences.remove(owner, absence).ok).toBe(true)
    }
    expect(await code('rg-cover')).toBe('NOT_ALLOWED')
    expect(fake.requests.slice(before).filter(q => q.method !== 'GET')).toEqual([])
  })
})

describe("an operation's via (plan 4b §5-13): where it may be called from", () => {
  it('add_note says via: [screen] — a run of a step that allows it, and a plugin screen, are refused before who; the screen passes on', async () => {
    const before = outsideCalls()
    const deal = recordOf('1000000001')
    const body = { body: '確認しました', at: '2026-11-05T15:00:00+09:00' }
    const NOT_VIA = { ok: false, kind: 'forbidden', body: { code: 'NOT_VIA', error: 'この操作はここからはできません。本体の画面から行ってください' } }
    expect(await services.pluginOperations.run(member, aiIn(runOf('sample-sales__ask')), 'sample-sales', deal, 'add_note', body)).toEqual(NOT_VIA)
    expect(await services.approvals.request(member, { kind: 'human', via: { plugin: 'sample-sales', version: '0.1.0' } }, 'sample-sales', deal, 'add_note', body)).toEqual(NOT_VIA)
    expect(await services.pluginOperations.run(member, { kind: 'human' }, 'sample-sales', deal, 'add_note', body)).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
    expect(fake.requests.slice(before).filter(q => q.method !== 'GET')).toEqual([])
  })
})
