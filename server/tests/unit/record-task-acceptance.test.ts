/**
 * Acceptance (引き受け, task version 7; records.md "Acceptance", owner decision
 * 2026-11-01) on the real schema and the real engine, wired as composition.ts
 * does: the company's task settings decide through services/task-acceptance.ts,
 * the delegate through services/absences.ts `actsFor`, the notices and the
 * server clock's sweep through services/notifications.ts.
 *
 * Guards (each mutation-checked: remove the check → a test here fails):
 * - only the assignee accepts — or their delegate, and only during the absence;
 *   the requester, another member and the AI (even the assignee's own) cannot;
 * - asked across departments → 引き受け待ち; each automatic case follows its
 *   setting (same department, a manager to their member, the AI's meeting
 *   homework for an attendee) and is off when the setting is off;
 * - nobody skips it by writing `accepted_by` on create;
 * - an owner-only task never waits;
 * - another company's departments and settings decide nothing here, and its
 *   record id is a record that does not exist;
 * - still waiting a business day later → the requester is told once.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordChange, type RecordEngine } from '../../src/services/record-engine'
import { createNotificationService, type NotificationService } from '../../src/services/notifications'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createAbsenceService, type AbsenceService } from '../../src/services/absences'
import { createTaskSettingsService } from '../../src/services/task-settings'
import { createTaskAcceptance } from '../../src/services/task-acceptance'
import { defaultTaskSettings, type AcceptanceSettings } from '../../shared/core/task-settings'
import type { Member } from '../../src/services/access'

const TS = '2026-11-01T00:00:00.000Z'
/** Friday 2026-11-06 10:00 in Japan. */
const FRIDAY_10 = Date.parse('2026-11-06T01:00:00.000Z')
const MEMBERS: Record<string, string[]> = {
  a: ['u-owner', 'u-alice', 'u-bob', 'u-carol', 'u-dan'],
  b: ['u-owner', 'u-alice', 'u-dan'],
}
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let writer: ReturnType<typeof createServiceRecordWriter>
let notices: NotificationService
let records: RecordService
let absences: AbsenceService
let nowMs: number

const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN = { kind: 'human' as const }
const AI = { kind: 'ai' as const, source: 'claude-code' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

/**
 * Company `a`: 営業 (alice, bob; carol manages it) and 経理 (dan). Company `b`:
 * alice and dan share 総務 — a membership that must not count in `a`.
 */
function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  for (const u of MEMBERS[id]) {
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-${u}`, u, id, u === 'u-owner' ? 'owner' : 'member', TS, TS)
  }
  const dept = (key: string, name: string, members: string[], manager?: string) => {
    conn.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-${key}`, id, name, name, TS, TS)
    if (manager) conn.prepare('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}-${key}`, manager, TS)
    source.forCompany(id).tasks.replaceDepartmentMembers(`${id}-${key}`, members, 'u-owner', TS)
  }
  if (id === 'a') {
    dept('sales', '営業', ['u-alice', 'u-bob'], 'u-carol')
    dept('acc', '経理', ['u-dan'])
  } else {
    dept('ga', '総務', ['u-alice', 'u-dan'], 'u-alice')
  }
  const recs = source.forCompany(id).records
  recs.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(recs, TS)
}

function setAcceptance(co: string, acceptance: Partial<AcceptanceSettings>) {
  const s = defaultTaskSettings()
  source.forCompany(co).tasks.save({ settings: JSON.stringify({ ...s, acceptance: { ...s.acceptance, ...acceptance } }), updatedAt: TS, updatedBy: 'u-owner' })
}

// Each ask is its own item: one meeting's tasks of the same title are one (minutes.md "Outputs made once").
let asked = 0
function ask(by: string, assignee: string, opts: { co?: string; actor?: typeof HUMAN | typeof AI; links?: Record<string, string>; personal?: boolean } = {}) {
  return ok(engine.create(m(by, opts.co ?? 'a'), opts.actor ?? HUMAN, {
    type: 'task', title: `請求書を確かめる ${++asked}`, fields: { assignee }, ...(opts.links ? { links: opts.links } : {}), ...(opts.personal ? { personal: true } : {}),
  })).record
}

