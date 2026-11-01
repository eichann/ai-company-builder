/**
 * Integration Test: a plugin screen's bridge, the server end (plan 4b B6 「橋の関所」,
 * `.claude/rules/plugin-frame.md`) on the real services and database.
 *
 * Guards (each mutation-checked):
 * - the company's grant: only a version the agent policy lists (turned on, not
 *   stopped by the operator, the chosen fingerprint) whose package declares a
 *   screen with this bridge version; another company's plugin is the same answer;
 * - the operation's scope: only the plugin's own types (a record of another type is
 *   the same answer as a missing one), an action only with `via: [… plugin …]`, a
 *   plugin operation only with its use's `via` and only as an approval request;
 * - the person's own rights: `who` still decides (a member who is not the assignee);
 * - the ledger keeps `via` (the plugin and version) and answers cause `plugin`; a
 *   person's own click has none;
 * - `via` holds for every caller: an action without `screen` is refused on the core's
 *   screens, one without `run` for a run-bound AI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const CO = 'pb-co'
const CO2 = 'pb-co2'
const ts = () => new Date().toISOString()
const FIXTURES = join(__dirname, '../fixtures/plugins')
const REFUSED = { ok: false, kind: 'forbidden', body: { code: 'PLUGIN_BRIDGE_REFUSED', error: 'この画面からはできない操作です' } }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let shelfDir: string
const owner = { companyId: CO, userId: 'pb-owner', role: 'owner' }
const member = { companyId: CO, userId: 'pb-member', role: 'member' }
const colleague = { companyId: CO, userId: 'pb-colleague', role: 'member' }
const owner2 = { companyId: CO2, userId: 'pb-owner2', role: 'owner' }
const member2 = { companyId: CO2, userId: 'pb-member2', role: 'member' }
let deal: string, task: string

const ACTIONS = `actions:
  set_next:    { label: 次のアクションを決める, from: [open], who: [assignee, ai], args: { next_step: text }, via: [screen, plugin, run] }
  win:         { label: 受注にする, from: [open], to: won, who: [assignee] }
  pick_stage:  { label: 段階を選ぶ, from: [open], who: [assignee, ai], args: { stage: choice }, via: [plugin] }
  hold:        { label: 止める, from: [open], who: [assignee, ai], args: { next_step: text }, via: [screen, plugin] }
---`

/** sample-flow as `version`, with actions on its deal type and `update_deal` callable from its screen. */
function putFlow(version: string, opts: { ui: boolean }): void {
  const dir = join(shelfDir, `sample-flow@${version}`)
  cpSync(join(FIXTURES, 'sample-flow'), dir, { recursive: true })
  let yaml = readFileSync(join(dir, 'plugin.yaml'), 'utf8').replace('version: 0.2.0', `version: ${version}`)
    .replace('    note: optional\n    decision: true\n', '    note: optional\n    decision: true\n    via: [screen, plugin]\n')
  expect(yaml).toContain('via: [screen, plugin]')
  if (!opts.ui) {
    yaml = yaml.replace(/\nui:\n[\s\S]*?\n\nupgrade:/, '\n\nupgrade:')
    rmSync(join(dir, 'ui'), { recursive: true })
  }
  writeFileSync(join(dir, 'plugin.yaml'), yaml)
  const dealFile = join(dir, 'types', 'deal.md')
  writeFileSync(dealFile, readFileSync(dealFile, 'utf8').replace(/\nfinal: \[won, lost\]\n---/, `\nfinal: [won, lost]\n${ACTIONS}`))
}

const bridge = (m: Json, op: string, args: Json, at: { pluginId?: string; version?: string } = {}) =>
  services.pluginBridge.call(m, { pluginId: at.pluginId ?? 'sample-flow', version: at.version ?? '0.2.0', op, args })
