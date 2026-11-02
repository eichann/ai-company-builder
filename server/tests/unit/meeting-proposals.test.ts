/**
 * After a meeting (owner decision 2026-11-02, plan F; records.md "Task version 11", minutes.md
 * "The review task"): the AI's homework as proposals (案), and 「議事録を確認する」.
 *
 * Guards (each fails when its part is removed — create.ts's proposal rule, `noTurnStates` in the
 * turn list, the definition's `who`, services/minutes-review.ts):
 * - the AI's homework of a meeting starts as a proposal when the company proposes, as a task when
 *   it creates; a person's create never does; a proposal is nobody's turn and tells nobody;
 * - a person adds it (足す → the assignee's turn, told) or puts it away (要らない: kept); never the
 *   AI; a second reading finds the put-away one and does not propose it again (made once);
 * - a meeting that is read gives its assignee one 「議事録を確認する」 linked to it as its origin,
 *   never two; it stays open when every proposal was handled.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sha256TokenDigest } from '../../src/adapters/system'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordEngine } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createMinutesReview, type MinutesReview } from '../../src/services/minutes-review'
import type { Member } from '../../src/services/access'

const TS = '2026-11-02T00:00:00.000Z'
const PEOPLE = ['u-owner', 'u-alice', 'u-bob']
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let review: MinutesReview
let notified: string[][]
let proposes = true

const m = (userId: string): Member => ({ companyId: 'a', userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN = { kind: 'human' as const }
const AI = { kind: 'ai' as const, source: 'claude' }
function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

let meetingId = ''
const homework = (actor: typeof HUMAN | typeof AI, title = '見積を直す', key = 'task:1') =>
  engine.create(m('u-alice'), actor, { type: 'task', title, key, fields: { assignee: 'u-bob' }, links: { meeting: meetingId } })
const turnOf = (userId: string) => ok(service.myTurn(m(userId))).records.map(r => r.id)
const stateOf = (id: string) => source.forCompany('a').records.states([id])[0]?.state

beforeEach(() => {
  notified = []
  proposes = true
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  conn.prepare("INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES ('a', 'a', 'a', 'u-owner', ?, ?)").run(TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-root', 'a', '', 'company', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-root-r', 'a-root', 'everyone', NULL, 1, 1, ?)").run(TS)
  source.forCompany('a').records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(source.forCompany('a').records, TS)
  let n = 0
  const shared = {
    companyData: source, transactions: sqliteTransactions(conn),
    clock: { now: () => `2026-11-02T01:00:${String(n++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') },
  }
  const isMember = (_c: string, u: string) => PEOPLE.includes(u)
  const roleOf = (_c: string, u: string) => (u === 'u-owner' ? 'owner' : PEOPLE.includes(u) ? 'member' : null)
  const writer = createServiceRecordWriter({ ...shared, isMember, roleOf, notify: () => {} })
  review = createMinutesReview({ companyData: source, writer, tokenDigest: sha256TokenDigest })
  engine = createRecordEngine({
    ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf,
    notify: (_c, userIds) => notified.push(userIds), tokenDigest: sha256TokenDigest,
    proposesFromMeeting: () => proposes, afterAct: (c, change) => review.afterAct(c, change),
  })
  service = createRecordService({ companyData: source, clock: shared.clock, indexer: { schedule: async () => {} } })
  const r = writer.create('a', { type: 'meeting', title: '定例', fields: { assignee: 'u-alice', attendees: JSON.stringify(['u-alice', 'u-bob']) }, links: {}, actor: { id: 'u-alice', kind: 'human' } })
  if (!r.ok) throw new Error(r.reason)
  meetingId = r.record.id
})

describe('the AI’s homework of a meeting as proposals (案)', () => {
  it('starts as a proposal when the company proposes: nobody’s turn, nobody told', () => {
    const p = ok(homework(AI)).record
    expect(p.state).toBe('proposed')
    expect(notified).toEqual([])
    expect(turnOf('u-bob')).not.toContain(p.id)
    // 自動で作る: a task at once, as before; and a person's create never proposes.
    proposes = false
    expect(ok(homework(AI, '日程を決める', 'task:2')).record.state).toBe('todo')
    proposes = true
    const byHand = ok(homework(HUMAN, '資料を送る', 'task:3')).record
    expect(byHand.state).toBe('todo')
    expect(turnOf('u-bob')).toContain(byHand.id)
  })

  it('a person adds it (the assignee’s turn, told) or puts it away (kept); never the AI', async () => {
    const add = ok(homework(AI)).record
    const away = ok(homework(AI, '日程を決める', 'task:2')).record
    expect(await engine.act(m('u-alice'), AI, add.id, 'adopt', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await engine.act(m('u-bob'), HUMAN, add.id, 'adopt', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden' })
    notified = []
    expect(ok(await engine.act(m('u-alice'), HUMAN, add.id, 'adopt', { expectedVersion: 1 })).record.state).toBe('todo')
    expect(notified).toEqual([['u-bob']])
    expect(turnOf('u-bob')).toContain(add.id)
    ok(await engine.act(m('u-alice'), HUMAN, away.id, 'dismiss', { expectedVersion: 1 }))
    expect(stateOf(away.id)).toBe('dismissed')
    // Read again: the same item is the put-away one, not a new proposal (made once, #473).
    const again = ok(homework(AI, '日程を決める', 'task:2'))
    expect([again.record.id, again.reused, stateOf(away.id)]).toEqual([away.id, true, 'dismissed'])
  })
})

describe('「議事録を確認する」', () => {
  const reviews = () => (conn.prepare(`SELECT l.source_id AS id FROM record_links l JOIN record_state s ON s.company_id = l.company_id AND s.record_id = l.source_id
    WHERE l.company_id = 'a' AND l.name = 'meeting' AND l.target_id = ? AND json_extract(s.fields, '$.task_kind') = 'minutes_review'`).all(meetingId) as Array<{ id: string }>).map(r => r.id)

  it('one for the meeting’s assignee when it is read, linked to it, never two; open until they complete it', async () => {
    ok(await engine.act(m('u-alice'), AI, meetingId, 'start_reading', { expectedVersion: 1 }))
    expect(reviews()).toEqual([])
    const p = ok(homework(AI)).record
    ok(await engine.act(m('u-alice'), AI, meetingId, 'finish_reading', { expectedVersion: 2, args: { summary_text: '見積を直すことにした' } }))
    const [id] = reviews()
    expect(reviews()).toHaveLength(1)
    const detail = ok(await service.get(m('u-alice'), id))
    expect(detail.record).toMatchObject({ state: 'todo', fields: { assignee: 'u-alice', requested_by: 'u-alice', task_kind: 'minutes_review' } })
    expect(detail.links.find(l => l.name === 'meeting')).toMatchObject({ direction: 'out', fixed: true })
    expect(turnOf('u-alice')).toContain(id)
    expect(review.ensure('a', meetingId)).toBeNull()
    expect(reviews()).toHaveLength(1)
    // Every proposal handled: the review is still the assignee's to complete.
    ok(await engine.act(m('u-alice'), HUMAN, p.id, 'adopt', { expectedVersion: 1 }))
    expect(stateOf(id)).toBe('todo')
    expect(ok(await engine.act(m('u-alice'), HUMAN, id, 'complete', { expectedVersion: 1 })).record.state).toBe('done')
  })
})