function meeting(attendees: string[], co = 'a') {
  const r = writer.create(co, {
    type: 'meeting', title: '定例', fields: { assignee: 'u-alice', attendees: JSON.stringify(attendees) }, links: {}, actor: { id: 'u-alice', kind: 'human' },
  })
  if (!r.ok) throw new Error(r.reason)
  return r.record.id
}

const turnOf = (userId: string, co = 'a') => ok(records.myTurn(m(userId, co))).records.map(r => r.id)

function wire() {
  const shared = {
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') },
  }
  const roleOf = (co: string, userId: string) => ((MEMBERS[co] ?? []).includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null)
  const isMember = (co: string, userId: string) => (MEMBERS[co] ?? []).includes(userId)
  const accounts = { byIds: (ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }])) }
  const taskSettings = createTaskSettingsService({ ...shared, accounts: accounts as never, memberships: { listByCompany: () => [] } as never, guardWrite: (_a, _f, _r, mutate) => ({ ok: true as const, value: mutate() }) })
  absences = createAbsenceService({ ...shared, accounts, memberships: { roleOf }, timeZoneOf: () => 'Asia/Tokyo' })
  const actsFor = (co: string, userId: string) => absences.actsFor(co, userId)
  notices = createNotificationService({
    ...shared, roleOf, accounts, push: () => {},
    timeZoneOf: () => 'Asia/Tokyo', holidaysOf: co => taskSettings.settingsOf(co).companyHolidays.map(h => h.date),
  })
  const notify = (companyId: string, userIds: string[], change?: RecordChange) => { if (change) notices.recordChange(companyId, userIds, change) }
  const acceptance = createTaskAcceptance({ companyData: source, settingsOf: co => taskSettings.settingsOf(co) })
  engine = createRecordEngine({
    ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf, notify, actsFor,
    autoAccepts: acceptance.autoAccepts,
  })
  writer = createServiceRecordWriter({ ...shared, isMember, roleOf, notify: () => {} })
  records = createRecordService({ ...shared, indexer: { schedule: async () => {} } as never, actsFor })
}

/** The member's notices (the kinds used here are on by default). */
const noticesOf = (userId: string, co = 'a') => ok(notices.list(m(userId, co))).items.map(i => ({ kind: i.kind, recordId: i.recordId }))

beforeEach(() => {
  nowMs = FRIDAY_10
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  wire()
  company('a')
  company('b')
})

