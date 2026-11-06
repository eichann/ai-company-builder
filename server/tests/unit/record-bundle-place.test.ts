/**
 * A task and the 案件・プロジェクト it belongs to (records.md "A task and its 案件・プロジェクト",
 * owner decision 2026-11-06). No new permission: a task's 見える範囲 is one of the existing ones, and
 * one that belongs to a まとまり is never seen by more people than the まとまり.
 *
 * Guards (each mutation-checked):
 * - a new まとまり the AI makes belongs to the creator's own department (所属) by default;
 * - a task made for a まとまり takes its place (folder, private folder, list) — owner-only stays
 *   owner-only, and a place given that is wider is refused;
 * - linking a wider task is refused unless the person narrows it, in one entry that is never undone,
 *   and never when someone the task names would lose it; the AI's set_bundle is refused alike;
 * - 「プロジェクトの人に見せる」: the share reaches the まとまり's private folder only for a task linked
 *   to it and only for a reader of it;
 * - nothing names a private まとまり to someone who cannot read it.
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
import { defaultBundleFolder } from '../../shared/core/bundle-place'

const TS = '2026-11-06T00:00:00.000Z'
const CO = 'a'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService

// u-alice and u-bob take part in 営業部/新製品 (a private folder); u-carol does not.
const PEOPLE = ['u-owner', 'u-admin', 'u-alice', 'u-bob', 'u-carol']
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const m = (userId: string): Member => ({ companyId: CO, userId, role: ROLES[userId] ?? 'member' })
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }
const HUMAN: ActorInput = { kind: 'human' }
const PRIVATE = '営業部/新製品'

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: unknown }) => (r.ok ? 'ok' : (r.body as { code?: string }).code)

function rule(id: string, scope: string, type: 'everyone' | 'user', subject: string | null, read: 0 | 1) {
  conn.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, type, subject, read, read, TS)
}
function department(id: string, folder: string, order: number, members: string[]) {
  conn.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, CO, folder, folder, order, TS, TS)
  for (const u of members) conn.prepare('INSERT INTO department_members (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(CO, id, u, TS)
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let tick = 0
  const clock = { now: () => `2026-11-06T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 }
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
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('root', ?, '', 'company', ?)").run(CO, TS)
  rule('root-r', 'root', 'everyone', null, 1)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('p', ?, ?, 'folder', 'a-repo', ?)").run(CO, PRIVATE, TS)
  rule('p-e', 'p', 'everyone', null, 0)
  rule('p-a', 'p', 'user', 'u-alice', 1)
  rule('p-b', 'p', 'user', 'u-bob', 1)
  // Another private folder nobody here takes part in (what "any other private folder" answers).
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('q', ?, '開発部/別件', 'folder', 'b-repo', ?)").run(CO, TS)
  rule('q-e', 'q', 'everyone', null, 0)
  department('d-sales', '営業部', 0, ['u-alice'])
  department('d-dev', '開発部', 1, ['u-bob'])
  const records = source.forCompany(CO).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
})

const project = (title: string, folder: string | null, who = 'u-alice') =>
  ok(engine.create(m(who), HUMAN, { type: 'project', title, fields: { owner: who }, ...(folder ? { folder } : {}) })).record
/** A まとまり in the private folder (made in a department, then placed there as part B's create does). */
function privateProject(title = '新製品の立ち上げ') {
  const p = project(title, '営業部')
  source.forCompany(CO).records.setPlace(p.id, { folder: PRIVATE, personalOwner: null }, TS)
  return p
}
const placeOf = (id: string) => {
  const r = source.forCompany(CO).records.byIds([id])[0]
  return { folder: r.folder, personalOwner: r.personalOwner, members: r.members }
}
const reads = async (who: string, id: string) => (await service.get(m(who), id)).ok

