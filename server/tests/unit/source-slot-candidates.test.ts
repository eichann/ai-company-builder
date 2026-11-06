/**
 * The meeting's slot for what an AI makes (出どころの枠, owner decision 2026-11-06 §10; minutes.md
 * "Outputs made once", records.md "Task version 13").
 *
 * Guards (each fails when its part is removed — services/source-slot-candidates.ts `decideSlot`, its
 * call in record-engine/create.ts and decisions.ts, the task definition's `link:meeting`, the engine's
 * `readsLink`, `slotTitlesClose`, the `TASK_VERSION` migration):
 * - a second reading that reuses the serial key `task:1` for a different item makes it (never lost);
 * - the same basis quote from two attendees' AIs is one candidate, and the second is told — only when
 *   it can read the first; a different quote with a close title is a second candidate marked similar;
 * - an owner-only task (「あなただけ」) is never compared or mentioned;
 * - every reader of the meeting may 足す・要らない・案に戻す・別のもの; a non-reader neither sees nor acts;
 *   the AI never;
 * - decisions take the same identity (meeting, quote);
 * - the task type moves to version 13 once at startup.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateTaskVersion } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sha256TokenDigest } from '../../src/adapters/system'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { currentTypes, ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordEngine } from '../../src/services/record-engine'
import { createDecisionService, type DecisionService } from '../../src/services/decisions'
import type { Member } from '../../src/services/access'
import { TASK_VERSION } from '../../shared/core/core-types'
import { slotTitlesClose } from '../../shared/core/source-slot-candidates'
import { parseTypeFile } from '../../shared/core/record-types'

const TS = '2026-11-06T00:00:00.000Z'
const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-carol']
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let decisions: DecisionService
let meetingId = ''

const m = (userId: string): Member => ({ companyId: 'a', userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN = { kind: 'human' as const }
const ai = (conversationId: string) => ({ kind: 'ai' as const, source: 'claude-code', conversationId })
function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const Q1 = '佐藤さんが来週までに修正見積を鈴木様へ送る'
const Q2 = '製造業の事例集を高杉さんが探しておく'
const homework = (who: string, conv: string, title: string, extra: Record<string, unknown> = {}) =>
  engine.createByAi(m(who), ai(conv), { type: 'task', title, fields: { assignee: who }, links: { meeting: meetingId }, ...extra })
const linkedTasks = () => (conn.prepare("SELECT source_id AS id FROM record_links WHERE company_id = 'a' AND name = 'meeting' AND target_id = ?").all(meetingId) as Array<{ id: string }>).map(r => r.id)
const stateOf = (id: string) => source.forCompany('a').records.states([id])[0]

beforeEach(() => {
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
    clock: { now: () => `2026-11-06T01:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') },
  }
  const isMember = (_c: string, u: string) => PEOPLE.includes(u)
  const roleOf = (_c: string, u: string) => (u === 'u-owner' ? 'owner' : PEOPLE.includes(u) ? 'member' : null)
  const writer = createServiceRecordWriter({ ...shared, isMember, roleOf, notify: () => {} })
  engine = createRecordEngine({
    ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf,
    notify: () => {}, tokenDigest: sha256TokenDigest, proposesFromMeeting: () => true,
  })
  decisions = createDecisionService({ companyData: source, writer, tokenDigest: sha256TokenDigest, ids: shared.ids } as Parameters<typeof createDecisionService>[0])
  // A members-only meeting (minutes.md "Meetings for their attendees"): Alice pressed ［AI に読ませる］, Bob attended, Carol did not.
  const r = writer.create('a', {
    type: 'meeting', title: 'ABC社との商談', state: 'received', members: ['u-alice', 'u-bob'],
    fields: { assignee: 'u-alice', attendees: JSON.stringify(['u-alice', 'u-bob']) }, links: {}, actor: { id: 'u-alice', kind: 'human' },
  })
  if (!r.ok) throw new Error(r.reason)
  meetingId = r.record.id
})

describe('the identity of a candidate is (meeting, kind, quote)', () => {
  it('a second reading that reuses `task:1` for a different item makes it; the same consultation retrying finds its own', () => {
    const first = ok(homework('u-alice', 'conv-a', '見積を送る', { key: 'task:1' })).record
    // The same consultation retrying: its own task:1, nothing new.
    const retry = ok(homework('u-alice', 'conv-a', '見積を送る（再）', { key: 'task:1' }))
    expect([retry.record.id, retry.reused]).toEqual([first.id, true])
    // Bob's consultation reuses task:1 for another item: made, never lost.
    const other = ok(homework('u-bob', 'conv-b', '日程を決める', { key: 'task:1' }))
    expect(other.reused).toBeUndefined()
    expect(other.record.id).not.toBe(first.id)
    expect(linkedTasks().sort()).toEqual([first.id, other.record.id].sort())
  })

  it('the same quote from two attendees’ AIs is one candidate; the second is told', () => {
    const a = ok(homework('u-alice', 'conv-a', '見積を送る', { quote: Q1 })).record
    expect(a.fields.basis).toBe(Q1)
    // Other spacing and punctuation is the same basis.
    const b = ok(homework('u-bob', 'conv-b', '修正見積を送付する', { quote: `「${Q1.replace('までに', ' までに ')}。」` }))
    expect([b.record.id, b.reused]).toEqual([a.id, true])
    expect(b.note).toContain('同じ根拠の案がもうあります（見積を送る）')
    expect(linkedTasks()).toEqual([a.id])
  })

  it('the second is told only when it can read the first: otherwise a candidate of its own, nothing said', () => {
    // Alice's AI narrowed its candidate to Alice alone (members-only, within the meeting's list).
    const hidden = ok(homework('u-alice', 'conv-a', '見積を送る', { quote: Q1, members: ['u-alice'] })).record
    const b = ok(homework('u-bob', 'conv-b', '見積を送る', { quote: Q1 }))
    expect(b.reused).toBeUndefined()
    expect(b.record.id).not.toBe(hidden.id)
    expect(JSON.stringify(b)).not.toContain(hidden.id)
    expect(b.note).toBeUndefined()
    expect(b.record.fields.similar_to ?? null).toBeNull()
  })

  it('a wording variant with a different quote is a second candidate, marked similar to the older', () => {
    const a = ok(homework('u-alice', 'conv-a', '見積を送る', { quote: Q1 })).record
    const b = ok(homework('u-bob', 'conv-b', '見積を送る（修正版）', { quote: '修正した見積は金曜までにお送りします' }))
    expect(b.record.id).not.toBe(a.id)
    expect(b.reused).toBeUndefined()
    expect(b.record.fields.similar_to).toBe(a.id)
    expect(b.similar).toEqual({ id: a.id, title: '見積を送る' })
    expect(b.note).toContain('似ている案')
    expect(stateOf(a.id)?.state).toBe('proposed')
    // A different item stays unmarked.
    expect(ok(homework('u-bob', 'conv-b', '事例集を探す', { quote: Q2 })).record.fields.similar_to ?? null).toBeNull()
  })

  it('an owner-only task is never compared or mentioned', () => {
    const own = ok(homework('u-alice', 'conv-a', '見積を送る', { quote: Q1, personal: true })).record
    expect(own.personal).toBe(true)
    // Alice's own AI in another consultation, then Bob's AI, with the same quote and title: neither meets it.
    const mine = ok(homework('u-alice', 'conv-a2', '見積を送る', { quote: Q1 }))
    expect(mine.reused).toBeUndefined()
    expect(mine.record.id).not.toBe(own.id)
    expect(mine.record.fields.similar_to ?? null).toBeNull()
    expect(JSON.stringify(mine)).not.toContain(own.id)
    const bobs = ok(homework('u-bob', 'conv-b', '見積を送る', { quote: Q1 }))
    expect(bobs.record.id).toBe(mine.record.id)
    expect(JSON.stringify(bobs)).not.toContain(own.id)
  })

  it('a quote is checked; the server sets similar_to and apart_by, never a body', () => {
    expect(homework('u-alice', 'conv-a', 'x', { quote: '短い' })).toMatchObject({ ok: false, body: { code: 'BAD_QUOTE' } })
    expect(engine.createByAi(m('u-alice'), ai('c'), { type: 'task', title: 'x', quote: Q1 })).toMatchObject({ ok: false, body: { code: 'QUOTE_NEEDS_MEETING' } })
    const a = ok(homework('u-alice', 'conv-a', '見積を送る', { quote: Q1 })).record
    for (const f of ['similar_to', 'apart_by']) {
      expect(homework('u-bob', 'conv-b', '別の件', { fields: { assignee: 'u-bob', [f]: f === 'similar_to' ? a.id : 'u-bob' } }))
        .toMatchObject({ ok: false, body: { code: 'BAD_VALUE' } })
    }
  })

  it('a person’s create is free: not compared, never answered with another', () => {
    const a = ok(homework('u-alice', 'conv-a', '見積を送る', { quote: Q1 })).record
    const byHand = ok(engine.create(m('u-bob'), HUMAN, { type: 'task', title: '見積を送る', fields: { assignee: 'u-bob' }, links: { meeting: meetingId } }))
    expect(byHand.reused).toBeUndefined()
    expect(byHand.record.id).not.toBe(a.id)
  })

  it('decisions take the same identity: the same quote once, a different one its own', async () => {
    const decide = (who: string, conv: string, title: string, quote: string) => decisions.record(m(who), ai(conv), {
      title, why: '先方と合意した', source: '議事録', links: { meeting: meetingId }, quote,
    })
    const a = ok(await decide('u-alice', 'conv-a', '見積は150万円にする', Q1))
    expect(a.created).toBe(true)
    const same = ok(await decide('u-bob', 'conv-b', '見積を150万円に改める', Q1))
    expect([same.record.id, same.reused]).toEqual([a.record.id, true])
    expect(same.note).toContain('同じ根拠')
    const other = ok(await decide('u-bob', 'conv-b', '見積は150万円にする', Q2))
    expect([other.created, other.record.id === a.record.id]).toEqual([true, false])
  })
})

describe('who may 足す・要らない・案に戻す・別のもの: everyone who reads the meeting', () => {
  it('an attendee who did not press read adopts, dismisses, brings back and keeps apart; the AI never', async () => {
    const a = ok(homework('u-alice', 'conv-a', '見積を送る', { quote: Q1 })).record
    const b = ok(homework('u-alice', 'conv-a', '見積を送る（修正版）', { quote: '修正した見積は金曜までにお送りします' })).record
    expect(await engine.act(m('u-bob'), ai('conv-b'), a.id, 'adopt', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(ok(await engine.act(m('u-bob'), HUMAN, a.id, 'adopt', { expectedVersion: 1 })).record.state).toBe('todo')
    // 「別のもの」: the similar mark is answered, with who said so.
    const apart = ok(await engine.act(m('u-bob'), HUMAN, b.id, 'keep_apart', { expectedVersion: 1 }))
    expect(apart.record.fields.apart_by).toBe('u-bob')
    expect(ok(await engine.act(m('u-bob'), HUMAN, b.id, 'dismiss', { expectedVersion: 2, note: '「見積を送る」と同じ案のため' })).record.state).toBe('dismissed')
    expect(ok(await engine.act(m('u-bob'), HUMAN, b.id, 'propose_again', { expectedVersion: 3 })).record.state).toBe('proposed')
  })

  it('someone who does not read the meeting neither sees nor acts on its proposals (owner included)', async () => {
    const a = ok(homework('u-alice', 'conv-a', '見積を送る', { quote: Q1 })).record
    for (const who of ['u-carol', 'u-owner']) {
      for (const action of ['adopt', 'dismiss', 'keep_apart']) {
        expect(await engine.act(m(who), HUMAN, a.id, action, { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'not-found' })
      }
    }
  })

  it('a reader of the task who does not read its meeting is not a reader of the meeting', async () => {
    // Carol is the assignee Alice's AI named: she reads the task (members-only + the people it names), not the meeting.
    const t = ok(engine.createByAi(m('u-alice'), ai('conv-a'), { type: 'task', title: '資料を作る', quote: Q2, fields: { assignee: 'u-carol' }, links: { meeting: meetingId } })).record
    expect(await engine.act(m('u-carol'), HUMAN, t.id, 'adopt', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(ok(await engine.act(m('u-bob'), HUMAN, t.id, 'adopt', { expectedVersion: 1 })).record.state).toBe('todo')
  })

  it('a task with no meeting is not widened: only its requester (and the roles) dismiss it', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '部署の仕事', fields: { assignee: 'u-alice' } })).record
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'dismiss', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden' })
  })
})

describe('the who-entry link:<name>', () => {
  const typeWith = (who: string) => parseTypeFile('memo', `---
label: メモ
version: 1
storage: server
fields:
  title: { label: 件名, kind: text, source: file }
links:
  meeting: { label: 会議, target: meeting, cardinality: one }
  files:   { label: ファイル, target: file, cardinality: many }
states: [open, closed]
initial: open
actions:
  close: { label: 閉じる, from: [open], to: closed, who: [${who}] }
---
`)
  it('names a record link of the type: not a file link, not a link it lacks', () => {
    expect(typeWith('link:meeting').ok).toBe(true)
    expect(typeWith('link:files').ok).toBe(false)
    expect(typeWith('link:nothing').ok).toBe(false)
  })
})

describe('the titles a person is asked about', () => {
  it('the same after the title rule, or one inside the other; never empty or one character', () => {
    expect(slotTitlesClose('見積を送る', '見積を 送る。')).toBe(true)
    expect(slotTitlesClose('見積を送る', '見積を送る（修正版）')).toBe(true)
    expect(slotTitlesClose('見積を送る', '日程を決める')).toBe(false)
    expect(slotTitlesClose('送', '見積を送る')).toBe(false)
    expect(slotTitlesClose('', '見積を送る')).toBe(false)
  })
})

describe('startup moves every task to version 13', () => {
  it('stores the core definition once and moves the tasks once', () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '前からある', fields: { assignee: 'u-alice' } })).record
    const json = (conn.prepare("SELECT definition FROM record_types WHERE company_id = 'a' AND name = 'task' AND version = ?").get(TASK_VERSION) as { definition: string }).definition
    conn.prepare("DELETE FROM record_types WHERE company_id = 'a' AND name = 'task' AND version >= 13").run()
    conn.prepare("INSERT INTO record_types (company_id, name, version, definition, source, commit_sha, created_at) VALUES ('a', 'task', 12, ?, 'core', NULL, ?)")
      .run(JSON.stringify({ ...JSON.parse(json), version: 12 }), TS)
    conn.prepare("UPDATE records SET type_version = 12 WHERE company_id = 'a' AND type = 'task'").run()
    expect(TASK_VERSION).toBe(13)
    migrateTaskVersion(conn)
    const stored = () => (conn.prepare("SELECT COUNT(*) AS n FROM record_types WHERE company_id = 'a' AND name = 'task' AND version = 13").get() as { n: number }).n
    expect(stored()).toBe(1)
    expect(currentTypes(source.forCompany('a').records).get('task')?.definition.actions.adopt.who).toContain('link:meeting')
    expect((conn.prepare("SELECT type_version AS v FROM records WHERE company_id = 'a' AND id = ?").get(t.id) as { v: number }).v).toBe(13)
    expect(source.forCompany('a').records.ledger(t.id)).toHaveLength(1)
    migrateTaskVersion(conn)
    expect(stored()).toBe(1)
  })
})
