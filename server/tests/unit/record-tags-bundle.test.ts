/**
 * Tags (kind `tags`) and links to an interface (`interface: bundle`) through
 * the state engine and the company map's query (records.md "Tags" /
 * "Links to an interface", stage 2 S1).
 *
 * Guards:
 * - a bad tags value is refused and nothing is written; a good one is
 *   stored normalized (NFC, spaces, no repeats);
 * - `{ contains: tag }` returns and counts only records the member may read,
 *   never another company's, and never searches a non-tags field of the
 *   same name; equality on a tags field is refused;
 * - a link to an interface holds only a record the creator reads whose type
 *   implements it — a record of another type, an unreadable one, another
 *   company's and a missing one get the same answer.
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
let tick = 0
const at = () => `2026-11-01T00:00:${String(tick++ % 60).padStart(2, '0')}.000Z`

const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-mallory']
const m = (userId: string, co = 'a', role = 'member'): Member => ({ companyId: co, userId, role })
const HUMAN: ActorInput = { kind: 'human' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

/** A bundle (implements `bundle`). */
const EFFORT = `---
label: 取り組み
version: 1
storage: server
implements: [bundle]
fields:
  owner:   { label: 持ち主, kind: person, source: server }
  purpose: { label: 目的, kind: text, source: server }
states: [active, done]
final: [done]
---
`

/** Something with tags and a link to whatever bundle it belongs to. */
const NOTE = `---
label: メモ
version: 1
storage: server
fields:
  tags: { label: タグ, kind: tags, source: server }
links:
  bundle: { label: まとまり, interface: bundle, cardinality: one }
states: [open]
---
`

/** Another type whose field `tags` is plain text that looks like a list. */
const PLAIN = `---
label: ふつう
version: 1
storage: server
fields:
  tags: { label: 文字, kind: text, source: server }
states: [open]
---
`

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 経理: a folder u-mallory cannot read (scope rules).
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '経理', 'folder', ?)").run(`${id}-acc`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-acc-e`, `${id}-acc`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-mallory', 0, 0, ?)").run(`${id}-acc-m`, `${id}-acc`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  sqliteTransactions(conn).run(() => applyRecordChanges(records, {
    repoKey: 'company', scopeId: null, prefix: '', full: false, tip: 'a'.repeat(40), at: at(), scopes: source.forCompany(id).scopes.listWithRules(),
    changes: [{ path: '.acb/types/effort.md', text: EFFORT }, { path: '.acb/types/note.md', text: NOTE }, { path: '.acb/types/plain.md', text: PLAIN }],
  }))
}

const create = (member: Member, body: Record<string, unknown>) => engine.create(member, HUMAN, { title: 'メモ', ...body })
const note = (tags: unknown, extra: Record<string, unknown> = {}, member = m('u-alice')) => create(member, { type: 'note', fields: { tags }, ...extra })
const query = (member: Member, body: Record<string, unknown>) => service.query(member, body)

beforeEach(() => {
  tick = 0
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
    notify: () => {},
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  company('a')
  company('b')
  expect(source.forCompany('a').records.problems(100)).toEqual([])
})

