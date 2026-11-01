/**
 * The content store (中身の箱, records.md "The content store") on the real
 * schema behind real company handles.
 *
 * Guards:
 * - the ledger, the state and the record index never hold the text of a
 *   title, summary, long_text field, note or decision reason — only references;
 * - erased content reads as 「消去済み（date）」 everywhere (detail, query,
 *   history, replay) and its text is gone from the database; the rest of
 *   the record and its replay still work;
 * - content resolves only through its own record: another company's handle,
 *   a reference copied into another record, and the eraser given another
 *   company all reach nothing;
 * - a record the member cannot read keeps its content unreadable, search
 *   included; search finds titles only among readable, unerased records;
 * - retention: an interaction's summary expires after 3 years (and a copy of
 *   it with it); the startup move of older rows is complete and idempotent.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { initDatabase, migrateRecordContents } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteRecordContentEraser } from '../../src/adapters/sqlite/record-contents'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordEngine } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createDecisionService, type DecisionService } from '../../src/services/decisions'
import { createRecordContentErasure, type RecordContentErasure } from '../../src/services/record-contents'
import type { Member } from '../../src/services/access'

const TS = '2026-11-01T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let decisions: DecisionService
let erasure: RecordContentErasure
let now = '2026-11-01T01:00:00.000Z'

const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-mallory']
const m = (userId: string, co = 'a', role = 'member'): Member => ({ companyId: co, userId, role })
const owner = (co = 'a') => m('u-owner', co, 'owner')
const HUMAN = { kind: 'human' as const }

const TITLE = '山田花子さんの引っ越し手続き'
const PURPOSE = '山田花子さん（090-1234-5678）の転居先を登録する'
const NOTE = '山田さんから電話で中止の依頼'
const WHY = '鈴木一郎さんの強い要望で窓口を増やす'

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  for (const folder of ['営業部', '秘書室']) {
    conn.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-${folder}`, id, folder, folder, TS, TS)
  }
  // 秘書室: a folder u-mallory cannot read.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '秘書室', 'folder', ?)").run(`${id}-sec`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-sec-e`, `${id}-sec`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-mallory', 0, 0, ?)").run(`${id}-sec-m`, `${id}-sec`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
}

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

/** Every row of the tables that hold references (not the content store itself). */
const referenceTables = () => JSON.stringify([
  conn.prepare('SELECT * FROM records').all(),
  conn.prepare('SELECT * FROM record_state').all(),
  conn.prepare('SELECT * FROM record_ledger').all(),
])

beforeEach(() => {
  now = '2026-11-01T01:00:00.000Z'
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: () => now, nowMs: () => Date.parse(now) }
  const ids = { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') }
  const roleOf = (_c: string, userId: string) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null)
  const base = {
    companyData: source, transactions: sqliteTransactions(conn), clock, ids,
    isMember: (_c: string, userId: string) => PEOPLE.includes(userId), roleOf, notify: () => {},
  }
  engine = createRecordEngine({ ...base, files: { appendHistoryLine: async () => true, fileAtCommit: async () => false }, managedFolders: () => [] })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  const writer = createServiceRecordWriter(base)
  decisions = createDecisionService({ companyData: source, writer, ids, tokenDigest: { digest: (t: string) => createHash('sha256').update(t).digest('hex') } })
  erasure = createRecordContentErasure({
    eraser: sqliteRecordContentEraser(conn), companyData: source, transactions: sqliteTransactions(conn), clock, companyIds: () => ['a', 'b'],
  })
  company('a')
  company('b')
})

/** A task with a title, a long_text purpose, then cancelled with a note (version 2). */
async function cancelledTask(folder: string | null = null) {
  const created = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: TITLE, ...(folder ? { folder } : {}), fields: { purpose: PURPOSE, assignee: 'u-bob' } }))
  ok(await engine.act(m('u-alice'), HUMAN, created.record.id, 'cancel', { expectedVersion: 1, note: NOTE, decision: {} }))
  return created.record.id
}

