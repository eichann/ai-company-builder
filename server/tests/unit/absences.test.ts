/**
 * Absence and the delegate (代わりの人, stage 2 S4; records.md "Absence and the
 * delegate") on the real schema, the real state engine, 「あなたの番」 and the
 * notices, wired as in composition.ts with the one resolution point
 * (services/absences.ts `actsFor` / `coverOf`).
 *
 * Guards (each mutation-checked: remove the check → a test here fails):
 * - the delegate acts only during the absence: before it and after it the
 *   absentee's item is neither in their list nor theirs to move;
 * - during it, with their own login: the ledger says 「代わりに（本来は X）」;
 * - the delegate never reads what they could not before — a folder closed to
 *   them, the absentee's owner-only record — and the department manager is
 *   told (「権限が足りない」), the count shown only of what the setter reads;
 * - no chains: a delegate who is absent too covers nobody; the manager is told;
 * - the absentee's notice also reaches the delegate, marked;
 * - another company's absence changes nothing here;
 * - who may set an absence: the member, their department's manager, owners /
 *   admins — nobody else.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordChange, type RecordEngine } from '../../src/services/record-engine'
import { createNotificationService, type NotificationService } from '../../src/services/notifications'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createAbsenceService, type AbsenceService } from '../../src/services/absences'
import type { Member } from '../../src/services/access'

const TS = '2026-11-01T00:00:00.000Z'
/** 2026-11-02 10:00 in Japan. */
const NOW = Date.parse('2026-11-02T01:00:00.000Z')
const MEMBERS: Record<string, string[]> = {
  a: ['u-owner', 'u-alice', 'u-bob', 'u-carol', 'u-dan', 'u-mallory'],
  b: ['u-owner', 'u-alice', 'u-bob'],
}
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let notices: NotificationService
let records: RecordService
let absences: AbsenceService
let nowMs: number

const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN = { kind: 'human' as const }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '経理', 'folder', ?)").run(`${id}-acc`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-acc-e`, `${id}-acc`, TS)
  for (const u of MEMBERS[id]) {
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-${u}`, u, id, u === 'u-owner' ? 'owner' : 'member', TS, TS)
  }
  // 経理 department: carol manages it, alice and bob belong to it.
  conn.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-d-acc`, id, '経理', '経理', TS, TS)
  conn.prepare('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}-d-acc`, 'u-carol', TS)
  source.forCompany(id).tasks.replaceDepartmentMembers(`${id}-d-acc`, ['u-alice', 'u-bob'], 'u-owner', TS)
  const recs = source.forCompany(id).records
  recs.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(recs, TS)
}

/** Bob may no longer read 経理. */
function closeAccountingTo(userId: string, co = 'a') {
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', ?, 0, 0, ?)").run(`${co}-acc-${userId}`, `${co}-acc`, userId, TS)
}

/** A task the owner asked alice for (waiting for her: todo, assignee alice). */
function taskForAlice(opts: { folder?: string; co?: string; personal?: boolean; title?: string } = {}) {
  const co = opts.co ?? 'a'
  const by = opts.personal ? 'u-alice' : 'u-owner'
  return ok(engine.create(m(by, co), HUMAN, {
    type: 'task', title: opts.title ?? '請求書を確かめる', ...(opts.folder ? { folder: opts.folder } : {}), ...(opts.personal ? { personal: true } : {}),
    fields: { assignee: 'u-alice' },
  })).record
}

const turnOf = (userId: string, co = 'a') => ok(records.myTurn(m(userId, co))).records
const away = (userId: string, delegateId: string, from = '2026-11-02', until = '2026-11-02', by = userId, co = 'a') =>
  absences.create(m(by, co), { userId, from, until, delegateId })

function wire() {
  const shared = {
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') },
  }
  const roleOf = (co: string, userId: string) => ((MEMBERS[co] ?? []).includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null)
  const accounts = { byIds: (ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id.replace('u-', '').replace(/^./, c => c.toUpperCase()) }])) }
  absences = createAbsenceService({
    ...shared, accounts, memberships: { roleOf }, timeZoneOf: () => 'Asia/Tokyo',
    delegateCannotRead: (co, absentee, delegate, setter) => notices.delegateCannotRead(co, absentee, delegate, setter),
  })
  const actsFor = (co: string, userId: string) => absences.actsFor(co, userId)
  notices = createNotificationService({
    ...shared, roleOf, accounts, push: () => {},
    coverOf: (co, userId) => absences.coverOf(co, userId),
    managersOf: (co, userId) => absences.managersOf(co, userId),
    activeAbsences: co => absences.activeToday(co),
  })
  const notify = (companyId: string, userIds: string[], change?: RecordChange) => { if (change) notices.recordChange(companyId, userIds, change) }
  const isMember = (co: string, userId: string) => (MEMBERS[co] ?? []).includes(userId)
  engine = createRecordEngine({
    ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf, notify, actsFor,
  })
  records = createRecordService({ ...shared, indexer: { schedule: async () => {} } as never, actsFor })
}

