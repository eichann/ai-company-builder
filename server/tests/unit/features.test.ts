/**
 * 「使う機能」 (per-company feature switches, owner decisions 2026-11-07; records.md "Features on and
 * off") on the real schema behind real company handles, wired as composition.ts wires them.
 *
 * Guards:
 * - every feature is on until an owner / admin turns one off; a member cannot, a bad body changes
 *   nothing, another company is untouched;
 * - records of a feature that is off are 「見るだけ」: still readable, out of 「あなたの番」/「AI の番」, no
 *   action, undo or link change (409 FEATURE_OFF, `whoMay` offers nothing), nothing new of the type
 *   (a person's / the AI's create, the service writer, the decisions service) — and turning the
 *   feature on again continues from where it stopped;
 * - a sent mail's receipt (`interaction`) is still written while the inbox is off;
 * - the server clock moves no 「見るだけ」 record; the minutes discovery reads no calendar and the
 *   arrivals are empty while 会議 is off; no notice of a feature that is off is written;
 * - `GET /records/types` carries the features (what the app and the AI's tools follow);
 * - プロジェクト off: no 「どの〇〇の会議ですか？」 without a business kind; bundle kinds say `coreOff`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordChange, type RecordEngine, type ServiceRecordWriter } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createDecisionService, type DecisionService } from '../../src/services/decisions'
import { createFeatureService, type FeatureService } from '../../src/services/features'
import { createServerClock } from '../../src/services/server-clock'
import { createNotificationService } from '../../src/services/notifications'
import { createMinutesService } from '../../src/services/minutes'
import { createBundleKinds } from '../../src/services/bundle-kinds'
import type { Member } from '../../src/services/access'
import { noticeTurnedOff } from '../../../shared/core/features'
import type { MeetingRecordsReader } from '../../src/ports/meeting-records'

const TS = '2026-11-01T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let features: FeatureService
let engine: RecordEngine
let records: RecordService
let writer: ServiceRecordWriter
let decisions: DecisionService
let changedCompanies: string[]
let nowMs: number

const PEOPLE = ['u-owner', 'u-admin', 'u-alice', 'u-bob']
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: ROLES[userId] ?? 'member' })
const HUMAN = { kind: 'human' as const }
const AI = { kind: 'ai' as const, source: 'claude-code', conversationId: 'conv-1' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
function refusedCode(r: { ok: boolean; body?: unknown }): string | undefined {
  return r.ok ? undefined : (r.body as { code?: string }).code
}
const turnOff = (feature: string, co = 'a') => ok(features.set(m('u-owner', co), { feature, on: false }))
const turnOn = (feature: string, co = 'a') => ok(features.set(m('u-owner', co), { feature, on: true }))

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  conn.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-sales`, id, '営業部', '営業部', TS, TS)
  const r = source.forCompany(id).records
  r.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(r, TS)
}

let tick = 0
beforeEach(() => {
  tick = 0
  changedCompanies = []
  nowMs = Date.parse('2026-11-05T01:00:00.000Z')
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: () => `2026-11-05T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => nowMs }
  const ids = { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') }
  const roleOf = (_c: string, userId: string) => (PEOPLE.includes(userId) ? ROLES[userId] ?? 'member' : null)
  features = createFeatureService({
    companyData: source, clock,
    accounts: { byIds: (list: string[]) => new Map(list.map(id => [id, { email: `${id}@example.com`, name: id }])) } as never,
    changed: co => { changedCompanies.push(co) },
  })
  const typeOff = (co: string, type: string) => features.typeOff(co, type)
  const base = {
    companyData: source, transactions: sqliteTransactions(conn), clock, ids,
    isMember: (_c: string, userId: string) => PEOPLE.includes(userId), roleOf,
    notify: () => {},
  }
  engine = createRecordEngine({
    ...base,
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => false },
    managedFolders: () => [],
    featureOff: typeOff,
  })
  records = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} }, features: co => features.of(co) })
  writer = createServiceRecordWriter({ ...base, featureOff: typeOff })
  decisions = createDecisionService({
    companyData: source, writer, ids,
    tokenDigest: { digest: (t: string) => createHash('sha256').update(t).digest('hex') },
    enabled: co => features.isOn(co, 'decisions'),
  })
  company('a')
  company('b')
})

/** A meeting received for alice (the AI's turn: 「AI に読ませる」 was pressed). */
function receivedMeeting(co = 'a') {
  const r = writer.create(co, {
    type: 'meeting', title: '定例', state: 'received', members: ['u-alice'],
    fields: { assignee: 'u-alice', meeting_at: '2026-11-04T10:00:00.000Z', external_count: 0 },
    actor: { id: 'u-alice', kind: 'human', source: null },
  })
  if (!r.ok) throw new Error(r.reason)
  return r.record.id
}

