/**
 * Settled notices (片付いた, 4b-4 「自動で読む・知らせ・受け箱の数」 第1.1版 D4; `shared/core/notification-settle.ts`,
 * `notifications.md` "Settled notices"): `GET /me/notifications` marks an unread notice `settled` when what it asked
 * for is clearly over, judged from the current state of the meeting / occurrence / job — on the real schema, the real
 * service writer and the notice service as composition.ts wires it (the jobs' answers stood in by what
 * `jobs.noticeJob` / `jobs.occurrenceNotice` answer).
 *
 * Guards (each fails when its check is removed):
 * - only the four clear kinds settle, each by its own condition; an unknown kind and an unknown state never do;
 * - a settled notice is not read and nothing is written: the unread count and the stored rows stay as they were;
 * - a read notice is never marked.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createServiceRecordWriter, type ServiceRecordWriter } from '../../src/services/record-engine'
import { createNotificationService, type NotificationService } from '../../src/services/notifications'
import type { Member } from '../../src/services/access'
import { NOTICE_SETTLE_RULES, noticeSettled } from '../../../shared/core/notification-settle'
import { NOTIFICATION_KINDS } from '../../../shared/types/notifications'

const TS = '2026-11-25T00:00:00.000Z'
const CO = 'a'
const MEMBERS = ['u-owner', 'u-alice', 'u-bob']
let conn: Database.Database
let source: CompanyDataSource
let writer: ServiceRecordWriter
let notices: NotificationService
/** What the jobs service answers now (the occurrence's and the job's state); null = not the member's to see. */
let occurrence: { state: string } | null
let job: { state: string } | null

const m = (userId: string): Member => ({ companyId: CO, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const roleOf = (co: string, userId: string) => (co === CO && MEMBERS.includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null)
const GOOGLE = { kind: 'external' as const, id: 'google', source: 'Google' }

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('root', ?, '', 'company', ?)").run(CO, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('root-r', 'root', 'everyone', NULL, 1, 1, ?)").run(TS)
  const records = source.forCompany(CO).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  const shared = {
    companyData: source, transactions: sqliteTransactions(conn),
    clock: { now: () => TS, nowMs: () => Date.parse(TS) },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '').repeat(2) },
  }
  occurrence = { state: 'needs_person' }
  job = { state: 'paused' }
  notices = createNotificationService({
    ...shared, roleOf, push: () => {},
    accounts: { byIds: ids => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }])) },
    jobNoticeOf: member => (member.role === 'owner' && job ? { name: '週の報告', state: job.state } : null),
    jobOccurrenceNoticeOf: () => (occurrence ? { name: '週の報告', dueSlot: '2026-11-25T09:00', outcomeCode: 'RUN_FAILED', state: occurrence.state } : null),
  })
  writer = createServiceRecordWriter({ ...shared, isMember: (co, u) => co === CO && MEMBERS.includes(u), roleOf, notify: (co, userIds, change) => { if (change) notices.recordChange(co, userIds, change) } })
})

/** A meeting that arrived for alice and bob (`minutes_arrived` to both, as the minutes service writes it). */
function arrivedMeeting(): { id: string; version: number } {
  const r = writer.create(CO, {
    type: 'meeting', title: '定例ミーティング', members: ['u-alice', 'u-bob'], actor: GOOGLE,
    fields: { meeting_at: TS, attendees: '[]' }, notify: ['u-alice', 'u-bob'],
  })
  if (!r.ok) throw new Error(JSON.stringify(r))
  return { id: r.record.id, version: r.entry.version }
}

function recordless(userId: string, kind: string, dedupeKey: string) {
  source.forCompany(CO).notifications.insert([{
    id: crypto.randomUUID(), userId, kind, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null, dedupeKey, createdAt: TS, readAt: null,
  }])
}