beforeEach(() => {
  nowMs = NOW
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  wire()
  company('a')
  company('b')
})

describe('the delegate acts only during the absence', () => {
  it('before, during and after: the list and the right to move the absentee\'s item; the ledger says 代わりに', async () => {
    const t = taskForAlice()
    expect(turnOf('u-bob').map(r => r.id)).not.toContain(t.id)
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'start', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })

    // Set for tomorrow: not yet.
    ok(away('u-alice', 'u-bob', '2026-11-03', '2026-11-04'))
    expect(turnOf('u-bob').map(r => r.id)).not.toContain(t.id)
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'start', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })

    nowMs = Date.parse('2026-11-03T01:00:00.000Z')
    expect(turnOf('u-bob').find(r => r.id === t.id)).toMatchObject({ actingFor: 'u-alice' })
    // Alice's own list keeps it.
    expect(turnOf('u-alice').find(r => r.id === t.id)?.actingFor).toBeUndefined()
    const done = ok(await engine.act(m('u-bob'), HUMAN, t.id, 'start', { expectedVersion: 1 }))
    expect(done.entry).toMatchObject({ actorId: 'u-bob', actorKind: 'human', onBehalfOf: 'u-alice' })
    expect(ok(engine.history(m('u-owner'), t.id)).entries.at(-1)).toMatchObject({ actorId: 'u-bob', onBehalfOf: 'u-alice' })

    // The day after it ended: over.
    nowMs = Date.parse('2026-11-05T01:00:00.000Z')
    expect(turnOf('u-bob').map(r => r.id)).not.toContain(t.id)
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'wait', { expectedVersion: 2, args: { waiting_on: '先方' } })).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
  })

  it('the absentee\'s AI turn is the delegate\'s to claim only during the absence (S10 runs it on the delegate\'s PC)', () => {
    const p = ok(engine.create(m('u-owner'), HUMAN, { type: 'task', title: '下調べ', state: 'preparing', fields: { assignee: 'u-alice' } })).record
    expect(records.aiTurnOf(m('u-bob'), p.id)).toBe('not-ai-turn')
    ok(away('u-alice', 'u-bob'))
    expect(records.aiTurnOf(m('u-bob'), p.id)).toBe('yes')
    expect(ok(records.aiTurn(m('u-bob'))).records.find(r => r.id === p.id)).toMatchObject({ actingFor: 'u-alice' })
    nowMs = Date.parse('2026-11-03T01:00:00.000Z')
    expect(records.aiTurnOf(m('u-bob'), p.id)).toBe('not-ai-turn')
  })

  it('the absentee\'s notice also reaches the delegate, marked as theirs', async () => {
    ok(away('u-alice', 'u-bob'))
    for (const u of ['u-alice', 'u-bob']) ok(notices.setSettings(m(u), { kinds: { others: true } }))
    const t = taskForAlice()
    expect(ok(notices.list(m('u-alice'))).items.map(i => i.text)).toEqual(['Ownerさんが「請求書を確かめる」であなたを担当にしました'])
    expect(ok(notices.list(m('u-bob'))).items.map(i => [i.recordId, i.forUserId, i.text]))
      .toEqual([[t.id, 'u-alice', '（Aliceさんの代わり）Ownerさんが「請求書を確かめる」であなたを担当にしました']])
  })
})

