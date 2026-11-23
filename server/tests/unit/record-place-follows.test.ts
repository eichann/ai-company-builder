/**
 * A record that follows its parent's 見える範囲 (records.md "Following the parent's 見える範囲", owner
 * decision 2026-11-23, step 2b): the engine reads a type's `place_follows` instead of a hard-coded list,
 * so a business plugin's 収録 follows its 番組 with no core change. Invariant: a record of a type
 * declaring `place_follows: L` is never readable by someone who cannot read the record linked through L.
 *
 * Here 番組 (`program`) is a company's own type (it may be owner-only or members-only), 収録 (`recording`)
 * a business plugin's type following it through a link to a type (not the `bundle` interface), and
 * 切り抜き (`clip`) a company's own type following it too (it may be owner-only / members-only).
 *
 * Guards (each mutation-checked):
 * - made with its parent and no place: the parent's place (a folder; owner-only / members-only for a
 *   type that may be, else 400 `PLACE_NOT_FOR_TYPE`); a place given that is wider → `WIDER_THAN_BUNDLE`
 *   in the words of a record (not a やること);
 * - an unreadable, missing or other-kind parent → the one `BAD_LINK`, before any place check;
 * - linking the parent later (record-links, an action's link) → refused when wider; narrowing on request,
 *   never to owner-only for a plugin's type;
 * - 「部署に出す」 / 「招待する」 never make it wider than its parent;
 * - the AI making a plugin's follower without a parent: the screen's department, else refused;
 * - an import (the external writer) never links a parent its record is wider than (the link is left out,
 *   a problem says so); the service writer refuses a wider place (`bad-place`);
 * - a core type keeps its declaration (task → bundle) even when the definition in force lacks it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import {
  createExternalRecordWriter, createRecordEngine, createServiceRecordWriter, type ActorInput, type ExternalRecordInput, type RecordEngine,
} from '../../src/services/record-engine'
import { followLinkName } from '../../src/services/record-engine/bundle-place'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'
import { canonicalTypeJson, parseTypeFile } from '../../shared/core/record-types'
import { coreTypeDefinitions } from '../../shared/core/core-types'

const TS = '2026-11-23T00:00:00.000Z'
const CO = 'a'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService

// 秘書室: everyone but u-carol reads it.
const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-carol']
const ROLES: Record<string, string> = { 'u-owner': 'owner' }
const m = (userId: string): Member => ({ companyId: CO, userId, role: ROLES[userId] ?? 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }
const isMember = (_c: string, u: string) => PEOPLE.includes(u)
const roleOf = (_c: string, u: string) => (PEOPLE.includes(u) ? ROLES[u] ?? 'member' : null)

const PROGRAM = '---\nlabel: 番組\nversion: 1\nstorage: server\nstates: [active]\n---\n'
const RECORDING = `---
label: 収録
version: 1
storage: server
links:
  program: { label: 番組, target: program, cardinality: one, inverse: recordings }
states: [planned]
place_follows: program
actions:
  set_program: { label: 番組を決める, who: [anyone], links: [program] }
---
`
const CLIP = RECORDING.replace('label: 収録', 'label: 切り抜き').replace('inverse: recordings', 'inverse: clips')
/** A company's own まとまり that follows its 番組 (a 企画 of a programme). */
const SERIES = `---
label: 企画
version: 1
storage: server
implements: [bundle]
fields:
  owner: { label: 責任者, kind: person, source: server }
  purpose: { label: 目的, kind: text, source: server }
links:
  program: { label: 番組, target: program, cardinality: one, inverse: series }
states: [active, done]
final: [done]
place_follows: program
---
`
/** A business plugin's request that follows its 番組 (出演の依頼). */
const BOOKING = `---
label: 出演の依頼
version: 1
storage: server
implements: [request]
fields:
  requested_by: { label: 頼んだ人, kind: person, source: server }
  assignee: { label: 担当, kind: person, source: server }
  next_actor: { label: 次に動く人, kind: person, source: server }
  waiting_on: { label: 待っているもの, kind: text, source: server }
  due: { label: 期限, kind: date, source: server }
links:
  program: { label: 番組, target: program, cardinality: one, inverse: bookings }
states: [open]
place_follows: program
---
`

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const body = (r: { ok: boolean; body?: unknown }) => (r.ok ? null : r.body as { code?: string; error?: string })
const code = (r: { ok: boolean; body?: unknown }) => (r.ok ? 'ok' : body(r)?.code)