describe('the content store', () => {
  it('the ledger, the state and the index hold references, never the text; reading gives the text back', async () => {
    const id = await cancelledTask()
    const d = ok(await decisions.record(m('u-alice'), HUMAN, { folder: '営業部', title: '窓口を3つにする', why: WHY, source: '鈴木一郎さんとの電話' }))
    const raw = referenceTables()
    for (const text of [TITLE, PURPOSE, NOTE, WHY, '鈴木一郎さんとの電話', '窓口を3つにする']) expect(raw).not.toContain(text)
    expect(raw).toContain('acb-content:')

    const detail = ok(await service.get(m('u-bob'), id))
    expect(detail.record.title).toBe(TITLE)
    expect(detail.record.fields.purpose).toBe(PURPOSE)
    const history = ok(engine.history(m('u-bob'), id)).entries
    expect(history[1].note).toBe(NOTE)
    expect(history[1].decision?.reason).toBe(NOTE)
    expect(history[0].changes).toContainEqual({ field: 'purpose', before: null, after: PURPOSE })
    expect(ok(await service.get(m('u-bob'), d.record.id)).record.fields).toMatchObject({ why: WHY, source: '鈴木一郎さんとの電話' })
  })

  it('erased content reads as erased everywhere and its text is gone; the record and its replay still work', async () => {
    const id = await cancelledTask()
    expect(ok(engine.atVersion(m('u-bob'), id, '1')).fields.purpose).toBe(PURPOSE)

    now = '2026-12-24T09:00:00.000Z'
    const r = erasure.eraseRecord('a', id, 'request')
    expect(r.erased.length).toBeGreaterThanOrEqual(3)
    const ERASED = '消去済み（2026-12-24）'

    const all = JSON.stringify(conn.prepare('SELECT * FROM record_contents').all()) + referenceTables()
    for (const text of [TITLE, PURPOSE, NOTE]) expect(all).not.toContain(text)

    const detail = ok(await service.get(m('u-bob'), id))
    expect(detail.record.title).toBe(ERASED)
    expect(detail.record.fields.purpose).toBe(ERASED)
    expect(detail.record.state).toBe('cancelled')
    expect(detail.record.fields.assignee).toBe('u-bob')
    const history = ok(engine.history(m('u-bob'), id)).entries
    expect(history[1].note).toBe(ERASED)
    const v1 = ok(engine.atVersion(m('u-bob'), id, '1'))
    expect(v1).toMatchObject({ state: 'todo', fields: { purpose: ERASED, assignee: 'u-bob' } })
    expect(ok(engine.atVersion(m('u-bob'), id, '2')).state).toBe('cancelled')
    // Erased stays erased: the same text written again for this record reads erased too.
    expect(ok(service.query(owner(), { text: '引っ越し' })).total).toBe(0)
    // Erasing again erases nothing more.
    expect(erasure.eraseRecord('a', id, 'request').erased).toEqual([])
  })

  it('content resolves only through its own record and company', async () => {
    const id = await cancelledTask()
    // Another company's handle: the record does not exist there.
    expect((await service.get(m('u-alice', 'b'), id)).ok).toBe(false)
    expect(ok(service.query(m('u-alice', 'b'), { text: '引っ越し' })).total).toBe(0)
    // A reference copied into another record (any company) resolves to nothing.
    const ref = (conn.prepare("SELECT title FROM records WHERE company_id = 'a' AND id = ?").get(id) as { title: string }).title
    conn.prepare("INSERT INTO records (company_id, id, type, title, created_at, updated_at) VALUES ('b', 'task-b000000001', 'task', ?, ?, ?)").run(ref, TS, TS)
    conn.prepare("INSERT INTO records (company_id, id, type, title, created_at, updated_at) VALUES ('a', 'task-a000000001', 'task', ?, ?, ?)").run(ref, TS, TS)
    expect(source.forCompany('b').records.find('task-b000000001')?.title).toBe('')
    expect(source.forCompany('a').records.find('task-a000000001')?.title).toBe('')
    // The eraser given another company erases nothing of this one.
    const ids = erasure.list('a', id).map(c => c.id)
    expect(erasure.eraseContents('b', ids, 'request').erased).toEqual([])
    expect(erasure.eraseRecord('b', id, 'request').erased).toEqual([])
    expect(ok(await service.get(m('u-bob'), id)).record.title).toBe(TITLE)
  })

  it('a record the member cannot read keeps its content unreadable; search finds titles only among readable, unerased records', async () => {
    const hidden = await cancelledTask('秘書室')
    const open = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '佐藤さんの引っ越し見積', summary: '見積の下書き' })).record.id
    expect(ok(service.query(m('u-alice'), { text: '引っ越し' })).records.map(r => r.id).sort()).toEqual([hidden, open].sort())
    expect(ok(service.query(m('u-mallory'), { text: '引っ越し' })).records.map(r => r.id)).toEqual([open])
    expect(ok(service.query(m('u-mallory'), { text: '山田花子', countOnly: true })).total).toBe(0)
    expect((await service.get(m('u-mallory'), hidden)).ok).toBe(false)
    expect(ok(service.query(m('u-alice'), { text: '下書き' })).records.map(r => r.id)).toEqual([open])
    // An erased title is not found any more.
    erasure.eraseRecord('a', open, 'request')
    expect(ok(service.query(m('u-alice'), { text: '佐藤' })).total).toBe(0)
  })

  it('an owner-only record’s content stays its owner’s: not found, searched or counted by anyone else, the company owner included', async () => {
    const id = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: TITLE, personal: true, fields: { purpose: PURPOSE } })).record.id
    expect(ok(await service.get(m('u-alice'), id)).record).toMatchObject({ title: TITLE, fields: { purpose: PURPOSE } })
    for (const who of [m('u-bob'), owner()]) {
      expect((await service.get(who, id)).ok).toBe(false)
      expect(ok(service.query(who, { text: '山田花子', countOnly: true })).total).toBe(0)
      expect(engine.history(who, id).ok).toBe(false)
    }
    expect(ok(service.query(m('u-alice'), { text: '山田花子' })).records.map(r => r.id)).toEqual([id])
  })

  it('an interaction summary expires after 3 years, and a copy of it with it', async () => {
    const SUMMARY = '田中様より、来月の訪問日程を変更したいとのご連絡がありました'
    const interaction = ok(engine.create(m('u-alice'), HUMAN, { type: 'interaction', title: '田中様からのメール', summary: SUMMARY })).record.id
    now = '2027-01-01T00:00:00.000Z'
    const task = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '訪問日程の調整', fields: { purpose: SUMMARY } })).record.id
    const other = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '別件の調整' })).record.id
    expect(erasure.list('a', interaction).every(c => c.retention === 'incoming_3y' && c.expiresAt === '2029-11-01T01:00:00.000Z')).toBe(true)

    now = '2029-10-31T00:00:00.000Z'
    expect(erasure.eraseExpired().erased).toEqual([])
    now = '2029-11-01T01:00:00.000Z'
    const erased = erasure.eraseExpired().erased
    expect(erased.every(e => e.companyId === 'a')).toBe(true)
    expect(ok(await service.get(m('u-alice'), interaction)).record.summary).toBe('消去済み（2029-11-01）')
    // The copy went with it; the task's own title (not a copy) stays.
    const t = ok(await service.get(m('u-alice'), task)).record
    expect(t.fields.purpose).toBe('消去済み（2029-11-01）')
    expect(t.title).toBe('訪問日程の調整')
    expect(ok(await service.get(m('u-alice'), other)).record.title).toBe('別件の調整')
  })

  it('older rows move into the store at startup, completely and once', async () => {
    // Rows as a build before the store wrote them (plain text), in a company not yet moved.
    conn.prepare("INSERT INTO records (company_id, id, type, title, summary, created_at, updated_at) VALUES ('a', 'task-old0000001', 'task', ?, '昔の要約', ?, ?)").run(TITLE, TS, TS)
    conn.prepare("INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES ('a', 'task-old0000001', 'cancelled', ?, 2, ?)")
      .run(JSON.stringify({ purpose: PURPOSE, assignee: 'u-bob' }), TS)
    const entry = (version: number, note: string, changes: unknown[], decision: unknown) => conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state,
      actor_id, actor_kind, at, note, changes, decision, is_decision) VALUES ('a', 'task-old0000001', ?, 'x', NULL, NULL, 'u-alice', 'human', ?, ?, ?, ?, ?)`)
      .run(version, TS, note, JSON.stringify(changes), decision ? JSON.stringify(decision) : null, decision ? 1 : 0)
    entry(1, '', [{ field: 'state', before: null, after: 'todo' }, { field: 'purpose', before: null, after: PURPOSE }], null)
    entry(2, NOTE, [{ field: 'state', before: 'todo', after: 'cancelled' }], { reason: NOTE, materials: [], policyVersion: null, precedents: [], supersedes: null })
    conn.prepare("UPDATE record_settings SET content_store = NULL WHERE company_id = 'a'").run()

    migrateRecordContents(conn)
    const raw = referenceTables()
    for (const text of [TITLE, PURPOSE, NOTE, '昔の要約']) expect(raw).not.toContain(text)
    const detail = ok(await service.get(m('u-alice'), 'task-old0000001'))
    expect(detail.record).toMatchObject({ title: TITLE, summary: '昔の要約', fields: { purpose: PURPOSE } })
    expect(ok(engine.history(m('u-alice'), 'task-old0000001')).entries[1]).toMatchObject({ note: NOTE, decision: { reason: NOTE } })

    // A second run (even when not marked done) changes nothing.
    conn.prepare("UPDATE record_settings SET content_store = NULL WHERE company_id = 'a'").run()
    const before = referenceTables() + JSON.stringify(conn.prepare('SELECT * FROM record_contents').all())
    migrateRecordContents(conn)
    expect(referenceTables() + JSON.stringify(conn.prepare('SELECT * FROM record_contents').all())).toBe(before)
  })

  it('content is never rewritten: only its text cleared, once', async () => {
    const id = await cancelledTask()
    const [c] = erasure.list('a', id)
    expect(() => conn.prepare("UPDATE record_contents SET text = 'changed' WHERE company_id = 'a' AND id = ?").run(c.id)).toThrow(/never rewritten/)
    erasure.eraseContents('a', [c.id], 'request')
    expect(() => conn.prepare("UPDATE record_contents SET erased_at = NULL, text = 'back' WHERE company_id = 'a' AND id = ?").run(c.id)).toThrow()
  })
})
