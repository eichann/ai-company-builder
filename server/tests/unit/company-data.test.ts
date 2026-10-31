/**
 * The company handle (ports/company-data.ts) against the real schema: a
 * handle opened for company A cannot see, change, reorder or delete company
 * B's rows, even when given B's ids — the guarantee every service relies on
 * instead of checking "is this id in my company?" first.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import type { CompanyDataSource } from '../../src/ports/company-data'

const TS = '2026-10-31T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u', TS, TS)
}

function department(companyId: string, id: string, folder: string, sortOrder: number) {
  source.forCompany(companyId).departments.insert({
    id, name: folder, nameEn: null, folder, icon: 'Folder', color: '#000000', description: null, sortOrder, createdAt: TS, createdBy: 'u',
  })
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  company('a')
  company('b')
  department('a', 'a-sales', '営業部', 0)
  department('b', 'b-sales', '営業部', 0)
  department('b', 'b-hr', '人事', 1)
})

const rowOf = (id: string) => conn.prepare('SELECT * FROM departments WHERE id = ?').get(id)

describe('company handle: departments', () => {
  it('a new row belongs to the handle’s company', () => {
    expect(rowOf('a-sales')).toMatchObject({ company_id: 'a' })
    expect(rowOf('b-hr')).toMatchObject({ company_id: 'b' })
  })

  it('reads only its own company', () => {
    const a = source.forCompany('a').departments
    expect(a.list().map(d => d.id)).toEqual(['a-sales'])
    expect(a.listUnordered().map(d => d.id)).toEqual(['a-sales'])
    expect(a.folders()).toEqual([{ id: 'a-sales', folder: '営業部' }])
    expect(a.count()).toBe(1)
    expect(a.maxSortOrder()).toBe(0)
    expect(a.find('b-hr')).toBeUndefined()
    expect(a.exists('b-hr')).toBe(false)
    expect(a.find('a-sales')).toMatchObject({ id: 'a-sales', company_id: 'a' })
  })

  it('cannot change, reorder or delete another company’s department', () => {
    const a = source.forCompany('a').departments
    const before = rowOf('b-hr')
    a.update('b-hr', { name: '乗っ取り', folder: 'x', isActive: false }, '2026-11-01T00:00:00.000Z')
    a.setSortOrders([{ id: 'b-hr', sortOrder: 99 }], '2026-11-01T00:00:00.000Z')
    a.delete('b-hr')
    expect(rowOf('b-hr')).toEqual(before)
    expect(source.forCompany('b').departments.count()).toBe(2)
  })

  it('changes its own department', () => {
    const a = source.forCompany('a').departments
    a.update('a-sales', { name: '営業' }, '2026-11-01T00:00:00.000Z')
    expect(a.find('a-sales')).toMatchObject({ name: '営業', updated_at: '2026-11-01T00:00:00.000Z' })
    a.delete('a-sales')
    expect(a.count()).toBe(0)
  })

  it('refuses to open a handle without a company', () => {
    expect(() => source.forCompany('')).toThrow()
  })
})

describe('company handle: invitations', () => {
  const invite = (companyId: string, id: string) => source.forCompany(companyId).invitations.insert({
    id, token: `t-${id}`, role: 'member', createdBy: 'u', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: TS,
  })
  const row = (id: string) => conn.prepare('SELECT * FROM invitations WHERE id = ?').get(id)

  it('cannot see, use, release, mark or delete another company’s invitation', () => {
    invite('a', 'ia')
    invite('b', 'ib')
    conn.prepare('UPDATE invitations SET signup_claimed_at = ? WHERE id = ?').run(TS, 'ib')
    const before = row('ib')
    const a = source.forCompany('a').invitations
    expect(a.list().map(i => i.id)).toEqual(['ia'])
    expect(a.exists('ib')).toBe(false)
    expect(a.consume('ib', 'intruder')).toBe(false)
    a.releaseSignupClaim('ib')
    a.recordSignupUser('ib', 'intruder')
    a.delete('ib')
    expect(row('ib')).toEqual(before)
    expect(row('ia')).toMatchObject({ company_id: 'a' })
  })
})

describe('company handle: scopes, rules and managers', () => {
  beforeEach(() => {
    for (const [co, u] of [['a', 'ua'], ['b', 'ub']]) {
      conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, co, 'member', TS, TS)
      source.forCompany(co).scopes.syncCompanyScopes()
    }
    source.forCompany('b').scopes.replaceDepartmentManagers('b-hr', ['ub'], 'ub')
    source.forCompany('b').scopes.upsertRule('人事', { subjectType: 'user', subjectId: 'ub', canRead: true, canWrite: true }, 'ub')
  })
  const bRoot = () => source.forCompany('b').scopes.getByPath('')!
  const table = (sql: string) => conn.prepare(sql).all()
  const snapshot = () => ({
    rules: table('SELECT * FROM scope_rules ORDER BY id'),
    managers: table('SELECT * FROM department_managers ORDER BY department_id, user_id'),
    scopes: table(`SELECT * FROM scopes WHERE company_id = 'b' ORDER BY id`),
  })

  it('reads only its own company', () => {
    const a = source.forCompany('a').scopes
    const b = source.forCompany('b').scopes
    const bRuleId = b.rulesOf(bRoot().id)[0].id
    expect(a.listWithRules().map(s => s.path).sort()).toEqual(['', '営業部'])
    expect(a.getById(bRoot().id)).toBeNull()
    expect(a.rulesOf(bRoot().id)).toEqual([])
    expect(a.ruleWithScope(bRuleId)).toBeNull()
    expect(a.departmentManagerIds('b-hr')).toEqual([])
    expect(b.departmentManagerIds('b-hr')).toEqual(['ub'])
  })

  it('cannot change or remove another company’s rules, scopes or managers', () => {
    const a = source.forCompany('a').scopes
    const root = bRoot()
    const hr = source.forCompany('b').scopes.getByPath('人事')!
    const bRuleId = source.forCompany('b').scopes.rulesOf(root.id)[0].id
    const before = snapshot()

    a.updateRuleAccess(bRuleId, false, false)
    a.deleteRule(bRuleId, root)
    expect(a.clearRules(hr)).toBe(0)
    expect(a.deleteUserRules('ub')).toBe(0)
    // Adding a manager to another company's department is refused outright (insert trigger).
    expect(() => a.replaceDepartmentManagers('b-hr', ['ua'], 'ua')).toThrow(/company of its department/)
    a.replaceDepartmentManagers('b-hr', [], 'ua')
    a.removeManagerFromCompany('ub')
    a.deleteDepartmentScopes('b-hr', '人事')
    a.ensureDepartmentScope('b-hr', '乗っ取り', 'ua')

    expect(snapshot()).toEqual(before)
  })
})

describe('company handle: private folders', () => {
  it('another company’s private folder is not found and its viewers do not change', () => {
    conn.prepare(`INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('s-b', 'b', '人事/評価', 'folder', 'r-b', ?)`).run(TS)
    conn.prepare(`INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES ('r-b', 'b', 's-b', ?)`).run(TS)
    conn.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('b', 'ru-b', 's-b', 'everyone', NULL, 0, 0, ?)`).run(TS)
    const a = source.forCompany('a').privateFolders
    expect(a.list()).toEqual([])
    expect(a.paths()).toEqual([])
    expect(a.get('s-b')).toBeNull()
    expect(source.forCompany('b').privateFolders.get('s-b')?.scope.path).toBe('人事/評価')

    // Adding a rule under another company's scope is refused outright (insert trigger); nothing is removed either.
    expect(() => a.replaceRules('s-b', { viewers: ['intruder'], editors: ['intruder'] }, 'intruder')).toThrow(/company of its scope/)
    expect(conn.prepare(`SELECT id FROM scope_rules WHERE scope_id = 's-b'`).all()).toEqual([{ id: 'ru-b' }])
  })
})

describe('company handle: connector plugins', () => {
  const brokerKey = (companyId: string, id: string, scope = 'company') => conn.prepare(`
    INSERT INTO broker_keys (id, company_id, scope, owner_user_id, service, display_name, last4, cipher_scheme, ciphertext, nonce, tag,
      wrapped_key, kek_id, destinations, audience, caps, allow_private_content, status, created_at, created_by, updated_at, updated_by, secret_updated_at)
    VALUES (?, ?, ?, ?, 'hubspot', 'k', 'abcd', 's', x'00', x'00', x'00', x'00', 'local:0', '{}', '{}', '{}', 0, 'active', ?, 'u', ?, 'u', ?)
  `).run(id, companyId, scope, scope === 'user' ? 'u' : null, TS, TS, TS)
  const install = (keyId: string | null) => ({
    pluginId: 'sample-crm', version: '0.1.0', fingerprint: 'f', service: 'hubspot', connectionId: 'conn-1', accountId: null,
    enabled: true, managedSince: TS, keyId, mappingVersion: 0, updatedAt: TS, updatedBy: 'u',
  })
  const h = (id: string) => ({ id, pluginId: 'sample-crm', action: 'install', at: TS, by: 'u', change: '{}' })

  it('reads and writes only its own company’s installs, mappings and history', () => {
    brokerKey('b', 'key-b')
    const b = source.forCompany('b').plugins
    b.saveInstall(install('key-b'), h('h-b'))
    b.addMapping({ pluginId: 'sample-crm', version: 1, text: 'deal: {}', createdAt: TS, createdBy: 'u' }, h('h-b2'))
    const a = source.forCompany('a').plugins
    expect(a.install('sample-crm')).toBeNull()
    expect(a.installs()).toEqual([])
    expect(a.mapping('sample-crm', 1)).toBeNull()
    expect(a.mappingVersions('sample-crm')).toEqual([])
    expect(a.history('sample-crm', 50)).toEqual([])
    // A mapping under another company's install is refused (insert trigger), and B's install is untouched.
    expect(() => a.addMapping({ pluginId: 'sample-crm', version: 2, text: 'x', createdAt: TS, createdBy: 'u' }, h('h-a'))).toThrow(/install of the same company/)
    expect(b.install('sample-crm')).toMatchObject({ mappingVersion: 1, keyId: 'key-b' })
  })

  it('an install can use only a company key of its own company', () => {
    brokerKey('b', 'key-b')
    brokerKey('a', 'own-a', 'user')
    const a = source.forCompany('a').plugins
    expect(() => a.saveInstall(install('key-b'), h('h1'))).toThrow(/company key of the same company/)
    expect(() => a.saveInstall(install('own-a'), h('h2'))).toThrow(/company key of the same company/)
    brokerKey('a', 'key-a')
    a.saveInstall(install('key-a'), h('h3'))
    expect(() => a.saveInstall(install('key-b'), h('h4'))).toThrow(/company key of the same company/)
    expect(a.install('sample-crm')?.keyId).toBe('key-a')
    expect(() => conn.prepare(`UPDATE plugin_installs SET company_id = 'b' WHERE company_id = 'a'`).run()).toThrow(/never move/)
  })

  it('an operation record belongs to a record of its own company, and keeps what it wrote and what it replaced', () => {
    conn.prepare(`INSERT INTO records (company_id, id, type, title, created_at, updated_at) VALUES ('b', 'deal-b00009', 'deal', 'B', ?, ?)`).run(TS, TS)
    conn.prepare(`INSERT INTO records (company_id, id, type, title, created_at, updated_at) VALUES ('a', 'deal-a00009', 'deal', 'A', ?, ?)`).run(TS, TS)
    const op = (recordId: string) => ({
      id: 'op-1', pluginId: 'p', operation: 'update_deal', pluginVersion: '0.1.0', fingerprint: 'f', mappingVersion: 1, connectionId: 'c', accountId: '1',
      object: 'deal', externalId: '1', recordId, actorId: 'u', actorKind: 'human' as const, actorSource: null, conversationId: null, state: 'pending' as const,
      fields: '{}', written: '{"x":"1"}', previous: '{"x":"0"}', reason: null, undoOf: null, undoneBy: null, recordVersion: null, createdAt: TS, updatedAt: TS,
    })
    const a = source.forCompany('a').plugins
    expect(() => a.insertOperation(op('deal-b00009'))).toThrow(/record of the same company/)
    a.insertOperation(op('deal-a00009'))
    expect(source.forCompany('b').plugins.operation('op-1')).toBeNull()
    expect(() => conn.prepare(`UPDATE plugin_operations SET previous = '{"x":"9"}' WHERE id = 'op-1'`).run()).toThrow(/keeps its company/)
    a.updateOperation('op-1', { state: 'applied' }, TS)
    expect(a.operation('op-1')).toMatchObject({ state: 'applied', previous: '{"x":"0"}' })
  })

  it('an outside object links only to a record of its own company, and links are found per company, connection and account', () => {
    conn.prepare(`INSERT INTO records (company_id, id, type, title, created_at, updated_at) VALUES ('b', 'deal-b00001', 'deal', 'B', ?, ?)`).run(TS, TS)
    conn.prepare(`INSERT INTO records (company_id, id, type, title, created_at, updated_at) VALUES ('a', 'deal-a00001', 'deal', 'A', ?, ?)`).run(TS, TS)
    const link = (recordId: string, accountId = '9001') => ({
      pluginId: 'sample-crm', connectionId: 'conn-1', accountId, object: 'deal', externalId: '42', recordId, externalUpdatedAt: null, seenAt: TS,
    })
    const a = source.forCompany('a').plugins
    expect(() => a.saveLink(link('deal-b00001'))).toThrow(/record of the same company/)
    a.saveLink(link('deal-a00001'))
    expect(a.link('conn-1', '9001', 'deal', '42')?.recordId).toBe('deal-a00001')
    expect(a.link('conn-1', '9002', 'deal', '42')).toBeNull()
    expect(a.link('conn-2', '9001', 'deal', '42')).toBeNull()
    expect(source.forCompany('b').plugins.link('conn-1', '9001', 'deal', '42')).toBeNull()
    expect(source.forCompany('b').plugins.linkOfRecord('deal-a00001')).toBeNull()
  })
})