/** A 返事のお願い waiting for their reply, expected by `waitUntil`. */
function waitingReplyRequest(waitUntil: string, co = 'a') {
  const r = writer.create(co, {
    type: 'reply_request', title: '見積の返事', state: 'waiting_reply',
    fields: { assignee: 'u-alice', requested_by: 'u-alice', wait_until: waitUntil, waiting_on: '先方の返事' },
    actor: { id: 'u-alice', kind: 'human', source: null },
  })
  if (!r.ok) throw new Error(r.reason)
  return r.record.id
}

const decisionBody = () => ({ folder: '営業部', title: '値引きは10%まで', why: '定例で合意', source: '定例' })

describe('the switches', () => {
  it('every feature is on until an owner or admin turns one off; a member cannot, a bad body changes nothing', () => {
    expect(features.of('a')).toEqual({ taskList: true, meetings: true, inbox: true, decisions: true, projects: true })
    const byMember = features.set(m('u-alice'), { feature: 'meetings', on: false })
    expect(byMember.ok).toBe(false)
    expect(byMember.ok ? null : byMember.kind).toBe('forbidden')
    expect(features.set(m('u-owner'), { feature: 'nothing', on: false }).ok).toBe(false)
    expect(features.set(m('u-owner'), { feature: 'meetings', on: 'no' }).ok).toBe(false)
    expect(features.of('a').meetings).toBe(true)

    const view = ok(features.set(m('u-admin'), { feature: 'meetings', on: false }))
    expect(view.features.meetings).toBe(false)
    expect(view.updatedBy).toBe('u-admin')
    expect(changedCompanies).toEqual(['a'])
    // The other switches and another company are untouched.
    expect(features.of('a')).toEqual({ taskList: true, meetings: false, inbox: true, decisions: true, projects: true })
    expect(features.of('b').meetings).toBe(true)
    expect(features.get(m('u-alice')).canEdit).toBe(false)
  })

  it('GET /records/types carries the features (the app and the AI follow them)', () => {
    expect(ok(records.types(m('u-alice'))).features.decisions).toBe(true)
    turnOff('decisions')
    expect(ok(records.types(m('u-alice'))).features.decisions).toBe(false)
  })
})

