/**
 * Owner-only records (「持ち主だけ」, records.md "Owner-only records", owner
 * decision 2026-11-01): `services/record-access.ts` `recordReader`, the
 * engine's create (`personal: true`) and `share`.
 *
 * Guards:
 * - another member AND an owner/admin (the first exception to "owner/admin see
 *   everything") get exactly the answer of a missing record — detail, history,
 *   versions, actions, undo, file links — and no query, count, 「あなたの番」
 *   or link traversal includes it;
 * - nobody else can link a record to it on create: the same answer as a missing id;
 * - another company's member finds nothing;
 * - records with no owner (every existing row) are seen as before, and the
 *   column is added without touching them;
 * - only the owner shares it to a folder: its readers see it from then on,
 *   the ledger says so, and that entry is never undone.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateRecordPersonalOwner } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type ActorInput, type RecordEngine } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'

const TS = '2026-11-01T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let tick = 0

const PEOPLE = ['u-owner', 'u-admin', 'u-alice', 'u-bob', 'u-mallory']
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: ROLES[userId] ?? 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }
const MISSING = 'task-0000000000000000'

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const DEAL_TYPE = '---\nlabel: 案件\nversion: 1\nstorage: server\nstates: [open]\n---\n'
/** A company's own bundle type (implements `bundle`; task v5 links one with `set_bundle`). */
const EFFORT_TYPE = '---\nlabel: 取り組み\nversion: 1\nstorage: server\nimplements: [bundle]\nfields:\n  owner: { label: 持ち主, kind: person, source: server }\n  purpose: { label: 目的, kind: text, source: server }\nstates: [active, done]\nfinal: [done]\n---\n'

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 秘書室: a folder u-mallory cannot read (scope rules). 経理部: a private folder only u-alice reads.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '秘書室', 'folder', ?)").run(`${id}-sec`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-sec-e`, `${id}-sec`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-mallory', 0, 0, ?)").run(`${id}-sec-m`, `${id}-sec`, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, '経理部', 'folder', ?, ?)").run(`${id}-priv`, id, `${id}-repo`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 0, 0, ?)").run(`${id}-priv-e`, `${id}-priv`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-alice', 1, 1, ?)").run(`${id}-priv-a`, `${id}-priv`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  const deal = parseTypeFile('deal', DEAL_TYPE)
  if (!deal.ok) throw new Error(deal.errors.join())
  records.insertTypeVersion({ name: 'deal', version: 1, definition: canonicalTypeJson(deal.definition), source: 'plugin', commitSha: null, createdAt: TS })
  const effort = parseTypeFile('effort', EFFORT_TYPE)
  if (!effort.ok) throw new Error(effort.errors.join())
  records.insertTypeVersion({ name: 'effort', version: 1, definition: canonicalTypeJson(effort.definition), source: 'file', commitSha: null, createdAt: TS })
}

