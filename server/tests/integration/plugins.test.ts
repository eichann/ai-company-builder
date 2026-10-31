/**
 * Integration Test: a company's connector plugins (milestone 3 P4,
 * `.claude/rules/plugins.md`) on the real services, database and key broker.
 *
 * - `available_to`: a package listed for another company is the same 404 as
 *   one that exists nowhere, and cannot be installed or turned on.
 * - A plugin turns on only with a company key of its service (of this
 *   company, active, allowed to the destination) and a mapping that passes
 *   the server's checks (members only, never a private folder); turning on
 *   makes the relay read-only for the service.
 * - Mapping versions are kept and restorable.
 * - Every kill switch acts on the next call (`active()`): the operator's
 *   stop list, the company's switch, the key's stop, a changed package.
 * - The key value never appears in an answer or the history.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const CO = 'pl-co'
const OTHER = 'pl-other'
const SECRET = 'pat-fake-NOT-REAL-plugins-0123456789'
const ts = () => new Date().toISOString()
const FIXTURES = join(__dirname, '../fixtures/plugins')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any, services: any
let kekDir: string, shelfDir: string
const owner = { companyId: CO, userId: 'pl-owner', role: 'owner' }
const admin = { companyId: CO, userId: 'pl-admin', role: 'admin' }
const member = { companyId: CO, userId: 'pl-member', role: 'member' }
/** A member who cannot read 営業部 (where the cards are visible). */
const reader = { companyId: CO, userId: 'pl-reader', role: 'member' }
const otherOwner = { companyId: OTHER, userId: 'pl-other-owner', role: 'owner' }
let hubKey: string, hubKeyOther: string, geminiKey: string
let oldToken: string, readerToken: string
let salesDept: string, otherDept: string
/** What reached "HubSpot" through the relay. */
const sent: Array<{ method: string; path: string; authorization?: string }> = []
const fakeUpstream = {
  async send(req: { method: string; path: string; headers: Record<string, string>; body: AsyncIterable<Uint8Array> | null }) {
    if (req.body) for await (const chunk of req.body) void chunk
    sent.push({ method: req.method, path: req.path, authorization: req.headers.authorization })
    return { ok: true as const, response: { status: 200, headers: [['content-type', 'application/json']] as Array<[string, string]>, body: (async function* () { yield new TextEncoder().encode('{"results":[]}') })(), viaPrivateAddress: false } }
  },
}

