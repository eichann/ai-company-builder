/**
 * The core's two noun interfaces, まとまり (`bundle`) and 相手 (`counterpart`)
 * (owner decision 2026-11-01 night, records.md "Core interfaces").
 *
 * Guards:
 * - the core type definitions never name a business plugin's type: every
 *   link target is a core type, `file` or an interface (fails if `deal` /
 *   `customer` come back as a target);
 * - a type claiming an interface without its required fields is refused — a
 *   business plugin's package too (the server's shelf validates it);
 * - a `bundle` link takes any type implementing `bundle` (a 案件 and a 企画)
 *   and nothing else; a `counterpart` link likewise (a 顧客 and a guest); an
 *   unreadable, another company's and a missing record get the same answer;
 * - the startup migration carries old-shape rows over once, per company.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { initDatabase, migrateCoreInterfaceLinks } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { applyRecordChanges, ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type ActorInput, type RecordEngine } from '../../src/services/record-engine'
import type { Member } from '../../src/services/access'
import { CORE_TYPE_FILES, coreTypeDefinitions } from '../../shared/core/core-types'
import { INTERFACES } from '../../shared/core/record-types'
import { validatePluginPackage } from '../../shared/core/plugins'

const TS = '2026-11-01T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let tick = 0
const at = () => `2026-11-01T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`
const PEOPLE = ['u-owner', 'u-alice', 'u-mallory']
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN: ActorInput = { kind: 'human' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const bundleFields = '  owner: { label: 責任者, kind: person, source: server }\n  purpose: { label: なんのため, kind: text, source: server }\n'
const counterpartFields = '  counterpart_kind: { label: 会社か人か, kind: choice, options: [company, person], source: server }\n  domain: { label: ドメイン, kind: text, source: server }\n  email: { label: メール, kind: text, source: server }\n'
/** Two lines of work's まとまり, two kinds of 相手, and a type that is neither. */
const TYPES: Record<string, string> = {
  deal: `---\nlabel: 案件\nversion: 1\nstorage: server\nimplements: [bundle]\nfields:\n${bundleFields}states: [open, won]\nfinal: [won]\n---\n`,
  plan: `---\nlabel: 企画\nversion: 1\nstorage: server\nimplements: [bundle]\nfields:\n${bundleFields}states: [planning, aired]\nfinal: [aired]\n---\n`,
  customer: `---\nlabel: 顧客\nversion: 1\nstorage: server\nimplements: [counterpart]\nfields:\n${counterpartFields}states: [active]\n---\n`,
  guest: `---\nlabel: ゲスト\nversion: 1\nstorage: server\nimplements: [counterpart]\nfields:\n${counterpartFields}states: [active]\n---\n`,
  memo: '---\nlabel: メモ\nversion: 1\nstorage: server\nstates: [open]\n---\n',
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 経理: a folder u-mallory cannot read.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '経理', 'folder', ?)").run(`${id}-acc`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-acc-e`, `${id}-acc`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-mallory', 0, 0, ?)").run(`${id}-acc-m`, `${id}-acc`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  sqliteTransactions(conn).run(() => applyRecordChanges(records, {
    repoKey: 'company', scopeId: null, prefix: '', full: false, tip: 'a'.repeat(40), at: at(), scopes: source.forCompany(id).scopes.listWithRules(),
    changes: Object.entries(TYPES).map(([name, text]) => ({ path: `.acb/types/${name}.md`, text })),
  }))
}

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: at, nowMs: () => 0 },
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null),
    notify: () => {},
  })
  company('a')
  company('b')
  expect(source.forCompany('a').records.problems(100)).toEqual([])
})

const make = (type: string, title: string, extra: Record<string, unknown> = {}, member = m('u-alice')) =>
  ok(engine.create(member, HUMAN, { type, title, ...extra })).record