describe('who may accept', () => {
  it('asked across departments: 引き受け待ち in the assignee\'s turn; only the assignee accepts — not the requester, another member or any AI — and the requester is told', async () => {
    const t = ask('u-alice', 'u-dan')
    expect(t).toMatchObject({ state: 'awaiting_acceptance', fields: { assignee: 'u-dan', next_actor: 'u-dan' } })
    expect(t.fields.accepted_by ?? null).toBeNull()
    expect(turnOf('u-dan')).toContain(t.id)
    // Work cannot start before it is accepted.
    expect(await engine.act(m('u-dan'), HUMAN, t.id, 'start', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'ACTION_NOT_ALLOWED_IN_STATE' } })
    for (const [who, actor] of [['u-alice', HUMAN], ['u-bob', HUMAN], ['u-owner', HUMAN], ['u-dan', AI], ['u-alice', AI]] as const) {
      expect(await engine.act(m(who), actor, t.id, 'accept', { expectedVersion: 1 }), `${who} ${actor.kind}`).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
    }
    const r = ok(await engine.act(m('u-dan'), HUMAN, t.id, 'accept', { expectedVersion: 1 }))
    expect(r.record).toMatchObject({ state: 'todo', fields: { accepted_by: 'u-dan', next_actor: 'u-dan' } })
    expect(noticesOf('u-alice')).toContainEqual({ kind: 'request_accepted', recordId: t.id })
    // Now theirs: no second acceptance is asked on the way.
    expect(ok(await engine.act(m('u-dan'), HUMAN, t.id, 'start', { expectedVersion: 2 })).record.state).toBe('in_progress')
  })

  it('the delegate accepts on the assignee\'s behalf only during the absence', async () => {
    const t = ask('u-alice', 'u-dan')
    ok(absences.create(m('u-dan'), { userId: 'u-dan', from: '2026-11-09', until: '2026-11-09', delegateId: 'u-bob' }))
    // Before the absence: not bob's.
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'accept', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
    nowMs = Date.parse('2026-11-09T01:00:00.000Z')
    expect(await engine.act(m('u-bob'), AI, t.id, 'accept', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
    const r = ok(await engine.act(m('u-bob'), HUMAN, t.id, 'accept', { expectedVersion: 1 }))
    expect(r.entry).toMatchObject({ actorId: 'u-bob', onBehalfOf: 'u-dan' })
    expect(r.record).toMatchObject({ state: 'todo', fields: { accepted_by: 'u-dan' } })
    // After the absence it is not bob's any more.
    const later = ask('u-alice', 'u-dan')
    nowMs = Date.parse('2026-11-10T01:00:00.000Z')
    expect(await engine.act(m('u-bob'), HUMAN, later.id, 'accept', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
  })

  it('the AI handing over what it prepared is not the assignee accepting, even when it is the assignee\'s AI', async () => {
    const t = ok(engine.create(m('u-alice'), AI, { type: 'task', title: '下調べ', state: 'preparing', fields: { assignee: 'u-dan' } })).record
    expect(t.state).toBe('preparing')
    const r = ok(await engine.act(m('u-dan'), AI, t.id, 'finish_prep', { expectedVersion: 1, args: { prep_summary: '調べました' } }))
    expect(r.record).toMatchObject({ state: 'awaiting_acceptance', fields: { next_actor: 'u-dan' } })
  })

  it('受けられない from 引き受け待ち goes back to the requester; reopening asks the assignee again', async () => {
    const t = ask('u-alice', 'u-dan')
    const d = ok(await engine.act(m('u-dan'), HUMAN, t.id, 'decline', { expectedVersion: 1, note: '今週は無理です' }))
    expect(d.record).toMatchObject({ state: 'declined', fields: { next_actor: 'u-alice' } })
    const again = ok(await engine.act(m('u-alice'), HUMAN, t.id, 'reopen', { expectedVersion: 2 }))
    expect(again.record).toMatchObject({ state: 'awaiting_acceptance', fields: { next_actor: 'u-dan' } })
  })
})

describe('when it is accepted by itself (the company\'s setting)', () => {
  it('the same department: automatic, and waits when the setting is off', () => {
    expect(ask('u-alice', 'u-bob')).toMatchObject({ state: 'todo', fields: { accepted_by: 'u-bob' } })
    setAcceptance('a', { sameDepartment: false })
    expect(ask('u-alice', 'u-bob').state).toBe('awaiting_acceptance')
  })

  it('a department manager to a member of it: automatic, and waits when the setting is off', () => {
    expect(ask('u-carol', 'u-alice')).toMatchObject({ state: 'todo', fields: { accepted_by: 'u-alice' } })
    // carol manages 営業, not 経理.
    expect(ask('u-carol', 'u-dan').state).toBe('awaiting_acceptance')
    setAcceptance('a', { managerToMember: false })
    expect(ask('u-carol', 'u-alice').state).toBe('awaiting_acceptance')
  })

  it('reassigning asks the new assignee by the same rule (the one reassigning is the asker)', async () => {
    const t = ask('u-alice', 'u-bob')
    const moved = ok(await engine.act(m('u-alice'), HUMAN, t.id, 'assign', { expectedVersion: 1, note: 'お願いします', args: { assignee: 'u-dan' } }))
    expect(moved.record).toMatchObject({ state: 'awaiting_acceptance', fields: { assignee: 'u-dan', next_actor: 'u-dan' } })
    // dan (経理) asked bob; bob, having accepted, hands it to alice of his own department: automatic.
    const u = ask('u-dan', 'u-bob')
    ok(await engine.act(m('u-bob'), HUMAN, u.id, 'accept', { expectedVersion: 1 }))
    const passed = ok(await engine.act(m('u-bob'), HUMAN, u.id, 'assign', { expectedVersion: 2, note: '代わりに', args: { assignee: 'u-alice' } }))
    expect(passed.record).toMatchObject({ state: 'todo', fields: { assignee: 'u-alice', accepted_by: 'u-alice' } })
  })

  it('the AI\'s homework of a meeting the assignee attended: automatic; not for a person, nor for someone absent from it, nor with the setting off', () => {
    const mtg = meeting(['u-alice', 'u-dan'])
    expect(ask('u-alice', 'u-dan', { actor: AI, links: { meeting: mtg } })).toMatchObject({ state: 'todo', fields: { accepted_by: 'u-dan' } })
    expect(ask('u-alice', 'u-dan', { links: { meeting: mtg } }).state).toBe('awaiting_acceptance')
    expect(ask('u-alice', 'u-dan', { actor: AI, links: { meeting: meeting(['u-alice']) } }).state).toBe('awaiting_acceptance')
    expect(ask('u-alice', 'u-dan', { actor: AI }).state).toBe('awaiting_acceptance')
    setAcceptance('a', { meetingHomework: false })
    expect(ask('u-alice', 'u-dan', { actor: AI, links: { meeting: mtg } }).state).toBe('awaiting_acceptance')
  })

  it('nobody skips it by writing who accepted on create', () => {
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', fields: { assignee: 'u-dan', accepted_by: 'u-dan' } }))
      .toMatchObject({ ok: false, body: { code: 'BAD_VALUE' } })
    // …nor by naming the assignee as the requester.
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', fields: { assignee: 'u-dan', requested_by: 'u-dan' } }))
      .toMatchObject({ ok: true, value: { record: { state: 'awaiting_acceptance' } } })
  })

  it('a task for oneself and an owner-only task never wait, whatever the settings', () => {
    setAcceptance('a', { sameDepartment: false, managerToMember: false, meetingHomework: false })
    expect(ask('u-dan', 'u-dan').state).toBe('todo')
    expect(ask('u-dan', 'u-dan', { personal: true, actor: AI })).toMatchObject({ state: 'todo', fields: { accepted_by: 'u-dan' } })
  })
})

describe('cross-company', () => {
  it('another company\'s departments and settings decide nothing; its record ids do not exist here', async () => {
    // alice and dan share 総務 in b (alice manages it), not in a.
    expect(ask('u-alice', 'u-dan').state).toBe('awaiting_acceptance')
    expect(ask('u-alice', 'u-dan', { co: 'b' }).state).toBe('todo')
    setAcceptance('b', { sameDepartment: false, managerToMember: false })
    expect(ask('u-alice', 'u-bob').state).toBe('todo')
    const theirs = ask('u-owner', 'u-dan', { co: 'b' })
    expect(theirs.state).toBe('awaiting_acceptance')
    expect(await engine.act(m('u-dan'), HUMAN, theirs.id, 'accept', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'not-found' })
  })
})

describe('still waiting a business day later (the server clock)', () => {
  it('the requester is told once, the next business day at the same time — not before, not twice, nobody else', () => {
    const t = ask('u-alice', 'u-dan')
    // Monday 09:59 (the weekend does not count): not yet.
    nowMs = Date.parse('2026-11-09T00:59:00.000Z')
    expect(notices.sweep('a', 500)).toBe(0)
    nowMs = Date.parse('2026-11-09T01:00:00.000Z')
    expect(notices.sweep('a', 500)).toBe(1)
    expect(notices.sweep('a', 500)).toBe(0)
    expect(noticesOf('u-alice').filter(n => n.kind === 'acceptance_waiting')).toEqual([{ kind: 'acceptance_waiting', recordId: t.id }])
    expect(noticesOf('u-dan').filter(n => n.kind === 'acceptance_waiting')).toEqual([])
  })

  it('an accepted request is never reported', async () => {
    const t = ask('u-alice', 'u-dan')
    ok(await engine.act(m('u-dan'), HUMAN, t.id, 'accept', { expectedVersion: 1 }))
    nowMs = Date.parse('2026-11-10T01:00:00.000Z')
    expect(notices.sweep('a', 500)).toBe(0)
  })
})