describe('the department a new 案件・プロジェクト belongs to', () => {
  it('the rule: on screen when it is theirs, else their first in tab order, else on screen', () => {
    const departments = [{ id: 's', folder: '営業部' }, { id: 'd', folder: '開発部' }, { id: 'k', folder: '経理部' }]
    expect(defaultBundleFolder({ departments, mine: ['d', 'k'], onScreen: '経理部' })).toBe('経理部')
    expect(defaultBundleFolder({ departments, mine: ['k', 'd'], onScreen: '営業部' })).toBe('開発部')
    expect(defaultBundleFolder({ departments, mine: ['d'], onScreen: null })).toBe('開発部')
    expect(defaultBundleFolder({ departments, mine: [], onScreen: '営業部' })).toBe('営業部')
    expect(defaultBundleFolder({ departments, mine: null, onScreen: null })).toBeNull()
  })

  it('the AI’s create: the creator’s own department, not the one on screen', () => {
    const made = ok(engine.createByAi(m('u-bob'), AI, { type: 'project', title: '試作', fields: { owner: 'u-bob' }, defaultFolder: '営業部' }))
    expect(made.placed?.folder).toBe('開発部')
    const own = ok(engine.createByAi(m('u-alice'), AI, { type: 'project', title: '提案', fields: { owner: 'u-alice' }, defaultFolder: '営業部' }))
    expect(own.placed?.folder).toBe('営業部')
    // Belonging nowhere (the owner): the department on screen.
    const owner = ok(engine.createByAi(m('u-owner'), AI, { type: 'project', title: '全体', fields: { owner: 'u-owner' }, defaultFolder: '開発部' }))
    expect(owner.placed?.folder).toBe('開発部')
    // A folder the AI names wins.
    const named = ok(engine.createByAi(m('u-bob'), AI, { type: 'project', title: '営業の', fields: { owner: 'u-bob' }, folder: '営業部', defaultFolder: '開発部' }))
    expect(named.placed?.folder).toBe('営業部')
  })
})

describe('a task made for a まとまり takes its 見える範囲', () => {
  it('asked of someone (the card’s line): the まとまり’s folder, not the department on screen', async () => {
    const p = privateProject()
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '試作を頼む', fields: { assignee: 'u-bob' }, links: { bundle: p.id } }))
    expect(t.placed).toEqual({ personal: false, folder: PRIVATE })
    expect(await reads('u-bob', t.record.id)).toBe(true)
    expect(await reads('u-carol', t.record.id)).toBe(false)
  })

  it('the AI’s create for someone else: the まとまり’s place, never the consultation’s department', async () => {
    const p = privateProject()
    const t = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: '原価を出す', fields: { assignee: 'u-bob' }, links: { bundle: p.id }, defaultFolder: '開発部' }))
    expect(t.placed).toEqual({ personal: false, folder: PRIVATE })
    expect(await reads('u-carol', t.record.id)).toBe(false)
  })

  it('a members-only まとまり gives its list', () => {
    const p = project('少人数', '営業部')
    conn.prepare("UPDATE records SET personal_owner = '@members', folder = NULL WHERE company_id = ? AND id = ?").run(CO, p.id)
    for (const u of ['u-alice', 'u-bob']) conn.prepare('INSERT INTO record_viewers (company_id, record_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?, ?)').run(CO, p.id, u, TS, 'u-alice')
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', fields: { assignee: 'u-bob' }, links: { bundle: p.id } }))
    expect(placeOf(t.record.id).members).toEqual(expect.arrayContaining(['u-alice', 'u-bob']))
  })

  it('an assignee who is not a participant is refused (never placed wider instead)', () => {
    const p = privateProject()
    const r = engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', fields: { assignee: 'u-carol' }, links: { bundle: p.id } })
    expect(code(r)).toBe('ASSIGNEE_CANNOT_READ')
  })

  it('an owner-only task stays owner-only (a person’s line, the AI’s “about the member alone”)', () => {
    const p = privateProject()
    const own = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分の', personal: true, fields: { assignee: 'u-alice' }, links: { bundle: p.id } }))
    expect(placeOf(own.record.id)).toEqual({ folder: null, personalOwner: 'u-alice', members: null })
    const byAi = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: '自分で調べる', links: { bundle: p.id }, defaultFolder: '営業部' }))
    expect(byAi.placed).toEqual({ personal: true, folder: null })
  })

  it('a place given that is wider is refused', () => {
    const p = privateProject()
    expect(code(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', fields: { assignee: 'u-bob' }, folder: '営業部', links: { bundle: p.id } }))).toBe('WIDER_THAN_BUNDLE')
    // Within (the same place) is kept.
    const d = project('部署の', '開発部', 'u-bob')
    expect(code(engine.create(m('u-bob'), HUMAN, { type: 'task', title: 'y', fields: { assignee: 'u-bob' }, folder: '開発部', links: { bundle: d.id } }))).toBe('ok')
  })
})