describe('the core names no business type', () => {
  it('every link of a core type targets a core type, a file or an interface', () => {
    const core = new Set(Object.keys(CORE_TYPE_FILES))
    for (const def of coreTypeDefinitions()) {
      for (const [name, link] of Object.entries(def.links)) {
        const fine = link.targetIsInterface ? Object.prototype.hasOwnProperty.call(INTERFACES, link.target) : link.target === 'file' || core.has(link.target)
        expect(fine, `${def.name}.links.${name} → ${link.target}`).toBe(true)
      }
      for (const [name, field] of Object.entries(def.fields)) if (field.target) expect(core.has(field.target), `${def.name}.fields.${name}`).toBe(true)
    }
    // Spelled out: the business plugin's types of 法人営業 are not targets anywhere in the core.
    for (const text of Object.values(CORE_TYPE_FILES)) expect(text).not.toMatch(/target:\s*(deal|customer)\b/)
  })

  it('the core interfaces are fixed: bundle and counterpart for things, request and prepared for turns, outside_event for what happened outside', () => {
    expect(Object.keys(INTERFACES).sort()).toEqual(['bundle', 'counterpart', 'outside_event', 'prepared', 'request'])
  })
})

describe('a type claiming an interface keeps its promise', () => {
  const FIXTURES = join(__dirname, '../fixtures/plugins')
  function readPackage(name: string) {
    const dir = join(FIXTURES, name)
    const types: Record<string, string> = {}
    for (const f of readdirSync(join(dir, 'types'))) types[f.replace(/\.md$/, '')] = readFileSync(join(dir, 'types', f), 'utf8')
    return { manifest: readFileSync(join(dir, 'plugin.yaml'), 'utf8'), types, mapping: existsSync(join(dir, 'mapping.yaml')) ? readFileSync(join(dir, 'mapping.yaml'), 'utf8') : null }
  }

  it('a business plugin whose 案件 claims bundle without its fields, or whose 顧客 claims counterpart without its kind, is refused', () => {
    const sales = readPackage('sample-sales')
    expect(validatePluginPackage(sales).ok).toBe(true)
    const noOwner = { ...sales, types: { ...sales.types, deal: sales.types.deal.replace(/ {2}owner: .*\n/, '') } }
    const r1 = validatePluginPackage(noOwner)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.errors.join()).toContain('owner')
    const noFinal = { ...sales, types: { ...sales.types, deal: sales.types.deal.replace(/final: .*\n/, '') } }
    expect(validatePluginPackage(noFinal).ok).toBe(false)
    const noKind = { ...sales, types: { ...sales.types, customer: sales.types.customer.replace(/ {2}counterpart_kind: .*\n/, '') } }
    const r2 = validatePluginPackage(noKind)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.errors.join()).toContain('counterpart_kind')
  })

  it('a company type file claiming an interface without its fields is not taken by the index', () => {
    const records = source.forCompany('a').records
    sqliteTransactions(conn).run(() => applyRecordChanges(records, {
      repoKey: 'company', scopeId: null, prefix: '', full: false, tip: 'b'.repeat(40), at: at(), scopes: source.forCompany('a').scopes.listWithRules(),
      changes: [{ path: '.acb/types/lead.md', text: '---\nlabel: 引き合い\nversion: 1\nstorage: server\nimplements: [counterpart]\nfields:\n  domain: { label: ドメイン, kind: text, source: server }\nstates: [open]\n---\n' }],
    }))
    expect(records.typeVersions().some(t => t.name === 'lead')).toBe(false)
    expect(records.problems(100).map(p => p.path)).toContain('.acb/types/lead.md')
  })
})