describe('the delegate\'s own permissions', () => {
  it('a folder closed to the delegate and the absentee\'s owner-only record stay unreadable; the manager is told 権限が足りない', async () => {
    closeAccountingTo('u-bob')
    const closed = taskForAlice({ folder: '経理' })
    const mine = taskForAlice({ personal: true, title: '自分用：健康診断' })
    // Set by the manager: the count is only of what the manager reads (not alice's owner-only record).
    expect(ok(away('u-alice', 'u-bob', '2026-11-02', '2026-11-02', 'u-carol')).delegateCannotRead).toBe(1)
    expect(turnOf('u-bob').map(r => r.id)).toEqual([])
    for (const id of [closed.id, mine.id]) {
      expect(await engine.act(m('u-bob'), HUMAN, id, 'start', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
    }
    const told = ok(notices.list(m('u-carol'))).items
    expect(told.map(i => [i.kind, i.recordId, i.text])).toEqual([
      ['delegate_stopped', closed.id, 'Aliceさんの不在中、代わりの人が「請求書を確かめる」を見られないため止まっています（権限が足りない）'],
    ])
    // The owner-only record reaches nobody else, not even as a stop.
    expect(conn.prepare('SELECT user_id FROM notifications WHERE record_id = ?').all(mine.id)).toEqual([])
    // A new one during the absence: no notice for the delegate who cannot read it; the manager is told.
    ok(notices.setSettings(m('u-bob'), { kinds: { others: true } }))
    const later = taskForAlice({ folder: '経理', title: '経費の精算' })
    expect(conn.prepare('SELECT user_id, kind FROM notifications WHERE record_id = ? ORDER BY user_id').all(later.id))
      .toEqual([{ user_id: 'u-alice', kind: 'others' }, { user_id: 'u-carol', kind: 'delegate_stopped' }])
    // Alice, setting it herself, is told of all three.
    ok(absences.remove(m('u-alice'), ok(absences.view(m('u-alice'))).absences[0].id))
    expect(ok(away('u-alice', 'u-bob')).delegateCannotRead).toBe(3)
  })
})

describe('no chains', () => {
  it('a delegate absent too covers nobody — their own delegate neither; the manager is told', async () => {
    const t = taskForAlice()
    ok(away('u-alice', 'u-bob'))
    // Bob cannot be chosen once he is absent; here he becomes absent after.
    ok(away('u-bob', 'u-dan'))
    expect(away('u-mallory', 'u-bob')).toMatchObject({ ok: false, body: { code: 'DELEGATE_ABSENT' } })
    for (const u of ['u-bob', 'u-dan']) {
      expect(turnOf(u).map(r => r.id)).not.toContain(t.id)
      expect(await engine.act(m(u), HUMAN, t.id, 'start', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
    }
    expect(absences.coverOf('a', 'u-alice')).toEqual({ kind: 'stopped', delegateId: 'u-bob', reason: 'delegate-absent' })
    notices.sweep('a', 500)
    expect(ok(notices.list(m('u-carol'))).items.map(i => i.text)).toEqual(['Aliceさんも代わりの人も不在のため、「請求書を確かめる」を受け持つ人がいません'])
  })
})

describe('another company', () => {
  it('an absence in another company changes nothing here', async () => {
    const t = taskForAlice()
    ok(away('u-alice', 'u-bob', '2026-11-02', '2026-11-02', 'u-alice', 'b'))
    expect(absences.actsFor('a', 'u-bob')).toEqual([])
    expect(turnOf('u-bob').map(r => r.id)).not.toContain(t.id)
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'start', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
    expect(absences.remove(m('u-owner', 'a'), ok(absences.view(m('u-alice', 'b'))).absences[0].id)).toMatchObject({ ok: false, body: { code: 'ABSENCE_NOT_FOUND' } })
  })
})

describe('who sets an absence', () => {
  it('the member, a manager of their department, an owner — not another member; the delegate must be a member here', () => {
    expect(away('u-alice', 'u-bob', '2026-11-02', '2026-11-02', 'u-mallory')).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(away('u-alice', 'u-zed')).toMatchObject({ ok: false, body: { code: 'DELEGATE_NOT_MEMBER' } })
    expect(away('u-alice', 'u-alice')).toMatchObject({ ok: false, body: { code: 'DELEGATE_SELF' } })
    ok(away('u-alice', 'u-bob', '2026-11-02', '2026-11-02', 'u-carol'))
    expect(away('u-alice', 'u-dan', '2026-11-02', '2026-11-03', 'u-owner')).toMatchObject({ ok: false, body: { code: 'ABSENCE_OVERLAP' } })
    // Dan belongs to no department carol manages.
    expect(away('u-dan', 'u-bob', '2026-11-05', '2026-11-05', 'u-carol')).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(absences.view(m('u-mallory'), 'u-alice')).toMatchObject({ ok: false, kind: 'forbidden' })
  })
})