describe('tags', () => {
  it('a bad tags value is refused and nothing is written', () => {
    const before = source.forCompany('a').records.candidates({}, 1000).length
    for (const bad of ['急ぎ', [''], ['a\u0007'], ['x'.repeat(41)], Array.from({ length: 21 }, (_, i) => `t${i}`), [1]]) {
      expect(note(bad), JSON.stringify(bad)).toMatchObject({ ok: false, body: { code: 'BAD_VALUE' } })
    }
    expect(source.forCompany('a').records.candidates({}, 1000)).toHaveLength(before)
  })

  it('a good value is stored normalized: NFC, one space, no repeats', () => {
    const r = ok(note([' がくせい  向け ', 'がくせい 向け', '急ぎ'])).record
    expect(r.fields.tags).toBe(JSON.stringify(['がくせい 向け', '急ぎ']))
    const found = ok(query(m('u-bob'), { type: 'note', fields: { tags: { contains: 'がくせい 向け' } } }))
    expect(found.records.map(x => x.id)).toEqual([r.id])
  })

  it('contains returns and counts only records the member may read', () => {
    const open = ok(note(['急ぎ'])).record
    const closed = ok(note(['急ぎ'], { folder: '経理' })).record
    ok(note(['ほか']))
    const ask = (who: Member, extra: Record<string, unknown> = {}) => ok(query(who, { fields: { tags: { contains: '急ぎ' } }, ...extra }))
    expect(ask(m('u-bob')).records.map(r => r.id).sort()).toEqual([open.id, closed.id].sort())
    expect(ask(m('u-mallory'))).toEqual({ total: 1, records: [expect.objectContaining({ id: open.id })] })
    expect(ask(m('u-mallory'), { countOnly: true }).total).toBe(1)
    expect(ask(m('u-mallory'), { type: 'note', countOnly: true }).total).toBe(1)
  })

  it('never another company’s records', () => {
    ok(note(['急ぎ'], {}, m('u-alice', 'b')))
    expect(ok(query(m('u-alice', 'a'), { fields: { tags: { contains: '急ぎ' } } }))).toEqual({ total: 0, records: [] })
    expect(ok(query(m('u-alice', 'b'), { fields: { tags: { contains: '急ぎ' } } })).total).toBe(1)
  })

  it('never searches a field of the same name that is not tags; equality on tags is refused', () => {
    ok(create(m('u-alice'), { type: 'plain', fields: { tags: '["急ぎ"]' } }))
    expect(ok(query(m('u-alice'), { fields: { tags: { contains: '急ぎ' } } })).total).toBe(0)
    expect(query(m('u-alice'), { type: 'plain', fields: { tags: { contains: '急ぎ' } } })).toMatchObject({ ok: false })
    expect(query(m('u-alice'), { type: 'note', fields: { tags: '["急ぎ"]' } })).toMatchObject({ ok: false })
    expect(query(m('u-alice'), { fields: { tags: { contains: '' } } })).toMatchObject({ ok: false })
    expect(query(m('u-alice'), { fields: { tags: { contains: '急ぎ', in: ['x'] } } })).toMatchObject({ ok: false })
  })
})

describe('a link to an interface', () => {
  const effort = (member = m('u-alice'), extra: Record<string, unknown> = {}) =>
    ok(create(member, { type: 'effort', title: '新しい講座', fields: { owner: member.userId, purpose: '春の募集' }, ...extra })).record

  it('holds a record whose type implements it', async () => {
    const e = effort()
    const n = ok(note(['急ぎ'], { links: { bundle: e.id } })).record
    const detail = ok(await service.get(m('u-bob'), n.id))
    expect(detail.links).toEqual([expect.objectContaining({ name: 'bundle', direction: 'out', record: expect.objectContaining({ id: e.id }) })])
    // Every type implementing it is found by the interface.
    expect(ok(query(m('u-bob'), { implements: 'bundle' })).records.map(r => r.id)).toEqual([e.id])
  })

  it('refuses another type, an unreadable bundle, another company’s and a missing one with the same answer', () => {
    const other = ok(note(['x'])).record
    const closed = effort(m('u-alice'), { folder: '経理' })
    const foreign = effort(m('u-alice', 'b'))
    // Someone else's owner-only bundle (records.md "Owner-only records"): unseen, so the same answer — for an owner too.
    const personal = effort(m('u-alice'), { personal: true })
    const answers = [other.id, closed.id, foreign.id, personal.id, 'effort-0000000000000000'].map(id => note(['y'], { links: { bundle: id } }, m('u-mallory')))
    for (const a of answers) expect(a).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
    expect(new Set(answers.map(a => JSON.stringify(a)))).toHaveProperty('size', 1)
    expect(note(['y'], { links: { bundle: personal.id } }, m('u-owner', 'a', 'owner'))).toEqual(answers[0])
    // The member who reads the closed bundle may link it.
    expect(note(['y'], { links: { bundle: closed.id } }, m('u-bob')).ok).toBe(true)
  })
})