/** Alice's own task (assigned to herself), started once so it has a later entry. */
async function alicesTask(co = 'a', extra: Record<string, unknown> = {}) {
  const t = ok(engine.create(m('u-alice', co), HUMAN, { type: 'task', title: '自分用：歯医者の予約', personal: true, fields: { assignee: 'u-alice' }, ...extra })).record
  return ok(await engine.act(m('u-alice', co), HUMAN, t.id, 'start', { expectedVersion: 1 }))
}

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: () => `2026-11-01T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    // u-bob manages every department: a manager still never sees someone's own record.
    managedFolders: (_c, userId) => (userId === 'u-bob' ? ['', '秘書室', '経理部'] : []),
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (PEOPLE.includes(userId) ? ROLES[userId] ?? 'member' : null),
    notify: () => {},
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  company('a')
  company('b')
})

describe('an owner-only record is its owner’s alone', () => {
  it('the owner sees it, marked personal', async () => {
    const { record } = await alicesTask()
    expect(ok(await service.get(m('u-alice'), record.id)).record).toMatchObject({ id: record.id, personal: true, title: '自分用：歯医者の予約' })
    expect(ok(service.query(m('u-alice'), { type: 'task' })).total).toBe(1)
    expect(ok(service.myTurn(m('u-alice'))).records.map(r => r.id)).toEqual([record.id])
  })

  it('another member, a department manager, an admin and the company owner get the answer of a missing record', async () => {
    const { record } = await alicesTask()
    for (const who of ['u-mallory', 'u-bob', 'u-admin', 'u-owner']) {
      const viewer = m(who)
      const same = async (id: string) => [
        await service.get(viewer, id),
        engine.history(viewer, id),
        engine.atVersion(viewer, id, '1'),
        await engine.act(viewer, HUMAN, id, 'reopen', { expectedVersion: 2, note: 'x' }),
        await engine.act(viewer, HUMAN, id, 'assign', { expectedVersion: 2, note: 'x', args: { assignee: who } }),
        await engine.act(viewer, HUMAN, id, 'cancel', { expectedVersion: 2, note: 'x' }),
        engine.undo(viewer, HUMAN, id, { version: 2, expectedVersion: 2 }),
        engine.fileLink(viewer, HUMAN, id, 'link', { path: 'メモ.md', expectedVersion: 2 }),
        engine.share(viewer, HUMAN, id, { folder: '秘書室', expectedVersion: 2 }),
        service.query(viewer, { linkedTo: { id, hops: 1 } }),
      ]
      const theirs = await same(record.id)
      const missing = await same(record.id.replace(/^task-.{4}/, 'task-zzzz'))
      expect(theirs).toEqual(missing.map(r => JSON.parse(JSON.stringify(r).replaceAll(record.id.replace(/^task-.{4}/, 'task-zzzz'), record.id))))
      expect(theirs[0]).toMatchObject({ ok: false, kind: 'not-found', body: { code: 'RECORD_NOT_FOUND' } })
    }
    // Nothing was written by any of them.
    expect(source.forCompany('a').records.ledger(record.id).map(e => e.action)).toEqual(['create', 'start'])
  })

  it('no query, count, text search or 「あなたの番」 of anyone else includes it', async () => {
    const { record } = await alicesTask()
    const shared = ok(engine.create(m('u-bob'), HUMAN, { type: 'task', title: '会社の予約', fields: { assignee: 'u-alice' } })).record
    for (const who of ['u-mallory', 'u-admin', 'u-owner']) {
      expect(ok(service.query(m(who), { type: 'task' }))).toMatchObject({ total: 1, records: [{ id: shared.id }] })
      expect(ok(service.query(m(who), { type: 'task', countOnly: true })).total).toBe(1)
      expect(ok(service.query(m(who), { text: '予約' })).total).toBe(1)
      expect(ok(service.query(m(who), { implements: 'request', state: ['in_progress', 'todo'] })).total).toBe(1)
    }
    // The owner sees both; their 「あなたの番」 has both (the shared one is assigned to them).
    expect(ok(service.query(m('u-alice'), { type: 'task' })).total).toBe(2)
    expect(ok(service.myTurn(m('u-alice'))).records.map(r => r.id).sort()).toEqual([record.id, shared.id].sort())
  })

  it('links: nobody else can link to it, and links from it reach nobody else', async () => {
    const { record } = await alicesTask()
    // Linking to it on create: the same answer as a missing id, nothing made.
    const toIt = engine.create(m('u-bob'), HUMAN, { type: 'task', title: '関係', links: { related: [record.id] } })
    const toMissing = engine.create(m('u-bob'), HUMAN, { type: 'task', title: '関係', links: { related: [MISSING] } })
    expect(toIt).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'LINK_TARGET_NOT_FOUND' } })
    expect(toIt).toEqual(toMissing)
    expect(engine.create(m('u-admin'), HUMAN, { type: 'task', title: '関係', links: { related: [record.id] } })).toEqual(toMissing)
    expect(ok(service.query(m('u-alice'), { type: 'task' })).total).toBe(1)

    // The owner links her own record to a shared one: the shared one's readers do not see the link.
    const shared = ok(engine.create(m('u-bob'), HUMAN, { type: 'task', title: '会社のタスク' })).record
    const mine = ok(engine.create(m('u-alice'), AI, { type: 'task', title: '自分用メモ', personal: true, links: { related: [shared.id] } })).record
    expect(mine).toMatchObject({ personal: true })
    for (const who of ['u-bob', 'u-admin']) {
      expect(ok(await service.get(m(who), shared.id)).links).toEqual([])
      expect(ok(service.query(m(who), { linkedTo: { id: shared.id, hops: 2 } })).total).toBe(0)
    }
    expect(ok(await service.get(m('u-alice'), shared.id)).links.map(l => l.record?.id)).toEqual([mine.id])
    expect(ok(service.query(m('u-alice'), { linkedTo: { id: shared.id, hops: 1 } })).total).toBe(1)
  })

  it('another company’s member finds nothing (the same user id included)', async () => {
    const { record } = await alicesTask('a')
    const inB = await service.get(m('u-alice', 'b'), record.id)
    expect(inB).toEqual(await service.get(m('u-alice', 'b'), MISSING))
    expect(inB).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
    expect(ok(service.query(m('u-owner', 'b'), { type: 'task' })).total).toBe(0)
    expect(engine.share(m('u-alice', 'b'), HUMAN, record.id, { folder: '秘書室', expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
  })

  it('only for the creator: no other assignee, no folder, not a business plugin’s type', () => {
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', personal: true, fields: { assignee: 'u-bob' } }))
      .toMatchObject({ ok: false, body: { code: 'ASSIGNEE_CANNOT_READ' } })
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', personal: true, folder: '秘書室' }))
      .toMatchObject({ ok: false, body: { code: 'PERSONAL_WITH_FOLDER' } })
    expect(engine.create(m('u-alice'), HUMAN, { type: 'deal', title: 'x', personal: true }))
      .toMatchObject({ ok: false, body: { code: 'PERSONAL_NOT_FOR_TYPE' } })
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', personal: 'yes' }))
      .toMatchObject({ ok: false, kind: 'bad-request' })
    expect(ok(service.query(m('u-alice'), {})).total).toBe(0)
  })
})

describe('the task list’s lookups (bundle links, finished, sorted) apply it too', () => {
  it('nobody else can put a task into an owner-only bundle, nor list a bundle’s tasks by it', async () => {
    const bundle = ok(engine.create(m('u-alice'), HUMAN, { type: 'effort', title: '自分の取り組み', personal: true })).record
    const missingBundle = 'effort-0000000000000000'
    for (const who of ['u-bob', 'u-admin', 'u-owner']) {
      const t = ok(engine.create(m(who), HUMAN, { type: 'task', title: `${who} のタスク` })).record
      const into = await engine.act(m(who), HUMAN, t.id, 'set_bundle', { expectedVersion: 1, links: { bundle: bundle.id } })
      const intoMissing = await engine.act(m(who), HUMAN, t.id, 'set_bundle', { expectedVersion: 1, links: { bundle: missingBundle } })
      expect(into).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'BAD_LINK' } })
      expect(into).toEqual(intoMissing)
      const byLink = service.query(m(who), { link: { name: 'bundle', id: bundle.id } })
      expect(byLink).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
      expect(byLink).toEqual(service.query(m(who), { link: { name: 'bundle', id: missingBundle } }))
    }
    // Its owner does both.
    const mine = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分の段取り', personal: true, fields: { assignee: 'u-alice' } })).record
    ok(await engine.act(m('u-alice'), HUMAN, mine.id, 'set_bundle', { expectedVersion: 1, links: { bundle: bundle.id } }))
    expect(ok(service.query(m('u-alice'), { link: { name: 'bundle', id: bundle.id } })).records.map(r => r.id)).toEqual([mine.id])
  })

  it('finished-since and sorted queries leave it out for everyone else', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分の片付け', personal: true, fields: { assignee: 'u-alice', due: '2026-11-03' } })).record
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'start', { expectedVersion: 1 }))
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'complete', { expectedVersion: 2 }))
    const finished = { finishedSince: '2026-01-01T00:00:00.000Z' }
    const sorted = { type: 'task', sort: { field: 'due' }, fields: { due: { gte: '2026-11-01' } } }
    for (const who of ['u-bob', 'u-admin', 'u-owner']) {
      expect(ok(service.query(m(who), finished)).total).toBe(0)
      expect(ok(service.query(m(who), sorted)).total).toBe(0)
    }
    expect(ok(service.query(m('u-alice'), finished)).records.map(r => r.id)).toEqual([t.id])
    expect(ok(service.query(m('u-alice'), sorted)).records.map(r => r.id)).toEqual([t.id])
  })
})

describe('records without an owner are unchanged', () => {
  it('a record with no folder and no owner is still seen by the whole company', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '全員の' })).record
    expect(t.personal).toBeUndefined()
    for (const who of ['u-alice', 'u-mallory', 'u-admin', 'u-owner']) expect(ok(await service.get(m(who), t.id)).record.id).toBe(t.id)
    expect(source.forCompany('a').records.find(t.id)?.personalOwner).toBeNull()
  })

  it('the column is added once to an existing table, leaving its rows as they were', () => {
    const old = new Database(':memory:')
    old.exec(`CREATE TABLE records (company_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, type_version INTEGER, scope_id TEXT, path TEXT,
      folder TEXT, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, removed_at TEXT,
      PRIMARY KEY (company_id, id))`)
    old.prepare("INSERT INTO records (company_id, id, type, folder, title, created_at, updated_at) VALUES ('a', 'task-aaaaaa', 'task', NULL, '前からの', ?, ?)").run(TS, TS)
    migrateRecordPersonalOwner(old)
    migrateRecordPersonalOwner(old)
    expect(old.prepare('SELECT id, folder, title, personal_owner FROM records').all()).toEqual([{ id: 'task-aaaaaa', folder: null, title: '前からの', personal_owner: null }])
  })
})

describe('sharing it to a folder (「部署に出す」)', () => {
  it('only the owner, to a folder they read outside private folders; then that folder’s readers see it', async () => {
    const { record } = await alicesTask()
    expect(engine.share(m('u-alice'), HUMAN, record.id, { expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'FOLDER_REQUIRED' } })
    expect(engine.share(m('u-alice'), HUMAN, record.id, { folder: '経理部', expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'FOLDER_NOT_PLACEABLE' } })
    expect(engine.share(m('u-alice'), HUMAN, record.id, { folder: '秘書室', expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT' } })
    expect(ok(service.query(m('u-bob'), {})).total).toBe(0)

    const r = ok(engine.share(m('u-alice'), HUMAN, record.id, { folder: '秘書室', expectedVersion: 2, note: '秘書室の予定に入れる' }))
    expect(r.record.personal).toBeUndefined()
    expect(r.entry).toMatchObject({
      action: 'share', version: 3, actorId: 'u-alice', actorKind: 'human', note: '秘書室の予定に入れる', fromState: 'in_progress', toState: 'in_progress',
      changes: [{ field: 'place.personal_owner', before: 'u-alice', after: null }, { field: 'place.folder', before: null, after: '秘書室' }],
    })
    expect(source.forCompany('a').records.ledger(record.id).at(-1)).toMatchObject(r.entry)
    for (const who of ['u-alice', 'u-bob', 'u-admin', 'u-owner']) expect(ok(await service.get(m(who), record.id)).record.version).toBe(3)
    // The folder decides now: who cannot read 秘書室 still cannot see it.
    expect(await service.get(m('u-mallory'), record.id)).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
    // Once shared it is not personal any more.
    expect(engine.share(m('u-alice'), HUMAN, record.id, { folder: '秘書室', expectedVersion: 3 })).toMatchObject({ ok: false, body: { code: 'NOT_PERSONAL' } })
  })

  it('sharing is never undone, and undoing a later change does not carry the place into the fields', async () => {
    const { record } = await alicesTask()
    ok(engine.share(m('u-alice'), HUMAN, record.id, { folder: '秘書室', expectedVersion: 2 }))
    for (const who of ['u-alice', 'u-owner']) {
      expect(engine.undo(m(who), HUMAN, record.id, { version: 3, expectedVersion: 3 })).toMatchObject({ ok: false, body: { code: 'NOT_UNDOABLE' } })
    }
    ok(await engine.act(m('u-alice'), HUMAN, record.id, 'set_due', { expectedVersion: 3, args: { due: '2026-11-20' } }))
    const undone = ok(engine.undo(m('u-alice'), HUMAN, record.id, { version: 4, expectedVersion: 4 }))
    expect(Object.keys(undone.record.fields).filter(k => k.startsWith('place.'))).toEqual([])
    expect(ok(await service.get(m('u-bob'), record.id)).record.id).toBe(record.id)
  })
})
