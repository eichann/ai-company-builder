/**
 * SERVERCORE-4: installing / changing a plugin and turning it on check the install, await (the operator's
 * stop file, the connector's evaluation), then write. Before, the write saved the whole row as it was read
 * before the awaits, so whatever another owner / admin did meanwhile — turning it off, another version, an
 * account bound, a new connection, a mapping saved — was written back (`plugins.md` "A company's install").
 *
 * Each test holds the real shelf's stop-file read (`tests/helpers/hold.ts` `stopAfter`: the service goes on
 * with what it read before), lands another owner / admin's change through the ordinary service on the same
 * database, then lets the held one finish. Production code has no hook for this.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { holdPoints } from '../helpers/hold'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const SECRET = 'pat-fake-NOT-REAL-install-race-0123456789'
const ts = () => new Date().toISOString()
const FIXTURES = join(__dirname, '../fixtures/plugins')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any, services: any, held: any
let kekDir: string, shelfDir: string
const points = holdPoints<'stop-file'>()

/** The HubSpot-shaped connector `crm-hub` (fixture `sample-crm`). */
function putHubPackage(dir: string) {
  cpSync(join(FIXTURES, 'sample-crm'), join(shelfDir, dir), { recursive: true })
  const [id, version] = dir.split('@')
  const file = join(shelfDir, dir, 'plugin.yaml')
  writeFileSync(file, readFileSync(file, 'utf8')
    .replace('id: sample-crm', `id: ${id}`).replace('version: 0.1.0', `version: ${version}`)
    .replace('service: sample-crm', 'service: hubspot').replace('https://api.sample-crm.example', 'https://api.hubapi.com'))
}

/** The business plugin `crm-sales` (fixture `sample-crm-sales`: deal / customer, its recommended mapping) using crm-hub. */
function putBusinessPackage(dir: string) {
  cpSync(join(FIXTURES, 'sample-crm-sales'), join(shelfDir, dir), { recursive: true })
  const [id, version] = dir.split('@')
  const file = join(shelfDir, dir, 'plugin.yaml')
  writeFileSync(file, readFileSync(file, 'utf8').replace('id: sample-crm-sales', `id: ${id}`).replace('version: 0.1.0', `version: ${version}`)
    .replace('connector: sample-crm >= 0.1.0', 'connector: crm-hub >= 0.1.0'))
}

/** A second business plugin on crm-hub with a type of its own (so it can sit beside crm-sales), accepting crm-hub 0.0.5. */
function putMemoPackage() {
  const dir = join(shelfDir, 'crm-memo@0.1.0')
  mkdirSync(join(dir, 'types'), { recursive: true })
  writeFileSync(join(dir, 'plugin.yaml'), [
    'id: crm-memo', 'label: 見本のメモ', 'version: 0.1.0', 'kind: official', 'contract: 1', 'types: [memo]',
    'connector: crm-hub >= 0.0.5', 'objects:', '  deal: { record_type: memo }', '',
  ].join('\n'))
  writeFileSync(join(dir, 'types', 'memo.md'), [
    '---', 'label: メモ', 'version: 1', 'storage: server', 'fields:', '  title: { label: 題, kind: text, source: file }', 'states: [open]', '---', '# メモ', '',
  ].join('\n'))
}

