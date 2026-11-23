/**
 * Where the member's AI puts a request it makes (records.md "Where the AI puts a request",
 * owner decision 2026-11-03): `recordEngine.createByAi`, the engine behind
 * `POST /api/records-ai/item` (tool records_create).
 *
 * Guards:
 * - nothing said about anyone → owner-only, the member as assignee (their turn), and nobody
 *   else — another member, the owner, an admin — finds it;
 * - another person as assignee, or a department asked for (`personal: false`) → the consultation's
 *   department (`defaultFolder`), assignee as said or the member; the 全社 tab said on purpose
 *   (`defaultPlace: 'company'`) → the whole company; a released app's 全社 tab (no default at all) → the
 *   whole company only until every active member's app says 全社 (`placeRequired`), then refused;
 * - nothing given and nobody else named (any type the member may keep for themself) → owner-only, and the
 *   answer says so; a plugin's type → refused (`PLACE_REQUIRED`), never company-wide quietly;
 * - `place: 'company'` said by the AI → the whole company; never with another place;
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
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'

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
  // A business plugin's type (never owner-only) and a company's own type that is neither a request nor a まとまり.
  for (const [name, text, src] of [
    ['deal', '---\nlabel: 案件\nversion: 1\nstorage: server\nfields:\n  contact: { label: 担当, kind: person, source: server }\nstates: [open]\n---\n', 'plugin'],
    ['memo', '---\nlabel: メモ\nversion: 1\nstorage: server\nfields:\n  writer: { label: 書いた人, kind: person, source: server }\nstates: [open]\n---\n', 'file'],
  ] as const) {
    const t = parseTypeFile(name, text)
    if (!t.ok) throw new Error(t.errors.join())
    records.insertTypeVersion({ name, version: 1, definition: canonicalTypeJson(t.definition), source: src, commitSha: null, createdAt: TS })
  }
})

/** The same engine with other deps (the 全社 gate). */
function withDeps(extra: Partial<Parameters<typeof createRecordEngine>[0]>): RecordEngine {
  return createRecordEngine({
    companyData: source, transactions: sqliteTransactions(conn),
    clock: { now: () => TS, nowMs: () => 0 },
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [], isMember: (_c, u) => PEOPLE.includes(u), roleOf: (_c, u) => (PEOPLE.includes(u) ? ROLES[u] ?? 'member' : null), notify: () => {},
    ...extra,
  })
}

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

  it('from the 全社 tab said on purpose (`defaultPlace: company`) → the whole company', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: '原稿を見る', fields: { assignee: 'u-bob' }, defaultPlace: 'company' }))
    expect(made.placed).toEqual({ personal: false, folder: null })
    expect(ids('u-mallory')).toContain(made.record.id)
  })

  it('a released app’s 全社 tab (no default at all) → the whole company until the gate, then refused', () => {
    const body = { type: 'task', title: '原稿を見る', fields: { assignee: 'u-bob' } }
    const made = ok(engine.createByAi(m('u-alice'), AI, body))
    expect(made.placed).toEqual({ personal: false, folder: null })
    expect(ids('u-mallory')).toContain(made.record.id)
    const gated = withDeps({ placeRequired: () => true })
    expect(gated.createByAi(m('u-alice'), AI, body)).toMatchObject({ ok: false, body: { code: 'PLACE_REQUIRED' } })
    expect(gated.createByAi(m('u-alice'), AI, { ...body, personal: false })).toMatchObject({ ok: false, body: { code: 'PLACE_REQUIRED' } })
    expect(ids('u-mallory')).toEqual([made.record.id])
  })

  it('the department on screen is never overridden by the 全社 hint', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', fields: { assignee: 'u-bob' }, defaultFolder: 'コンテンツ', defaultPlace: 'company' }))
    expect(made.placed).toEqual({ personal: false, folder: 'コンテンツ' })
  })

  it('a folder the AI names wins over the default', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', fields: { assignee: 'u-bob' }, folder: 'コンテンツ', defaultFolder: '営業部' }))
    expect(made.placed?.folder).toBe('コンテンツ')
  })

  it('the default is checked like any folder: a private one is refused, never placed company-wide', () => {
    const r = engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', fields: { assignee: 'u-bob' }, defaultFolder: '経理部' })
    expect(r).toMatchObject({ ok: false, body: { code: 'FOLDER_NOT_PLACEABLE' } })
    expect(ids('u-owner')).toEqual([])
  })

  it('an assignee who cannot read the department is refused', () => {
    const r = engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', fields: { assignee: 'u-mallory' }, defaultFolder: 'コンテンツ' })
    expect(r).toMatchObject({ ok: false, body: { code: 'ASSIGNEE_CANNOT_READ' } })
  })
})

