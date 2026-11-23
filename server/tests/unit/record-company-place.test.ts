/**
 * 全社 is a choice (records.md "全社 is a choice", owner decision 2026-11-23): the engine's side for a
 * person's create, what is made from a meeting, and the service writer.
 *
 * Guards (each mutation-checked):
 * - `place: 'company'` is the whole company; with a folder, owner-only or a list it is refused
 *   (`PLACE_CONFLICT`), any other value `BAD_PLACE`; with a members-only meeting it is not used to widen
 *   (`MEMBERS_WITH_PLACE`), and with a まとまり it must be within it (`WIDER_THAN_BUNDLE`);
 * - a person's create with nothing given: the whole company before the gate, 400 `PLACE_REQUIRED` with
 *   nothing written once `placeRequired` says so;
 * - a record made from a meeting placed in a department folder (made before members-only meetings) with no
 *   place of its own takes the meeting's folder — not the whole company — for a person and the AI; one
 *   from a company-wide meeting stays company-wide (also after the gate: inherited, not "nothing given");
 * - the service writer refuses a create that names no place (a caller typed loosely) and `folder: ''`
 *   (it would read as the company root); `folder: null` is the whole company, said on purpose.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type ActorInput, type RecordEngine, type ServiceCreateInput } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'

const TS = '2026-11-23T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let service: RecordService

const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-mallory']
const ROLES: Record<string, string> = { 'u-owner': 'owner' }
const m = (userId: string): Member => ({ companyId: 'a', userId, role: ROLES[userId] ?? 'member' })
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }
const HUMAN: ActorInput = { kind: 'human' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const deps = (extra: Record<string, unknown> = {}) => ({
  companyData: source,
  transactions: sqliteTransactions(conn),
  clock: { now: () => TS, nowMs: () => 0 },
  ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
  files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
  managedFolders: () => [],
  isMember: (_c: string, u: string) => PEOPLE.includes(u),
  roleOf: (_c: string, u: string) => (PEOPLE.includes(u) ? ROLES[u] ?? 'member' : null),
  notify: () => {},
  ...extra,
})
const engineWith = (extra: Record<string, unknown> = {}): RecordEngine => createRecordEngine(deps(extra))
const writer = () => createServiceRecordWriter(deps())

function rule(id: string, scope: string, type: 'everyone' | 'user', subject: string | null, read: 0 | 1) {
  conn.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, type, subject, read, read, TS)
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  service = createRecordService({ companyData: source, clock: { now: () => TS, nowMs: () => 0 }, indexer: { schedule: async () => {} } })
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('root', 'a', '', 'company', ?)").run(TS)
  rule('root-r', 'root', 'everyone', null, 1)
  // コンテンツ: a department u-mallory cannot read. 営業部: everyone.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('c', 'a', 'コンテンツ', 'folder', ?)").run(TS)
  rule('c-e', 'c', 'everyone', null, 1)
  rule('c-m', 'c', 'user', 'u-mallory', 0)
  const records = source.forCompany('a').records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
})

const seen = (who: string, id: string) => ok(service.query(m(who), { type: 'task' })).records.some(r => r.id === id)

/** A meeting the minutes intake made: in a folder (before members-only meetings), company-wide, or for a list. */
function meeting(place: { folder: string | null } | { members: string[] } | { personalOwner: string }): string {
  const made = writer().create('a', { type: 'meeting', title: '定例', fields: {}, actor: { id: 'u-alice', kind: 'human', source: null }, ...place } as ServiceCreateInput)
  if (!made.ok) throw new Error(made.reason)
  return made.record.id
}