let companies = 0
/** A company of its own per test (installs are per company): its owner, an admin, a department and a HubSpot company key. */
async function company() {
  const co = `race-co-${++companies}`
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'x', ts(), ts())
  const owner = { companyId: co, userId: `${co}-owner`, role: 'owner' }
  const admin = { companyId: co, userId: `${co}-admin`, role: 'admin' }
  for (const m of [owner, admin]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${m.userId}`, m.userId, co, m.role, ts(), ts())
  }
  const dept = `${co}-sales`
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(dept, co, '営業部', '営業部', ts(), ts())
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: SECRET, audience })).value.keys[0].id as string
  return { co, owner, admin, dept, key }
}

const row = (co: string, pluginId: string) => db.prepare(
  'SELECT version, fingerprint, enabled, key_id, connection_id, account_id, mapping_version, managed_since FROM plugin_installs WHERE company_id = ? AND plugin_id = ?',
).get(co, pluginId) as Json
const historyActions = (co: string, pluginId: string) => (db.prepare(
  'SELECT action FROM plugin_history WHERE company_id = ? AND plugin_id = ? ORDER BY rowid',
).all(co, pluginId) as Array<{ action: string }>).map(r => r.action)

/** A connector turned on (key, read scope), as an owner leaves it. */
async function connectorOn(c: Awaited<ReturnType<typeof company>>) {
  expect((await services.plugins.install(c.owner, 'crm-hub', { version: '0.1.0', keyId: c.key })).ok).toBe(true)
  expect((await services.plugins.setReadScope(c.owner, 'crm-hub', { departmentIds: [c.dept] })).ok).toBe(true)
  expect((await services.plugins.setEnabled(c.owner, 'crm-hub', { enabled: true })).ok).toBe(true)
}

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-race-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-race-shelf-'))
  putHubPackage('crm-hub@0.0.5')
  putHubPackage('crm-hub@0.1.0')
  putHubPackage('crm-hub@0.2.0')
  putBusinessPackage('crm-sales@0.1.0')
  putBusinessPackage('crm-sales@0.2.0')
  putMemoPackage()

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { pluginsDir: shelfDir })
  const loaded = await services.pluginShelf.load()
  expect(loaded.refused).toEqual([])

  // The same service on the same database, its shelf's stop-file read held when the test asks.
  const { createPluginService } = await import('../../src/services/plugins')
  const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
  const { sqliteTransactions } = await import('../../src/adapters/sqlite/transactions')
  const { sqliteKeyBrokerRepository } = await import('../../src/adapters/sqlite/key-broker')
  const { randomIds, systemClock } = await import('../../src/adapters/system')
  const keys = sqliteKeyBrokerRepository(db)
  held = createPluginService({
    companyData: sqliteCompanyData(db), clock: systemClock, ids: randomIds, transactions: sqliteTransactions(db),
    shelf: { ...services.pluginShelf, isStopped: points.stopAfter('stop-file', services.pluginShelf.isStopped) },
    companyKey: (companyId, keyId) => {
      const k = keys.find(companyId, keyId)
      return k ? { scope: k.scope, service: k.service, status: k.status, hosts: (JSON.parse(k.destinations) as { hosts: string[] }).hosts } : null
    },
    isMember: (companyId, userId) => db.prepare('SELECT 1 FROM memberships WHERE company_id = ? AND user_id = ?').get(companyId, userId) !== undefined,
    roleOf: (companyId, userId) => (db.prepare('SELECT role FROM memberships WHERE company_id = ? AND user_id = ?').get(companyId, userId) as Json)?.role ?? null,
    relayReadOnly: () => {},
  })
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('SERVERCORE-4: a plugin change writes only its own fields, and only on what it checked', () => {
  it('an admin turning a business plugin off while its version change is checked: the stop stays, the change is refused', async () => {
    const c = await company()
    expect((await services.plugins.install(c.owner, 'crm-sales', { version: '0.1.0', keyId: null })).ok).toBe(true)
    expect(row(c.co, 'crm-sales')).toMatchObject({ version: '0.1.0', enabled: 1 })
    const at = points.held('stop-file')
    const changing = held.install(c.owner, 'crm-sales', { version: '0.2.0', keyId: null })
    await at.arrived
    expect((await services.plugins.setEnabled(c.admin, 'crm-sales', { enabled: false })).ok).toBe(true)
    at.release()
    expect(await changing).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'PLUGIN_CHANGED' } })
    expect(row(c.co, 'crm-sales')).toMatchObject({ version: '0.1.0', enabled: 0 })
    expect(historyActions(c.co, 'crm-sales').at(-1)).toBe('disable')
  })

  it('another version installed while a business plugin is being turned on: refused, the newer version stays and stays off', async () => {
    const c = await company()
    expect((await services.plugins.install(c.owner, 'crm-sales', { version: '0.1.0', keyId: null })).ok).toBe(true)
    expect((await services.plugins.setEnabled(c.owner, 'crm-sales', { enabled: false })).ok).toBe(true)
    const at = points.held('stop-file')
    const turning = held.setEnabled(c.owner, 'crm-sales', { enabled: true })
    await at.arrived
    expect((await services.plugins.install(c.admin, 'crm-sales', { version: '0.2.0', keyId: null })).ok).toBe(true)
    at.release()
    expect(await turning).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'PLUGIN_CHANGED' } })
    expect(row(c.co, 'crm-sales')).toMatchObject({ version: '0.2.0', enabled: 0 })
  })

  it('a mapping saved while a business plugin\'s version change is checked is kept: the change writes only version, package and key', async () => {
    const c = await company()
    await connectorOn(c) // saving a mapping needs the connector it reads against
    expect((await services.plugins.install(c.owner, 'crm-sales', { version: '0.1.0', keyId: null })).ok).toBe(true)
    const text = db.prepare('SELECT text FROM plugin_mappings WHERE company_id = ? AND plugin_id = ? AND version = 1').get(c.co, 'crm-sales').text as string
    const at = points.held('stop-file')
    const changing = held.install(c.owner, 'crm-sales', { version: '0.2.0', keyId: null })
    await at.arrived
    const edited = text.replace('member-a', c.admin.userId).replace('member-b', c.owner.userId)
    const asked = await services.plugins.saveMapping(c.admin, 'crm-sales', { text: edited })
    expect(asked).toMatchObject({ ok: false, body: { code: 'AUTO_NEEDS_ACKNOWLEDGEMENT' } })
    const saved = await services.plugins.saveMapping(c.admin, 'crm-sales', { text: edited, acknowledgeAuto: asked.body.fields })
    expect(saved).toMatchObject({ ok: true })
    expect(row(c.co, 'crm-sales').mapping_version).toBe(2)
    at.release()
    expect((await changing).ok).toBe(true)
    expect(row(c.co, 'crm-sales')).toMatchObject({ version: '0.2.0', enabled: 1, mapping_version: 2 })
  })

  it('an account bound while a connector is being turned on is kept (the switch is the only field written)', async () => {
    const c = await company()
    expect((await services.plugins.install(c.owner, 'crm-hub', { version: '0.1.0', keyId: c.key })).ok).toBe(true)
    expect((await services.plugins.setReadScope(c.owner, 'crm-hub', { departmentIds: [c.dept] })).ok).toBe(true)
    const { connection_id: connectionId } = row(c.co, 'crm-hub')
    const at = points.held('stop-file')
    const turning = held.setEnabled(c.owner, 'crm-hub', { enabled: true })
    await at.arrived
    // The connector's first call binds the outside account (a compare-and-set of its own).
    const { sqliteCompanyData } = await import('../../src/adapters/sqlite/company-data')
    expect(sqliteCompanyData(db).forCompany(c.co).plugins.bindAccount('crm-hub', connectionId, '4400001',
      { id: `h-${c.co}`, pluginId: 'crm-hub', action: 'account', at: ts(), by: 'connector', change: '{}' })).toBe(true)
    at.release()
    expect((await turning).ok).toBe(true)
    expect(row(c.co, 'crm-hub')).toMatchObject({ enabled: 1, connection_id: connectionId, account_id: '4400001' })
    expect(row(c.co, 'crm-hub').managed_since).not.toBeNull()
  })

  it('a new connection started while a connector\'s version change is checked: refused, the new connection stays', async () => {
    const c = await company()
    await connectorOn(c)
    const before = row(c.co, 'crm-hub')
    const at = points.held('stop-file')
    const changing = held.install(c.owner, 'crm-hub', { version: '0.2.0', keyId: c.key })
    await at.arrived
    expect((await services.pluginImport.renewConnection(c.admin, 'crm-hub')).ok).toBe(true)
    const renewed = row(c.co, 'crm-hub').connection_id
    expect(renewed).not.toBe(before.connection_id)
    at.release()
    expect(await changing).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'PLUGIN_CHANGED' } })
    expect(row(c.co, 'crm-hub')).toMatchObject({ version: '0.1.0', connection_id: renewed, account_id: null, enabled: 1 })
    expect(row(c.co, 'crm-hub').managed_since).toBe(before.managed_since)
  })

  it('a business plugin turned on while a connector change is judged: refused, so its use of the connector does not stop', async () => {
    const c = await company()
    await connectorOn(c)
    // crm-memo on (judged first, its evaluation awaits); crm-sales installed and off.
    expect((await services.plugins.install(c.owner, 'crm-memo', { version: '0.1.0', keyId: null })).ok).toBe(true)
    expect((await services.plugins.install(c.owner, 'crm-sales', { version: '0.1.0', keyId: null })).ok).toBe(true)
    expect((await services.plugins.setEnabled(c.owner, 'crm-sales', { enabled: false })).ok).toBe(true)
    expect(row(c.co, 'crm-memo').enabled).toBe(1)
    // crm-hub 0.0.5 is older than crm-sales accepts (crm-memo takes it). The change's own check (the connector's stop file), then crm-memo's
    // judgement: hold the read inside the dependents' check, after it listed the installs.
    const own = points.held('stop-file')
    const judged = points.held('stop-file')
    const changing = held.install(c.owner, 'crm-hub', { version: '0.0.5', keyId: c.key })
    await own.arrived
    own.release()
    await judged.arrived
    expect((await services.plugins.setEnabled(c.admin, 'crm-sales', { enabled: true })).ok).toBe(true)
    judged.release()
    const r = await changing
    expect(r).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'PLUGIN_CHANGED' } })
    expect(row(c.co, 'crm-hub').version).toBe('0.1.0')
    expect(row(c.co, 'crm-sales').enabled).toBe(1)
  })

  it('a first install\'s automatic turning on leaves an install another admin changed meanwhile as they made it', async () => {
    const c = await company()
    const at = points.held('stop-file')
    const installing = held.install(c.owner, 'crm-sales', { version: '0.1.0', keyId: null })
    await at.arrived
    expect(row(c.co, 'crm-sales')).toMatchObject({ version: '0.1.0', enabled: 0, mapping_version: 1 })
    expect((await services.plugins.install(c.admin, 'crm-sales', { version: '0.2.0', keyId: null })).ok).toBe(true)
    at.release()
    expect((await installing).ok).toBe(true)
    expect(row(c.co, 'crm-sales')).toMatchObject({ version: '0.2.0', enabled: 0, mapping_version: 1 })
    expect(historyActions(c.co, 'crm-sales')).not.toContain('enable')
    // Not turned on, so its types were not stored either.
    expect(db.prepare("SELECT COUNT(*) AS n FROM record_types WHERE company_id = ? AND source = 'plugin'").get(c.co).n).toBe(0)
  })

  it('two admins choosing the same version at once: both succeed, it is written once', async () => {
    const c = await company()
    expect((await services.plugins.install(c.owner, 'crm-sales', { version: '0.1.0', keyId: null })).ok).toBe(true)
    const at = points.held('stop-file')
    const first = held.install(c.owner, 'crm-sales', { version: '0.2.0', keyId: null })
    await at.arrived
    expect((await services.plugins.install(c.admin, 'crm-sales', { version: '0.2.0', keyId: null })).ok).toBe(true)
    at.release()
    expect((await first).ok).toBe(true)
    expect(row(c.co, 'crm-sales')).toMatchObject({ version: '0.2.0', enabled: 1 })
    expect(historyActions(c.co, 'crm-sales').filter(a => a === 'change')).toHaveLength(1)
  })

  it('two owners turning the same plugin on at once: both succeed, it is written once', async () => {
    const c = await company()
    expect((await services.plugins.install(c.owner, 'crm-sales', { version: '0.1.0', keyId: null })).ok).toBe(true)
    expect((await services.plugins.setEnabled(c.owner, 'crm-sales', { enabled: false })).ok).toBe(true)
    const at = points.held('stop-file')
    const first = held.setEnabled(c.owner, 'crm-sales', { enabled: true })
    await at.arrived
    expect((await services.plugins.setEnabled(c.admin, 'crm-sales', { enabled: true })).ok).toBe(true)
    at.release()
    expect((await first).ok).toBe(true)
    expect(row(c.co, 'crm-sales').enabled).toBe(1)
    expect(historyActions(c.co, 'crm-sales').filter(a => a === 'enable')).toHaveLength(2) // the install's own, and one of the two
  })
})
