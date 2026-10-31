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
const otherOwner = { companyId: OTHER, userId: 'pl-other-owner', role: 'owner' }
let hubKey: string, hubKeyOther: string, geminiKey: string

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
  for (const m of [owner, admin, member, otherOwner]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${m.userId}`, m.userId, m.companyId, m.role, ts(), ts())
  }
  // A private folder (its own repository) inside 営業部.
  db.prepare(`INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('pl-s-priv', ?, '営業部/評価', 'folder', 'pl-r-priv', ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES ('pl-r-priv', ?, 'pl-s-priv', ?)`).run(CO, ts())

  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { pluginsDir: shelfDir })
  await services.pluginShelf.load()
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  hubKey = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: SECRET, audience })).value.keys[0].id
  geminiKey = (await services.keyBroker.create(owner, { service: 'gemini', displayName: 'Gemini', secret: `${SECRET}-gemini`, audience })).value.keys
    .find((k: Json) => k.service === 'gemini').id
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
    const saved = await services.plugins.saveMapping(admin, 'crm-hub', { text: MAPPING() })
    expect(saved.value.mapping.version).toBe(2)
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