async function relay(token: string, method: string, path: string, headers: Record<string, string> = {}) {
  const { Hono } = await import('hono')
  const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
  const app = new Hono().route('/api/broker', brokerRelayRoutes(services.brokerRelay))
  const before = sent.length
  const res = await app.request(`http://acb.test/api/broker/hubspot${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: '{}' }),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, code: json?.error?.code as string | undefined, forwarded: sent.length > before }
}

/** A HubSpot-shaped package (the public fixture `sample-crm`, pointed at HubSpot's host and service). */
function putHubPackage(dir: string, extra = '') {
  cpSync(join(FIXTURES, 'sample-crm'), join(shelfDir, dir), { recursive: true })
  const [id, version] = dir.split('@')
  const file = join(shelfDir, dir, 'plugin.yaml')
  writeFileSync(file, readFileSync(file, 'utf8')
    .replace('id: sample-crm', `id: ${id}`).replace('version: 0.1.0', `version: ${version}`)
    .replace('service: sample-crm', 'service: hubspot').replace('https://api.sample-crm.example', 'https://api.hubapi.com') + extra)
}

const MAPPING = (people = 'pl-member', folder = '営業部') => `
deal:
  visible_to_folder: ${folder}
  fields:
    title:      { from: dealname, write: false }
    confidence: { from: juchu_kakudo, write: true, values: { high: a, medium: b, low: c } }
    next_step:  { from: hs_next_step, write: true }
    amount:     { from: amount, write: true }
    assignee:   { from: hubspot_owner_id, write: false, people: owners }
people:
  owners:
    "75123001": ${people}
# The package's creates run automatically by default; here they wait for approval (no acknowledgement needed).
policy:
  add_note: prior
  log_meeting: prior
`

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-pl-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-pl-shelf-'))
  putHubPackage('crm-hub@0.1.0')
  putHubPackage('crm-hub@0.2.0')
  putHubPackage('only-other@0.1.0', `\navailable_to: [${OTHER}]\n`)

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  for (const co of [CO, OTHER]) db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'x', ts(), ts())
  for (const m of [owner, admin, member, reader, otherOwner]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${m.userId}`, m.userId, m.companyId, m.role, ts(), ts())
  }
  // A private folder (its own repository) inside 営業部.
  db.prepare(`INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('pl-s-priv', ?, '営業部/評価', 'folder', 'pl-r-priv', ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES ('pl-r-priv', ?, 'pl-s-priv', ?)`).run(CO, ts())

  // 営業部: only pl-member (and owners / admins) may read it.
  db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('pl-s-sales', ?, '営業部', 'folder', ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'pl-r1', 'pl-s-sales', 'everyone', NULL, 0, 0, ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'pl-r2', 'pl-s-sales', 'user', 'pl-member', 1, 1, ?)`).run(CO, ts())

  // Departments (root folders): 営業部 here, another one in the other company.
  salesDept = 'pl-d-sales'
  otherDept = 'pl-d-other'
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(salesDept, CO, '営業部', '営業部', ts(), ts())
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(otherDept, OTHER, '営業部', '営業部', ts(), ts())

  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { pluginsDir: shelfDir, upstream: fakeUpstream })
  await services.pluginShelf.load()
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  hubKey = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: SECRET, audience })).value.keys[0].id
  geminiKey = (await services.keyBroker.create(owner, { service: 'gemini', displayName: 'Gemini', secret: `${SECRET}-gemini`, audience })).value.keys
    .find((k: Json) => k.service === 'gemini').id
  // Tokens issued before the plugin is ever turned on (an old consultation).
  oldToken = services.brokerTokens.issue(member, { conversationId: 'c-old', services: ['hubspot'] }).value.token
  readerToken = services.brokerTokens.issue(reader, { conversationId: 'c-reader', services: ['hubspot'] }).value.token
  hubKeyOther = (await services.keyBroker.create(otherOwner, { service: 'hubspot', displayName: 'HubSpot', secret: `${SECRET}-other`, audience })).value.keys[0].id
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

const otherRows = () => JSON.stringify(['plugin_installs', 'plugin_mappings', 'plugin_history', 'broker_keys', 'broker_services']
  .map(t => db.prepare(`SELECT * FROM ${t} WHERE company_id = ?`).all(OTHER)))

describe('connector plugins: the shelf as a company sees it', () => {
  it('a package available only to another company does not exist here', async () => {
    const list = (await services.plugins.list(owner)).value.plugins as Json[]
    expect(list.map(p => p.id)).toEqual(['crm-hub'])
    expect((await services.plugins.list(otherOwner)).value.plugins.map((p: Json) => p.id)).toEqual(['crm-hub', 'only-other'])
    const before = otherRows()
    const missing = await services.plugins.get(owner, 'no-such-plugin')
    for (const r of [
      await services.plugins.get(owner, 'only-other'),
      await services.plugins.install(owner, 'only-other', { version: '0.1.0', keyId: hubKey }),
      await services.plugins.setEnabled(owner, 'only-other', { enabled: true }),
      await services.plugins.saveMapping(owner, 'only-other', { text: MAPPING() }),
    ]) {
      expect(r).toEqual(missing)
    }
    expect(missing).toMatchObject({ ok: false, kind: 'not-found', body: { code: 'PLUGIN_NOT_FOUND' } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_installs WHERE company_id = ?').get(CO).n).toBe(0)
    expect(otherRows()).toBe(before)
  })

  it('only owners and admins', async () => {
    expect(await services.plugins.list(member)).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await services.plugins.install(member, 'crm-hub', { version: '0.1.0', keyId: hubKey })).toMatchObject({ ok: false, kind: 'forbidden' })
  })
})

describe('connector plugins: install, turn on, mapping', () => {
  it('another company’s key, a key of another service, or no key: cannot be chosen / cannot turn on', async () => {
    for (const keyId of [hubKeyOther, geminiKey]) {
      const r = await services.plugins.install(owner, 'crm-hub', { version: '0.1.0', keyId })
      expect(r).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'KEY_NOT_USABLE' } })
    }
    const installed = await services.plugins.install(owner, 'crm-hub', { version: '0.1.0', keyId: null })
    expect(installed.ok).toBe(true)
    // The package's recommended mapping is version 1; it names members of another company, so it does not pass here.
    expect(installed.value.mapping.version).toBe(1)
    expect(installed.value.mappingErrors.join()).toMatch(/この会社のメンバーではありません/)
    expect(await services.plugins.setEnabled(owner, 'crm-hub', { enabled: true })).toMatchObject({ ok: false, body: { code: 'PLUGIN_NOT_READY', problem: 'no-key' } })
    await services.plugins.install(owner, 'crm-hub', { version: '0.1.0', keyId: hubKey })
    expect(await services.plugins.setEnabled(owner, 'crm-hub', { enabled: true })).toMatchObject({ ok: false, body: { problem: 'mapping-invalid' } })
  })

  it('the mapping: members only, never a private folder; versions kept and restorable', async () => {
    const notMember = await services.plugins.saveMapping(admin, 'crm-hub', { text: MAPPING('pl-other-owner') })
    expect(notMember).toMatchObject({ ok: false, body: { code: 'MAPPING_INVALID' } })
    expect(notMember.body.errors.join()).toMatch(/pl-other-owner はこの会社のメンバーではありません/)
    const privateFolder = await services.plugins.saveMapping(admin, 'crm-hub', { text: MAPPING('pl-member', '営業部/評価/2026') })
    expect(privateFolder.body.errors.join()).toMatch(/非公開のフォルダ/)
    // Fields that would write automatically need the recorded acknowledgement (no HubSpot workflow behind them).
    const unconfirmed = await services.plugins.saveMapping(admin, 'crm-hub', { text: MAPPING(), acknowledgeAuto: ['confidence'] })
    expect(unconfirmed).toMatchObject({ ok: false, body: { code: 'AUTO_NEEDS_ACKNOWLEDGEMENT', fields: ['next_step'] } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_policy_acks').get().n).toBe(0)
    const saved = await services.plugins.saveMapping(admin, 'crm-hub', { text: MAPPING(), acknowledgeAuto: ['confidence', 'next_step'] })
    expect(saved.value.mapping.version).toBe(2)
    expect(saved.value.autoAcknowledgements).toEqual([
      { field: 'confidence', property: 'juchu_kakudo', by: 'pl-admin', at: expect.any(String) },
      { field: 'next_step', property: 'hs_next_step', by: 'pl-admin', at: expect.any(String) },
    ])
    // The same field writing another property is not covered by the old acknowledgement.
    const moved = await services.plugins.saveMapping(admin, 'crm-hub', { text: MAPPING().replace('from: hs_next_step', 'from: description') })
    expect(moved).toMatchObject({ ok: false, body: { code: 'AUTO_NEEDS_ACKNOWLEDGEMENT', fields: ['next_step'] } })
    expect(saved.value.mappingErrors).toEqual([])
    // amount has no company policy: the declaration's default (prior); next_step auto.
    expect(saved.value.policies).toEqual(expect.arrayContaining([
      { operation: 'update_deal', object: 'deal', field: 'amount', policy: 'prior' },
      { operation: 'update_deal', object: 'deal', field: 'next_step', policy: 'auto' },
    ]))
    const restored = await services.plugins.restoreMapping(admin, 'crm-hub', { version: 1 })
    expect(restored).toMatchObject({ ok: false, body: { code: 'MAPPING_INVALID' } })
    const again = await services.plugins.saveMapping(admin, 'crm-hub', { text: MAPPING().replace('hs_next_step, write: true', 'hs_next_step, write: false') })
    expect(again.value.mapping.version).toBe(3)
    const back = await services.plugins.restoreMapping(admin, 'crm-hub', { version: 2 })
    expect(back.value.mapping).toMatchObject({ version: 4, text: MAPPING() })
    expect(back.value.mappingVersions.map((v: Json) => v.version)).toEqual([4, 3, 2, 1])
  })

  it('turning on makes the relay read-only for the service; nothing holds the key value', async () => {
    expect(services.keyBroker.relayReadOnly(CO, 'hubspot')).toBe(false)
    // Who may read it through the relay must be decided first (empty = nobody; owner, 2026-10-31).
    expect(await services.plugins.setEnabled(owner, 'crm-hub', { enabled: true })).toMatchObject({ ok: false, body: { code: 'READ_SCOPE_REQUIRED' } })
    expect(services.keyBroker.relayReadOnly(CO, 'hubspot')).toBe(false)
    expect((await services.plugins.setReadScope(owner, 'crm-hub', { departmentIds: [salesDept] })).ok).toBe(true)
    const on = await services.plugins.setEnabled(owner, 'crm-hub', { enabled: true })
    expect(on.ok).toBe(true)
    expect(on.value.plugin.install).toMatchObject({ enabled: true, problem: null, keyId: hubKey })
    expect(services.keyBroker.relayReadOnly(CO, 'hubspot')).toBe(true)
    expect(services.keyBroker.relayReadOnly(OTHER, 'hubspot')).toBe(false)
    const all = JSON.stringify([on, await services.plugins.list(owner), db.prepare('SELECT * FROM plugin_history').all(), db.prepare('SELECT * FROM plugin_installs').all()])
    expect(all).not.toContain(SECRET)
  })
})

describe('connector plugins: every kill switch acts on the next call', () => {
  it('the operator’s stop, the company’s switch, the key’s stop, a changed package', async () => {
    const active = () => services.plugins.active(CO, 'crm-hub')
    expect(await active()).toMatchObject({ ok: true, plugin: { version: '0.1.0', keyId: hubKey, mappingVersion: 4 } })
    expect(await services.plugins.active(OTHER, 'crm-hub')).toEqual({ ok: false, problem: 'off' })

    writeFileSync(join(shelfDir, 'stopped'), 'crm-hub@0.1.0\n')
    expect(await active()).toEqual({ ok: false, problem: 'stopped' })
    rmSync(join(shelfDir, 'stopped'))
    expect((await active()).ok).toBe(true)

    await services.keyBroker.update(owner, hubKey, { status: 'disabled' })
    expect(await active()).toEqual({ ok: false, problem: 'key-stopped' })
    await services.keyBroker.update(owner, hubKey, { status: 'active' })
    expect((await active()).ok).toBe(true)

    // An automatic field whose acknowledgement is gone (or never recorded) stops the plugin.
    const ack = db.prepare("SELECT * FROM plugin_policy_acks WHERE company_id = ? AND field = 'next_step'").get(CO)
    db.prepare("DELETE FROM plugin_policy_acks WHERE company_id = ? AND field = 'next_step'").run(CO)
    expect(await active()).toEqual({ ok: false, problem: 'auto-not-acknowledged' })
    db.prepare('INSERT INTO plugin_policy_acks (company_id, plugin_id, field, property, acknowledged_by, acknowledged_at) VALUES (@company_id, @plugin_id, @field, @property, @acknowledged_by, @acknowledged_at)').run(ack)
    expect((await active()).ok).toBe(true)

    await services.plugins.setEnabled(admin, 'crm-hub', { enabled: false })
    expect(await active()).toEqual({ ok: false, problem: 'off' })
    await services.plugins.setEnabled(admin, 'crm-hub', { enabled: true })
    expect((await active()).ok).toBe(true)

    // The package on the shelf changes under the same version: not used until an admin chooses it again.
    const file = join(shelfDir, 'crm-hub@0.1.0/plugin.yaml')
    writeFileSync(file, readFileSync(file, 'utf8').replace('label: 見本の CRM', 'label: 見本の CRM（差し替え）'))
    await services.pluginShelf.load()
    expect(await active()).toEqual({ ok: false, problem: 'package-changed' })
    const chosen = await services.plugins.install(owner, 'crm-hub', { version: '0.1.0', keyId: hubKey })
    expect(chosen.ok).toBe(true)
    expect((await active()).ok).toBe(true)

    // A plugin that is on cannot be moved to a setup that would not run.
    expect(await services.plugins.install(owner, 'crm-hub', { version: '0.2.0', keyId: null }))
      .toMatchObject({ ok: false, body: { code: 'PLUGIN_WOULD_STOP', problem: 'no-key' } })
    expect((await active()).plugin.version).toBe('0.1.0')
  })
})

describe('the relay and a connection the plugin manages (review §5.1 / §5.2)', () => {
  it('before the plugin was ever on, the relay is untouched (existing skills keep working)', async () => {
    // Runs first in file order? No: the plugin is on by now. Checked on the other company, which never turned it on.
    const otherToken = services.brokerTokens.issue(otherOwner, { conversationId: 'c-o', services: ['hubspot'] }).value.token
    expect(await relay(otherToken, 'PATCH', '/crm/v3/objects/deals/1')).toMatchObject({ status: 200, forwarded: true })
  })

  it('writes never pass, from old tokens too, and turning the plugin off does not bring them back', async () => {
    expect(services.plugins.manages(CO, 'hubspot')).toBe(true)
    for (const [method, path] of [['PATCH', '/crm/objects/2026-03/deals/1'], ['POST', '/crm/objects/2026-03/deals'], ['DELETE', '/crm/objects/2026-03/deals/1'], ['POST', '/crm/v3/objects/contacts/search']] as const) {
      expect([method, path, await relay(oldToken, method, path)]).toEqual([method, path, { status: 403, code: 'ACB_MANAGED_BY_PLUGIN', forwarded: false }])
    }
    // A "GET" that would write on some APIs — refused by the managed rule itself, whatever the read-only switch says.
    db.prepare("UPDATE broker_services SET read_only = 0 WHERE company_id = ? AND service = 'hubspot'").run(CO)
    expect(await relay(oldToken, 'GET', '/crm/objects/2026-03/deals/1', { 'x-http-method-override': 'PATCH' })).toMatchObject({ status: 403, code: 'ACB_MANAGED_BY_PLUGIN', forwarded: false })
    db.prepare("UPDATE broker_services SET read_only = 1 WHERE company_id = ? AND service = 'hubspot'").run(CO)
    // Reads and the declared search pass.
    expect(await relay(oldToken, 'GET', '/crm/objects/2026-03/deals/1')).toMatchObject({ status: 200, forwarded: true })
    expect(await relay(oldToken, 'POST', '/crm/objects/2026-03/deals/search')).toMatchObject({ status: 200, forwarded: true })

    await services.plugins.setEnabled(owner, 'crm-hub', { enabled: false })
    expect(await relay(oldToken, 'PATCH', '/crm/objects/2026-03/deals/1')).toMatchObject({ status: 403, code: 'ACB_MANAGED_BY_PLUGIN', forwarded: false })
    // The read-only switch cannot be turned off while a plugin manages the service.
    expect(services.keyBroker.setReadOnly(owner, 'hubspot', { readOnly: false })).toMatchObject({ ok: false, body: { code: 'MANAGED_BY_PLUGIN' } })
    await services.plugins.setEnabled(owner, 'crm-hub', { enabled: true })
  })

})

describe('who may read HubSpot through the relay: the connection\'s read scope (owner, 2026-10-31)', () => {
  const READ: Array<[string, string]> = [['GET', '/crm/objects/2026-03/deals/1'], ['POST', '/crm/objects/2026-03/deals/search'], ['GET', '/crm/v3/objects/contacts/42']]
  const refused = { status: 403, code: 'ACB_READ_NOT_ALLOWED', forwarded: false }
  // The members' AI: a token issued for one of their consultations (the chat / a skill), never a session.
  const aiToken = (m: typeof member) => services.brokerTokens.issue(m, { conversationId: `c-ai-${m.userId}`, department: '営業部', services: ['hubspot'] }).value.token

  it('scope = a department: members who can read its folder, and their AI, read; others and their AI are refused', async () => {
    expect((await services.plugins.setReadScope(owner, 'crm-hub', { departmentIds: [salesDept] })).ok).toBe(true)
    for (const [method, path] of READ) {
      expect(await relay(oldToken, method, path)).toMatchObject({ status: 200, forwarded: true })
      expect(await relay(aiToken(member), method, path)).toMatchObject({ status: 200, forwarded: true })
      expect(await relay(readerToken, method, path)).toEqual(refused)
      expect(await relay(aiToken(reader), method, path)).toEqual(refused)
    }
  })

  it('scope = members: only those named (no filtering by deal inside it); writes still never pass', async () => {
    expect((await services.plugins.setReadScope(owner, 'crm-hub', { userIds: ['pl-reader'] })).ok).toBe(true)
    expect(await relay(aiToken(reader), 'GET', '/crm/objects/2026-03/deals/1')).toMatchObject({ status: 200, forwarded: true })
    expect(await relay(readerToken, 'GET', '/crm/objects/2026-03/deals/999')).toMatchObject({ status: 200, forwarded: true })
    // pl-member reads 営業部 but is not named now; an owner is not let in by role either.
    expect(await relay(oldToken, 'GET', '/crm/objects/2026-03/deals/1')).toEqual(refused)
    expect(await relay(services.brokerTokens.issue(owner, { conversationId: 'c-owner', services: ['hubspot'] }).value.token, 'GET', '/crm/objects/2026-03/deals/1')).toEqual(refused)
    expect(await relay(readerToken, 'PATCH', '/crm/objects/2026-03/deals/1')).toMatchObject({ status: 403, code: 'ACB_MANAGED_BY_PLUGIN', forwarded: false })
  })

  it('an empty scope lets nobody read and blocks turning on; it cannot be emptied while on', async () => {
    expect(await services.plugins.setReadScope(owner, 'crm-hub', { departmentIds: [], userIds: [] })).toMatchObject({ ok: false, body: { code: 'READ_SCOPE_REQUIRED' } })
    await services.plugins.setEnabled(owner, 'crm-hub', { enabled: false })
    expect((await services.plugins.setReadScope(owner, 'crm-hub', { departmentIds: [], userIds: [] })).ok).toBe(true)
    for (const token of [oldToken, readerToken, aiToken(member), services.brokerTokens.issue(owner, { conversationId: 'c-owner2', services: ['hubspot'] }).value.token]) {
      expect(await relay(token, 'GET', '/crm/objects/2026-03/deals/1')).toEqual(refused)
    }
    expect(await services.plugins.setEnabled(owner, 'crm-hub', { enabled: true })).toMatchObject({ ok: false, body: { code: 'READ_SCOPE_REQUIRED' } })
    expect((await services.plugins.setReadScope(admin, 'crm-hub', { departmentIds: [salesDept] })).ok).toBe(true)
    expect((await services.plugins.setEnabled(owner, 'crm-hub', { enabled: true })).ok).toBe(true)
  })

  it('another company\'s departments or members cannot be named; the scope is per company', async () => {
    expect(await services.plugins.setReadScope(owner, 'crm-hub', { userIds: ['pl-other-owner'] })).toMatchObject({ ok: false, body: { code: 'READ_SCOPE_INVALID' } })
    expect(await services.plugins.setReadScope(owner, 'crm-hub', { departmentIds: [otherDept] })).toMatchObject({ ok: false, body: { code: 'READ_SCOPE_INVALID' } })
    // The database refuses it too (案 A), whatever a future service does.
    const install = db.prepare("SELECT connection_id FROM plugin_installs WHERE company_id = ? AND plugin_id = 'crm-hub'").get(CO)
    expect(() => db.prepare("INSERT INTO plugin_read_scopes (company_id, plugin_id, connection_id, subject_type, subject_id, added_by, added_at) VALUES (?, 'crm-hub', ?, 'user', 'pl-other-owner', 'x', 'x')")
      .run(CO, install.connection_id)).toThrow(/same company/)
    expect(() => db.prepare("UPDATE plugin_read_scopes SET company_id = ? WHERE company_id = ?").run(OTHER, CO)).toThrow(/never move/)
    // Only owners / admins set it.
    expect(await services.plugins.setReadScope(member, 'crm-hub', { userIds: ['pl-member'] })).toMatchObject({ ok: false, kind: 'forbidden' })
    // The other company's owner reaches only their own company's (missing) install, never this one.
    expect(await services.plugins.setReadScope(otherOwner, 'crm-hub', { userIds: ['pl-other-owner'] })).toMatchObject({ ok: false, body: { code: 'NOT_INSTALLED' } })
    expect((await services.plugins.get(owner, 'crm-hub')).value.readScope).toEqual({ departmentIds: [salesDept], userIds: [] })
  })

  it('each relay read is logged with the member, the connection and the path as a pattern — never a body or the key', async () => {
    db.prepare("DELETE FROM agent_events WHERE company_id = ?").run(CO)
    expect(await relay(oldToken, 'GET', '/crm/objects/2026-03/deals/12345')).toMatchObject({ status: 200 })
    const install = db.prepare("SELECT connection_id FROM plugin_installs WHERE company_id = ? AND plugin_id = 'crm-hub'").get(CO)
    const rows = db.prepare('SELECT * FROM agent_events WHERE company_id = ?').all(CO)
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe('pl-member')
    const target = JSON.parse(rows[0].target)
    expect(target).toMatchObject({ kind: 'broker', service: 'hubspot', connection: install.connection_id, path: '/crm/objects/2026-03/deals/{id}' })
    const all = JSON.stringify(rows)
    expect(all).not.toContain('12345')
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain('results')
  })
})

describe('the relay uses the key of the connection the plugin manages (staging: an older practice key went to the real HubSpot)', () => {
  it('with several company keys the member may use, a relay call goes out with the connection\'s key, not the first registered', async () => {
    const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
    const second = `${SECRET}-connection`
    const created = await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot（本物）', secret: second, audience })
    const newer = created.value.keys.find((k: Json) => k.service === 'hubspot' && k.id !== hubKey).id
    // Before: the connection uses the first key, and so does the relay.
    expect(await relay(oldToken, 'GET', '/crm/objects/2026-03/deals/1')).toMatchObject({ status: 200, forwarded: true })
    expect(sent.at(-1)!.authorization).toBe(`Bearer ${SECRET}`)
    // The admin points the connection at the newer key: the relay follows (the same key as the connector).
    expect((await services.plugins.install(owner, 'crm-hub', { version: '0.1.0', keyId: newer })).ok).toBe(true)
    expect(await relay(oldToken, 'GET', '/crm/objects/2026-03/deals/1')).toMatchObject({ status: 200, forwarded: true })
    expect(sent.at(-1)!.authorization).toBe(`Bearer ${second}`)
    expect((await services.plugins.install(owner, 'crm-hub', { version: '0.1.0', keyId: hubKey })).ok).toBe(true)
    expect(await relay(oldToken, 'GET', '/crm/objects/2026-03/deals/1')).toMatchObject({ status: 200, forwarded: true })
    expect(sent.at(-1)!.authorization).toBe(`Bearer ${SECRET}`)
  })
})