describe('links to an interface take any type implementing it, and nothing else', () => {
  it('bundle: a 案件 and a 企画, never a 相手 or a memo', () => {
    const deal = make('deal', '導入案件')
    const plan = make('plan', '秋の特番')
    expect(make('task', 'A', { links: { bundle: deal.id } })).toBeTruthy()
    expect(make('task', 'B', { links: { bundle: plan.id } })).toBeTruthy()
    const refused = engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'C', links: { bundle: make('customer', '物産').id } })
    expect(refused).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'D', links: { bundle: make('memo', 'メモ').id } })).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
  })

  it('counterpart: a 顧客 and a guest, never a まとまり', () => {
    const customer = make('customer', '株式会社サンプル物産')
    const guest = make('guest', '出演者さん')
    expect(make('task', 'A', { links: { counterpart: customer.id } })).toBeTruthy()
    expect(make('interaction', 'メール', { links: { counterpart: guest.id, bundle: make('plan', '企画').id } })).toBeTruthy()
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'B', links: { counterpart: make('deal', '案件').id } })).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
  })

  it('an unreadable, another company’s and a missing record get the same answer', () => {
    const hidden = make('customer', '経理の相手', { folder: '経理' }, m('u-owner'))
    const theirs = make('customer', 'よその相手', {}, m('u-alice', 'b'))
    const missing = engine.create(m('u-mallory'), HUMAN, { type: 'task', title: 'X', links: { counterpart: 'customer-zzzzzzzz' } })
    expect(missing).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
    expect(engine.create(m('u-mallory'), HUMAN, { type: 'task', title: 'X', links: { counterpart: hidden.id } })).toEqual(missing)
    expect(engine.create(m('u-mallory'), HUMAN, { type: 'task', title: 'X', links: { counterpart: theirs.id } })).toEqual(missing)
  })

  it('the task no longer has a customer link', () => {
    const customer = make('customer', '物産')
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'X', links: { customer: customer.id } })).toMatchObject({ ok: false })
  })
})

describe('the startup migration (records made before the core interfaces)', () => {
  it('carries the old shape over once, per company, and leaves other types alone', () => {
    const q = (sql: string, ...args: unknown[]) => conn.prepare(sql).all(...args)
    const ins = (co: string, id: string, type: string) =>
      conn.prepare("INSERT INTO records (company_id, id, type, type_version, title, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)").run(co, id, type, id, TS, TS)
    const link = (co: string, from: string, name: string, to: string) =>
      conn.prepare('INSERT INTO record_links (company_id, source_id, name, position, target_id) VALUES (?, ?, ?, 0, ?)').run(co, from, name, to)
    for (const co of ['a', 'b']) {
      ins(co, 'minutes-000001', 'minutes')
      ins(co, 'approval-000001', 'approval')
      ins(co, 'interaction-000001', 'interaction')
      ins(co, 'deal-000001', 'deal')
      link(co, 'minutes-000001', 'deal', 'deal-000001')
      link(co, 'minutes-000001', 'customer', 'customer-000001')
      link(co, 'approval-000001', 'about', 'deal-000001')
      link(co, 'approval-000001', 'minutes', 'minutes-000001')
      link(co, 'interaction-000001', 'deal', 'deal-000001')
      // A business plugin's own link of the same name is not the core's: it stays.
      link(co, 'deal-000001', 'customer', 'customer-000001')
      conn.prepare('INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(co, 'interaction-000001', 'received', JSON.stringify({ counterpart: 'example.co.jp', channel: 'email' }), TS)
    }
    conn.prepare("INSERT INTO record_types (company_id, name, version, definition, source, created_at) VALUES ('a', 'minutes', 1, '{}', 'core', ?)").run(TS)

    migrateCoreInterfaceLinks(conn)
    const once = q('SELECT company_id, source_id, name, target_id FROM record_links ORDER BY company_id, source_id, name')
    migrateCoreInterfaceLinks(conn) // a second start changes nothing
    expect(q('SELECT company_id, source_id, name, target_id FROM record_links ORDER BY company_id, source_id, name')).toEqual(once)

    for (const co of ['a', 'b']) {
      expect(q("SELECT type, type_version FROM records WHERE company_id = ? AND id = 'minutes-000001'", co)).toEqual([{ type: 'meeting', type_version: 1 }])
      const names = (id: string) => (q('SELECT name FROM record_links WHERE company_id = ? AND source_id = ? ORDER BY name', co, id) as Array<{ name: string }>).map(r => r.name)
      expect(names('minutes-000001')).toEqual(['bundle', 'counterpart'])
      expect(names('approval-000001')).toEqual(['bundle', 'meeting'])
      expect(names('interaction-000001')).toEqual(['bundle'])
      expect(names('deal-000001')).toEqual(['customer'])
      const fields = JSON.parse((q("SELECT fields FROM record_state WHERE company_id = ? AND record_id = 'interaction-000001'", co)[0] as { fields: string }).fields)
      expect(fields).toEqual({ counterpart_text: 'example.co.jp', channel: 'email' })
    }
    expect(q("SELECT name FROM record_types WHERE company_id = 'a' AND name = 'minutes'")).toEqual([])
  })
})
