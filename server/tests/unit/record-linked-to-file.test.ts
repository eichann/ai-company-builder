/**
 * 「つながっているもの」 of a file: `POST /records/query { linkedToFile }`
 * (services/records.ts, records.md "Reading").
 *
 * Guards:
 * - only records the caller reads, and only for a file the caller reads — an
 *   unreadable file answers exactly like a file nothing links to;
 * - a record outside a private folder never counts for a path inside it (the
 *   link is stored but never shown, for anyone), while a record inside that
 *   folder shows only to its readers;
 * - another company's links never count.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'

const TS = '2026-11-01T00:00:00.000Z'
const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-carol', 'u-mallory']
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  source.forCompany(id).records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(source.forCompany(id).records, TS)
}

/** A record row and its file link written straight into the map (as the indexer would for a file record). */
function rawRecord(co: string, id: string, scopeId: string | null, path: string | null, folder: string | null, linkTo: string) {
  conn.prepare('INSERT INTO records (company_id, id, type, type_version, scope_id, path, folder, title, summary, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .run(co, id, 'task', scopeId, path, folder, id, '', TS, TS)
  conn.prepare('INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path) VALUES (?, ?, ?, 0, NULL, ?)').run(co, id, 'files', linkTo)
}

const linkedTo = (member: Member, path: string) => ok(service.query(member, { linkedToFile: path }))
const ids = (member: Member, path: string) => linkedTo(member, path).records.map(r => r.id).sort()

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: () => TS, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null),
    notify: () => {},
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  company('a')
  company('b')
  // 営業部/評価: a private folder only u-carol reads. 経理: closed to u-mallory.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('a-priv', 'a', '営業部/評価', 'folder', 'a-repo', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-priv-e', 'a-priv', 'everyone', NULL, 0, 0, ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-priv-c', 'a-priv', 'user', 'u-carol', 1, 1, ?)").run(TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-acc', 'a', '経理', 'folder', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-acc-e', 'a-acc', 'everyone', NULL, 1, 1, ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-acc-m', 'a-acc', 'user', 'u-mallory', 0, 0, ?)").run(TS)
})

describe('records linked to a file', () => {
  it('lists the readable records linking to exactly that path', () => {
    const t = ok(engine.create(m('u-alice'), { kind: 'human' }, { type: 'task', title: '見積を出す', links: { files: ['営業部/見積.md'] } })).record
    ok(engine.create(m('u-alice'), { kind: 'human' }, { type: 'task', title: 'ほか', links: { files: ['営業部/見積.md.bak'] } }))
    expect(ids(m('u-bob'), '営業部/見積.md')).toEqual([t.id])
    expect(linkedTo(m('u-bob'), '営業部/見積.md').total).toBe(1)
    expect(service.query(m('u-bob'), { linkedToFile: '/etc/passwd' })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(service.query(m('u-bob'), { linkedToFile: '営業部/../経理/給与.md' })).toMatchObject({ ok: false, kind: 'bad-request' })
  })

  it('a file the caller cannot read answers like a file nothing links to', () => {
    ok(engine.create(m('u-alice'), { kind: 'human' }, { type: 'task', title: '給与', links: { files: ['経理/給与.md'] } }))
    expect(ids(m('u-bob'), '経理/給与.md')).toHaveLength(1)
    expect(service.query(m('u-mallory'), { linkedToFile: '経理/給与.md' })).toEqual(service.query(m('u-mallory'), { linkedToFile: '経理/なにもない.md' }))
    expect(linkedTo(m('u-mallory'), '経理/給与.md')).toEqual({ total: 0, records: [] })
  })

  it('never counts a record outside a private folder for a path inside it; one inside shows to its readers only', () => {
    // Public record → private path (stored, never shown); private file record → private path.
    rawRecord('a', 'task-pubtoprv1', null, null, '', '営業部/評価/山田.md')
    rawRecord('a', 'task-inprivate', 'a-priv', '営業部/評価/task.md', null, '営業部/評価/山田.md')
    expect(ids(m('u-carol'), '営業部/評価/山田.md')).toEqual(['task-inprivate'])
    expect(linkedTo(m('u-bob'), '営業部/評価/山田.md')).toEqual({ total: 0, records: [] })
    expect(ok(service.query(m('u-carol'), { linkedToFile: '営業部/評価/山田.md', countOnly: true })).total).toBe(1)
    // A private record linking to a public file is still not shown to someone outside the folder.
    rawRecord('a', 'task-prvtopub1', 'a-priv', '営業部/評価/t2.md', null, '営業部/公開.md')
    expect(ids(m('u-carol'), '営業部/公開.md')).toEqual(['task-prvtopub1'])
    expect(linkedTo(m('u-bob'), '営業部/公開.md')).toEqual({ total: 0, records: [] })
  })

  it('another company’s links never count', () => {
    ok(engine.create(m('u-alice', 'b'), { kind: 'human' }, { type: 'task', title: 'b社', links: { files: ['営業部/見積.md'] } }))
    expect(linkedTo(m('u-alice', 'a'), '営業部/見積.md')).toEqual({ total: 0, records: [] })
  })
})
