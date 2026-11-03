/**
 * 探す (`POST /records/find`, `/records/find-home`; services/record-find.ts, records.md "探す").
 *
 * Guards:
 * - a hit carries its department, whether the caller is in it and its readable 案件;
 * - nothing the caller cannot read is found, counted in `total`, named as a hit's 案件 or
 *   counted in a summary (owner-only records, a private folder's records and files);
 * - a summary counts open やること, meetings, decisions and files of a 案件, and its next meeting;
 * - the empty tab lists only the caller's unfinished 案件 and their meetings of the window.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
import { createRecordFind, departmentOf, type RecordFind } from '../../src/services/record-find'
import type { Member } from '../../src/services/access'

const TS = '2026-11-01T00:00:00.000Z'
const TODAY = '2026-11-03'
const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-carol']
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let find: RecordFind
const m = (userId: string): Member => ({ companyId: 'a', userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN = { kind: 'human' } as const

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const create = (who: string, body: Record<string, unknown>) => ok(engine.create(m(who), HUMAN, body)).record

/** A meeting as the minutes service would leave it (service-owned: written straight into the map). */
function meeting(id: string, title: string, at: string, fields: Record<string, unknown>, opts: { bundle?: string; scopeId?: string; path?: string } = {}) {
  conn.prepare('INSERT INTO records (company_id, id, type, type_version, scope_id, path, folder, title, summary, created_at, updated_at) VALUES (?, ?, ?, 4, ?, ?, ?, ?, ?, ?, ?)')
    .run('a', id, 'meeting', opts.scopeId ?? null, opts.path ?? null, opts.path ? null : '営業部', title, '', TS, TS)
  conn.prepare("INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES ('a', ?, 'read', ?, 1, ?)").run(id, JSON.stringify({ meeting_at: at, ...fields }), TS)
  if (opts.bundle) conn.prepare("INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path) VALUES ('a', ?, 'bundle', 0, ?, NULL)").run(id, opts.bundle)
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: () => TS, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source, transactions: sqliteTransactions(conn), clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null),
    notify: () => {},
  })
  find = createRecordFind({ companyData: source })
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-root', 'a', '', 'company', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-root-r', 'a-root', 'everyone', NULL, 1, 1, ?)").run(TS)
  // 営業部/評価: a private folder only u-carol reads.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('a-priv', 'a', '営業部/評価', 'folder', 'a-repo', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-priv-e', 'a-priv', 'everyone', NULL, 0, 0, ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-priv-c', 'a-priv', 'user', 'u-carol', 1, 1, ?)").run(TS)
  source.forCompany('a').records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(source.forCompany('a').records, TS)
})