describe('「見るだけ」 and turning back on', () => {
  it('決めたこと off: nothing is recorded by a person or the AI, the old one stays readable with nothing to press, and on again it continues', async () => {
    const d = ok(await decisions.record(m('u-alice'), HUMAN, decisionBody())).record
    turnOff('decisions')

    expect(refusedCode(await decisions.record(m('u-alice'), HUMAN, { ...decisionBody(), title: '別の決めたこと' }))).toBe('FEATURE_OFF')
    expect(refusedCode(await decisions.record(m('u-alice'), AI, { ...decisionBody(), title: 'AI の決めたこと' }))).toBe('FEATURE_OFF')
    // Still there to read.
    expect(ok(await records.get(m('u-alice'), d.id)).record.title).toBe('値引きは10%まで')
    // No action: refused, and the screen is offered none.
    expect(refusedCode(await engine.act(m('u-owner'), HUMAN, d.id, 'confirm', { expectedVersion: 1 }))).toBe('FEATURE_OFF')
    expect(engine.whoMay(m('u-owner'), d.id, ['confirm'])).toBeNull()

    turnOn('decisions')
    expect(engine.whoMay(m('u-owner'), d.id, ['confirm'])?.may.confirm).toBe(true)
    ok(await engine.act(m('u-owner'), HUMAN, d.id, 'confirm', { expectedVersion: 1 }))
    expect(ok(await decisions.record(m('u-alice'), HUMAN, { ...decisionBody(), title: '別の決めたこと' })).created).toBe(true)
  })

  it('プロジェクト off: no project is made by a person or the AI; on again it is', () => {
    turnOff('projects')
    expect(refusedCode(engine.create(m('u-alice'), HUMAN, { type: 'project', title: '新製品', folder: '営業部', fields: { owner: 'u-alice' } }))).toBe('FEATURE_OFF')
    expect(refusedCode(engine.createByAi(m('u-alice'), AI, { type: 'project', title: '新製品', folder: '営業部', fields: { owner: 'u-alice' } }))).toBe('FEATURE_OFF')
    // A task is the core's: still made.
    ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積を作る' }))
    turnOn('projects')
    ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title: '新製品', folder: '営業部', fields: { owner: 'u-alice' } }))
  })

  it('会議 off: a received meeting leaves 「AI の番」, no AI step may claim it, the writer moves it no more; on again it is back', async () => {
    const id = receivedMeeting()
    expect(ok(records.aiTurn(m('u-alice'))).records.map(r => r.id)).toContain(id)
    turnOff('meetings')

    expect(ok(records.aiTurn(m('u-alice'))).records.map(r => r.id)).not.toContain(id)
    expect(records.aiTurnOf(m('u-alice'), id)).toBe('not-ai-turn')
    expect(refusedCode(await engine.act(m('u-alice'), AI, id, 'start_reading', { expectedVersion: 1 }))).toBe('FEATURE_OFF')
    const moved = writer.transition('a', { recordId: id, action: 'skip', expectedVersion: 1, to: 'skipped', actor: { id: 'u-alice', kind: 'human', source: null } })
    expect(moved.ok ? null : moved.reason).toBe('feature-off')
    // Readable on its card all the while.
    expect(ok(await records.get(m('u-alice'), id)).record.state).toBe('received')
    expect(writer.create('a', {
      type: 'meeting', title: '別の会議', members: ['u-alice'], fields: { assignee: 'u-alice' }, actor: { id: 'u-alice', kind: 'human', source: null },
    })).toMatchObject({ ok: false, reason: 'feature-off' })

    turnOn('meetings')
    expect(records.aiTurnOf(m('u-alice'), id)).toBe('yes')
    ok(await engine.act(m('u-alice'), AI, id, 'start_reading', { expectedVersion: 1 }))
  })

  it('受信 off: a 返事のお願い leaves 「あなたの番」 and takes no action, no new one is made — a sent mail\'s receipt still is', async () => {
    const r = writer.create('a', {
      type: 'reply_request', title: '見積の返事', state: 'waiting_reply',
      fields: { assignee: 'u-alice', requested_by: 'u-alice', waiting_on: '先方' },
      actor: { id: 'u-alice', kind: 'human', source: null },
    })
    if (!r.ok) throw new Error(r.reason)
    ok(await engine.act(m('u-alice'), HUMAN, r.record.id, 'resume', { expectedVersion: 1 }))
    expect(ok(records.myTurn(m('u-alice'))).records.map(x => x.id)).toContain(r.record.id)
    turnOff('inbox')

    expect(ok(records.myTurn(m('u-alice'))).records.map(x => x.id)).not.toContain(r.record.id)
    expect(refusedCode(await engine.act(m('u-alice'), HUMAN, r.record.id, 'close', { expectedVersion: 2 }))).toBe('FEATURE_OFF')
    expect(writer.create('a', {
      type: 'reply_request', title: '別の返事', fields: { assignee: 'u-alice' }, actor: { id: 'u-alice', kind: 'human', source: null },
    })).toMatchObject({ ok: false, reason: 'feature-off' })
    // The receipt of a mail sent from ACB: sending stays on.
    expect(writer.create('a', {
      type: 'interaction', title: '送ったメール', fields: { channel: 'email' }, actor: { id: 'u-alice', kind: 'human', source: null },
    }).ok).toBe(true)

    turnOn('inbox')
    expect(ok(records.myTurn(m('u-alice'))).records.map(x => x.id)).toContain(r.record.id)
  })
})

