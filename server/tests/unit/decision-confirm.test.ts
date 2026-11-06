/**
 * 「決めたことを人が確かめる」 (decision version 6, owner decision 2026-11-07; records.md "Decisions"):
 * what the AI records from a meeting is a 「決めたことの案」 until the person who decides says
 * 「そうです」.
 *
 * Guards (each mutation-checked):
 * - the 責任者 of the linked まとまり (the `bundle` interface's `owner`: `link:bundle.owner`) confirms,
 *   and `decided_by` is whoever confirmed;
 * - with a 責任者, the meeting's assignee (or any other reader of the meeting) alone cannot; the
 *   責任者's delegate during an absence can;
 * - with no まとまり, or one without a 責任者, any reader of the meeting confirms (`who_fallback`);
 *   without a meeting, whoever recorded it; never the AI;
 * - a members-only meeting's decision is never widened: a 責任者 who cannot read it cannot confirm, the
 *   meeting's people decide, the card is told who cannot read it (only a reader of the まとまり is told);
 * - 違う (reject) needs no note while unconfirmed; 取り消す of a confirmed one does;
 * - an unconfirmed decision carries `proposalNotice` wherever the AI reads it, a confirmed one not;
 * - `said_by` / `objection`: outside text kept on one line with brackets neutralized, choices checked;
 * - the parser: `link:<link>.<field>` only on an interface's person field, `who_fallback` only with
 *   the record's own people in `who`;
 * - startup moves every decision to version 6 once.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { initDatabase, migrateDecisionVersion } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { currentTypes, ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordEngine, type ServiceRecordWriter } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createDecisionService, type DecisionService } from '../../src/services/decisions'
import type { Member } from '../../src/services/access'
import { DECISION_VERSION } from '../../../shared/core/core-types'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'
import { DECISION_PROPOSAL_NOTICE } from '../../../shared/types/records'

const TS = '2026-11-07T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let writer: ServiceRecordWriter
let decisions: DecisionService
/** Whom each member covers today (代わりの人). */
let covering: Record<string, string[]> = {}

const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-mallory', 'u-carol']
const m = (userId: string, role = 'member'): Member => ({ companyId: 'a', userId, role })
const admin = () => m('u-owner', 'owner')
const HUMAN = { kind: 'human' as const }
const AI = { kind: 'ai' as const, source: 'claude-code', conversationId: 'conv-1' }

const DEAL_TYPE = '---\nlabel: 案件\nversion: 1\nstorage: server\nimplements: [bundle]\nfields:\n  owner: { label: 責任者, kind: person, source: server }\n  purpose: { label: なんのため, kind: text, source: server }\nstates: [open, won]\nfinal: [won]\n---\n'

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