const listOf = (userId: string) => {
  const r = notices.list(m(userId))
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const settledKinds = (userId: string) => listOf(userId).items.filter(i => i.settled === true).map(i => i.kind).sort()
const stored = () => conn.prepare('SELECT id, kind, read_at, dedupe_key, action, created_at FROM notifications ORDER BY id').all()

describe('the table (shared/core/notification-settle.ts)', () => {
  it('only the four clear kinds settle; every other kind of today never does, whatever is known', () => {
    expect(Object.keys(NOTICE_SETTLE_RULES).sort()).toEqual(['job_expired', 'job_failed', 'job_paused', 'minutes_arrived'])
    const everything = { meetingState: 'read', occurrenceState: 'done', jobState: 'active' }
    for (const kind of [...NOTIFICATION_KINDS, 'a_kind_of_a_later_build']) {
      expect(noticeSettled(kind, everything)).toBe(kind in NOTICE_SETTLE_RULES)
    }
  })

  it('each kind by its own condition, and an unknown state never settles', () => {
    expect(noticeSettled('minutes_arrived', { meetingState: 'arrived' })).toBe(false)
    expect(noticeSettled('minutes_arrived', { meetingState: 'received' })).toBe(true)
    expect(noticeSettled('minutes_arrived', { meetingState: null })).toBe(false)
    expect(noticeSettled('minutes_arrived', { occurrenceState: 'done', jobState: 'active' })).toBe(false)
    for (const kind of ['job_failed', 'job_expired']) {
      for (const s of ['done', 'nothing']) expect(noticeSettled(kind, { occurrenceState: s })).toBe(true)
      for (const s of ['due', 'running', 'needs_person', 'expired', 'held', 'skipped', null]) expect(noticeSettled(kind, { occurrenceState: s })).toBe(false)
      expect(noticeSettled(kind, { meetingState: 'read', jobState: 'active' })).toBe(false)
    }
    expect(noticeSettled('job_paused', { jobState: 'active' })).toBe(true)
    for (const s of ['paused', 'retired', 'draft', null]) expect(noticeSettled('job_paused', { jobState: s })).toBe(false)
    expect(noticeSettled('job_paused', { occurrenceState: 'done', meetingState: 'read' })).toBe(false)
  })
})

describe('GET /me/notifications marks settled notices (never stored, never read)', () => {
  it('「議事録が届きました」 settles once someone asked the AI to read it — for every attendee — and not before', () => {
    const meeting = arrivedMeeting()
    expect(listOf('u-alice').items.map(i => i.kind)).toEqual(['minutes_arrived'])
    expect(settledKinds('u-alice')).toEqual([])
    const before = stored()
    // Bob presses ［AI に読ませる］ (the minutes service's write, quiet).
    const moved = writer.transition(CO, { recordId: meeting.id, action: 'request_reading', expectedVersion: meeting.version, to: 'received', fields: { assignee: 'u-bob' }, actor: { kind: 'human', id: 'u-bob' }, quiet: true })
    expect(moved.ok).toBe(true)
    for (const u of ['u-alice', 'u-bob']) {
      const l = listOf(u)
      expect(l.items).toHaveLength(1)
      expect(l.items[0]).toMatchObject({ kind: 'minutes_arrived', read: false, settled: true })
      // Not read: the unread count stays, and nothing was written.
      expect(l.unread).toBe(1)
    }
    expect(stored()).toEqual(before)
  })

  it('a read notice is never marked settled', () => {
    const meeting = arrivedMeeting()
    writer.transition(CO, { recordId: meeting.id, action: 'request_reading', expectedVersion: meeting.version, to: 'received', fields: { assignee: 'u-bob' }, actor: { kind: 'human', id: 'u-bob' }, quiet: true })
    const id = listOf('u-alice').items[0].id
    expect(notices.markRead(m('u-alice'), { ids: [id] }).ok).toBe(true)
    expect(listOf('u-alice').items[0]).toMatchObject({ read: true })
    expect(listOf('u-alice').items[0].settled).toBeUndefined()
  })

  it('「止まりました」 / 「期限切れ」 settle only once that occurrence ran afterwards', () => {
    recordless('u-alice', 'job_failed', 'job_failed:job.1:occ.1:0:RUN_FAILED')
    recordless('u-alice', 'job_expired', 'job_expired:job.1:occ.2:0:EXPIRED')
    recordless('u-alice', 'job_skipped', 'job_skipped:job.1:occ.3:0:OWNER_ABSENT')
    for (const state of ['needs_person', 'due', 'running', 'expired', 'held']) {
      occurrence = { state }
      expect(settledKinds('u-alice')).toEqual([])
    }
    const before = stored()
    occurrence = { state: 'done' }
    // job_skipped is not one of the four: it stays as it was (できた・未確認 already).
    expect(settledKinds('u-alice')).toEqual(['job_expired', 'job_failed'])
    expect(listOf('u-alice').unread).toBe(3)
    occurrence = { state: 'nothing' }
    expect(settledKinds('u-alice')).toEqual(['job_expired', 'job_failed'])
    expect(stored()).toEqual(before)
  })

  it('「止めました」 settles once the job runs again; retired or still paused stays', () => {
    recordless('u-owner', 'job_paused', `job_paused:job.1:OWNER_LEFT:${TS}`)
    expect(settledKinds('u-owner')).toEqual([])
    job = { state: 'retired' }
    expect(settledKinds('u-owner')).toEqual([])
    job = { state: 'active' }
    expect(settledKinds('u-owner')).toEqual(['job_paused'])
    expect(listOf('u-owner').unread).toBe(1)
  })
})