describe('全社 is a choice: the AI giving no place (records.md "全社 is a choice")', () => {
  it('a project with no department of the member’s and no screen → owner-only, said in the answer', () => {
    const made = ok(engine.createByAi(m('u-owner'), AI, { type: 'project', title: '新しい取り組み' }))
    expect(made.placed).toEqual({ personal: true, folder: null })
    for (const who of ['u-alice', 'u-admin']) expect(ok(service.query(m(who), { type: 'project' })).records).toEqual([])
  })

  it('the same on the 全社 tab said on purpose → the whole company, as the screen says', () => {
    const made = ok(engine.createByAi(m('u-owner'), AI, { type: 'project', title: '全社の取り組み', defaultPlace: 'company' }))
    expect(made.placed).toEqual({ personal: false, folder: null })
    expect(ok(service.query(m('u-mallory'), { type: 'project' })).records.map(r => r.id)).toEqual([made.record.id])
  })

  it('`place: company` said by the AI → the whole company; with another place → refused', () => {
    const made = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: '全員へ', place: 'company', defaultFolder: 'コンテンツ' }))
    expect(made.placed).toEqual({ personal: false, folder: null })
    expect(ids('u-mallory')).toContain(made.record.id)
    expect(engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', place: 'company', folder: 'コンテンツ' })).toMatchObject({ ok: false, body: { code: 'PLACE_CONFLICT' } })
    expect(engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', place: 'company', personal: true })).toMatchObject({ ok: false, body: { code: 'PLACE_CONFLICT' } })
    expect(engine.createByAi(m('u-alice'), AI, { type: 'task', title: 'x', place: 'everyone' })).toMatchObject({ ok: false, body: { code: 'BAD_PLACE' } })
  })

  it('any other kind of record about the member alone → owner-only; naming someone else → refused', () => {
    const mine = ok(engine.createByAi(m('u-alice'), AI, { type: 'memo', title: '覚え書き', defaultFolder: 'コンテンツ' }))
    expect(mine.placed).toEqual({ personal: true, folder: null })
    expect(ok(service.query(m('u-owner'), { type: 'memo' })).records).toEqual([])
    const other = engine.createByAi(m('u-alice'), AI, { type: 'memo', title: 'x', fields: { writer: 'u-bob' }, defaultFolder: 'コンテンツ' })
    expect(other).toMatchObject({ ok: false, body: { code: 'PLACE_REQUIRED' } })
    expect(ok(service.query(m('u-bob'), { type: 'memo' })).records).toEqual([])
  })

  it('a business plugin’s type (never owner-only) with no place → refused when the app said its screen, never company-wide', () => {
    for (const hint of [{ defaultFolder: 'コンテンツ' }, { defaultPlace: 'company' }]) {
      expect(engine.createByAi(m('u-alice'), AI, { type: 'deal', title: 'x', ...hint })).toMatchObject({ ok: false, body: { code: 'PLACE_REQUIRED' } })
    }
    expect(ok(service.query(m('u-alice'), { type: 'deal' })).records).toEqual([])
    // Said: a folder or 全社 on purpose.
    expect(ok(engine.createByAi(m('u-alice'), AI, { type: 'deal', title: 'x', folder: 'コンテンツ' })).placed).toEqual({ personal: false, folder: 'コンテンツ' })
    expect(ok(engine.createByAi(m('u-alice'), AI, { type: 'deal', title: 'y', place: 'company' })).placed).toEqual({ personal: false, folder: null })
    // A released app that says nothing of its screen: as before until the gate, then refused.
    expect(ok(engine.createByAi(m('u-alice'), AI, { type: 'deal', title: 'z' })).placed).toEqual({ personal: false, folder: null })
    expect(withDeps({ placeRequired: () => true }).createByAi(m('u-alice'), AI, { type: 'deal', title: 'z' })).toMatchObject({ ok: false, body: { code: 'PLACE_REQUIRED' } })
  })

  it('the refusal names no place or title', () => {
    const r = engine.createByAi(m('u-alice'), AI, { type: 'deal', title: '秘密の案件', defaultFolder: 'コンテンツ' })
    const text = JSON.stringify(r)
    expect(text).not.toContain('秘密の案件')
    expect(text).not.toContain('コンテンツ')
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

describe('a private folder\'s name is never confirmed by the answer (audit B-M1)', () => {
  it('someone who cannot read 経理部 gets the same answer for it, inside it and for a folder that is not there; a reader too', async () => {
    // The company folder holds コンテンツ only (経理部 is a private folder: not in the company repository).
    const withRepo = createRecordEngine({
      companyData: source, transactions: sqliteTransactions(conn),
      clock: { now: () => TS, nowMs: () => 0 },
      ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
      files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
      managedFolders: () => [], isMember: (_c, u) => PEOPLE.includes(u), roleOf: (_c, u) => (PEOPLE.includes(u) ? ROLES[u] ?? 'member' : null), notify: () => {},
      folderExists: async (_c, path) => path === 'コンテンツ',
    })
    const answerOf = async (who: string, folder: string, how: 'person' | 'ai') => {
      const body = { type: 'task', title: 'x', fields: { assignee: who }, personal: false, folder }
      const pre = await withRepo.checkPlace(m(who), body, how === 'ai')
      const r = pre.ok ? (how === 'ai' ? withRepo.createByAi(m(who), AI, body) : withRepo.create(m(who), HUMAN, body)) : pre
      return JSON.stringify(r.ok ? 'created' : { kind: r.kind, body: r.body })
    }
    for (const how of ['person', 'ai'] as const) {
      const missing = await answerOf('u-bob', '存在しない部', how)
      expect(missing).toContain('FOLDER_NOT_PLACEABLE')
      expect(await answerOf('u-bob', '経理部', how)).toBe(missing)
      expect(await answerOf('u-bob', '経理部/請求', how)).toBe(missing)
      // A folder the member cannot read answers the same too.
      expect(await answerOf('u-mallory', 'コンテンツ', how)).toBe(missing)
      // Its reader learns nothing more either (a server-only record is not placed in a private folder yet).
      expect(await answerOf('u-alice', '経理部', how)).toBe(missing)
      expect(await answerOf('u-bob', 'コンテンツ', how)).toBe('"created"')
    }
    expect(ids('u-owner').length).toBe(2)
  })
})
