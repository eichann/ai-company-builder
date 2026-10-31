/**
 * The company map (stage 4-2): the index built from file changes
 * (services/record-index.ts applyRecordChanges) and the query service
 * (services/records.ts), on the real schema behind real company handles.
 *
 * Guards:
 * - id hijack: a copied file claiming a live record's id takes nothing over
 *   (the record keeps its file; the copy is reported), a move keeps the
 *   record, and nothing crosses into or out of a private folder by id;
 * - a type definition change that removes something, or does not raise the
 *   version, leaves the definition in force;
 * - answers AND counts hold only what the caller may read: a private
 *   folder's records do not exist for a member who cannot read it;
 * - a link from outside a private folder into it is never shown or followed,
 *   for anyone; traversal stops at two hops;
 * - one company's handle cannot see, count or reach another's records.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { RecordFileChange } from '../../src/ports/record-files'
import { applyRecordChanges } from '../../src/services/record-index'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'

const TS = '2026-10-31T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let service: RecordService
let tick = 0
const at = () => `2026-11-01T00:00:${String(tick++).padStart(2, '0')}.000Z`

const DEAL_TYPE = (version: number, states = '[open, won, lost]') => `---
label: 商談
version: ${version}
fields:
  title: { label: 件名, kind: text, source: file }
  owner: { label: 担当, kind: person, source: server }
links:
  customer: { label: 顧客, target: customer, cardinality: one }
  related:  { label: 関係する商談, target: deal, cardinality: many }
  files:    { label: 資料, target: file, cardinality: many }
states: ${states}
---
`
const CUSTOMER_TYPE = '---\nlabel: 顧客\nversion: 1\nstates: []\n---\n'
const record = (id: string, type: string, title: string, links = '') => `---\nid: ${id}\ntype: ${type}\n${links ? `links:\n${links}` : ''}---\n# ${title}\n\n${title} の要約。\n`

const owner = (co: string): Member => ({ companyId: co, userId: 'u-owner', role: 'owner' })
const viewer = (co: string): Member => ({ companyId: co, userId: 'u-viewer', role: 'member' })
const other = (co: string): Member => ({ companyId: co, userId: 'u-other', role: 'member' })

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 営業部/評価: a private folder only u-viewer (and owners/admins) may read.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, '営業部/評価', 'folder', ?, ?)").run(`${id}-priv`, id, `${id}-repo`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 0, 0, ?)").run(`${id}-priv-e`, `${id}-priv`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-viewer', 1, 0, ?)").run(`${id}-priv-v`, `${id}-priv`, TS)
  source.forCompany(id).records.setEnabled(true, 'u-owner', TS)
}

function push(co: string, changes: Record<string, string | null>, opts: { scope?: boolean; full?: boolean } = {}) {
  const handle = source.forCompany(co)
  const list: RecordFileChange[] = Object.entries(changes).map(([path, text]) => ({ path, text }))
  sqliteTransactions(conn).run(() => applyRecordChanges(handle.records, {
    repoKey: opts.scope ? `scope:${co}-priv` : 'company',
    scopeId: opts.scope ? `${co}-priv` : null,
    prefix: opts.scope ? '営業部/評価' : '',
    full: opts.full ?? false,
    tip: 'a'.repeat(40),
    at: at(),
    changes: list,
    scopes: handle.scopes.listWithRules(),
  }))
}

function query(member: Member, body: unknown) {
  const r = service.query(member, body)
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const ids = (r: { records: Array<{ id: string }> }) => r.records.map(x => x.id).sort()

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  service = createRecordService({ companyData: source, clock: { now: at, nowMs: () => 0 }, indexer: { schedule: async () => {} } })
  company('a')
  company('b')
  for (const co of ['a', 'b']) {
    push(co, {
      '.acb/types/deal.md': DEAL_TYPE(1),
      '.acb/types/customer.md': CUSTOMER_TYPE,
      '営業部/顧客/A社.md': record(`customer-${co}cust01`, 'customer', `${co} の A社`),
      '営業部/商談/商談1.md': record(`deal-${co}deal01`, 'deal', `${co} 商談1 値引き`, `  customer: customer-${co}cust01\n`),
      // Public → private: written, but never shown or followed.
      '営業部/商談/商談2.md': record(`deal-${co}deal02`, 'deal', `${co} 商談2`, `  related: [deal-${co}priv01]\n`),
    })
    push(co, { '査定.md': record(`deal-${co}priv01`, 'deal', `${co} 査定 値引き`, `  customer: customer-${co}cust01\n`) }, { scope: true })
  }
})

describe('index: ids cannot be taken over', () => {
  it('a copied file with a live record’s id is not indexed; the record keeps its file', () => {
    push('a', { '営業部/コピー.md': record('deal-adeal01', 'deal', '乗っ取り') })
    expect(source.forCompany('a').records.find('deal-adeal01')).toMatchObject({ path: '営業部/商談/商談1.md', title: 'a 商談1 値引き' })
    expect(source.forCompany('a').records.problems(50)).toContainEqual(expect.objectContaining({ path: '営業部/コピー.md', kind: 'duplicate_id' }))
  })

  it('a move in one push keeps the record (and its id)', () => {
    push('a', { '営業部/商談/商談1.md': null, '営業部/商談/2026/商談1.md': record('deal-adeal01', 'deal', 'a 商談1 値引き') })
    expect(source.forCompany('a').records.find('deal-adeal01')).toMatchObject({ path: '営業部/商談/2026/商談1.md', removedAt: null })
  })

  it('a public file cannot claim a private record’s id, nor a private file a public one', () => {
    push('a', { '営業部/漏れ.md': record('deal-apriv01', 'deal', '外から') })
    expect(source.forCompany('a').records.find('deal-apriv01')).toMatchObject({ path: '営業部/評価/査定.md', scopeId: 'a-priv' })
    push('a', { '取り込み.md': record('deal-adeal02', 'deal', '中から') }, { scope: true })
    expect(source.forCompany('a').records.find('deal-adeal02')).toMatchObject({ path: '営業部/商談/商談2.md', scopeId: null })
    const kinds = source.forCompany('a').records.problems(50).map(p => p.kind)
    expect(kinds.filter(k => k === 'moved_across_folders')).toHaveLength(2)
  })

  it('a removed file removes the record from answers; the same file coming back revives it', () => {
    push('a', { '営業部/商談/商談1.md': null })
    expect(ids(query(owner('a'), { type: 'deal' }))).not.toContain('deal-adeal01')
    push('a', { '営業部/商談/商談1.md': record('deal-adeal01', 'deal', 'a 商談1 値引き') })
    expect(ids(query(owner('a'), { type: 'deal' }))).toContain('deal-adeal01')
  })

  it('a full read removes records whose files are gone', () => {
    push('a', { '営業部/顧客/A社.md': record('customer-acust01', 'customer', 'a の A社') }, { full: true })
    expect(ids(query(owner('a'), { type: 'deal' }))).toEqual(['deal-apriv01'])
  })
})

describe('index: type definitions', () => {
  it('a breaking change or an unchanged version leaves the definition in force', () => {
    push('a', { '.acb/types/deal.md': DEAL_TYPE(2, '[open, won]') })
    push('a', { '.acb/types/customer.md': CUSTOMER_TYPE.replace('label: 顧客', 'label: お客さま') })
    const types = service.types(owner('a'))
    if (!types.ok) throw new Error('types')
    const deal = types.value.types.find(t => t.definition.name === 'deal')!
    expect(deal.definition.states).toEqual(['open', 'won', 'lost'])
    expect(deal.versions).toEqual([1])
    expect(types.value.types.find(t => t.definition.name === 'customer')!.definition.label).toBe('顧客')
    const kinds = source.forCompany('a').records.problems(50).map(p => p.kind)
    expect(kinds).toContain('breaking_type_change')
    expect(kinds).toContain('type_version')
  })

  it('an additive change with a higher version is the new version; records keep theirs', () => {
    push('a', { '.acb/types/deal.md': DEAL_TYPE(2, '[open, won, lost, paused]') })
    const types = service.types(owner('a'))
    if (!types.ok) throw new Error('types')
    expect(types.value.types.find(t => t.definition.name === 'deal')!.versions).toEqual([1, 2])
    expect(source.forCompany('a').records.find('deal-adeal01')!.typeVersion).toBe(1)
  })
})

describe('query: only what the caller may read', () => {
  it('a private folder’s records are absent from answers and counts for a member who cannot read it', () => {
    expect(query(owner('a'), { type: 'deal' }).total).toBe(3)
    expect(query(viewer('a'), { type: 'deal' }).total).toBe(3)
    expect(query(other('a'), { type: 'deal', countOnly: true }).total).toBe(2)
    expect(ids(query(other('a'), { text: '値引き' }))).toEqual(['deal-adeal01'])
    expect(ids(query(viewer('a'), { text: '値引き' }))).toEqual(['deal-adeal01', 'deal-apriv01'])
    const missing = service.get(other('a'), 'deal-zzzzzz99')
    const hidden = service.get(other('a'), 'deal-apriv01')
    expect(hidden).toEqual(missing)
  })

  it('links: inbound from a private record only for its readers; public → private never, not even for the owner', () => {
    expect(ids(query(other('a'), { linkedTo: { id: 'customer-acust01' } }))).toEqual(['deal-adeal01'])
    expect(ids(query(viewer('a'), { linkedTo: { id: 'customer-acust01' } }))).toEqual(['deal-adeal01', 'deal-apriv01'])
    expect(ids(query(owner('a'), { linkedTo: { id: 'deal-adeal02' } }))).toEqual([])
    const detail = service.get(owner('a'), 'deal-adeal02')
    expect(detail.ok && detail.value.links).toEqual([])
  })

  it('two hops reach the customer’s other deals; one hop does not', () => {
    expect(ids(query(other('a'), { linkedTo: { id: 'deal-adeal01', hops: 1 } }))).toEqual(['customer-acust01'])
    expect(ids(query(other('a'), { linkedTo: { id: 'deal-adeal01', hops: 2 } }))).toEqual(['customer-acust01'])
    expect(ids(query(viewer('a'), { linkedTo: { id: 'deal-adeal01', hops: 2 } }))).toEqual(['customer-acust01', 'deal-apriv01'])
  })

  it('state and server-field filters read the server state', () => {
    conn.prepare("INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES ('a', 'deal-adeal01', 'won', ?, 3, ?)").run(JSON.stringify({ owner: 'u-other' }), TS)
    expect(ids(query(other('a'), { type: 'deal', state: ['won'] }))).toEqual(['deal-adeal01'])
    expect(ids(query(other('a'), { type: 'deal', fields: { owner: 'u-other' } }))).toEqual(['deal-adeal01'])
    expect(query(other('a'), { type: 'deal', fields: { owner: 'u-other' } }).records[0]).toMatchObject({ state: 'won', version: 3 })
    expect(service.query(other('a'), { type: 'deal', fields: { title: 'x' } }).ok).toBe(false)
  })

  it('turned off: every read answers RECORDS_DISABLED', () => {
    source.forCompany('a').records.setEnabled(false, 'u-owner', TS)
    for (const r of [service.query(owner('a'), {}), service.get(owner('a'), 'deal-adeal01'), service.types(owner('a'))]) {
      expect(r).toMatchObject({ ok: false, kind: 'not-found', body: { code: 'RECORDS_DISABLED' } })
    }
  })
})

describe('across companies', () => {
  it('a company’s handle never sees, counts or reaches another company’s records', () => {
    expect(source.forCompany('a').records.find('deal-bdeal01')).toBeNull()
    expect(query(owner('a'), { type: 'deal' }).total).toBe(3)
    expect(ids(query(owner('a'), { text: 'b ' }))).toEqual([])
    expect(service.get(owner('a'), 'deal-bdeal01')).toEqual(service.get(owner('a'), 'deal-zzzzzz99'))
    expect(service.query(owner('a'), { linkedTo: { id: 'customer-bcust01' } })).toMatchObject({ ok: false, kind: 'not-found' })
  })

  it('a file in one company cannot touch a record id of another', () => {
    push('a', { '営業部/他社.md': record('deal-bdeal01', 'deal', 'a から b の id') })
    expect(source.forCompany('b').records.find('deal-bdeal01')).toMatchObject({ path: '営業部/商談/商談1.md', title: 'b 商談1 値引き' })
    expect(source.forCompany('a').records.find('deal-bdeal01')).toMatchObject({ title: 'a から b の id' })
  })
})