function store(name: string, text: string, from: 'plugin' | 'file') {
  const parsed = parseTypeFile(name, text)
  if (!parsed.ok) throw new Error(parsed.errors.join())
  source.forCompany(CO).records.insertTypeVersion({ name, version: 1, definition: canonicalTypeJson(parsed.definition), source: from, commitSha: null, createdAt: TS })
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let tick = 0
  const clock = { now: () => `2026-11-23T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember,
    roleOf,
    notify: () => {},
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', TS, TS)
  const rule = (id: string, scope: string, type: 'everyone' | 'user', subject: string | null, read: 0 | 1) =>
    conn.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, type, subject, read, read, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('root', ?, '', 'company', ?)").run(CO, TS)
  rule('root-r', 'root', 'everyone', null, 1)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('sec', ?, '秘書室', 'folder', ?)").run(CO, TS)
  rule('sec-e', 'sec', 'everyone', null, 1)
  rule('sec-c', 'sec', 'user', 'u-carol', 0)
  const records = source.forCompany(CO).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  store('program', PROGRAM, 'file')
  store('recording', RECORDING, 'plugin')
  store('clip', CLIP, 'file')
  store('series', SERIES, 'file')
  store('booking', BOOKING, 'plugin')
})

const program = (place: Record<string, unknown>, who = 'u-alice') => ok(engine.create(m(who), HUMAN, { type: 'program', title: '朝の番組', ...place })).record
const placeOf = (id: string) => {
  const r = source.forCompany(CO).records.byIds([id])[0]
  return { folder: r.folder, personalOwner: r.personalOwner, members: r.members }
}
const reads = async (who: string, id: string) => (await service.get(m(who), id)).ok

describe('made with its parent', () => {
  it('no place given: the parent’s folder — someone who cannot read the parent cannot read it', async () => {
    const p = program({ folder: '秘書室' })
    const r = ok(engine.create(m('u-alice'), HUMAN, { type: 'recording', title: '第1回', links: { program: p.id } }))
    expect(r.placed).toEqual({ personal: false, folder: '秘書室' })
    expect(await reads('u-bob', r.record.id)).toBe(true)
    expect(await reads('u-carol', r.record.id)).toBe(false)
  })

  it('a place given that is wider than the parent is refused in a record’s words; one within is kept', () => {
    const p = program({ folder: '秘書室' })
    for (const place of [{ place: 'company' }, { folder: '営業部' }]) {
      const r = engine.create(m('u-alice'), HUMAN, { type: 'recording', title: '第1回', links: { program: p.id }, ...place })
      expect(code(r)).toBe('WIDER_THAN_BUNDLE')
      expect(body(r)?.error).toMatch(/^この記録は/)
    }
    const wide = program({ place: 'company' })
    expect(ok(engine.create(m('u-alice'), HUMAN, { type: 'recording', title: '第2回', links: { program: wide.id }, folder: '秘書室' })).placed?.folder).toBe('秘書室')
  })

  it('an owner-only parent: a type that may be owner-only follows it; a business plugin’s type is refused', async () => {
    const p = program({ personal: true })
    const clip = ok(engine.create(m('u-alice'), HUMAN, { type: 'clip', title: '切り抜き', links: { program: p.id } }))
    expect(placeOf(clip.record.id).personalOwner).toBe('u-alice')
    expect(await reads('u-owner', clip.record.id)).toBe(false)
    const r = engine.create(m('u-alice'), HUMAN, { type: 'recording', title: '第1回', links: { program: p.id } })
    expect(code(r)).toBe('PLACE_NOT_FOR_TYPE')
    expect(JSON.stringify(body(r))).not.toContain('朝の番組')
    expect((conn.prepare("SELECT COUNT(*) AS n FROM records WHERE type = 'recording'").get() as { n: number }).n).toBe(0)
  })

  it('a members-only parent: its list (meeting first, then the parent); a business plugin’s type is refused', async () => {
    const p = program({ members: ['u-bob'] })
    const clip = ok(engine.create(m('u-alice'), HUMAN, { type: 'clip', title: '切り抜き', links: { program: p.id } }))
    expect([...(placeOf(clip.record.id).members ?? [])].sort()).toEqual(['u-alice', 'u-bob'])
    expect(await reads('u-bob', clip.record.id)).toBe(true)
    expect(await reads('u-carol', clip.record.id)).toBe(false)
    expect(code(engine.create(m('u-alice'), HUMAN, { type: 'recording', title: '第1回', links: { program: p.id } }))).toBe('PLACE_NOT_FOR_TYPE')
  })

  it('a parent the creator cannot read, a missing one and one of another kind get the one BAD_LINK, naming nothing', () => {
    const hidden = program({ folder: '秘書室' })
    const other = ok(engine.create(m('u-carol'), HUMAN, { type: 'clip', title: '別のもの', place: 'company' })).record
    const answers = [hidden.id, 'program-0000000000000000', other.id].map(id => body(engine.create(m('u-carol'), HUMAN, { type: 'recording', title: '第1回', links: { program: id } })))
    expect(answers.map(a => a?.code)).toEqual(['BAD_LINK', 'BAD_LINK', 'BAD_LINK'])
    expect(new Set(answers.map(a => JSON.stringify(a))).size).toBe(1)
  })
})

describe('linked to its parent later', () => {
  it('a wider record is refused (record-links and an action’s link); narrowing on request takes the parent’s folder', async () => {
    const p = program({ folder: '秘書室' })
    const r = ok(engine.create(m('u-alice'), HUMAN, { type: 'recording', title: '第1回', place: 'company' })).record
    const linked = engine.recordLink(m('u-alice'), HUMAN, r.id, 'link', { link: 'program', target: p.id, expectedVersion: 1 })
    expect(code(linked)).toBe('WIDER_THAN_BUNDLE')
    expect(code(await engine.act(m('u-alice'), HUMAN, r.id, 'set_program', { expectedVersion: 1, links: { program: p.id } }))).toBe('WIDER_THAN_BUNDLE')
    expect(source.forCompany(CO).records.linksFrom([r.id])).toHaveLength(0)
    ok(engine.recordLink(m('u-alice'), HUMAN, r.id, 'link', { link: 'program', target: p.id, expectedVersion: 1, narrow: true }))
    expect(placeOf(r.id).folder).toBe('秘書室')
    expect(await reads('u-carol', r.id)).toBe(false)
  })

  it('a business plugin’s record is never narrowed to owner-only', () => {
    const p = program({ personal: true })
    const r = ok(engine.create(m('u-alice'), HUMAN, { type: 'recording', title: '第1回', place: 'company' })).record
    expect(code(engine.recordLink(m('u-alice'), HUMAN, r.id, 'link', { link: 'program', target: p.id, expectedVersion: 1, narrow: true }))).toBe('PLACE_NOT_FOR_TYPE')
    expect(placeOf(r.id).personalOwner).toBeNull()
  })
})

describe('「部署に出す」 and 「招待する」 keep it within its parent', () => {
  it('sharing an owner-only follower to a wider folder is refused; to the parent’s folder it is shared', () => {
    const p = program({ folder: '秘書室' })
    const c = ok(engine.create(m('u-alice'), HUMAN, { type: 'clip', title: '切り抜き', personal: true, links: { program: p.id } })).record
    const r = engine.share(m('u-alice'), HUMAN, c.id, { folder: '営業部', expectedVersion: 1 })
    expect(code(r)).toBe('WIDER_THAN_BUNDLE')
    expect(body(r)?.error).toContain('この記録')
    expect(placeOf(c.id).personalOwner).toBe('u-alice')
    ok(engine.share(m('u-alice'), HUMAN, c.id, { folder: '秘書室', expectedVersion: 1 }))
  })

  it('inviting someone who cannot read the parent to a members-only follower is refused', () => {
    const p = program({ members: ['u-bob'] })
    const c = ok(engine.create(m('u-alice'), HUMAN, { type: 'clip', title: '切り抜き', links: { program: p.id } })).record
    expect(code(engine.invite(m('u-alice'), HUMAN, c.id, { add: ['u-carol'], expectedVersion: 1 }))).toBe('WIDER_THAN_BUNDLE')
    expect(placeOf(c.id).members).not.toContain('u-carol')
  })
})

describe('the AI making a business plugin’s follower without its parent', () => {
  it('the department on screen, else refused (never the whole company), whatever the gate', () => {
    const onScreen = ok(engine.createByAi(m('u-alice'), AI, { type: 'recording', title: '第1回', defaultFolder: '営業部' }))
    expect(onScreen.placed).toEqual({ personal: false, folder: '営業部' })
    expect(code(engine.createByAi(m('u-alice'), AI, { type: 'recording', title: '第2回' }))).toBe('PLACE_REQUIRED')
    // With its parent: the parent's place, not the screen's.
    const p = program({ folder: '秘書室' })
    expect(ok(engine.createByAi(m('u-alice'), AI, { type: 'recording', title: '第3回', links: { program: p.id }, defaultFolder: '営業部' })).placed?.folder).toBe('秘書室')
  })

  it('a request type: the screen’s department with the member as its assignee, else refused', () => {
    const r = ok(engine.createByAi(m('u-alice'), AI, { type: 'booking', title: '出演のお願い', defaultFolder: '営業部' }))
    expect(r.placed).toEqual({ personal: false, folder: '営業部' })
    expect(r.record.fields.assignee).toBe('u-alice')
    expect(code(engine.createByAi(m('u-alice'), AI, { type: 'booking', title: '出演のお願い2' }))).toBe('PLACE_REQUIRED')
  })

  it('a まとまり that follows a parent takes the parent’s place, not the member’s department', () => {
    const p = program({ folder: '秘書室' })
    expect(ok(engine.createByAi(m('u-alice'), AI, { type: 'series', title: '特集', links: { program: p.id }, defaultFolder: '営業部' })).placed?.folder).toBe('秘書室')
  })
})

describe('the writers no route reaches', () => {
  const receipt = {
    plugin: 'p', pluginVersion: '1.0.0', fingerprint: 'f', mappingVersion: 1, connectionId: 'c', accountId: 'acc', object: 'recording',
    outsideId: '1', outsideModifiedAt: TS, operationId: null, kind: 'observed',
  }
  const imported = (folder: string | null, links: Record<string, string[]>, recordId: string | null = null): ExternalRecordInput => ({
    recordId, type: 'recording', folder, title: '外の収録', fields: {}, links, action: 'p.import', source: 'p', receipt,
  } as never)

  it('an import never links a parent its record is wider than: the link is left out and a problem says so', async () => {
    let n = 0
    const ids = { newId: () => 'x', newToken: () => `abcdef01234567${String(n++).padStart(2, '0')}` }
    const external = createExternalRecordWriter({ companyData: source, transactions: sqliteTransactions(conn), clock: { now: () => TS, nowMs: () => 0 }, ids, isMember, roleOf, notify: () => {} })
    const p = program({ folder: '秘書室' })
    const wide = external.apply(CO, imported(null, { program: [p.id] }))
    if (!wide.ok) throw new Error(wide.reason)
    expect(source.forCompany(CO).records.linksFrom([wide.recordId])).toHaveLength(0)
    expect(wide.problems.join()).toMatch(/つなぎませんでした/)
    // Linked later by the import: the same.
    const again = external.apply(CO, imported(null, { program: [p.id] }, wide.recordId))
    if (!again.ok) throw new Error(again.reason)
    expect(source.forCompany(CO).records.linksFrom([wide.recordId])).toHaveLength(0)
    const within = external.apply(CO, { ...imported('秘書室', { program: [p.id] }), receipt: { ...receipt, outsideId: '2' } } as never)
    if (!within.ok) throw new Error(within.reason)
    expect(source.forCompany(CO).records.linksFrom([within.recordId]).map(l => l.targetId)).toEqual([p.id])
    expect(await reads('u-carol', within.recordId)).toBe(false)
  })

  it('the service writer refuses a task placed wider than its まとまり', () => {
    const writer = createServiceRecordWriter({ companyData: source, transactions: sqliteTransactions(conn), clock: { now: () => TS, nowMs: () => 0 }, ids: { newId: () => 'x', newToken: () => 'abcdef0123456789' }, isMember, roleOf, notify: () => {} })
    const bundle = ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title: '秘書の案件', folder: '秘書室', fields: { owner: 'u-alice' } })).record
    const input = { type: 'task', title: '片付け', fields: { assignee: 'u-alice' }, links: { bundle: [bundle.id] }, actor: { id: 'acb:clock', kind: 'external' as const, source: 'ACB' } }
    expect(writer.create(CO, { ...input, folder: null })).toMatchObject({ ok: false, reason: 'bad-place' })
    expect(writer.create(CO, { ...input, folder: '秘書室' })).toMatchObject({ ok: true })
    // Linked by a transition: the same.
    const wide = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '全社の', place: 'company', fields: { assignee: 'u-alice' } })).record
    expect(writer.transition(CO, { recordId: wide.id, action: 'reply_check', expectedVersion: 1, to: 'done', links: { bundle: [bundle.id] }, actor: input.actor }))
      .toMatchObject({ ok: false, reason: 'bad-place' })
    expect(writer.transition(CO, { recordId: wide.id, action: 'reply_check', expectedVersion: 1, to: 'done', links: { bundle: [] }, actor: input.actor })).toMatchObject({ ok: true })
  })
})

describe('the declaration', () => {
  it('the core task follows its まとまり, also when the definition in force lacks the key', () => {
    const task = coreTypeDefinitions().find(d => d.name === 'task')!
    expect(task.placeFollows).toBe('bundle')
    expect(followLinkName({ ...task, placeFollows: undefined })).toBe('bundle')
    // A type that never declared it follows nothing.
    const interaction = coreTypeDefinitions().find(d => d.name === 'interaction')!
    expect(followLinkName(interaction)).toBeNull()
  })
})
