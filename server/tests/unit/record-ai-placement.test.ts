/**
 * Where the member's AI puts a request it makes (records.md "Where the AI puts a request",
 * owner decision 2026-11-03): `recordEngine.createByAi`, the engine behind
 * `POST /api/records-ai/item` (tool records_create).
 *
 * Guards:
 * - nothing said about anyone → owner-only, the member as assignee (their turn), and nobody
 *   else — another member, the owner, an admin — finds it;
 * - another person as assignee, or a department asked for (`personal: false`) → the consultation's
 *   department (`defaultFolder`), assignee as said or the member; 全社 (no default) → the whole company;
 * - a folder the AI names wins over the default; the default is checked like any folder (a private
 *   one is refused, never placed company-wide instead);
 * - the answer says where it went (`placed`), for the AI to tell the member;
 * - a person's create (the list's line, a session) keeps its own rules: no defaults.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type ActorInput, type RecordEngine } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'

const TS = '2026-11-03T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService

const PEOPLE = ['u-owner', 'u-admin', 'u-alice', 'u-bob', 'u-mallory']
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const m = (userId: string): Member => ({ companyId: 'a', userId, role: ROLES[userId] ?? 'member' })
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }
const HUMAN: ActorInput = { kind: 'human' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

function rule(id: string, scope: string, type: 'everyone' | 'user', subject: string | null, read: 0 | 1) {
  conn.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, type, subject, read, read, TS)
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let tick = 0
  const clock = { now: () => `2026-11-03T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (PEOPLE.includes(userId) ? ROLES[userId] ?? 'member' : null),
    notify: () => {},
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('root', 'a', '', 'company', ?)").run(TS)
  rule('root-r', 'root', 'everyone', null, 1)
  // コンテンツ: a department u-mallory cannot read. 経理部: a private folder only u-alice reads.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('c', 'a', 'コンテンツ', 'folder', ?)").run(TS)
  rule('c-e', 'c', 'everyone', null, 1)
  rule('c-m', 'c', 'user', 'u-mallory', 0)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('p', 'a', '経理部', 'folder', 'a-repo', ?)").run(TS)
  rule('p-e', 'p', 'everyone', null, 0)
  rule('p-a', 'p', 'user', 'u-alice', 1)
  const records = source.forCompany('a').records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
})

const ids = (who: string) => ok(service.query(m(who), { type: 'task' })).records.map(r => r.id)

describe('a task the member’s AI makes about the member alone', () => {
  it('is owner-only, the member’s own turn, and the answer says so', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'テスト自分用', defaultFolder: 'コンテンツ' }))
    expect(made.placed).toEqual({ personal: true, folder: null })
    expect(made.record).toMatchObject({ personal: true, fields: { assignee: 'u-alice', requested_by: 'u-alice', next_actor: 'u-alice' } })
    expect(ok(service.myTurn(m('u-alice'))).records.map(r => r.id)).toEqual([made.record.id])
  })

  it('the member named as assignee is the same', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: '自分で', fields: { assignee: 'u-alice' }, defaultFolder: 'コンテンツ' }))
    expect(made.placed).toEqual({ personal: true, folder: null })
  })

  it('nobody else finds it: another member, the owner, an admin', async () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'テスト自分用' }))
    expect(ids('u-alice')).toEqual([made.record.id])
    for (const who of ['u-bob', 'u-owner', 'u-admin']) {
      expect(ids(who)).toEqual([])
      expect((await service.get(m(who), made.record.id)).ok).toBe(false)
      expect(ok(service.myTurn(m(who))).records).toEqual([])
    }
  })
})

describe('another person, or a department asked for', () => {
  it('assigned to someone else → the consultation’s department, their turn', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: '原稿を見る', fields: { assignee: 'u-bob' }, defaultFolder: 'コンテンツ' }))
    expect(made.placed).toEqual({ personal: false, folder: 'コンテンツ' })
    expect(made.record.personal).toBeUndefined()
    expect(made.record.fields).toMatchObject({ assignee: 'u-bob', requested_by: 'u-alice' })
    expect(ids('u-bob')).toContain(made.record.id)
    expect(ids('u-mallory')).toEqual([])
  })

  it('「部署のやることにして」 (personal: false) without an assignee → the department, the member assigned', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: '棚卸し', personal: false, defaultFolder: 'コンテンツ' }))
    expect(made.placed).toEqual({ personal: false, folder: 'コンテンツ' })
    expect(made.record.fields).toMatchObject({ assignee: 'u-alice', next_actor: 'u-alice' })
  })

  it('from the 全社 tab (no default) → the whole company', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: '原稿を見る', fields: { assignee: 'u-bob' } }))
    expect(made.placed).toEqual({ personal: false, folder: null })
    expect(ids('u-mallory')).toContain(made.record.id)
  })

  it('a folder the AI names wins over the default', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', fields: { assignee: 'u-bob' }, folder: 'コンテンツ', defaultFolder: '営業部' }))
    expect(made.placed?.folder).toBe('コンテンツ')
  })

  it('the default is checked like any folder: a private one is refused, never placed company-wide', () => {
    const r = engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', fields: { assignee: 'u-bob' }, defaultFolder: '経理部' })
    expect(r).toMatchObject({ ok: false, body: { code: 'PRIVATE_PLACE' } })
    expect(ids('u-owner')).toEqual([])
  })

  it('an assignee who cannot read the department is refused', () => {
    const r = engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', fields: { assignee: 'u-mallory' }, defaultFolder: 'コンテンツ' })
    expect(r).toMatchObject({ ok: false, body: { code: 'ASSIGNEE_CANNOT_READ' } })
  })
})

describe('a person’s create keeps its own rules', () => {
  it('no defaults: not owner-only, nobody assigned, a default folder ignored', () => {
    const made = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', defaultFolder: 'コンテンツ' }))
    expect(made.record.personal).toBeUndefined()
    expect(made.record.fields.assignee ?? null).toBeNull()
    expect(made.placed).toEqual({ personal: false, folder: null })
  })
})
