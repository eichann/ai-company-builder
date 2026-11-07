/**
 * Groups and departments on a members-only list (「この人たちだけ」, records.md "Members-only records",
 * owner direction 2026-11-08: a record's exception is written in a place rule's subjects — people,
 * groups 見える人のまとまり, departments 所属 — resolved when read; the decision stays the one
 * `recordReader`, record layer first, then the place's rules).
 *
 * Guards:
 * - equivalence: on existing data (people-only lists, owner-only records, place rules, private
 *   folders, read-restricted places) in a company with and without the shared folder, the new
 *   reader gives every role exactly the answer the reader before this change gave (a frozen copy
 *   below), and a people-only row reads exactly as before (no new key);
 * - a group / department on a list is read through who is in it NOW: someone added reads the record
 *   on every path, someone taken off (or the group deleted, the department deleted) gets a missing
 *   record's answer on every path — detail, history, query / count / text / linkedTo, 探す,
 *   「あなたの番」, 見られる人, notices, the push signal, `recordReaders`; owners / admins / managers
 *   are never included unless they are in it (the list stays strict);
 * - who may widen by a group / department (the record's 責任者, a 部署の管理役, an owner / admin, each
 *   on the list) and that any reader may narrow, never leaving someone the record names, nor nobody;
 * - the ledger and permission_history keep each change; another company's group / department is
 *   one that does not exist; a meeting's list (with its group) is what a task made from it gets.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateRecordViewerSets } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { RecordAccessRow } from '../../src/ports/records'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, placeOfRow, type ActorInput, type RecordEngine, type ServiceRecordWriter } from '../../src/services/record-engine'
import type { RecordChange } from '../../src/services/record-engine/types'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createRecordFind, type RecordFind } from '../../src/services/record-find'
import { createViewersService, type ViewersService } from '../../src/services/viewers'
import { createPushChannel, type PushChannel } from '../../src/services/push-channel'
import { createRecordSignal } from '../../src/services/record-signal'
import { createNotificationService } from '../../src/services/notifications'
import { listedUserIds, onList, recordReader, recordReaders } from '../../src/services/record-access'
import type { Member } from '../../src/services/access'
import type { PushEvent } from '../../../shared/types/agent-stop'
import {
  canReadPrivateScope, findPrivateScope, resolveAccess, type PermissionRepository, type ScopeWithRules,
} from '../../../shared/core/permissions'

const TS = '2026-11-08T00:00:00.000Z'
const TODAY = '2026-11-08'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let writer: ServiceRecordWriter
let service: RecordService
let find: RecordFind
let viewers: ViewersService
let notices: ReturnType<typeof createNotificationService>
let push: PushChannel
let tick = 0

/** Companies: `g` with the shared folder (git), `n` without; `x` another company. */
const USERS = ['u-owner', 'u-admin', 'u-mgr', 'u-alice', 'u-bob', 'u-carol', 'u-dave']
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const NAMES: Record<string, string> = { 'u-owner': '阿部', 'u-admin': '安達', 'u-mgr': '前田', 'u-alice': '有田', 'u-bob': '坊野', 'u-carol': '加賀', 'u-dave': '出井' }
const roleOf = (_co: string, userId: string) => (USERS.includes(userId) ? ROLES[userId] ?? 'member' : null)
const m = (userId: string, co = 'g'): Member => ({ companyId: co, userId, role: roleOf(co, userId) ?? 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const group = (co: string) => `${co}-grp`
const sales = (co: string) => `${co}-d-sales`
const hr = (co: string) => `${co}-d-hr`

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const run = (sql: string, ...args: unknown[]) => conn.prepare(sql).run(...args)

/**
 * Each company: 営業部 (everyone reads, who belongs writes; alice and dave belong, mgr manages it),
 * 人事部 (nobody but the group 採用チーム = bob reads: a read-restricted place in `n`, a stored rule
 * in `g`), 経理部 (a private folder alice reads), the group 採用チーム with bob.
 */
function company(co: string, kind: 'git' | 'none') {
  run('INSERT INTO companies (id, name, slug, owner_id, folder_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', co, co, co, 'u-owner', kind, TS, TS)
  for (const u of USERS) run('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', `m-${co}-${u}`, u, co, roleOf(co, u), TS, TS)
  const scope = (id: string, path: string, kindOf: string, repo: string | null = null) =>
    run('INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, co, path, kindOf, repo, TS)
  const rule = (id: string, scopeId: string, type: string, subject: string | null, r: number, w: number) =>
    run('INSERT INTO scope_rules (id, scope_id, company_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, scopeId, co, type, subject, r, w, TS)
  run('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)', sales(co), co, '営業部', '営業部', TS, TS)
  run('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', hr(co), co, '人事部', '人事部', TS, TS)
  for (const u of ['u-alice', 'u-dave']) run('INSERT INTO department_members (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)', co, sales(co), u, TS)
  run('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)', co, sales(co), 'u-mgr', TS)
  const handle = source.forCompany(co)
  handle.groups.create({ id: group(co), name: '採用チーム', nameKey: '採用チーム', createdAt: TS, createdBy: 'u-owner' })
  handle.groups.replaceMembers(group(co), ['u-bob'], 'u-owner', TS)
  scope(`${co}-root`, '', 'company')
  rule(`${co}-root-e`, `${co}-root`, 'everyone', null, 1, 1)
  scope(`${co}-sales`, '営業部', 'department')
  rule(`${co}-sales-e`, `${co}-sales`, 'everyone', null, 1, 0)
  rule(`${co}-sales-d`, `${co}-sales`, 'department', sales(co), 1, 1)
  scope(`${co}-hr`, '人事部', 'department')
  rule(`${co}-hr-e`, `${co}-hr`, 'everyone', null, 0, 0)
  if (kind === 'none') rule(`${co}-hr-g`, `${co}-hr`, 'group', group(co), 1, 1)
  else rule(`${co}-hr-u`, `${co}-hr`, 'user', 'u-bob', 1, 1)
  run('INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES (?, ?, ?, ?)', `${co}-repo`, co, `${co}-acc`, TS)
  scope(`${co}-acc`, '経理部', 'folder', `${co}-repo`)
  rule(`${co}-acc-a`, `${co}-acc`, 'user', 'u-alice', 1, 1)
  handle.records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(handle.records, TS)
}

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  push = createPushChannel()
  const clock = { now: () => `2026-11-08T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => Date.parse(TS) }
  const ids = { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') }
  const memberships = sqliteMembershipRepository(conn)
  const transactions = sqliteTransactions(conn)
  const isMember = (co: string, u: string) => roleOf(co, u) !== null
  notices = createNotificationService({
    companyData: source, clock, ids, roleOf,
    accounts: { byIds: list => new Map(list.map(id => [id, { email: `${id}@example.com`, name: NAMES[id] ?? null }])) },
    push: () => {},
  })
  const recordChanged = createRecordSignal({ companyData: source, memberships, push, ids })
  const notify = (companyId: string, userIds: string[], change?: RecordChange) => { if (change) notices.recordChange(companyId, userIds, change) }
  writer = createServiceRecordWriter({ companyData: source, transactions, clock, ids, isMember, roleOf, notify, recordChanged })
  engine = createRecordEngine({
    companyData: source, transactions, clock, ids,
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: (_c, userId) => (userId === 'u-mgr' ? ['営業部'] : []),
    isMember, roleOf, notify, recordChanged,
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  find = createRecordFind({ companyData: source })
  viewers = createViewersService({
    companyData: source, memberships,
    accounts: { byIds: (list: string[]) => new Map(list.map(id => [id, { name: NAMES[id] ?? null, email: `${id}@acme.example` }])) } as never,
  })
  company('g', 'git')
  company('n', 'none')
  company('x', 'none')
})

/**
 * The reader as it was before groups and departments could be on a list (main at 6e166e1a,
 * `services/record-access.ts`), kept here only to compare against: the equivalence below must
 * hold for every row that existed before.
 */
function readerBefore(member: Member, scopes: ScopeWithRules[]) {
  const perms: PermissionRepository = { getMemberRole: () => member.role, listScopes: () => scopes }
  const byId = new Map(scopes.map(s => [s.id, s]))
  const readable = (path: string) => resolveAccess(member.companyId, member.userId, path, perms).read
  return (r: RecordAccessRow): boolean => {
    if (r.personalOwner !== null) return r.personalOwner === member.userId
    if (r.members != null) return r.members.includes(member.userId)
    if (r.path === null) return r.scopeId === null && readable(r.folder ?? '')
    if (r.scopeId !== null) {
      const scope = byId.get(r.scopeId)
      if (!scope || scope.repoId === null) return false
      return canReadPrivateScope(scope, member.userId, member.role) && readable(r.path)
    }
    if (findPrivateScope(scopes, r.path)) return false
    return readable(r.path)
  }
}

/** Rows as existing data has them: every kind of place, people-only lists. */
function existingRows(co: string): string[] {
  const records = source.forCompany(co).records
  const put = (id: string, place: Partial<RecordAccessRow>) => {
    records.upsert({
      id, type: 'task', typeVersion: 13, scopeId: null, path: null, folder: null, personalOwner: null, members: null,
      title: id, summary: '', createdAt: TS, updatedAt: TS, removedAt: null, ...place,
    })
  }
  const lists: Record<string, string[]> = {
    empty: [], alice: ['u-alice'], two: ['u-alice', 'u-bob'], admins: ['u-owner', 'u-admin'], mgr: ['u-mgr'], all: [...USERS],
  }
  const ids: string[] = []
  for (const [name, list] of Object.entries(lists)) {
    const id = `task-list${name}00000000`.slice(0, 21)
    put(id, { members: list })
    records.addMembers(id, list, 'u-alice', TS)
    ids.push(id)
  }
  const places: Array<[string, Partial<RecordAccessRow>]> = [
    ['own-alice', { personalOwner: 'u-alice' }], ['own-owner', { personalOwner: 'u-owner' }],
    ['company', { folder: null }], ['sales', { folder: '営業部' }], ['hr', { folder: '人事部' }], ['hr-deep', { folder: '人事部/採用' }],
    ['acc-folder', { folder: '経理部' }], ['file-sales', { path: '営業部/a.md' }], ['file-hr', { path: '人事部/b.md' }],
    ['file-acc', { path: '経理部/c.md', scopeId: `${co}-acc` }], ['file-acc-main', { path: '経理部/d.md' }],
    ['file-gone-scope', { path: '経理部/e.md', scopeId: `${co}-nosuch` }],
  ]
  for (const [name, place] of places) {
    const id = `task-${name.replace(/-/g, '')}0000000000000`.slice(0, 21)
    put(id, place)
    ids.push(id)
  }
  return ids
}

describe('equivalence: existing data reads exactly as before', () => {
  for (const co of ['g', 'n']) {
    it(`company ${co === 'g' ? 'with' : 'without'} the shared folder: every role × every kind of record`, () => {
      const ids = existingRows(co)
      const records = source.forCompany(co).records
      const rows = records.byIds(ids)
      expect(rows).toHaveLength(ids.length)
      const scopes = source.forCompany(co).scopes.listWithRules()
      const answers: string[] = []
      for (const u of USERS) {
        const before = readerBefore(m(u, co), scopes)
        const now = recordReader(m(u, co), scopes)
        for (const row of rows) {
          expect(now.record(row), `${u} × ${row.id}`).toBe(before(row))
          answers.push(`${u}:${row.id}:${before(row)}`)
        }
      }
      // The matrix is not trivial: some yes, some no, for every role.
      for (const u of USERS) {
        const mine = answers.filter(a => a.startsWith(`${u}:`))
        expect(mine.some(a => a.endsWith(':true'))).toBe(true)
        expect(mine.some(a => a.endsWith(':false'))).toBe(true)
      }
      const people = USERS.map(u => ({ userId: u, role: roleOf(co, u) ?? 'member' }))
      for (const row of rows) {
        const before = people.filter(p => readerBefore({ companyId: co, ...p }, scopes)(row)).map(p => p.userId)
        expect(recordReaders(co, row, people, scopes), row.id).toEqual(before)
      }
      // A people-only row is the same object as before: no `memberSets` key at all.
      for (const row of rows.filter(r => r.members !== null)) expect(Object.keys(row)).not.toContain('memberSets')
      expect(records.candidates({ types: ['task'] }, 100).every(r => !('memberSets' in r))).toBe(true)
    })
  }

  it('the table is made once; twice is harmless; existing lists keep their rows', () => {
    const ids = existingRows('g')
    const before = conn.prepare('SELECT * FROM record_viewers ORDER BY record_id, user_id').all()
    migrateRecordViewerSets(conn)
    migrateRecordViewerSets(conn)
    expect(conn.prepare('SELECT * FROM record_viewers ORDER BY record_id, user_id').all()).toEqual(before)
    expect(conn.prepare('SELECT COUNT(*) AS n FROM record_viewer_sets').get()).toEqual({ n: 0 })
    expect(source.forCompany('g').records.byIds(ids).filter(r => r.members !== null)).toHaveLength(6)
  })
})

/** A task alice keeps for herself and is the 責任者 of (assignee), then a group or department added to its list. */
function listedTask(co: string, add: Array<{ subjectType: 'group' | 'department'; subjectId: string }>) {
  const t = ok(engine.create(m('u-alice', co), HUMAN, { type: 'task', title: '採用面接の段取り', members: [], fields: { assignee: 'u-alice' } })).record
  const r = ok(engine.invite(m('u-alice', co), HUMAN, t.id, { add, expectedVersion: 1 }))
  return { id: t.id, version: r.entry.version }
}

/** Every read path, as `who` sees the record: true = it is there. */
async function seen(co: string, who: string, id: string): Promise<boolean[]> {
  const me = m(who, co)
  const detail = await service.get(me, id)
  return [
    detail.ok,
    engine.history(me, id).ok,
    ok(service.query(me, { type: 'task' })).records.some(r => r.id === id),
    ok(service.query(me, { type: 'task', countOnly: true })).total > 0,
    ok(service.query(me, { text: '採用面接' })).total > 0,
    service.query(me, { linkedTo: { id, hops: 1 } }).ok,
    ok(find.find(me, { text: '採用面接', today: TODAY })).hits.some(h => h.record.id === id),
    ok(service.myTurn(me)).records.some(r => r.id === id),
    id in ok(viewers.labels(me, { records: [id] })).records,
    ok(notices.list(me)).items.some(n => n.recordId === id),
    recordReaders(co, source.forCompany(co).records.byIds([id])[0], [{ userId: who, role: me.role }], source.forCompany(co).scopes.listWithRules()).includes(who),
  ]
}
const ALL = (v: boolean) => Array(11).fill(v)

describe('a group on the list: who is in it now reads it, on every path', () => {
  for (const co of ['g', 'n']) {
    it(`company ${co}: added → reads everywhere; taken off → a missing record everywhere; owners / admins / managers never by themselves`, async () => {
      const { id } = listedTask(co, [{ subjectType: 'group', subjectId: group(co) }])
      // alice gives it to bob (in the group): he is told and it is his turn.
      ok(await engine.act(m('u-alice', co), HUMAN, id, 'assign', { expectedVersion: 2, note: 'お願いします', args: { assignee: 'u-bob' } }))
      expect(await seen(co, 'u-bob', id)).toEqual([true, true, true, true, true, true, true, true, true, true, true])
      for (const who of ['u-carol', 'u-owner', 'u-admin', 'u-mgr']) {
        const s = await seen(co, who, id)
        expect(s.slice(0, 9).concat(s.slice(10)), who).toEqual(ALL(false).slice(1))
      }
      // carol joins the group: she reads it at once.
      const handle = source.forCompany(co)
      handle.groups.replaceMembers(group(co), ['u-bob', 'u-carol'], 'u-owner', TS)
      expect((await seen(co, 'u-carol', id)).slice(0, 7)).toEqual(ALL(true).slice(0, 7))
      // bob leaves the group: everything says there is no such record (the answer of a missing id).
      handle.groups.replaceMembers(group(co), ['u-carol'], 'u-owner', TS)
      expect(await seen(co, 'u-bob', id)).toEqual(ALL(false))
      const missing = 'task-0000000000000000'
      expect(await service.get(m('u-bob', co), id)).toEqual(JSON.parse(JSON.stringify(await service.get(m('u-bob', co), missing)).replaceAll(missing, id)))
      // …and the push signal of a later change reaches carol, not bob.
      const got: Record<string, PushEvent[]> = {}
      for (const u of USERS) {
        got[u] = []
        push.open(co, u, { send: e => got[u].push(e) })
      }
      ok(await engine.act(m('u-alice', co), HUMAN, id, 'set_due', { expectedVersion: 3, args: { due: '2026-11-20' } }))
      expect(Object.entries(got).filter(([, e]) => e.length > 0).map(([u]) => u).sort()).toEqual(['u-alice', 'u-carol'])
    })
  }

  it('the group deleted: off every list (nobody reads through it any more)', async () => {
    const { id } = listedTask('n', [{ subjectType: 'group', subjectId: group('n') }])
    expect((await seen('n', 'u-bob', id))[0]).toBe(true)
    source.forCompany('n').groups.delete(group('n'))
    expect(await seen('n', 'u-bob', id)).toEqual(ALL(false))
    expect(source.forCompany('n').records.byIds([id])[0]).toEqual(expect.objectContaining({ members: ['u-alice'] }))
    expect(source.forCompany('n').records.byIds([id])[0]).not.toHaveProperty('memberSets')
  })
})

describe('a department on the list: the people who belong to it now', () => {
  for (const co of ['g', 'n']) {
    it(`company ${co}: who belongs reads it; its manager (not belonging), owners and admins do not; joining and leaving apply at once`, async () => {
      const { id } = listedTask(co, [{ subjectType: 'department', subjectId: sales(co) }])
      expect((await seen(co, 'u-dave', id)).slice(0, 7)).toEqual(ALL(true).slice(0, 7))
      for (const who of ['u-mgr', 'u-owner', 'u-admin', 'u-bob']) expect((await seen(co, who, id))[0], who).toBe(false)
      run('INSERT INTO department_members (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)', co, sales(co), 'u-carol', TS)
      expect((await seen(co, 'u-carol', id))[0]).toBe(true)
      run('DELETE FROM department_members WHERE company_id = ? AND department_id = ? AND user_id = ?', co, sales(co), 'u-dave')
      expect(await seen(co, 'u-dave', id)).toEqual(ALL(false))
      // 見られる人 counts who belongs (alice listed, carol belonging; alice also belongs: once).
      expect(ok(viewers.labels(m('u-alice', co), { records: [id] })).records[id]).toEqual({ kind: 'you-and-one', text: 'あなたと加賀さん', count: 2 })
    })
  }

  it('the department deleted: off every list', async () => {
    const { id } = listedTask('g', [{ subjectType: 'department', subjectId: sales('g') }])
    run('DELETE FROM departments WHERE company_id = ? AND id = ?', 'g', sales('g'))
    expect((await seen('g', 'u-dave', id))[0]).toBe(false)
    expect(conn.prepare('SELECT COUNT(*) AS n FROM record_viewer_sets').get()).toEqual({ n: 0 })
  })
})

describe('changing the list', () => {
  it('a group or department: only the 責任者, a 部署の管理役 or an owner / admin — each on the list; people: anyone on it', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '面談', members: ['u-bob', 'u-mgr', 'u-admin'], fields: { assignee: 'u-alice' } })).record
    const add = [{ subjectType: 'group' as const, subjectId: group('g') }]
    const refused = engine.invite(m('u-bob'), HUMAN, t.id, { add, expectedVersion: 1 })
    expect(refused).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'LIST_WIDENING_NOT_ALLOWED' } })
    expect(engine.invite(m('u-bob'), HUMAN, t.id, { add: [{ subjectType: 'department', subjectId: sales('g') }], expectedVersion: 1 }))
      .toMatchObject({ ok: false, body: { code: 'LIST_WIDENING_NOT_ALLOWED' } })
    // A person: as before, any listed member.
    expect(ok(engine.invite(m('u-bob'), HUMAN, t.id, { add: [{ subjectType: 'user', subjectId: 'u-carol' }], expectedVersion: 1 })).added).toEqual(['u-carol'])
    // The owner is not on the list: the record does not exist for them.
    expect(engine.invite(m('u-owner'), HUMAN, t.id, { add, expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
    for (const [who, version] of [['u-mgr', 2], ['u-admin', 3], ['u-alice', 4]] as const) {
      const r = ok(engine.invite(m(who), HUMAN, t.id, { add: [{ subjectType: who === 'u-admin' ? 'department' : 'group', subjectId: who === 'u-admin' ? sales('g') : group('g') }], expectedVersion: version }))
      expect(r.entry.version).toBe(version + 1)
    }
    const choices = (who: string) => ok(engine.listChoices(m(who), t.id))
    expect(choices('u-bob')).toEqual({ maySets: false, groups: [], departments: [], listed: [
      { type: 'group', id: group('g'), name: '採用チーム' }, { type: 'department', id: sales('g'), name: '営業部' },
    ] })
    expect(choices('u-alice')).toMatchObject({ maySets: true, groups: [{ id: group('g'), name: '採用チーム' }], departments: [{ name: '営業部' }, { name: '人事部' }] })
    expect(engine.listChoices(m('u-dave'), t.id)).toMatchObject({ ok: true })
    expect(engine.listChoices(m('u-owner'), t.id)).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
  })

  it('the ledger keeps it in subject form; permission_history records who changed what; never undone', () => {
    const { id } = listedTask('g', [{ subjectType: 'group', subjectId: group('g') }])
    const entry = source.forCompany('g').records.ledger(id).at(-1)!
    expect(entry).toMatchObject({ action: 'invite', changes: [{ field: 'place.members', before: 'u-alice', after: `u-alice,group:${group('g')}` }] })
    expect(engine.undo(m('u-alice'), HUMAN, id, { version: 2, expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'NOT_UNDOABLE' } })
    expect(source.forCompany('g').permissionHistory.recent(5)[0]).toMatchObject({
      action: 'record-members', byUser: 'u-alice', detail: { recordId: id, via: 'invite', added: { users: [], sets: [{ type: 'group', id: group('g') }] } },
    })
    // Adding what is already there adds nothing new to the history.
    ok(engine.invite(m('u-alice'), HUMAN, id, { add: [{ subjectType: 'group', subjectId: group('g') }], expectedVersion: 2 }))
    expect(source.forCompany('g').permissionHistory.recent(5).filter(e => e.action === 'record-members')).toHaveLength(1)
  })

  it('another company’s group or department, or an unknown one, is refused like one that does not exist', () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', members: [], fields: { assignee: 'u-alice' } })).record
    for (const [subjectType, subjectId, code] of [['group', group('x'), 'BAD_GROUP'], ['group', 'nosuch', 'BAD_GROUP'], ['department', sales('x'), 'BAD_DEPARTMENT'], ['department', 'nosuch', 'BAD_DEPARTMENT']] as const) {
      expect(engine.invite(m('u-alice'), HUMAN, t.id, { add: [{ subjectType, subjectId }], expectedVersion: 1 }), `${subjectType} ${subjectId}`)
        .toMatchObject({ ok: false, kind: 'bad-request', body: { code } })
    }
    expect(engine.invite(m('u-alice'), HUMAN, t.id, { add: [{ subjectType: 'everyone', subjectId: 'x' }], expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'bad-request' })
    // The database refuses another company's subject even when a caller forgets to check.
    expect(() => source.forCompany('g').records.addMemberSets(t.id, [{ type: 'group', id: group('x') }], 'u-alice', TS)).toThrow()
    expect(() => source.forCompany('g').records.addMemberSets(t.id, [{ type: 'department', id: sales('x') }], 'u-alice', TS)).toThrow()
  })

  it('narrowing: any reader; never someone the record names, never nobody; the caller may take themself off', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '面談', members: ['u-carol'], fields: { assignee: 'u-alice' } })).record
    ok(engine.invite(m('u-alice'), HUMAN, t.id, { add: [{ subjectType: 'group', subjectId: group('g') }], expectedVersion: 1 }))
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'assign', { expectedVersion: 2, note: 'x', args: { assignee: 'u-bob' } }))
    // bob is the assignee and reads it through the group only.
    expect(engine.removeMembers(m('u-carol'), HUMAN, t.id, { remove: [{ subjectType: 'group', subjectId: group('g') }], expectedVersion: 3 }))
      .toMatchObject({ ok: false, body: { code: 'NAMED_PERSON_CANNOT_READ' } })
    // requested_by is alice: she cannot be taken off either.
    expect(engine.removeMembers(m('u-carol'), HUMAN, t.id, { remove: ['u-alice'], expectedVersion: 3 })).toMatchObject({ ok: false, body: { code: 'NAMED_PERSON_CANNOT_READ' } })
    expect(engine.removeMembers(m('u-carol'), HUMAN, t.id, { remove: ['u-dave'], expectedVersion: 3 })).toMatchObject({ ok: false, body: { code: 'NOT_ON_LIST' } })
    expect(engine.removeMembers(m('u-carol'), HUMAN, t.id, { remove: ['u-carol'], expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT' } })
    // carol (a plain reader) takes herself off: done, and the record is gone for her.
    const r = ok(engine.removeMembers(m('u-carol'), HUMAN, t.id, { remove: ['u-carol'], expectedVersion: 3 }))
    expect(r).toMatchObject({ record: null, removed: ['u-carol'], removedSets: [] })
    expect(r.entry).toMatchObject({ action: 'remove_members', changes: [{ field: 'place.members', before: `u-alice,u-carol,group:${group('g')}`, after: `u-alice,group:${group('g')}` }] })
    expect((await service.get(m('u-carol'), t.id)).ok).toBe(false)
    expect(source.forCompany('g').permissionHistory.recent(1)[0]).toMatchObject({ action: 'record-members', byUser: 'u-carol', detail: { via: 'remove', removed: { users: ['u-carol'] } } })
    expect(engine.undo(m('u-carol'), HUMAN, t.id, { version: 4, expectedVersion: 4 })).toMatchObject({ ok: false })
    // Nobody left would read it.
    const lone = ok(engine.create(m('u-dave'), HUMAN, { type: 'task', title: 'ひとり', members: [] })).record
    expect(engine.removeMembers(m('u-dave'), HUMAN, lone.id, { remove: ['u-dave'], expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'LIST_WOULD_BE_EMPTY' } })
  })

  it('only on a members-only record', () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '全員の' })).record
    expect(engine.removeMembers(m('u-alice'), HUMAN, t.id, { remove: ['u-alice'], expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOT_MEMBERS_ONLY' } })
    expect(engine.listChoices(m('u-alice'), t.id)).toMatchObject({ ok: false, body: { code: 'NOT_MEMBERS_ONLY' } })
  })
})

describe('what is made from a record with a group on its list', () => {
  it('a task made from a meeting gets the meeting’s list as written: the group follows for both', async () => {
    const actor = { id: 'acb:minutes', kind: 'external' as const, source: 'minutes' }
    const mt = writer.create('n', {
      type: 'meeting', title: '採用会議', members: ['u-alice'], memberSets: [{ type: 'group', id: group('n'), memberIds: [] }],
      fields: { assignee: 'u-alice', meeting_at: '2026-11-08T10:00' }, actor, quiet: true,
    })
    if (!mt.ok) throw new Error(mt.reason)
    const task = ok(engine.create(m('u-alice', 'n'), HUMAN, { type: 'task', title: '採用面接の宿題', links: { meeting: mt.record.id }, fields: { assignee: 'u-bob' } })).record
    expect(source.forCompany('n').records.byIds([task.id])[0]).toMatchObject({ members: ['u-alice', 'u-bob'], memberSets: [{ type: 'group', id: group('n') }] })
    source.forCompany('n').groups.replaceMembers(group('n'), ['u-bob', 'u-carol'], 'u-owner', TS)
    for (const id of [mt.record.id, task.id]) expect((await service.get(m('u-carol', 'n'), id)).ok, id).toBe(true)
    // The service writer's outputs of the meeting (the review task) inherit it the same way.
    const review = writer.create('n', { type: 'task', title: '議事録を確認する', links: { meeting: [mt.record.id] }, fields: { assignee: 'u-alice' }, actor })
    if (!review.ok) throw new Error(review.reason)
    expect((await service.get(m('u-carol', 'n'), review.record.id)).ok).toBe(true)
    // A place copied from it (a reply, a mail's やりとり: `placeOfRow`) keeps the group too.
    const row = source.forCompany('n').records.byIds([mt.record.id])[0]
    const copy = writer.create('n', { type: 'meeting', title: '写し', ...placeOfRow(row), actor, quiet: true })
    if (!copy.ok) throw new Error(copy.reason)
    expect((await service.get(m('u-carol', 'n'), copy.record.id)).ok).toBe(true)
    // A service may copy a list's groups only with a list.
    expect(writer.check('n', { type: 'meeting', title: 'x', memberSets: [{ type: 'group', id: group('n'), memberIds: [] }], actor })).toMatchObject({ reason: 'bad-place' })
  })

  it('a task whose list has a group is wider than a まとまり its group’s people cannot read', async () => {
    // A group no place rule names (so only the list makes carol a representative of who reads).
    source.forCompany('g').groups.create({ id: 'g-grp2', name: '面接官', nameKey: '面接官', createdAt: TS, createdBy: 'u-owner' })
    source.forCompany('g').groups.replaceMembers('g-grp2', ['u-carol'], 'u-owner', TS)
    const project = ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title: '採用', members: [], fields: { owner: 'u-alice' } })).record
    const { id } = listedTask('g', [{ subjectType: 'group', subjectId: 'g-grp2' }])
    expect(await engine.act(m('u-alice'), HUMAN, id, 'set_bundle', { expectedVersion: 2, links: { bundle: project.id } }))
      .toMatchObject({ ok: false, body: { code: 'WIDER_THAN_BUNDLE' } })
    // With the group on the まとまり's list too, it is within.
    ok(engine.invite(m('u-alice'), HUMAN, project.id, { add: [{ subjectType: 'group', subjectId: 'g-grp2' }], expectedVersion: 1 }))
    ok(await engine.act(m('u-alice'), HUMAN, id, 'set_bundle', { expectedVersion: 2, links: { bundle: project.id } }))
  })

  it('the inbox: a members-only やりとり takes a message that reached someone in a group on its list (onList)', () => {
    // The inbox's thread rule asks `onList`; the same answer as the reader (covered above) for a group member.
    const row = { members: ['u-alice'], memberSets: [{ type: 'group' as const, id: group('g'), memberIds: ['u-bob'] }] }
    expect(onList(row, 'u-bob')).toBe(true)
    expect(onList(row, 'u-carol')).toBe(false)
    expect(onList({ members: null, memberSets: row.memberSets }, 'u-bob')).toBe(false)
    expect(listedUserIds(row)).toEqual(['u-alice', 'u-bob'])
  })
})