describe('linking a task to a まとまり', () => {
  const companyTask = (assignee = 'u-alice') => ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積', fields: { assignee } })).record

  it('a company-wide task and a private まとまり: refused, nothing written', () => {
    const p = privateProject()
    const t = companyTask()
    const r = engine.recordLink(m('u-alice'), HUMAN, t.id, 'link', { link: 'bundle', target: p.id, expectedVersion: 1 })
    expect(code(r)).toBe('WIDER_THAN_BUNDLE')
    expect(source.forCompany(CO).records.ledger(t.id)).toHaveLength(1)
    expect(placeOf(t.id).folder).toBeNull()
  })

  it('narrowed on the person’s yes: one entry with the place, never undone; then only participants read it', async () => {
    const p = privateProject()
    const t = companyTask('u-bob')
    const r = ok(engine.recordLink(m('u-alice'), HUMAN, t.id, 'link', { link: 'bundle', target: p.id, expectedVersion: 1, narrow: true }))
    expect(placeOf(t.id).folder).toBe(PRIVATE)
    expect(r.entry?.changes.map(c => c.field)).toEqual(['place.personal_owner', 'place.folder', 'links.bundle'])
    expect(code(await engine.undo(m('u-alice'), HUMAN, t.id, { version: 2, expectedVersion: 2 }))).toBe('NOT_UNDOABLE')
    expect(await reads('u-bob', t.id)).toBe(true)
    expect(await reads('u-carol', t.id)).toBe(false)
  })

  it('never narrowed away from someone the task names', () => {
    const p = privateProject()
    const t = companyTask('u-carol')
    const r = engine.recordLink(m('u-alice'), HUMAN, t.id, 'link', { link: 'bundle', target: p.id, expectedVersion: 1, narrow: true })
    expect(code(r)).toBe('NAMED_PERSON_CANNOT_READ')
    expect(placeOf(t.id).folder).toBeNull()
  })

  it('a task already within is linked as before (department まとまり, company-wide task)', () => {
    const d = project('部署の', '開発部', 'u-bob')
    const t = companyTask()
    expect(code(engine.recordLink(m('u-alice'), HUMAN, t.id, 'link', { link: 'bundle', target: d.id, expectedVersion: 1 }))).toBe('ok')
  })

  it('an owner-only task is never wider', () => {
    const p = privateProject()
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分の', personal: true, fields: { assignee: 'u-alice' } })).record
    expect(code(engine.recordLink(m('u-alice'), HUMAN, t.id, 'link', { link: 'bundle', target: p.id, expectedVersion: 1 }))).toBe('ok')
    expect(placeOf(t.id).personalOwner).toBe('u-alice')
  })

  it('a members-only task is within when all its members read the まとまり', () => {
    const p = privateProject()
    const both = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '二人の', members: ['u-bob'], fields: { assignee: 'u-alice' } })).record
    expect(code(engine.recordLink(m('u-alice'), HUMAN, both.id, 'link', { link: 'bundle', target: p.id, expectedVersion: 1 }))).toBe('ok')
    const withCarol = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '三人の', members: ['u-carol'], fields: { assignee: 'u-alice' } })).record
    expect(code(engine.recordLink(m('u-alice'), HUMAN, withCarol.id, 'link', { link: 'bundle', target: p.id, expectedVersion: 1 }))).toBe('WIDER_THAN_BUNDLE')
  })

  it('the action set_bundle (the AI’s tool) is refused alike', async () => {
    const p = privateProject()
    const t = companyTask()
    const r = await engine.act(m('u-alice'), AI, t.id, 'set_bundle', { expectedVersion: 1, links: { bundle: p.id } })
    expect(code(r)).toBe('WIDER_THAN_BUNDLE')
  })
})