describe('`place: company` on a person’s create', () => {
  it('is the whole company', () => {
    const made = ok(engineWith().create(m('u-alice'), HUMAN, { type: 'task', title: '全員へ', fields: { assignee: 'u-bob' }, place: 'company' }))
    expect(made.placed).toEqual({ personal: false, folder: null })
    expect(seen('u-mallory', made.record.id)).toBe(true)
  })

  it('never with another place, and only the one word', () => {
    const e = engineWith()
    expect(e.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', place: 'company', folder: 'コンテンツ' })).toMatchObject({ ok: false, body: { code: 'PLACE_CONFLICT' } })
    expect(e.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', place: 'company', personal: true })).toMatchObject({ ok: false, body: { code: 'PLACE_CONFLICT' } })
    expect(e.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', place: 'company', members: ['u-bob'] })).toMatchObject({ ok: false, body: { code: 'PLACE_CONFLICT' } })
    expect(e.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', place: '' })).toMatchObject({ ok: false, body: { code: 'BAD_PLACE' } })
    expect(ok(service.query(m('u-owner'), { type: 'task' })).records).toEqual([])
  })

  it('does not widen what a members-only meeting or a まとまり keeps narrower', () => {
    const e = engineWith()
    const listed = meeting({ members: ['u-alice', 'u-bob'] })
    expect(e.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', place: 'company', links: { meeting: listed } })).toMatchObject({ ok: false, body: { code: 'MEMBERS_WITH_PLACE' } })
    const bundle = ok(e.create(m('u-alice'), HUMAN, { type: 'project', title: '取り組み', folder: 'コンテンツ' })).record.id
    expect(e.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', place: 'company', links: { bundle } })).toMatchObject({ ok: false, body: { code: 'WIDER_THAN_BUNDLE' } })
    // Nothing given still takes the まとまり's place.
    expect(ok(e.create(m('u-alice'), HUMAN, { type: 'task', title: 'y', fields: { assignee: 'u-bob' }, links: { bundle } })).placed).toEqual({ personal: false, folder: 'コンテンツ' })
  })
})

describe('a person’s create with nothing given', () => {
  it('the whole company before the gate; refused with nothing written after it', () => {
    const body = { type: 'task', title: '棚卸し', fields: { assignee: 'u-bob' } }
    expect(ok(engineWith().create(m('u-alice'), HUMAN, body)).placed).toEqual({ personal: false, folder: null })
    const r = engineWith({ placeRequired: () => true }).create(m('u-alice'), HUMAN, { ...body, title: '二つ目' })
    expect(r).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'PLACE_REQUIRED' } })
    expect(ok(service.query(m('u-owner'), { type: 'task' })).records.map(x => x.title)).toEqual(['棚卸し'])
  })

  it('what it inherits is not "nothing given": a まとまり’s place passes the gate', () => {
    const e = engineWith({ placeRequired: () => true })
    const bundle = ok(e.create(m('u-alice'), HUMAN, { type: 'project', title: '全社の取り組み', place: 'company' })).record.id
    expect(ok(e.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', fields: { assignee: 'u-bob' }, links: { bundle } })).placed).toEqual({ personal: false, folder: null })
  })
})

describe('made from a meeting placed by a folder (before members-only meetings)', () => {
  it('a person’s task with no place takes the meeting’s department, not the whole company', () => {
    const old = meeting({ folder: 'コンテンツ' })
    const made = ok(engineWith().create(m('u-alice'), HUMAN, { type: 'task', title: '宿題', fields: { assignee: 'u-bob' }, links: { meeting: old } }))
    expect(made.placed).toEqual({ personal: false, folder: 'コンテンツ' })
    expect(seen('u-bob', made.record.id)).toBe(true)
    expect(seen('u-mallory', made.record.id)).toBe(false)
  })

  it('the AI’s meeting output too (its placement defaults leave meeting outputs alone)', () => {
    const old = meeting({ folder: 'コンテンツ' })
    const made = ok(engineWith().createByAi(m('u-alice'), AI, { type: 'task', title: '宿題', fields: { assignee: 'u-bob' }, links: { meeting: old } }))
    expect(made.placed).toEqual({ personal: false, folder: 'コンテンツ' })
    expect(seen('u-mallory', made.record.id)).toBe(false)
  })

  it('an owner-only meeting gives no place: after the gate its task must say one (never company-wide by inheritance)', () => {
    const mine = meeting({ personalOwner: 'u-alice' })
    const r = engineWith({ placeRequired: () => true }).create(m('u-alice'), HUMAN, { type: 'task', title: 'x', fields: { assignee: 'u-alice' }, links: { meeting: mine } })
    expect(r).toMatchObject({ ok: false, body: { code: 'PLACE_REQUIRED' } })
  })

  it('a company-wide meeting’s task stays company-wide (inherited, also after the gate)', () => {
    const e = engineWith({ placeRequired: () => true })
    const wide = meeting({ folder: null })
    expect(ok(e.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', fields: { assignee: 'u-bob' }, links: { meeting: wide } })).placed).toEqual({ personal: false, folder: null })
  })
})

describe('the service writer always says where', () => {
  const base = { type: 'meeting', title: '定例', fields: {}, actor: { id: 'u-alice', kind: 'human' as const, source: null } }
  it('no place (a caller typed loosely) and an empty folder are refused; null is the whole company', () => {
    expect(writer().create('a', base as unknown as ServiceCreateInput)).toEqual({ ok: false, reason: 'bad-place' })
    expect(writer().check('a', base as unknown as ServiceCreateInput)).toEqual({ ok: false, reason: 'bad-place' })
    expect(writer().create('a', { ...base, folder: '' })).toEqual({ ok: false, reason: 'bad-place' })
    expect(writer().create('a', { ...base, folder: '/' })).toEqual({ ok: false, reason: 'bad-place' })
    const made = writer().create('a', { ...base, folder: null })
    expect(made.ok).toBe(true)
  })
})
