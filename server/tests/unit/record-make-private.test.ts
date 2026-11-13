/**
 * 「非公開にする」 (records.md "Making a 案件・プロジェクト private", owner FB #35 2026-11-13): an existing,
 * public 案件・プロジェクト moves into its own new private folder.
 *
 * Guards (each mutation-checked):
 * - only who may make a 非公開 one in its department today: owners / admins, that department's
 *   managers (a participant, another department's manager, the AI: refused; a company-wide one:
 *   owners / admins only);
 * - only a まとまり, only a public one (already private, owner-only: refused), at the version seen;
 * - only exactly an empty private folder directly inside its department — a public folder, a deeper
 *   one, another department's, one another 案件 is in: the one answer FOLDER_NOT_PLACEABLE, naming no
 *   folder;
 * - afterwards a non-participant reads neither it nor its やること (narrowed in the same move; an
 *   owner-only one stays owner-only); a やること the mover cannot narrow stops the whole move, and so
 *   does someone named who would not read it there; never undone.
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
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'

const TS = '2026-11-13T00:00:00.000Z'
const CO = 'a'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService

// 営業部's manager u-mgr; u-alice and u-carol are plain members; u-dev manages 開発部.
const PEOPLE = ['u-owner', 'u-admin', 'u-mgr', 'u-alice', 'u-carol', 'u-dev']
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const MANAGES: Record<string, string[]> = { 'u-mgr': ['営業部'], 'u-dev': ['開発部'] }
const m = (userId: string): Member => ({ companyId: CO, userId, role: ROLES[userId] ?? 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'c' }
// The private folder the app has just made for it (readers u-mgr and u-alice).
const NEW = '営業部/新製品'

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: unknown }) => (r.ok ? 'ok' : (r.body as { code?: string }).code)
function rule(id: string, scope: string, type: 'everyone' | 'user', subject: string | null, read: 0 | 1) {
  conn.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, type, subject, read, read, TS)
}
function privateFolder(id: string, path: string, readers: string[]) {
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, ?, 'folder', ?, ?)").run(id, CO, path, `${id}-repo`, TS)
  rule(`${id}-e`, id, 'everyone', null, 0)
  for (const u of readers) rule(`${id}-${u}`, id, 'user', u, 1)
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
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', TS, TS)
  for (const u of PEOPLE) conn.prepare('INSERT INTO memberships (user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(u, CO, ROLES[u] ?? 'member', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('root', ?, '', 'company', ?)").run(CO, TS)
  rule('root-r', 'root', 'everyone', null, 1)
  privateFolder('p', NEW, ['u-mgr', 'u-alice'])
  const records = source.forCompany(CO).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  // A business plugin's 案件 (other records copy its place when they are made).
  const deal = parseTypeFile('deal', '---\nlabel: 案件\nversion: 1\nstorage: server\nimplements: [bundle]\nfields:\n  owner: { label: 担当, kind: person, source: server }\n  purpose: { label: 目的, kind: text, source: server }\nstates: [open, done]\nfinal: [done]\n---\n')
  if (!deal.ok) throw new Error(deal.errors.join())
  records.insertTypeVersion({ name: 'deal', version: 1, definition: canonicalTypeJson(deal.definition), source: 'plugin', commitSha: null, createdAt: TS })
})

const project = (folder: string | null = '営業部', title = '新製品の立ち上げ') =>
  ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title, fields: { owner: 'u-alice' }, ...(folder !== null ? { folder } : {}) })).record
const task = (bundle: string, extra: Record<string, unknown> = {}, who = 'u-alice') =>
  ok(engine.create(m(who), HUMAN, { type: 'task', title: '試作の手配', fields: { assignee: who }, folder: '営業部', links: { bundle }, ...extra })).record
const versionOf = (id: string) => source.forCompany(CO).records.states([id])[0]?.version ?? 0
const move = (who: string, id: string, folder = NEW, actor = HUMAN, expectedVersion = versionOf(id)) =>
  engine.makePrivate(m(who), actor, id, { folder, expectedVersion })
const reads = async (who: string, id: string) => (await service.get(m(who), id)).ok

describe('who may make an existing 案件・プロジェクト private', () => {
  it('the department’s manager, an admin and the owner', () => {
    for (const who of ['u-mgr', 'u-admin', 'u-owner']) {
      const p = project()
      expect(code(engine.makePrivatePlan(m(who), p.id))).toBe('ok')
      expect(code(move(who, p.id))).toBe('ok')
      // Each into a fresh folder: the next one goes into the same path, so free it again.
      source.forCompany(CO).records.setPlace(p.id, { folder: '営業部', personalOwner: null }, TS)
    }
  })

  it('nobody else: a participant, another department’s manager, the AI', () => {
    const p = project()
    for (const who of ['u-alice', 'u-dev', 'u-carol']) {
      expect(code(engine.makePrivatePlan(m(who), p.id))).toBe('MAKE_PRIVATE_NOT_ALLOWED')
      expect(code(move(who, p.id))).toBe('MAKE_PRIVATE_NOT_ALLOWED')
    }
    expect(code(move('u-mgr', p.id, NEW, AI))).toBe('NOT_ALLOWED')
    expect(source.forCompany(CO).records.find(p.id)?.folder).toBe('営業部')
  })

  it('a company-wide one: owners / admins only, into a private folder at the company root', () => {
    privateFolder('top', '新製品', ['u-alice'])
    const p = project(null)
    expect(code(move('u-mgr', p.id, '新製品'))).toBe('MAKE_PRIVATE_NOT_ALLOWED')
    expect(ok(engine.makePrivatePlan(m('u-admin'), p.id)).parent).toBe('')
    expect(code(move('u-admin', p.id, '新製品'))).toBe('ok')
  })
})

describe('only a public まとまり, at the version seen', () => {
  it('a task is not a まとまり', () => {
    const t = ok(engine.create(m('u-mgr'), HUMAN, { type: 'task', title: 't', fields: { assignee: 'u-mgr' }, folder: '営業部' })).record
    expect(code(move('u-mgr', t.id))).toBe('NOT_A_BUNDLE')
  })

  it('a business plugin’s 案件: not for now', () => {
    const d = ok(engine.create(m('u-alice'), HUMAN, { type: 'deal', title: 'A社', fields: { owner: 'u-alice' }, folder: '営業部' })).record
    expect(code(engine.makePrivatePlan(m('u-mgr'), d.id))).toBe('MAKE_PRIVATE_NOT_FOR_TYPE')
    expect(code(move('u-mgr', d.id))).toBe('MAKE_PRIVATE_NOT_FOR_TYPE')
  })

  it('already private, or owner-only: NOT_PUBLIC', () => {
    const p = project()
    expect(code(move('u-mgr', p.id))).toBe('ok')
    expect(code(move('u-mgr', p.id))).toBe('NOT_PUBLIC')
    const mine = ok(engine.create(m('u-mgr'), HUMAN, { type: 'project', title: '自分の', fields: { owner: 'u-mgr' }, personal: true })).record
    expect(code(move('u-mgr', mine.id))).toBe('NOT_PUBLIC')
  })

  it('another version: VERSION_CONFLICT, nothing moved', () => {
    const p = project()
    expect(code(move('u-mgr', p.id, NEW, HUMAN, versionOf(p.id) + 3))).toBe('VERSION_CONFLICT')
    expect(source.forCompany(CO).records.find(p.id)?.folder).toBe('営業部')
  })
})

describe('only its own new private folder — one answer for every other place', () => {
  it('a public folder, a deeper one, another department’s, one another 案件 is in', () => {
    privateFolder('dev', '開発部/秘密の企画', ['u-admin'])
    privateFolder('deep', '営業部/新製品/中', ['u-mgr'])
    const other = project('営業部', 'ほかの案件')
    privateFolder('used', '営業部/使用中', ['u-mgr', 'u-alice'])
    expect(code(move('u-mgr', other.id, '営業部/使用中'))).toBe('ok')
    const p = project()
    const answers = [
      move('u-mgr', p.id, '営業部/公開の'),
      move('u-mgr', p.id, '営業部/新製品/中'),
      move('u-admin', p.id, '開発部/秘密の企画'),
      move('u-mgr', p.id, '営業部/使用中'),
      move('u-mgr', p.id, '../営業部/新製品'),
    ]
    for (const a of answers) expect(code(a)).toBe('FOLDER_NOT_PLACEABLE')
    expect(new Set(answers.map(a => JSON.stringify(a))).size).toBe(1)
    expect(JSON.stringify(answers)).not.toMatch(/秘密|使用中|新製品/)
    expect(source.forCompany(CO).records.find(p.id)?.folder).toBe('営業部')
  })
})

describe('afterwards: participants only, its やること too', () => {
  it('a non-participant reads neither it nor its narrowed やること; an owner-only one stays the owner’s', async () => {
    const p = project()
    const t = task(p.id)
    const mine = ok(engine.create(m('u-carol'), HUMAN, { type: 'task', title: '自分のメモ', fields: { assignee: 'u-carol' }, personal: true, links: { bundle: p.id } })).record
    expect(await reads('u-carol', p.id)).toBe(true)
    expect(await reads('u-carol', t.id)).toBe(true)
    const plan = ok(engine.makePrivatePlan(m('u-mgr'), p.id))
    expect(plan).toEqual({ parent: '営業部', tasks: 1, people: ['u-alice'], blocked: false })
    const done = ok(move('u-mgr', p.id))
    expect(done.narrowed).toBe(1)
    expect(await reads('u-carol', p.id)).toBe(false)
    expect(await reads('u-carol', t.id)).toBe(false)
    expect(await reads('u-alice', t.id)).toBe(true)
    expect(await reads('u-carol', mine.id)).toBe(true)
    expect(source.forCompany(CO).records.find(mine.id)?.personalOwner).toBe('u-carol')
    const q = ok(await service.query(m('u-carol'), { text: '新製品' }))
    expect(q.total).toBe(0)
    // Both entries say what moved; neither is undone (it would show them to everyone again).
    const records = source.forCompany(CO).records
    for (const id of [p.id, t.id]) {
      const last = records.ledger(id).at(-1)!
      expect(last.action).toBe('make_private')
      expect(last.changes).toEqual([{ field: 'place.folder', before: '営業部', after: NEW }])
      expect(code(engine.undo(m('u-mgr'), HUMAN, id, { version: last.version, expectedVersion: last.version }))).toBe('NOT_UNDOABLE')
    }
  })

  it('someone a やること names who is not a participant: refused, nothing moved', () => {
    const p = project()
    const t = task(p.id, { fields: { assignee: 'u-carol' } })
    expect(ok(engine.makePrivatePlan(m('u-mgr'), p.id)).people).toEqual(['u-alice', 'u-carol'])
    expect(code(move('u-mgr', p.id))).toBe('NAMED_PERSON_CANNOT_READ')
    expect(source.forCompany(CO).records.find(p.id)?.folder).toBe('営業部')
    expect(source.forCompany(CO).records.find(t.id)?.folder).toBe('営業部')
    rule('p-c', 'p', 'user', 'u-carol', 1)
    expect(code(move('u-mgr', p.id))).toBe('ok')
  })

  it('a やること the mover cannot narrow (one they do not read) stops the move, naming nothing', () => {
    const p = project()
    const hidden = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '内緒の段取り', fields: { assignee: 'u-alice' }, members: ['u-carol'], links: { bundle: p.id } })).record
    expect(ok(engine.makePrivatePlan(m('u-mgr'), p.id))).toMatchObject({ tasks: 0, blocked: true })
    const r = move('u-mgr', p.id)
    expect(code(r)).toBe('LINKED_NOT_MOVABLE')
    expect(JSON.stringify(r)).not.toMatch(/内緒|新製品/)
    expect(source.forCompany(CO).records.find(p.id)?.folder).toBe('営業部')
    expect(source.forCompany(CO).records.find(hidden.id)?.members).not.toBeNull()
  })

  it('a やること in another private folder that a participant could not see stops it (never shown to someone new)', () => {
    privateFolder('dev', '開発部/秘密の企画', ['u-mgr', 'u-carol'])
    const p = project()
    const t = ok(engine.create(m('u-mgr'), HUMAN, { type: 'task', title: '試作', fields: { assignee: 'u-mgr' }, folder: '営業部', links: { bundle: p.id } })).record
    // Placed there as a narrowed one of that folder's 案件 would be (written directly).
    source.forCompany(CO).records.setPlace(t.id, { folder: '開発部/秘密の企画', personalOwner: null }, TS)
    // u-alice (the 案件's 責任者, a participant) does not read 開発部/秘密の企画.
    expect(ok(engine.makePrivatePlan(m('u-mgr'), p.id)).blocked).toBe(true)
    const r = move('u-mgr', p.id)
    expect(code(r)).toBe('LINKED_NOT_MOVABLE')
    expect(JSON.stringify(r)).not.toMatch(/秘密/)
    expect(source.forCompany(CO).records.find(t.id)?.folder).toBe('開発部/秘密の企画')
  })

  it('a やること already seen by fewer people (another private folder of participants only) is left as it is', () => {
    privateFolder('small', '開発部/少人数', ['u-mgr'])
    const p = project()
    const t = ok(engine.create(m('u-mgr'), HUMAN, { type: 'task', title: '試作', fields: { assignee: 'u-mgr' }, folder: '営業部', links: { bundle: p.id } })).record
    source.forCompany(CO).records.setPlace(t.id, { folder: '開発部/少人数', personalOwner: null }, TS)
    expect(ok(engine.makePrivatePlan(m('u-mgr'), p.id)).blocked).toBe(false)
    expect(ok(move('u-mgr', p.id)).narrowed).toBe(0)
    expect(source.forCompany(CO).records.find(t.id)?.folder).toBe('開発部/少人数')
  })

  it('another record linked to it and placed by a folder (it never follows) stops it, naming nothing', () => {
    const p = project()
    const other = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '関係する話', fields: { assignee: 'u-alice' }, folder: '営業部' })).record
    // A record of another kind linked to the 案件 (a sent mail, a decision…), written directly.
    source.forCompany(CO).records.replaceLinks(other.id, [{ sourceId: other.id, name: 'related', position: 0, targetId: p.id, targetPath: null }])
    expect(ok(engine.makePrivatePlan(m('u-mgr'), p.id)).blocked).toBe(true)
    const r = move('u-mgr', p.id)
    expect(code(r)).toBe('LINKED_RECORDS_WIDER')
    expect(JSON.stringify(r)).not.toMatch(/関係する話|新製品/)
    expect(source.forCompany(CO).records.find(p.id)?.folder).toBe('営業部')
  })

  it('a participant who could not read the 案件 before is refused (nobody gains it with its history)', () => {
    // A company without the shared folder: 営業部 is read by its people only.
    conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('sales', ?, '営業部', 'folder', ?)").run(CO, TS)
    rule('sales-e', 'sales', 'everyone', null, 0)
    rule('sales-m', 'sales', 'user', 'u-mgr', 1)
    rule('sales-a', 'sales', 'user', 'u-alice', 1)
    const p = project()
    expect(code(engine.makePrivatePlan(m('u-carol'), p.id))).toBe('RECORD_NOT_FOUND')
    rule('p-c', 'p', 'user', 'u-carol', 1)
    expect(code(move('u-mgr', p.id))).toBe('PARTICIPANTS_WIDER')
    expect(source.forCompany(CO).records.find(p.id)?.folder).toBe('営業部')
  })

  it('a members-only やること the mover reads whose list is wider stops it too (never a list turned into a folder)', () => {
    const p = project()
    ok(engine.create(m('u-mgr'), HUMAN, { type: 'task', title: '打ち合わせ', fields: { assignee: 'u-mgr' }, members: ['u-carol'], links: { bundle: p.id } }))
    expect(code(move('u-mgr', p.id))).toBe('LINKED_NOT_MOVABLE')
    // With u-carol a participant, the list is within the 案件: it stays as it is.
    rule('p-c', 'p', 'user', 'u-carol', 1)
    expect(ok(move('u-mgr', p.id)).narrowed).toBe(0)
  })
})
