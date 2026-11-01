/**
 * Linking a file to a record after it was made, and the task's due with an
 * optional time (services/record-engine.ts `fileLink`, records.md "Linking
 * files later" / "Due with a time").
 *
 * Guards:
 * - a link (and its removal) is a ledger entry with the link's targets before
 *   and after, recorded as the credential's actor, and can be undone;
 * - only a file the member reads, never into a private folder from a record
 *   outside it — one refusal for both, naming no place; nothing is written;
 * - the member's AI only on types that let the AI act at all;
 * - another company's record is a record that does not exist;
 * - a due may carry a time of day (date-only stays valid, both sort as text);
 *   pushing it back tells the requester when someone else does it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { applyRecordChanges, ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type ActorInput, type RecordEngine } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'

const TS = '2026-10-31T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let notified: Array<[string, string[]]>
let tick = 0
const at = () => `2026-11-01T00:00:${String(tick++ % 60).padStart(2, '0')}.000Z`

const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-carol', 'u-mallory']
const m = (userId: string, co = 'a', role = 'member'): Member => ({ companyId: co, userId, role })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
}

/** A task requested by alice, assigned to bob. */
const newTask = (co = 'a', extra: Record<string, unknown> = {}) =>
  ok(engine.create(m('u-alice', co), HUMAN, { type: 'task', title: '提案書を作る', fields: { assignee: 'u-bob' }, ...extra })).record

const link = (member: Member, id: string, body: Record<string, unknown>, actor = HUMAN) => engine.fileLink(member, actor, id, 'link', body)
const unlink = (member: Member, id: string, body: Record<string, unknown>, actor = HUMAN) => engine.fileLink(member, actor, id, 'unlink', body)
const filesOf = async (member: Member, id: string) =>
  ok(await service.get(member, id)).links.filter(l => l.path !== undefined).map(l => l.path)

beforeEach(() => {
  tick = 0
  notified = []
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: at, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null),
    notify: (companyId, userIds) => notified.push([companyId, userIds]),
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  company('a')
  company('b')
})

