/**
 * Linking records later and removing those links (records.md "Linking records later", owner
 * decision 2026-11-02 「つなぐ・外す・新しく作るの動線」), and the origin mark (出どころ).
 *
 * Guards (each fails when its check in services/record-engine/record-links.ts,
 * services/records.ts or shared/core/record-types.ts is removed):
 * - removing a link is a ledger entry that undo (取り消す) reverses; the other record stays;
 * - an origin link (task `meeting`) is never removed or linked by hand, nothing written;
 * - linking: another type, an unreadable record, another company's and a missing id get one
 *   answer; removing a target the caller cannot see answers like one not linked;
 * - a stale version is refused; an approval's links only its service changes;
 * - the detail marks the links that cannot be removed (`fixed`), on both sides;
 * - the core marks task / decision / reply_request origins, and `origin` must be a boolean.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { applyRecordChanges, ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type ActorInput, type RecordEngine, type ServiceRecordWriter } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'
import { coreTypeDefinitions } from '../../../shared/core/core-types'
import { parseTypeFile } from '../../../shared/core/record-types'

const TS = '2026-11-02T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let writer: ServiceRecordWriter
let service: RecordService
let tick = 0
const at = () => `2026-11-02T00:00:${String(tick++ % 60).padStart(2, '0')}.000Z`

const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-mallory']
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN: ActorInput = { kind: 'human' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const EFFORT = `---
label: プロジェクト
version: 1
storage: server
implements: [bundle]
fields:
  owner:   { label: 責任者, kind: person, source: server }
  purpose: { label: 目的, kind: text, source: server }
states: [active, done]
final: [done]
---
`

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 経理: a folder u-mallory cannot read.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '経理', 'folder', ?)").run(`${id}-acc`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-acc-e`, `${id}-acc`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-mallory', 0, 0, ?)").run(`${id}-acc-m`, `${id}-acc`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  sqliteTransactions(conn).run(() => applyRecordChanges(records, {
    repoKey: 'company', scopeId: null, prefix: '', full: false, tip: 'a'.repeat(40), at: at(), scopes: source.forCompany(id).scopes.listWithRules(),
    changes: [{ path: '.acb/types/effort.md', text: EFFORT }],
  }))
}

const effort = (title: string, member = m('u-alice'), folder?: string) =>
  ok(engine.create(member, HUMAN, { type: 'effort', title, ...(folder ? { folder } : {}), fields: { owner: member.userId } })).record
function meeting(co = 'a') {
  const r = writer.create(co, { type: 'meeting', title: '定例', fields: { assignee: 'u-alice' }, links: {}, actor: { id: 'u-alice', kind: 'human' } })
  if (!r.ok) throw new Error(r.reason)
  return r.record
}
const task = (links: Record<string, unknown> = {}, member = m('u-alice')) =>
  ok(engine.create(member, HUMAN, { type: 'task', title: '見積を直す', fields: { assignee: member.userId }, links })).record
const link = (member: Member, id: string, body: Record<string, unknown>) => engine.recordLink(member, HUMAN, id, 'link', body)
const unlink = (member: Member, id: string, body: Record<string, unknown>) => engine.recordLink(member, HUMAN, id, 'unlink', body)
const ledger = (id: string) => source.forCompany('a').records.ledger(id)
const linkedIds = (id: string, name: string) => source.forCompany('a').records.linksFrom([id]).filter(l => l.name === name).map(l => l.targetId)

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const shared = {
    companyData: source, transactions: sqliteTransactions(conn), clock: { now: at, nowMs: () => 0 },
    ids: { newId: () => crypto.randomUUID(), newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
  }
  const isMember = (_c: string, userId: string) => PEOPLE.includes(userId)
  const roleOf = (_c: string, userId: string) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null)
  engine = createRecordEngine({ ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf, notify: () => {} })
  writer = createServiceRecordWriter({ ...shared, isMember, roleOf, notify: () => {} })
  service = createRecordService({ companyData: source, clock: shared.clock, indexer: { schedule: async () => {} } })
  company('a')
  company('b')
})

describe('removing a link, and taking it back', () => {
  it('unlinks only the link (the other record stays), as an entry undo reverses', async () => {
    const p = effort('A社 研修導入')
    const t = task({ bundle: p.id })
    const r = ok(unlink(m('u-bob'), t.id, { link: 'bundle', target: p.id, expectedVersion: 1 }))
    expect(r.entry).toMatchObject({ action: 'unlink_record', actorId: 'u-bob', changes: [{ field: 'links.bundle', before: p.id, after: null }] })
    expect(linkedIds(t.id, 'bundle')).toEqual([])
    expect(ok(await service.get(m('u-bob'), p.id)).record.id).toBe(p.id)
    // 取り消す
    ok(await engine.undo(m('u-bob'), HUMAN, t.id, { version: 2, expectedVersion: 2 }))
    expect(linkedIds(t.id, 'bundle')).toEqual([p.id])
  })

  it('links later; a `one` link is replaced; linking it again changes nothing', () => {
    const p = effort('A社'), q = effort('B社')
    const t = task()
    ok(link(m('u-alice'), t.id, { link: 'bundle', target: p.id, expectedVersion: 1 }))
    ok(link(m('u-alice'), t.id, { link: 'bundle', target: q.id, expectedVersion: 2 }))
    expect(linkedIds(t.id, 'bundle')).toEqual([q.id])
    expect(ok(link(m('u-alice'), t.id, { link: 'bundle', target: q.id, expectedVersion: 3 })).changed).toBe(false)
    expect(ledger(t.id)).toHaveLength(3)
  })

  it('a stale version is refused and nothing is written', () => {
    const p = effort('A社')
    const t = task({ bundle: p.id })
    expect(unlink(m('u-alice'), t.id, { link: 'bundle', target: p.id, expectedVersion: 0 })).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT' } })
    expect(linkedIds(t.id, 'bundle')).toEqual([p.id])
  })
})

describe('an origin link (出どころ) stays', () => {
  it('is neither removed nor linked by hand, and nothing is written', () => {
    const mt = meeting()
    const t = task({ meeting: mt.id })
    expect(unlink(m('u-alice'), t.id, { link: 'meeting', target: mt.id, expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'LINK_IS_ORIGIN' } })
    const other = task()
    expect(link(m('u-alice'), other.id, { link: 'meeting', target: mt.id, expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'LINK_IS_ORIGIN' } })
    expect(ledger(t.id)).toHaveLength(1)
    expect(linkedIds(t.id, 'meeting')).toEqual([mt.id])
  })

  it('the detail marks what cannot be removed, on both sides', async () => {
    const mt = meeting()
    const p = effort('A社')
    const t = task({ meeting: mt.id, bundle: p.id })
    const fromTask = ok(await service.get(m('u-alice'), t.id)).links
    expect(fromTask.find(l => l.name === 'meeting')?.fixed).toBe(true)
    expect(fromTask.find(l => l.name === 'bundle')?.fixed).toBeUndefined()
    const fromMeeting = ok(await service.get(m('u-alice'), mt.id)).links
    expect(fromMeeting.find(l => l.record?.id === t.id)?.fixed).toBe(true)
  })

  it('the core marks where tasks, decisions and replies came from — and nothing else', () => {
    const origins = Object.fromEntries(coreTypeDefinitions().map(d => [d.name, Object.entries(d.links).filter(([, l]) => l.origin).map(([n]) => n).sort()]))
    expect(origins.task).toEqual(['interaction', 'meeting', 'prepared'])
    expect(origins.decision).toEqual(['approval', 'meeting'])
    expect(origins.reply_request).toEqual(['interaction', 'prepared', 'task'])
    const text = (origin: string) => `---\nlabel: メモ\nversion: 1\nstorage: server\nlinks:\n  from: { label: もと, target: task, cardinality: one, origin: ${origin} }\nstates: [open]\n---\n`
    expect(parseTypeFile('memo', text('true')).ok).toBe(true)
    expect(parseTypeFile('memo', text('yes')).ok).toBe(false)
  })
})

describe('nothing about an unseen record leaks', () => {
  it('linking: another type, an unreadable record, another company’s and a missing id get one answer', () => {
    const t = task({}, m('u-mallory'))
    const closed = effort('経理の', m('u-alice'), '経理')
    const foreign = effort('B社の', m('u-alice', 'b'))
    const notBundle = task()
    const answers = [closed.id, foreign.id, notBundle.id, 'effort-0000000000000000']
      .map(id => link(m('u-mallory'), t.id, { link: 'bundle', target: id, expectedVersion: 1 }))
    for (const a of answers) expect(a).toEqual(answers[0])
    expect(answers[0]).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
    expect(JSON.stringify(answers[0])).not.toMatch(/経理/)
    expect(ledger(t.id)).toHaveLength(1)
  })

  it('removing a target the caller cannot see answers like one not linked', () => {
    const closed = effort('経理の', m('u-alice'), '経理')
    const t = task({ related: [] })
    // A link made before a task followed its まとまり's place (a company-wide task, a 経理 まとまり):
    // linking it now is refused as wider (records.md "A task and its 案件・プロジェクト").
    source.forCompany('a').records.replaceLinks(t.id, [{ sourceId: t.id, name: 'bundle', position: 0, targetId: closed.id, targetPath: null }])
    const unseen = unlink(m('u-mallory'), t.id, { link: 'bundle', target: closed.id, expectedVersion: 1 })
    const notLinked = unlink(m('u-mallory'), t.id, { link: 'bundle', target: 'effort-0000000000000000', expectedVersion: 1 })
    expect(unseen).toEqual(notLinked)
    expect(unseen).toMatchObject({ ok: false, kind: 'not-found', body: { code: 'LINK_NOT_FOUND' } })
    expect(linkedIds(t.id, 'bundle')).toEqual([closed.id])
  })
})