describe('「プロジェクトの人に見せる」 (share to the まとまり’s place)', () => {
  const ownLinked = (p: { id: string }) => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分の', personal: true, fields: { assignee: 'u-alice' }, links: { bundle: p.id } })).record
    return t
  }

  it('the まとまり’s private folder, for a linked task of a reader: then its participants see it', async () => {
    const p = privateProject()
    const t = ownLinked(p)
    ok(engine.share(m('u-alice'), HUMAN, t.id, { folder: PRIVATE, expectedVersion: 1 }))
    expect(placeOf(t.id)).toEqual({ folder: PRIVATE, personalOwner: null, members: null })
    expect(await reads('u-bob', t.id)).toBe(true)
    expect(await reads('u-carol', t.id)).toBe(false)
  })

  it('toBundle names the same place without a path; a company-wide まとまり shows it to everyone', async () => {
    const p = privateProject()
    const t = ownLinked(p)
    ok(engine.share(m('u-alice'), HUMAN, t.id, { toBundle: true, expectedVersion: 1 }))
    expect(placeOf(t.id).folder).toBe(PRIVATE)
    const everyone = project('全社の', null)
    const t2 = ownLinked(everyone)
    ok(engine.share(m('u-alice'), HUMAN, t2.id, { toBundle: true, expectedVersion: 1 }))
    expect(await reads('u-carol', t2.id)).toBe(true)
  })

  it('a task not linked to that まとまり gets the answer of any private folder', () => {
    const p = privateProject()
    const other = project('別の', '営業部')
    const unlinked = ownLinked(other)
    const r = engine.share(m('u-alice'), HUMAN, unlinked.id, { folder: PRIVATE, expectedVersion: 1 })
    expect(code(r)).toBe('FOLDER_NOT_PLACEABLE')
    expect(placeOf(p.id).folder).toBe(PRIVATE)
  })

  it('no longer a reader of the まとまり (taken off the participants): refused like any private folder', () => {
    const p = privateProject()
    const t = ownLinked(p)
    conn.prepare("DELETE FROM scope_rules WHERE id = 'p-a'").run()
    const r = engine.share(m('u-alice'), HUMAN, t.id, { folder: PRIVATE, expectedVersion: 1 })
    const missing = engine.share(m('u-alice'), HUMAN, t.id, { folder: '開発部/別件', expectedVersion: 1 })
    expect(code(r)).toBe('FOLDER_NOT_PLACEABLE')
    expect(r).toEqual(missing)
  })
})

describe('nothing names a private まとまり to someone who cannot read it', () => {
  it('linking to it or making a task for it answers like a missing record, with no name or place', () => {
    const p = privateProject('極秘の新製品')
    const t = ok(engine.create(m('u-carol'), HUMAN, { type: 'task', title: 'x', fields: { assignee: 'u-carol' } })).record
    const linked = engine.recordLink(m('u-carol'), HUMAN, t.id, 'link', { link: 'bundle', target: p.id, expectedVersion: 1 })
    const missing = engine.recordLink(m('u-carol'), HUMAN, t.id, 'link', { link: 'bundle', target: 'project-0000000000000000', expectedVersion: 1 })
    expect(linked).toEqual(missing)
    const made = engine.create(m('u-carol'), HUMAN, { type: 'task', title: 'y', fields: { assignee: 'u-carol' }, links: { bundle: p.id } })
    const madeMissing = engine.create(m('u-carol'), HUMAN, { type: 'task', title: 'y', fields: { assignee: 'u-carol' }, links: { bundle: 'project-0000000000000000' } })
    expect(made).toEqual(madeMissing)
    for (const r of [linked, made]) expect(JSON.stringify(r)).not.toMatch(/極秘|新製品/)
  })

  it('a share naming its folder answers like any private folder', () => {
    privateProject()
    const own = ok(engine.create(m('u-carol'), HUMAN, { type: 'task', title: '自分の', personal: true, fields: { assignee: 'u-carol' } })).record
    const r = engine.share(m('u-carol'), HUMAN, own.id, { folder: PRIVATE, expectedVersion: 1 })
    const missing = engine.share(m('u-carol'), HUMAN, own.id, { folder: '開発部/別件', expectedVersion: 1 })
    expect(r).toEqual(missing)
    expect(JSON.stringify(r)).not.toMatch(/新製品/)
  })

  it('the route’s first check: a reader’s private folder is left to the engine, anyone else’s answers like a missing folder', async () => {
    const withRepo = createRecordEngine({
      companyData: source, transactions: sqliteTransactions(conn), clock: { now: () => TS, nowMs: () => 0 },
      ids: { newId: () => 'x', newToken: () => 'f'.repeat(16) },
      files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
      managedFolders: () => [], isMember: () => true, roleOf: (_c, u) => ROLES[u] ?? 'member', notify: () => {},
      // Private folders are never in the company repository.
      folderExists: async (_c, path) => !path.startsWith(PRIVATE) && !path.includes('どこにもない'),
    })
    expect(code(await withRepo.checkPlace(m('u-alice'), { folder: PRIVATE }))).toBe('ok')
    const carol = await withRepo.checkPlace(m('u-carol'), { folder: PRIVATE })
    expect(code(carol)).toBe('FOLDER_NOT_PLACEABLE')
    expect(carol).toEqual(await withRepo.checkPlace(m('u-carol'), { folder: '営業部/どこにもない' }))
  })
})