describe('linking a file to a record later', () => {
  it('is a ledger entry with the targets before and after, by the credential’s actor, and can be undone', async () => {
    const t = newTask('a', { links: { files: ['営業部/見積.md'] } })
    const r = ok(link(m('u-carol'), t.id, { path: '営業部/提案書/計画.md', expectedVersion: 1 }))
    expect(r.changed).toBe(true)
    expect(r.record.version).toBe(2)
    expect(r.entry).toMatchObject({
      action: 'link_file', version: 2, actorId: 'u-carol', actorKind: 'human', fromState: 'todo', toState: 'todo',
      changes: [{ field: 'links.files', before: JSON.stringify(['営業部/見積.md']), after: JSON.stringify(['営業部/見積.md', '営業部/提案書/計画.md']) }],
    })
    expect(await filesOf(m('u-bob'), t.id)).toEqual(['営業部/見積.md', '営業部/提案書/計画.md'])
    // The server fields are untouched (no `links.*` key slips into them).
    expect(r.record.fields).toEqual(t.fields)

    // Already linked: nothing written.
    expect(ok(link(m('u-carol'), t.id, { path: '営業部/提案書/計画.md', expectedVersion: 2 }))).toMatchObject({ changed: false, entry: null })
    expect(source.forCompany('a').records.ledger(t.id)).toHaveLength(2)

    // The AI (record token) on a task: recorded as ai, with its conversation.
    const byAi = ok(link(m('u-bob'), t.id, { path: '営業部/メモ.md', expectedVersion: 2 }, AI))
    expect(byAi.entry).toMatchObject({ actorKind: 'ai', actorSource: 'claude-code', conversationId: 'conv-1' })

    // Undo: the link goes away again, and the record's fields stay as they were.
    const undone = ok(engine.undo(m('u-bob'), HUMAN, t.id, { version: 3, expectedVersion: 3 }))
    expect(undone.entry.changes).toEqual([{ field: 'links.files', before: byAi.entry!.changes[0].after, after: byAi.entry!.changes[0].before }])
    expect(await filesOf(m('u-bob'), t.id)).toEqual(['営業部/見積.md', '営業部/提案書/計画.md'])
    expect(JSON.parse(source.forCompany('a').records.states([t.id])[0].fields)).toEqual(t.fields)

    // Removing: an entry too; an undo of the earlier link is refused once the targets changed since.
    ok(unlink(m('u-alice'), t.id, { path: '営業部/見積.md', expectedVersion: 4 }))
    expect(await filesOf(m('u-bob'), t.id)).toEqual(['営業部/提案書/計画.md'])
    expect(engine.undo(m('u-owner', 'a', 'owner'), HUMAN, t.id, { version: 2, expectedVersion: 5 })).toMatchObject({ ok: false, body: { code: 'CHANGED_SINCE' } })
    expect(unlink(m('u-alice'), t.id, { path: '営業部/見積.md', expectedVersion: 5 })).toMatchObject({ ok: false, body: { code: 'LINK_NOT_FOUND' } })
  })

  it('a stale version changes nothing', () => {
    const t = newTask()
    expect(link(m('u-bob'), t.id, { path: '営業部/a.md', expectedVersion: 0 })).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT', version: 1 } })
    expect(source.forCompany('a').records.linksFrom([t.id])).toEqual([])
  })

  it('refuses a file the member cannot read and one inside a private folder alike, naming no place', async () => {
    // 営業部/評価: a private folder u-carol reads; 経理: closed to u-mallory by scope rules.
    conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('a-priv', 'a', '営業部/評価', 'folder', 'a-repo', ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-priv-e', 'a-priv', 'everyone', NULL, 0, 0, ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-priv-c', 'a-priv', 'user', 'u-carol', 1, 1, ?)").run(TS)
    conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-acc', 'a', '経理', 'folder', ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-acc-e', 'a-acc', 'everyone', NULL, 1, 1, ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-acc-m', 'a-acc', 'user', 'u-mallory', 0, 0, ?)").run(TS)
    const t = newTask()

    const unreadable = link(m('u-mallory'), t.id, { path: '経理/給与.md', expectedVersion: 1 })
    // u-carol reads the private folder, but the task is outside it: its readers must not reach it.
    const intoPrivate = link(m('u-carol'), t.id, { path: '営業部/評価/山田.md', expectedVersion: 1 })
    const outsiderProbe = link(m('u-bob'), t.id, { path: '営業部/評価/山田.md', expectedVersion: 1 })
    expect(unreadable).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'FILE_NOT_LINKABLE' } })
    expect(intoPrivate).toEqual(unreadable)
    expect(outsiderProbe).toEqual(unreadable)
    expect(JSON.stringify([unreadable, intoPrivate])).not.toMatch(/評価|経理|営業部/)
    expect(source.forCompany('a').records.ledger(t.id)).toHaveLength(1)
    expect(source.forCompany('a').records.linksFrom([t.id])).toEqual([])

    // The same rule when the task is made with its files.
    expect(engine.create(m('u-carol'), HUMAN, { type: 'task', title: 'x', links: { files: ['営業部/評価/山田.md'] } }))
      .toMatchObject({ ok: false, body: { code: 'FILE_NOT_LINKABLE' } })
    expect(engine.create(m('u-mallory'), HUMAN, { type: 'task', title: 'x', links: { files: ['経理/給与.md'] } }))
      .toMatchObject({ ok: false, body: { code: 'FILE_NOT_LINKABLE' } })
  })

  it('the AI only on types that let the AI act; a type without a file link has nothing to link', () => {
    const memo = `---\nlabel: 覚え書き\nversion: 1\nstorage: server\nlinks:\n  files: { label: ファイル, target: file, cardinality: many }\nstates: [open, closed]\ninitial: open\nactions:\n  close: { label: 閉じる, from: [open], to: closed, who: [anyone] }\n---\n`
    sqliteTransactions(conn).run(() => applyRecordChanges(source.forCompany('a').records, {
      repoKey: 'company', scopeId: null, prefix: '', full: false, tip: 'a'.repeat(40), at: at(), scopes: [], changes: [{ path: '.acb/types/memo.md', text: memo }],
    }))
    const note = ok(engine.create(m('u-bob'), HUMAN, { type: 'memo', title: '覚え書き' })).record
    expect(link(m('u-bob'), note.id, { path: '営業部/a.md', expectedVersion: 1 }, AI)).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'NOT_ALLOWED' } })
    expect(ok(link(m('u-bob'), note.id, { path: '営業部/a.md', expectedVersion: 1 })).changed).toBe(true)

    const contact = ok(engine.create(m('u-bob'), HUMAN, { type: 'interaction', title: '電話' })).record
    expect(link(m('u-bob'), contact.id, { path: '営業部/a.md', expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NO_FILE_LINK' } })
  })

  it('another company’s record is a record that does not exist', () => {
    const theirs = newTask('b')
    const missing = link(m('u-bob', 'a'), 'task-zzzzzzzz', { path: '営業部/a.md', expectedVersion: 1 })
    expect(link(m('u-bob', 'a'), theirs.id, { path: '営業部/a.md', expectedVersion: 1 })).toEqual(missing)
    expect(unlink(m('u-owner', 'a', 'owner'), theirs.id, { path: '営業部/a.md', expectedVersion: 1 })).toEqual(unlink(m('u-owner', 'a', 'owner'), 'task-zzzzzzzz', { path: '営業部/a.md', expectedVersion: 1 }))
    expect(source.forCompany('b').records.ledger(theirs.id)).toHaveLength(1)
    expect(source.forCompany('b').records.linksFrom([theirs.id])).toEqual([])
  })
})

