/**
 * A まとまり always has a 責任者 (owner FB #34, 2026-11-13: a プロジェクト the AI made through
 * records_create without `owner` showed 責任者 「—」, and nobody could end it or name one in the app).
 *
 * Guards (each mutation-checked):
 * - create: a type implementing `bundle` given no `owner` gets the member who creates it — the person,
 *   or the person whose AI made it (the record token's member); an owner named is kept, and one who is
 *   not a member here is refused as before; a non-bundle type gets no `owner`;
 * - project v2's 責任者を替える (`who_fallback: [anyone]`): on one with no 責任者 (made before this
 *   fix) any member who reads it may name one — never 終える / やめる / the other fields, never the AI,
 *   never someone who cannot read it; once a 責任者 is named, only the 責任者 (or an admin / the
 *   department's manager) again. `whoMay` (the screens' answer) says the same.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type ActorInput, type RecordEngine } from '../../src/services/record-engine'
import type { Member } from '../../src/services/access'

const TS = '2026-11-13T00:00:00.000Z'
const CO = 'a'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine

// 営業部 is open to everyone; 営業部/新製品 is private (u-mgr and u-alice take part; u-carol does not).
const PEOPLE = ['u-owner', 'u-admin', 'u-mgr', 'u-alice', 'u-carol']
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const MANAGES: Record<string, string[]> = { 'u-mgr': ['営業部'] }
const m = (userId: string): Member => ({ companyId: CO, userId, role: ROLES[userId] ?? 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'c' }
const PRIVATE = '営業部/新製品'

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: unknown }) => (r.ok ? 'ok' : (r.body as { code?: string }).code)
function rule(id: string, scope: string, type: 'everyone' | 'user', subject: string | null, read: 0 | 1) {
  conn.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, type, subject, read, read, TS)
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let tick = 0
  const clock = { now: () => `2026-11-13T02:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source, transactions: sqliteTransactions(conn), clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: (_c, userId) => MANAGES[userId] ?? [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (PEOPLE.includes(userId) ? ROLES[userId] ?? 'member' : null),
    notify: () => {},
  })
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', TS, TS)
  for (const u of PEOPLE) conn.prepare('INSERT INTO memberships (user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(u, CO, ROLES[u] ?? 'member', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('root', ?, '', 'company', ?)").run(CO, TS)
  rule('root-r', 'root', 'everyone', null, 1)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('p', ?, ?, 'folder', 'a-repo', ?)").run(CO, PRIVATE, TS)
  rule('p-e', 'p', 'everyone', null, 0)
  rule('p-m', 'p', 'user', 'u-mgr', 1)
  rule('p-a', 'p', 'user', 'u-alice', 1)
  const records = source.forCompany(CO).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
})

const fieldsOf = (id: string) => JSON.parse(source.forCompany(CO).records.states([id])[0].fields) as Record<string, unknown>
const versionOf = (id: string) => source.forCompany(CO).records.states([id])[0].version
/** A プロジェクト as the AI made them before this fix: no `owner` in its fields. */
function ownerless(folder = '営業部') {
  const p = ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title: '窓口の整理', folder })).record
  conn.prepare("UPDATE record_state SET fields = json_remove(fields, '$.owner') WHERE record_id = ?").run(p.id)
  expect(fieldsOf(p.id).owner).toBeUndefined()
  return p.id
}
const act = (who: string, id: string, action: string, args: Record<string, unknown> = {}, actor = HUMAN) =>
  engine.act(m(who), actor, id, action, { expectedVersion: versionOf(id), args })

describe('a new まとまり gets a 責任者', () => {
  it('the AI gives none → the member it acts for; the AI names one → kept', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'project', title: '採用の見直し' })).record
    expect(made.fields.owner).toBe('u-alice')
    expect(fieldsOf(made.id).owner).toBe('u-alice')
    const named = ok(engine.createByAi(m('u-alice'), AI, { type: 'project', title: '展示会', fields: { owner: 'u-carol' } })).record
    expect(named.fields.owner).toBe('u-carol')
    // owner: null is "none given" too.
    expect(ok(engine.createByAi(m('u-carol'), AI, { type: 'project', title: '研修', fields: { owner: null } })).record.fields.owner).toBe('u-carol')
  })

  it('a person gives none → themselves; someone who is not a member here is still refused', () => {
    expect(ok(engine.create(m('u-carol'), HUMAN, { type: 'project', title: '棚卸し', folder: '営業部' })).record.fields.owner).toBe('u-carol')
    expect(code(engine.createByAi(m('u-alice'), AI, { type: 'project', title: 'x', fields: { owner: 'u-stranger' } }))).toBe('BAD_VALUE')
    expect(code(engine.create(m('u-alice'), HUMAN, { type: 'project', title: 'x', fields: { owner: 'u-stranger' } }))).toBe('BAD_VALUE')
  })

  it('where it goes and who may place it are unchanged: a private folder still only by who may manage it', () => {
    expect(code(engine.create(m('u-alice'), HUMAN, { type: 'project', title: '新製品', folder: PRIVATE }))).toBe('FOLDER_NOT_PLACEABLE')
    expect(code(engine.createByAi(m('u-mgr'), AI, { type: 'project', title: '新製品', folder: PRIVATE }))).toBe('FOLDER_NOT_PLACEABLE')
    const p = ok(engine.create(m('u-mgr'), HUMAN, { type: 'project', title: '新製品', folder: PRIVATE })).record
    expect([p.fields.owner, source.forCompany(CO).records.byIds([p.id])[0].folder]).toEqual(['u-mgr', PRIVATE])
  })

  it('only a まとまり: a task gets no owner field', () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積を出す', fields: { assignee: 'u-alice' }, folder: '営業部' })).record
    expect(Object.prototype.hasOwnProperty.call(fieldsOf(t.id), 'owner')).toBe(false)
  })
})