const versionOf = (id: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, id) as Json).version as number
const approvalCount = () => (db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'approval'").get(CO) as Json).n as number
async function call(user: string, path: string, body: unknown) {
  currentUser.id = user
  const res: Response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}

beforeAll(async () => {
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-pb-shelf-'))
  putFlow('0.2.0', { ui: true })
  putFlow('0.3.0', { ui: false })
  process.env.PLUGINS_DIR = shelfDir
  vi.spyOn(console, 'log').mockImplementation(() => {})

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/plugin-bridge')).pluginBridgeRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  const loaded = await services.pluginShelf.load()
  expect(loaded.loaded, JSON.stringify(loaded.refused)).toEqual(expect.arrayContaining(['sample-flow@0.2.0', 'sample-flow@0.3.0']))

  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
  const { ensureCoreTypes } = await import('../../src/services/record-index')
  for (const co of [CO, CO2]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'x', ts(), ts())
    ensureCompanyScope(db, co)
    db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(co, ts(), 'x')
    ensureCoreTypes(sqliteCompanyData(db).forCompany(co).records, ts())
  }
  for (const m of [owner, member, colleague, owner2, member2]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${m.userId}`, m.userId, m.companyId, m.role, ts(), ts())
  }
  expect((await services.plugins.install(owner, 'sample-flow', { version: '0.2.0', keyId: null })).ok).toBe(true)
  const on = await services.plugins.setEnabled(owner, 'sample-flow', { enabled: true })
  expect(on.ok, JSON.stringify(on)).toBe(true)
  expect((await services.plugins.install(owner2, 'sample-flow', { version: '0.3.0', keyId: null })).ok).toBe(true)
  expect((await services.plugins.setEnabled(owner2, 'sample-flow', { enabled: true })).ok).toBe(true)

  const made = services.recordEngine.create(member, { kind: 'human' }, { type: 'deal', title: '見本の案件', fields: { assignee: member.userId } })
  expect(made.ok, JSON.stringify(made)).toBe(true)
  deal = made.value.record.id
  const t = services.recordEngine.create(member, { kind: 'human' }, { type: 'task', title: '見本のやること', fields: { assignee: member.userId } })
  expect(t.ok, JSON.stringify(t)).toBe(true)
  task = t.value.record.id
})

afterAll(() => {
  rmSync(shelfDir, { recursive: true, force: true })
  delete process.env.PLUGINS_DIR
})

describe("the company's grant", () => {
  it('a listed version with a screen reads its own types', async () => {
    const r = await bridge(member, 'records.query', { type: 'deal' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.value.value.records.map((x: Json) => x.id)).toEqual([deal])
  })

  it('another version, another company, a plugin that does not exist: the same one answer', async () => {
    expect(await bridge(member, 'records.query', { type: 'deal' }, { version: '0.3.0' })).toEqual(REFUSED)
    expect(await bridge(member, 'records.query', { type: 'deal' }, { pluginId: 'no-such-plugin' })).toEqual(REFUSED)
    // The other company turned on 0.3.0, which has no screen: no bridge, though the plugin is on and listed.
    expect((await services.pluginDistribution.pluginsFor(CO2)).map((p: Json) => p.version)).toEqual(['0.3.0'])
    expect(await bridge(member2, 'records.query', { type: 'deal' }, { version: '0.3.0' })).toEqual(REFUSED)
    expect(await bridge(member2, 'records.query', { type: 'deal' })).toEqual(REFUSED)
  })

  it('turned off by the company, or stopped by the operator: nothing passes', async () => {
    expect((await services.plugins.setEnabled(owner, 'sample-flow', { enabled: false })).ok).toBe(true)
    try {
      expect(await bridge(member, 'records.query', { type: 'deal' })).toEqual(REFUSED)
    } finally { expect((await services.plugins.setEnabled(owner, 'sample-flow', { enabled: true })).ok).toBe(true) }
    writeFileSync(join(shelfDir, 'stopped'), 'sample-flow@0.2.0\n')
    try {
      expect(await bridge(member, 'records.query', { type: 'deal' })).toEqual(REFUSED)
    } finally { rmSync(join(shelfDir, 'stopped'), { force: true }) }
    expect((await bridge(member, 'records.query', { type: 'deal' })).ok).toBe(true)
  })
})

describe("the operation's scope", () => {
  it("only the plugin's own types: another type's record is the same answer as a missing one", async () => {
    expect(await bridge(member, 'records.query', { type: 'task' })).toEqual(REFUSED)
    expect(await bridge(member, 'records.query', { type: 'deal', implements: 'request' })).toEqual(REFUSED)
    expect(await bridge(member, 'records.get', { recordId: task })).toEqual(REFUSED)
    expect(await bridge(member, 'records.get', { recordId: 'deal-0000000000000000' })).toEqual(REFUSED)
    expect(await bridge(member, 'records.act', { recordId: task, action: 'complete', expectedVersion: 1 })).toEqual(REFUSED)
    const got = await bridge(member, 'records.get', { recordId: deal })
    expect(got.ok, JSON.stringify(got)).toBe(true)
    expect(got.value.value.record.id).toBe(deal)
  })

  it("an action only where its type's via names plugin; the default does not", async () => {
    const v = versionOf(deal)
    expect(await bridge(member, 'records.act', { recordId: deal, action: 'win', expectedVersion: v })).toEqual(REFUSED)
    expect(versionOf(deal)).toBe(v)
    const r = await bridge(member, 'records.act', { recordId: deal, action: 'set_next', expectedVersion: v, args: { next_step: '見積を送る' } })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(versionOf(deal)).toBe(v + 1)
  })

  it('a plugin operation only through its via, and only as a request (never run)', async () => {
    const before = approvalCount()
    // refresh_deal says no via (the default): the bridge refuses it before anything is asked.
    expect(await bridge(member, 'approvals.request', { recordId: deal, operation: 'refresh_deal', input: {} })).toEqual(REFUSED)
    expect(await bridge(member, 'approvals.request', { recordId: task, operation: 'update_deal', input: {} })).toEqual(REFUSED)
    // update_deal names plugin: it reaches the approval request's own checks (this company has no connector).
    const asked = await bridge(member, 'approvals.request', { recordId: deal, operation: 'update_deal', input: { expectedVersion: 1, fields: { amount: 5 } } })
    expect(asked.ok).toBe(false)
    expect(asked.body.code).not.toBe('PLUGIN_BRIDGE_REFUSED')
    expect(approvalCount()).toBe(before)
  })
})

describe("the person's own rights", () => {
  it('who still decides: a colleague who is not the assignee cannot do it through the screen', async () => {
    const v = versionOf(deal)
    const r = await bridge(colleague, 'records.act', { recordId: deal, action: 'set_next', expectedVersion: v, args: { next_step: '別の人' } })
    expect(r).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'NOT_ALLOWED' } })
    expect(versionOf(deal)).toBe(v)
  })
})

describe('the ledger', () => {
  it("keeps the plugin and version for a change through the screen (cause plugin); a person's own click has none", async () => {
    const v = versionOf(deal)
    const viaBridge = await call(member.userId, `/api/companies/${CO}/plugin-bridge`,
      { pluginId: 'sample-flow', version: '0.2.0', op: 'records.act', args: { recordId: deal, action: 'pick_stage', expectedVersion: v, args: { stage: 'proposal' } } })
    expect(viaBridge.status, JSON.stringify(viaBridge.body)).toBe(200)
    const byHand = await call(member.userId, `/api/companies/${CO}/records/item/${deal}/actions/set_next`,
      { expectedVersion: v + 1, args: { next_step: '電話する' }, via: { plugin: 'forged', version: '9.9.9' } })
    expect(byHand.status, JSON.stringify(byHand.body)).toBe(200)
    const entries = services.recordEngine.history(member, deal).value.entries as Json[]
    expect(entries.find(e => e.version === v + 1)).toMatchObject({ action: 'pick_stage', actorKind: 'human', via: { plugin: 'sample-flow', version: '0.2.0' }, cause: 'plugin' })
    const own = entries.find(e => e.version === v + 2)
    expect(own).toMatchObject({ action: 'set_next', cause: 'person' })
    expect(own.via ?? null).toBeNull()
  })

  it('a refusal answers one shape over HTTP; a body of another shape is 400', async () => {
    const r = await call(member.userId, `/api/companies/${CO}/plugin-bridge`, { pluginId: 'sample-flow', version: '0.3.0', op: 'records.get', args: { recordId: deal } })
    expect(r).toEqual({ status: 403, body: { error: 'この画面からはできない操作です', code: 'PLUGIN_BRIDGE_REFUSED' } })
    const bad = await call(member.userId, `/api/companies/${CO}/plugin-bridge`, { pluginId: 'sample-flow', version: '0.2.0', op: 'files.read', args: {} })
    expect(bad.status).toBe(400)
  })
})

describe('via holds for every caller', () => {
  it("an action without screen is refused on the core's screens; one without run for a run-bound AI", async () => {
    const v = versionOf(deal)
    expect(await services.recordEngine.act(member, { kind: 'human' }, deal, 'pick_stage', { expectedVersion: v, args: { stage: 'quote' } }))
      .toMatchObject({ ok: false, body: { code: 'NOT_VIA' } })
    expect(await services.recordEngine.act(member, { kind: 'ai', source: 'claude-code', runId: 'pb-run' }, deal, 'hold', { expectedVersion: v, args: { next_step: 'x' } }))
      .toMatchObject({ ok: false, body: { code: 'NOT_VIA' } })
    expect(versionOf(deal)).toBe(v)
    // A consultation (no run) is the core's screen: `hold` lists it.
    const r = await services.recordEngine.act(member, { kind: 'ai', source: 'claude-code' }, deal, 'hold', { expectedVersion: v, args: { next_step: 'y' } })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  })
})