describe('探す: records found by words', () => {
  it('carries the department, whether the caller is in it, and its 案件', () => {
    const p = create('u-alice', { type: 'project', title: 'サンプル社 研修導入', folder: '営業部', fields: { owner: 'u-alice' } })
    const t = create('u-alice', { type: 'task', title: '見積を直す', folder: '営業部/顧客', fields: { assignee: 'u-bob' }, links: { bundle: p.id } })
    create('u-alice', { type: 'task', title: '全社の見積ルール', fields: { assignee: 'u-alice' } })
    const r = ok(find.find(m('u-bob'), { text: '見積', today: TODAY }))
    expect(r.total).toBe(2)
    const hit = r.hits.find(h => h.record.id === t.id)!
    expect(hit).toMatchObject({ department: '営業部', mine: true, bundle: { id: p.id, title: 'サンプル社 研修導入' } })
    expect(r.hits.find(h => h.record.id !== t.id)).toMatchObject({ department: null, mine: false })
    expect(r.hits.every(h => !('bundle' in h) || h.record.id === t.id)).toBe(true)
  })

  it('never finds, counts or names what the caller cannot read', () => {
    create('u-alice', { type: 'task', title: '歯医者の見積', personal: true, fields: { assignee: 'u-alice' } })
    const pub = create('u-alice', { type: 'task', title: '見積を出す', fields: { assignee: 'u-alice' } })
    expect(ok(find.find(m('u-alice'), { text: '見積', today: TODAY })).total).toBe(2)
    // Owners included: an owner-only record is its owner's alone.
    for (const who of ['u-bob', 'u-owner']) {
      const r = ok(find.find(m(who), { text: '見積', today: TODAY }))
      expect(r.total).toBe(1)
      expect(r.hits.map(h => h.record.id)).toEqual([pub.id])
    }
  })

  it('a 案件 whose name holds the words gets a summary of what the caller reads', async () => {
    const p = create('u-alice', { type: 'project', title: 'サンプル社 研修導入', folder: '営業部', fields: { owner: 'u-alice' }, links: { files: ['営業部/見積.md'] } })
    // A link into the private folder (stored by an older app): a file u-bob cannot read.
    conn.prepare("INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path) VALUES ('a', ?, 'files', 1, NULL, '営業部/評価/山田.md')").run(p.id)
    create('u-alice', { type: 'task', title: '見積を直す', fields: { assignee: 'u-bob' }, links: { bundle: p.id } })
    const done = create('u-alice', { type: 'task', title: 'お礼を送る', fields: { assignee: 'u-alice' }, links: { bundle: p.id } })
    ok(await engine.act(m('u-alice'), HUMAN, done.id, 'complete', { expectedVersion: done.version }))
    meeting('meeting-000001', '定例 1回目', '2026-10-30T10:00', {}, { bundle: p.id })
    meeting('meeting-000002', '定例 2回目', '2026-11-06T15:00', {}, { bundle: p.id })
    // Inside the private folder: never counted for someone outside it (and a public 案件 never reaches it anyway).
    meeting('meeting-000003', '評価の話', '2026-11-04T09:00', {}, { bundle: p.id, scopeId: 'a-priv', path: '営業部/評価/m.md' })
    const r = ok(find.find(m('u-bob'), { text: 'サンプル', today: TODAY }))
    expect(r.hubs).toHaveLength(1)
    const hub = r.hubs[0]
    expect(hub.counts).toEqual({ bundles: 0, openTasks: 1, meetings: 2, decisions: 0, files: 1 })
    expect(hub.nextMeetingAt).toBe('2026-11-06T15:00')
    expect(hub.memberIds).toHaveLength(2)
    // Words only in a task's name: no summary card.
    expect(ok(find.find(m('u-bob'), { text: '見積', today: TODAY })).hubs).toEqual([])
  })

  it('refuses words that are missing or too long, and a missing day', () => {
    expect(find.find(m('u-bob'), { text: '', today: TODAY })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(find.find(m('u-bob'), { text: 'あ'.repeat(101), today: TODAY })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(find.find(m('u-bob'), { text: '見積' })).toMatchObject({ ok: false, kind: 'bad-request' })
  })
})

describe('探す with nothing typed', () => {
  it('lists the caller’s unfinished 案件 and their meetings of the window', async () => {
    const mine = create('u-bob', { type: 'project', title: '自分の案件', folder: '営業部', fields: { owner: 'u-bob' } })
    create('u-alice', { type: 'project', title: 'ほかの人の案件', folder: '営業部', fields: { owner: 'u-alice' } })
    const over = create('u-bob', { type: 'project', title: '終わった案件', folder: '営業部', fields: { owner: 'u-bob' } })
    ok(await engine.act(m('u-bob'), HUMAN, over.id, 'finish', { expectedVersion: over.version }))
    meeting('meeting-000011', 'あしたの会議', '2026-11-04T10:00', { attendees: '["u-bob"]' })
    meeting('meeting-000012', 'きのうの会議', '2026-11-02T10:00', { assignee: 'u-bob' })
    meeting('meeting-000013', '来月の会議', '2026-12-04T10:00', { assignee: 'u-bob' })
    meeting('meeting-000014', 'ほかの人の会議', '2026-11-04T11:00', { assignee: 'u-alice' })
    meeting('meeting-000015', '評価の会議', '2026-11-04T12:00', { attendees: '["u-bob"]' }, { scopeId: 'a-priv', path: '営業部/評価/m2.md' })
    const home = ok(find.home(m('u-bob'), { today: TODAY, from: '2026-11-02', to: '2026-11-10' }))
    expect(home.bundles.map(b => b.record.id)).toEqual([mine.id])
    expect(home.meetings.map(h => h.record.title)).toEqual(['きのうの会議', 'あしたの会議'])
  })
})

describe('departmentOf', () => {
  it('reads the first folder of a path or a server-only folder', () => {
    expect(departmentOf({ path: '営業部/顧客/a.md', folder: null })).toBe('営業部')
    expect(departmentOf({ path: 'README.md', folder: null })).toBeNull()
    expect(departmentOf({ path: null, folder: '営業部/顧客' })).toBe('営業部')
    expect(departmentOf({ path: null, folder: '' })).toBeNull()
    expect(departmentOf({ path: null, folder: null })).toBeNull()
  })
})