describe('a プロジェクト without a 責任者 (made before the fix)', () => {
  it('any member who reads it may name a 責任者 — and only that', async () => {
    const id = ownerless()
    for (const action of ['finish', 'cancel']) expect(code(await act('u-carol', id, action)), action).toBe('NOT_ALLOWED')
    expect(code(await act('u-carol', id, 'set_purpose', { purpose: 'x' }))).toBe('NOT_ALLOWED')
    expect(code(await act('u-carol', id, 'set_due', { due: '2026-12-01' }))).toBe('NOT_ALLOWED')
    expect(engine.whoMay(m('u-carol'), id, ['set_owner', 'finish', 'cancel', 'set_purpose', 'set_due'])?.may)
      .toEqual({ set_owner: true, finish: false, cancel: false, set_purpose: false, set_due: false })
    ok(await act('u-carol', id, 'set_owner', { owner: 'u-alice' }))
    expect(fieldsOf(id).owner).toBe('u-alice')
    // Named: the fallback is gone — the 責任者 decides again.
    expect(code(await act('u-carol', id, 'set_owner', { owner: 'u-carol' }))).toBe('NOT_ALLOWED')
    expect(engine.whoMay(m('u-carol'), id, ['set_owner'])?.may).toEqual({ set_owner: false })
    ok(await act('u-alice', id, 'finish'))
  })

  it('never the AI, never someone who cannot read it', async () => {
    const open = ownerless()
    expect(code(await act('u-carol', open, 'set_owner', { owner: 'u-carol' }, AI))).toBe('NOT_ALLOWED')
    const p = ok(engine.create(m('u-mgr'), HUMAN, { type: 'project', title: '新製品', folder: PRIVATE })).record
    conn.prepare("UPDATE record_state SET fields = json_remove(fields, '$.owner') WHERE record_id = ?").run(p.id)
    expect(code(await act('u-carol', p.id, 'set_owner', { owner: 'u-carol' }))).not.toBe('ok')
    expect(engine.whoMay(m('u-carol'), p.id, ['set_owner'])).toBeNull()
    ok(await act('u-alice', p.id, 'set_owner', { owner: 'u-alice' }))
  })

  // Owner decision A (2026-11-13): a 責任者 who can no longer read it (left, or taken off its private
  // folder) counts as none, so its readers can take an abandoned one over — the server's
  // `who_fallback` (ownPeopleOf keeps only named people who read the record). The app offers the
  // button only when the field is empty (it cannot tell who reads what).
  it('a 責任者 who can no longer read it counts as none; one who can keeps it closed', async () => {
    const p = ok(engine.create(m('u-mgr'), HUMAN, { type: 'project', title: '新製品', folder: PRIVATE, fields: { owner: 'u-alice' } })).record
    rule('p-c', 'p', 'user', 'u-carol', 1)
    // u-alice reads it: u-carol (a participant, not a manager) may not name another.
    expect(code(await act('u-carol', p.id, 'set_owner', { owner: 'u-carol' }))).toBe('NOT_ALLOWED')
    expect(engine.whoMay(m('u-carol'), p.id, ['set_owner'])?.may).toEqual({ set_owner: false })
    // u-alice taken off the private folder: the project is open to be taken over — set_owner only.
    conn.prepare("DELETE FROM scope_rules WHERE id = 'p-a'").run()
    expect(engine.whoMay(m('u-carol'), p.id, ['set_owner', 'finish'])?.may).toEqual({ set_owner: true, finish: false })
    expect(code(await act('u-carol', p.id, 'finish'))).toBe('NOT_ALLOWED')
    ok(await act('u-carol', p.id, 'set_owner', { owner: 'u-carol' }))
    expect(fieldsOf(p.id).owner).toBe('u-carol')
  })
})