describe('the due: a day, or a day and time; pushing it back', () => {
  it('takes a time of day, keeps date-only values, refuses what is not a day or time', async () => {
    const t = newTask('a', { fields: { assignee: 'u-bob', due: '2026-11-05' } })
    const r = ok(await engine.act(m('u-bob'), HUMAN, t.id, 'set_due', { expectedVersion: 1, args: { due: '2026-11-05T15:00' }, note: '先方の都合' }))
    expect(r.entry.changes).toEqual([{ field: 'due', before: '2026-11-05', after: '2026-11-05T15:00' }])
    for (const bad of ['2026-11-05T24:00', '2026-02-30', '2026-11-05 15:00', '2026-11-05T15:00Z', '11/05']) {
      expect(await engine.act(m('u-bob'), HUMAN, t.id, 'set_due', { expectedVersion: 2, args: { due: bad } })).toMatchObject({ ok: false, body: { code: 'BAD_VALUE' } })
    }
    // A day sorts before its own times and after the day before's.
    expect(['2026-11-06', '2026-11-05T15:00', '2026-11-05', '2026-11-04T23:59'].sort()).toEqual(['2026-11-04T23:59', '2026-11-05', '2026-11-05T15:00', '2026-11-06'])
  })

  it('pushing it back tells the requester when someone else does it, and keeps the earlier value', async () => {
    const t = newTask('a', { fields: { assignee: 'u-bob', due: '2026-11-05' } })
    notified = []
    const r = ok(await engine.act(m('u-bob'), AI, t.id, 'set_due', { expectedVersion: 1, args: { due: '2026-11-12T10:00' } }))
    expect(r.entry).toMatchObject({ actorKind: 'ai', changes: [{ field: 'due', before: '2026-11-05', after: '2026-11-12T10:00' }] })
    expect(notified.flatMap(([, to]) => to)).toContain('u-alice')
    notified = []
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'set_due', { expectedVersion: 2, args: { due: '2026-11-19' } }))
    expect(notified.flatMap(([, to]) => to)).not.toContain('u-alice')
  })
})