describe('the clock and the notices', () => {
  function clockFor() {
    return createServerClock({
      companyData: source, clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
      companyIds: () => ['a'], writer, notifications: { sweep: () => 0 },
      autoRunFor: () => false, timeZoneOf: () => 'Asia/Tokyo',
      yieldNow: async () => {}, log: () => {},
    })
  }

  // The service writer refuses to move a 「見るだけ」 record, so the clock's move of it does not happen.
  it('受信 off: the clock moves no 返事のお願い whose wait is over; on again, the next run does', async () => {
    const id = waitingReplyRequest('2026-11-03')
    turnOff('inbox')
    expect((await clockFor().runOnce()).moved).toBe(0)
    expect(source.forCompany('a').records.states([id])[0].state).toBe('waiting_reply')
    turnOn('inbox')
    expect((await clockFor().runOnce()).moved).toBe(1)
    expect(source.forCompany('a').records.states([id])[0].state).toBe('open')
  })

  it('no notice of a feature that is off: its own kinds, and any notice about a 「見るだけ」 record', async () => {
    const notices = createNotificationService({
      companyData: source, clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
      ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID() },
      accounts: { byIds: ids => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }])) },
      push: () => {},
      roleOf: (_c, u) => (PEOPLE.includes(u) ? 'member' : null),
      noticeOff: (co, kind, type) => noticeTurnedOff(features.of(co), kind, type),
    })
    const id = waitingReplyRequest('2026-11-30')
    const change = (version: number): RecordChange => ({
      type: 'reply_request',
      entry: {
        recordId: id, version, action: 'resume', fromState: 'waiting_reply', toState: 'open', actorId: 'u-bob', actorKind: 'human', actorSource: null,
        at: TS, note: '', changes: [], attachments: [], decision: null, isDecision: false, typeVersion: 5, reversesVersion: null, proposedBy: null, conversationId: null, runId: null,
      },
      fields: { assignee: 'u-alice', next_actor: 'u-alice' },
    })
    const count = () => (conn.prepare("SELECT COUNT(*) AS n FROM notifications WHERE company_id = 'a'").get() as { n: number }).n
    turnOff('inbox')
    notices.recordChange('a', ['u-alice'], change(2))
    expect(count()).toBe(0)
    turnOn('inbox')
    notices.recordChange('a', ['u-alice'], change(2))
    expect(count()).toBe(1)
    // The rule itself: a kind the feature owns, whatever the record.
    expect(noticeTurnedOff({ taskList: true, meetings: false, inbox: true, decisions: true, projects: true }, 'minutes_arrived', null)).toBe(true)
    expect(noticeTurnedOff({ taskList: true, meetings: true, inbox: true, decisions: true, projects: true }, 'minutes_arrived', 'meeting')).toBe(false)
  })
})

describe('会議 and プロジェクト in the minutes service and bundle kinds', () => {
  let calendarReads: number
  function minutesService() {
    calendarReads = 0
    const reader = {
      meetEvents: async () => { calendarReads++; return [] },
    } as unknown as MeetingRecordsReader
    return createMinutesService({
      companyData: source, writer, meetings: reader,
      clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
      tokenDigest: { digest: (t: string) => createHash('sha256').update(t).digest('hex') },
      members: () => [{ userId: 'u-alice', email: 'alice@example.com', name: 'alice', role: 'member' }],
      enabled: co => features.isOn(co, 'meetings'),
      projectsOn: co => features.isOn(co, 'projects'),
    })
  }

  it('会議 off: the clock\'s discovery reads no calendar, arrivals are empty and ［AI に読ませる］ is refused; on again it reads', async () => {
    const minutes = minutesService()
    const id = receivedMeeting()
    turnOff('meetings')
    expect(await minutes.pollCompany('a')).toBe(0)
    expect(calendarReads).toBe(0)
    expect(ok(minutes.arrivals(m('u-alice'))).items).toEqual([])
    expect(refusedCode(await minutes.requestReading(m('u-alice'), id, {}))).toBe('FEATURE_OFF')
    turnOn('meetings')
    await minutes.pollCompany('a')
    expect(calendarReads).toBeGreaterThan(0)
    expect(ok(minutes.arrivals(m('u-alice'))).items.map(i => i.recordId)).toContain(id)
  })

  it('プロジェクト off: a meeting with someone from outside is not asked 「どの〇〇の会議ですか？」 when only the core kind exists', async () => {
    const minutes = minutesService()
    ok(engine.create(m('u-alice'), HUMAN, { type: 'project', title: '新製品', folder: '営業部', fields: { owner: 'u-alice' } }))
    const made = writer.create('a', {
      type: 'meeting', title: 'A社と打ち合わせ', state: 'received', members: ['u-alice'],
      fields: { assignee: 'u-alice', meeting_at: '2026-11-04T10:00:00.000Z', external_count: 2 },
      actor: { id: 'u-alice', kind: 'human', source: null },
    })
    if (!made.ok) throw new Error(made.reason)
    ok(await engine.act(m('u-alice'), AI, made.record.id, 'start_reading', { expectedVersion: 1 }))
    ok(await engine.act(m('u-alice'), AI, made.record.id, 'finish_reading', { expectedVersion: 2, args: { summary_text: 'まとめ' } }))
    expect(ok(minutes.bundleQuestions(m('u-alice'))).questions.map(q => q.recordId)).toEqual([made.record.id])
    turnOff('projects')
    expect(ok(minutes.bundleQuestions(m('u-alice'))).questions).toEqual([])

    const kinds = createBundleKinds({
      companyData: source, shelf: { find: () => null } as never, settingsOf: () => ({ bundleName: 'プロジェクト' }),
      projectsOn: co => features.isOn(co, 'projects'),
    })
    expect(ok(kinds.kinds(m('u-alice'))).coreOff).toBe(true)
    turnOn('projects')
    expect(ok(kinds.kinds(m('u-alice'))).coreOff).toBeUndefined()
  })
})
