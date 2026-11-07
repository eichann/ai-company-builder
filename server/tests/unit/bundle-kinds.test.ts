/**
 * 束ねる種類 (records.md "Bundle kinds", owner decision 2026-11-02): which kind each department
 * makes, decided without a setting, and the company's name for the core's kind.
 *
 * Guards (each fails when its part of services/bundle-kinds.ts or shared/core/task-settings.ts is
 * removed):
 * - with no business kind every department makes the core's `project`, under the company's name;
 * - a department where an enabled business plugin's bundle type lives — placed there by its
 *   mapping, or with records there — makes that kind; other departments the core's;
 * - a turned-off plugin, or another company's plugin and records, decide nothing;
 * - records the member cannot read decide nothing for them (records.md "No leaks");
 * - the name is checked (one line, 1–20 characters) and a document without it reads 「プロジェクト」.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { applyRecordChanges, ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
import { createBundleKinds } from '../../src/services/bundle-kinds'
import type { Member } from '../../src/services/access'
import { parseTypeFile, type TypeDefinition } from '../../../shared/core/record-types'
import { defaultTaskSettings, parseTaskSettings } from '../../../shared/core/task-settings'

const TS = '2026-11-02T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let names: Record<string, string>

const m = (co = 'a', userId = 'u-alice'): Member => ({ companyId: co, userId, role: 'member' })
function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const DEAL = `---
label: 案件
version: 1
storage: server
implements: [bundle]
fields:
  owner:   { label: 担当, kind: person, source: server }
  purpose: { label: 目的, kind: text, source: server }
states: [open, won, lost]
final: [won, lost]
---
`
const dealDef = (parseTypeFile('deal', DEAL) as { ok: true; definition: TypeDefinition }).definition
/** A business plugin owning `deal` and placing the connector's `deals` there. */
const PKG = { manifest: { id: 'corporate-sales', service: '', uses: { objects: { deals: { recordType: 'deal' } } } }, types: { deal: dealDef } }
const shelf = { find: (_co: string, id: string) => (id === 'corporate-sales' ? { pkg: PKG } as never : null) }

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  for (const [i, folder] of ['営業部', '開発部'].entries()) {
    conn.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${id}-${i}`, id, folder, folder, i, TS, TS)
  }
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  sqliteTransactions(conn).run(() => applyRecordChanges(records, {
    repoKey: 'company', scopeId: null, prefix: '', full: false, tip: 'a'.repeat(40), at: TS, scopes: source.forCompany(id).scopes.listWithRules(),
    changes: [{ path: '.acb/types/deal.md', text: DEAL }],
  }))
}

function install(co: string, opts: { enabled: boolean; mapping?: string }) {
  conn.prepare(`INSERT INTO plugin_installs (company_id, plugin_id, version, fingerprint, service, connection_id, enabled, mapping_version, updated_at, updated_by)
    VALUES (?, 'corporate-sales', '0.3.0', 'f', '', 'c', ?, ?, ?, 'u-owner')`).run(co, opts.enabled ? 1 : 0, opts.mapping ? 1 : 0, TS)
  if (opts.mapping) {
    conn.prepare("INSERT INTO plugin_mappings (company_id, plugin_id, version, text, created_at, created_by) VALUES (?, 'corporate-sales', 1, ?, ?, 'u-owner')").run(co, opts.mapping, TS)
  }
}

const kinds = (co = 'a') => ok(createBundleKinds({ companyData: source, shelf, settingsOf: c => ({ bundleName: names[c] ?? 'プロジェクト' }) }).kinds(m(co)))
const byFolder = (co = 'a') => Object.fromEntries(kinds(co).departments.map(d => [d.folder, `${d.kind.type}:${d.kind.name}`]))

beforeEach(() => {
  names = {}
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  engine = createRecordEngine({
    companyData: source, transactions: sqliteTransactions(conn), clock: { now: () => TS, nowMs: () => 0 },
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [],
    isMember: () => true, roleOf: () => 'member', notify: () => {},
  })
  company('a')
  company('b')
})

describe('which kind each department makes', () => {
  it('with no business kind: the core’s, under the company’s name', () => {
    expect(byFolder()).toEqual({ 営業部: 'project:プロジェクト', 開発部: 'project:プロジェクト' })
    names.a = '取り組み'
    expect(kinds().core).toEqual({ type: 'project', name: '取り組み', source: 'core' })
    expect(kinds().kinds).toEqual([{ type: 'project', name: '取り組み', source: 'core' }])
  })

  it('the department the plugin’s mapping places its kind in makes that kind; the others the core’s', () => {
    install('a', { enabled: true, mapping: 'objects:\n  deals:\n    visible_to_folder: 営業部\n' })
    expect(byFolder()).toEqual({ 営業部: 'deal:案件', 開発部: 'project:プロジェクト' })
    expect(kinds().kinds.map(k => k.type)).toEqual(['deal', 'project'])
    // Another company's plugin decides nothing here.
    expect(byFolder('b')).toEqual({ 営業部: 'project:プロジェクト', 開発部: 'project:プロジェクト' })
  })

  it('records of the kind living in a department count too; a turned-off plugin decides nothing', () => {
    install('a', { enabled: true })
    ok(engine.create(m('a'), { kind: 'human' }, { type: 'deal', title: 'A社 研修導入', folder: '開発部', fields: { owner: 'u-alice' } }))
    expect(byFolder()).toEqual({ 営業部: 'project:プロジェクト', 開発部: 'deal:案件' })
    // Another company's records of the same type do not move company a's departments.
    ok(engine.create(m('b'), { kind: 'human' }, { type: 'deal', title: 'B社', folder: '営業部', fields: { owner: 'u-alice' } }))
    expect(byFolder().営業部).toBe('project:プロジェクト')
    conn.prepare("UPDATE plugin_installs SET enabled = 0 WHERE company_id = 'a'").run()
    expect(byFolder()).toEqual({ 営業部: 'project:プロジェクト', 開発部: 'project:プロジェクト' })
  })

  it('records the member cannot read decide nothing for them', () => {
    install('a', { enabled: true })
    // 開発部: u-bob may not read it.
    conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-dev', 'a', '開発部', 'folder', ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-dev-e', 'a-dev', 'everyone', NULL, 1, 1, ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-dev-b', 'a-dev', 'user', 'u-bob', 0, 0, ?)").run(TS)
    ok(engine.create(m('a'), { kind: 'human' }, { type: 'deal', title: '開発部の案件', folder: '開発部', fields: { owner: 'u-alice' } }))
    expect(byFolder().開発部).toBe('deal:案件')
    const bob = ok(createBundleKinds({ companyData: source, shelf, settingsOf: () => ({ bundleName: 'プロジェクト' }) }).kinds(m('a', 'u-bob')))
    expect(Object.fromEntries(bob.departments.map(d => [d.folder, d.kind.type]))).toEqual({ 営業部: 'project', 開発部: 'project' })
  })

  it('answers like every records route while the company map is off', () => {
    source.forCompany('a').records.setEnabled(false, 'u-owner', TS)
    expect(createBundleKinds({ companyData: source, shelf, settingsOf: () => ({ bundleName: 'x' }) }).kinds(m('a'))).toMatchObject({ ok: false, body: { code: 'RECORDS_DISABLED' } })
  })
})

describe('the company’s name for the core kind', () => {
  const doc = (bundleName?: unknown) => ({ ...defaultTaskSettings(), ...(bundleName === undefined ? {} : { bundleName }) })
  it('is 「プロジェクト」 when a document has none, normalized, and one line of 1–20 characters', () => {
    const older: Record<string, unknown> = { ...defaultTaskSettings() }
    delete older.bundleName
    expect(parseTaskSettings(older)).toMatchObject({ value: { bundleName: 'プロジェクト' } })
    expect(parseTaskSettings(doc('  取り組み  '))).toMatchObject({ value: { bundleName: '取り組み' } })
    for (const bad of ['', '   ', 'あ'.repeat(21), '案件\nB', 3]) expect(parseTaskSettings(doc(bad)), JSON.stringify(bad)).toHaveProperty('error')
  })
})