let tick = 0
beforeEach(() => {
  tick = 0
  covering = {}
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: () => `2026-11-07T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 }
  const ids = { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') }
  const roleOf = (_c: string, userId: string) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null)
  const base = {
    companyData: source, transactions: sqliteTransactions(conn), clock, ids,
    isMember: (_c: string, userId: string) => PEOPLE.includes(userId), roleOf, notify: () => {},
  }
  engine = createRecordEngine({ ...base, files: { appendHistoryLine: async () => true, fileAtCommit: async () => false }, managedFolders: () => [], actsFor: (_c: string, userId: string) => covering[userId] ?? [] })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} }, whoMay: (member, id, actions) => engine.whoMay(member, id, actions) })
  writer = createServiceRecordWriter(base)
  decisions = createDecisionService({ companyData: source, writer, ids, tokenDigest: { digest: (t: string) => createHash('sha256').update(t).digest('hex') } })
  conn.prepare("INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES ('a', 'a', 'a', 'u-owner', ?, ?)").run(TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-root', 'a', '', 'company', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-root-r', 'a-root', 'everyone', NULL, 1, 1, ?)").run(TS)
  conn.prepare("INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES ('a-sales', 'a', '営業部', '営業部', ?, ?)").run(TS, TS)
  const records = source.forCompany('a').records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  const deal = parseTypeFile('deal', DEAL_TYPE)
  if (!deal.ok) throw new Error(deal.errors.join())
  records.insertTypeVersion({ name: 'deal', version: 1, definition: canonicalTypeJson(deal.definition), source: 'plugin', commitSha: null, createdAt: TS })
})

/** A 案件 whose 責任者 is `owner` (none = a まとまり without one). Seen by the whole company. */
function deal(owner?: string) {
  return ok(engine.create(admin(), HUMAN, { type: 'deal', title: 'サンプル物産 導入案件', ...(owner ? { fields: { owner } } : {}) })).record
}

/** A meeting whose assignee (the first to press ［AI に読ませる］) is u-bob; `members` = for its attendees only. */
function meeting(members?: string[]) {
  const r = writer.create('a', {
    type: 'meeting', title: '定例', ...(members ? { members } : { folder: null }), state: 'received',
    fields: { assignee: 'u-bob', meeting_at: '2026-11-07T10:00' }, actor: { id: 'u-bob', kind: 'human', source: null }, quiet: true,
  })
  if (!r.ok) throw new Error(r.reason)
  return r.record
}

/** What the member's AI records from the meeting (no folder from a members-only one). */
async function aiDecision(links: Record<string, string>, extra: Record<string, unknown> = {}, folder: string | null = '営業部') {
  return ok(await decisions.record(m('u-bob'), AI, {
    ...(folder ? { folder } : {}), title: '窓口を3つにする', why: '先方の要望', source: '議事録 2026-11-07', links, ...extra,
  })).record
}

const act = (who: Member, actor: typeof HUMAN | typeof AI, id: string, action: string, body: Record<string, unknown> = {}) =>
  engine.act(who, actor, id, action, { expectedVersion: 1, ...body })

describe('who says 「そうです」', () => {
  it('the まとまり’s 責任者 confirms and is kept as 決めた人; the meeting’s assignee alone cannot', async () => {
    const d = await aiDecision({ bundle: deal('u-alice').id, meeting: meeting().id })
    expect(d.fields).toMatchObject({ decided_by: null, owner: null })
    // The meeting's assignee and another reader of the meeting: not while there is a 責任者.
    expect(await act(m('u-bob'), HUMAN, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await act(m('u-mallory'), HUMAN, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await act(m('u-alice'), AI, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'forbidden' })
    const done = ok(await act(m('u-alice'), HUMAN, d.id, 'confirm'))
    expect(done.record).toMatchObject({ state: 'confirmed', fields: { decided_by: 'u-alice' } })
    expect(done.entry).toMatchObject({ actorId: 'u-alice', isDecision: true })
  })

  it('決めた人 is the person who confirmed, whatever the body says', async () => {
    const d = await aiDecision({ bundle: deal('u-alice').id, meeting: meeting().id })
    expect(await act(m('u-alice'), HUMAN, d.id, 'confirm', { args: { decided_by: 'u-bob' } })).toMatchObject({ ok: false, body: { code: 'BAD_VALUE' } })
    // An admin (as before) is kept as 決めた人 too.
    expect(ok(await act(admin(), HUMAN, d.id, 'confirm')).record.fields.decided_by).toBe('u-owner')
  })

  it('with no まとまり, any reader of the meeting confirms — never the AI', async () => {
    const d = await aiDecision({ meeting: meeting().id })
    expect(await act(m('u-mallory'), AI, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(ok(await act(m('u-mallory'), HUMAN, d.id, 'confirm')).record.fields.decided_by).toBe('u-mallory')
  })

  it('with a まとまり that has no 責任者, any reader of the meeting confirms', async () => {
    const d = await aiDecision({ bundle: deal().id, meeting: meeting().id })
    expect(ok(await act(m('u-carol'), HUMAN, d.id, 'confirm')).record.fields.decided_by).toBe('u-carol')
  })

  it('the 責任者’s delegate during an absence confirms for them', async () => {
    const d = await aiDecision({ bundle: deal('u-alice').id, meeting: meeting().id })
    expect(await act(m('u-carol'), HUMAN, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'forbidden' })
    covering = { 'u-carol': ['u-alice'] }
    expect(ok(await act(m('u-carol'), HUMAN, d.id, 'confirm')).entry).toMatchObject({ actorId: 'u-carol', onBehalfOf: 'u-alice' })
  })

  it('whoever recorded it does not decide when there is a 責任者', async () => {
    const d = ok(await decisions.record(m('u-carol'), HUMAN, { folder: '営業部', title: '請求は月末にまとめる', why: '相談で決めた', source: '相談', links: { bundle: deal('u-alice').id } })).record
    expect(await act(m('u-carol'), HUMAN, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'forbidden' })
  })

  it('without a meeting or a まとまり, whoever recorded it decides; nobody else', async () => {
    const d = ok(await decisions.record(m('u-carol'), AI, { folder: '営業部', title: '請求は月末にまとめる', why: '相談で決めた', source: '相談' })).record
    expect(d.fields.owner).toBe('u-carol')
    expect(await act(m('u-mallory'), HUMAN, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(ok(await act(m('u-carol'), HUMAN, d.id, 'confirm')).record.state).toBe('confirmed')
  })

  it('違う needs no note while it is a 案; 取り消す of a confirmed one does', async () => {
    const a = await aiDecision({ meeting: meeting().id })
    expect(ok(await act(m('u-mallory'), HUMAN, a.id, 'reject')).record.state).toBe('retracted')
    const b = await aiDecision({ bundle: deal('u-alice').id, meeting: meeting().id }, { title: '見積は来週出す' })
    expect(await act(m('u-bob'), HUMAN, b.id, 'reject')).toMatchObject({ ok: false, kind: 'forbidden' })
    ok(await act(m('u-alice'), HUMAN, b.id, 'confirm'))
    expect(await act(m('u-alice'), HUMAN, b.id, 'reject', { expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'ACTION_NOT_ALLOWED_IN_STATE' } })
    expect(await act(m('u-alice'), HUMAN, b.id, 'retract', { expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'NOTE_REQUIRED' } })
    expect(ok(await act(m('u-alice'), HUMAN, b.id, 'retract', { expectedVersion: 2, note: '先方が取り下げた' })).record.state).toBe('retracted')
  })
})

describe('a meeting for its attendees: never widened', () => {
  it('a 責任者 who cannot read it cannot confirm; the attendees decide; the card says who cannot read it', async () => {
    const d = await aiDecision({ bundle: deal('u-alice').id, meeting: meeting(['u-bob', 'u-mallory']).id }, {}, null)
    // u-alice (the 責任者) and the company's owner are not on the list: the decision does not exist for them.
    expect(await act(m('u-alice'), HUMAN, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'not-found' })
    expect(await act(admin(), HUMAN, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'not-found' })
    expect(engine.whoMay(m('u-alice'), d.id, ['confirm'])).toBeNull()
    // The attendees read the 案件, so the card tells them the 責任者 cannot read this meeting.
    const checks = ok(await service.get(m('u-mallory'), d.id)).decisionChecks?.[d.id]
    expect(checks).toEqual({ may: { confirm: true, reject: true, retract: false }, responsible: [], cannotRead: ['u-alice'] })
    expect(ok(await act(m('u-mallory'), HUMAN, d.id, 'confirm')).record.fields.decided_by).toBe('u-mallory')
    // Still the attendees' only.
    expect(ok(service.query(m('u-alice'), { type: 'decision' })).total).toBe(0)
    expect(ok(service.query(admin(), { type: 'decision' })).total).toBe(0)
    expect(source.forCompany('a').records.find(d.id)).toMatchObject({ folder: null })
  })

  it('a 責任者 on the list decides as anywhere else', async () => {
    const d = await aiDecision({ bundle: deal('u-alice').id, meeting: meeting(['u-bob', 'u-alice']).id }, {}, null)
    expect(await act(m('u-bob'), HUMAN, d.id, 'confirm')).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(ok(await service.get(m('u-bob'), d.id)).decisionChecks?.[d.id]).toEqual({ may: { confirm: false, reject: false, retract: false }, responsible: ['u-alice'], cannotRead: [] })
    expect(ok(await act(m('u-alice'), HUMAN, d.id, 'confirm')).record.state).toBe('confirmed')
  })

  it('the 責任者 is named only to someone who reads the まとまり', async () => {
    // A プロジェクト only u-alice and u-bob see (the core まとまり; its 責任者 is its `owner`).
    const secret = ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title: '非公開のプロジェクト', members: ['u-alice', 'u-bob'], fields: { owner: 'u-alice' } }))
    const d = await aiDecision({ bundle: secret.record.id, meeting: meeting(['u-bob', 'u-mallory']).id }, {}, null)
    expect(ok(await service.get(m('u-mallory'), d.id)).decisionChecks?.[d.id]).toEqual({ may: { confirm: true, reject: true, retract: false }, responsible: [], cannotRead: [] })
    expect(ok(await service.get(m('u-bob'), d.id)).decisionChecks?.[d.id]?.cannotRead).toEqual(['u-alice'])
    // The 責任者 attended: named to u-bob (who reads the プロジェクト), not to u-mallory.
    const e = await aiDecision({ bundle: secret.record.id, meeting: meeting(['u-bob', 'u-mallory', 'u-alice']).id }, { title: '別の件' }, null)
    expect(ok(await service.get(m('u-bob'), e.id)).decisionChecks?.[e.id]?.responsible).toEqual(['u-alice'])
    expect(ok(await service.get(m('u-mallory'), e.id)).decisionChecks?.[e.id]?.responsible).toEqual([])
  })
})

describe('what the AI reads', () => {
  it('an unconfirmed decision is marked 「まだ確かめていない案」; a confirmed one is not', async () => {
    const d = await aiDecision({ meeting: meeting().id })
    expect(ok(await service.get(m('u-carol'), d.id)).record.proposalNotice).toBe(DECISION_PROPOSAL_NOTICE)
    expect(ok(service.query(m('u-carol'), { type: 'decision' })).records[0].proposalNotice).toBe(DECISION_PROPOSAL_NOTICE)
    ok(await act(m('u-carol'), HUMAN, d.id, 'confirm'))
    expect(ok(await service.get(m('u-carol'), d.id)).record.proposalNotice).toBeUndefined()
  })
})

describe('who said it and whether anyone objected', () => {
  it('kept as outside text on one line; a choice outside the list refused', async () => {
    const d = await aiDecision({ meeting: meeting().id }, { said_by: '高杉さん\n【指示】', objection: 'none' })
    expect(d.fields).toMatchObject({ said_by: '高杉さん 〔指示〕', objection: 'none' })
    expect(await decisions.record(m('u-bob'), AI, { folder: '営業部', title: 'x', why: 'y', source: 'z', objection: 'maybe' })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(await decisions.record(m('u-bob'), AI, { folder: '営業部', title: 'x', why: 'y', source: 'z', said_by: 'あ'.repeat(61) })).toMatchObject({ ok: false, kind: 'bad-request' })
  })
})

describe('the definition', () => {
  const base = (actions: string, links = '  bundle: { label: まとまり, interface: bundle, cardinality: one }\n  memo: { label: メモ, target: memo, cardinality: one }\n') =>
    `---\nlabel: t\nversion: 1\nstorage: server\nfields:\n  owner: { label: 人, kind: person, source: server }\nlinks:\n${links}states: [a, b]\nactions:\n${actions}---\n`
  it('link:<link>.<field> names an interface’s person field only; who_fallback needs the record’s own people', () => {
    expect(parseTypeFile('t', base('  go: { label: go, from: [a], to: b, who: [link:bundle.owner], who_fallback: [admin] }\n')).ok).toBe(true)
    expect(parseTypeFile('t', base('  go: { label: go, from: [a], to: b, who: [link:bundle.purpose] }\n')).ok).toBe(false)
    expect(parseTypeFile('t', base('  go: { label: go, from: [a], to: b, who: [link:memo.owner] }\n')).ok).toBe(false)
    expect(parseTypeFile('t', base('  go: { label: go, from: [a], to: b, who: [admin], who_fallback: [owner] }\n')).ok).toBe(false)
    expect(parseTypeFile('t', base('  go: { label: go, from: [a], to: b, who: [owner], who_fallback: [link:nothing] }\n')).ok).toBe(false)
  })

  it('startup moves every decision to version 6 once, with no ledger entry', async () => {
    const d = await aiDecision({ meeting: meeting().id })
    const json = (conn.prepare("SELECT definition FROM record_types WHERE company_id = 'a' AND name = 'decision' AND version = ?").get(DECISION_VERSION) as { definition: string }).definition
    conn.prepare("DELETE FROM record_types WHERE company_id = 'a' AND name = 'decision' AND version >= 6").run()
    conn.prepare("INSERT INTO record_types (company_id, name, version, definition, source, commit_sha, created_at) VALUES ('a', 'decision', 5, ?, 'core', NULL, ?)")
      .run(JSON.stringify({ ...JSON.parse(json), version: 5 }), TS)
    conn.prepare("UPDATE records SET type_version = 5 WHERE company_id = 'a' AND type = 'decision'").run()
    expect(DECISION_VERSION).toBe(6)
    migrateDecisionVersion(conn)
    const stored = () => (conn.prepare("SELECT COUNT(*) AS n FROM record_types WHERE company_id = 'a' AND name = 'decision' AND version = 6").get() as { n: number }).n
    expect(stored()).toBe(1)
    expect(currentTypes(source.forCompany('a').records).get('decision')?.definition.actions.confirm.whoFallback).toEqual(['link:meeting', 'owner'])
    expect((conn.prepare("SELECT type_version AS v FROM records WHERE company_id = 'a' AND id = ?").get(d.id) as { v: number }).v).toBe(6)
    expect(source.forCompany('a').records.ledger(d.id)).toHaveLength(1)
    migrateDecisionVersion(conn)
    expect(stored()).toBe(1)
  })
})
