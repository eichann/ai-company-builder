/**
 * The notices (知らせ, stage 2 S5, `.claude/rules/notifications.md`; contract
 * `shared/types/notifications.ts`): what happened that concerns a member —
 * a task they asked for was completed, their approval request was answered,
 * a due they set was pushed back… — kept per company × member on the server
 * with the read state, so the member's PCs agree.
 *
 * - Written at the engine's existing notify points (`recordChange`, wired in
 *   composition.ts next to the push channel): only kind, record, version and
 *   actor. No value, title or note is stored.
 * - The text is built when the member reads, and only for a record they can
 *   read NOW (`recordReader`): a member who lost access sees nothing of it.
 * - Overdue (A-2: to the requester, once per due, the next business morning
 *   in company time) and a stuck AI turn (C-18: 24 h, to the requester, once
 *   per version) are written by the server clock (`sweep`, services/
 *   server-clock.ts); the same rule runs when the member reads, as a safety
 *   net — the dedupe keys make the two meet once.
 * - Noticing one's own turn without Slack (owner decision 2026-11-03): being
 *   asked (`asked`, on every person's assignment and on the AI's hand-over of
 *   what someone asked, once per assignment), the business morning's
 *   「今日のあなたの番」 (`morning_summary`, the clock, once per member and
 *   business day, counts only — built when read) and a due on the next
 *   business day (`due_tomorrow`, the clock, to the assignee, once per due
 *   value). Fresh ones carry `desktop`: the app's Mac notification.
 * - The push channel carries only `{ kind: 'notifications', version }`, a
 *   fresh value: the app asks again; it never acts on the signal.
 */
import { isNotificationKind, NOTIFICATION_DEFAULTS, NOTIFICATION_KINDS, NOTIFICATION_LIST_MAX, RECORDLESS_NOTIFICATION_KINDS } from '../../shared/types/notifications'
import type { NotificationItem, NotificationKind, NotificationList, NotificationSettings } from '../../shared/types/notifications'
import { DEFAULT_COMPANY_TIME_ZONE } from '../../shared/core/calendar'
import type { LedgerEntry, LedgerValue } from '../../shared/core/record-ledger'
import { aiTurnStates, noTurnStates, type TypeDefinition } from '../../shared/core/record-types'
import { addDays, isBusinessDay, nextBusinessDay } from '../../shared/core/business-days'
import { acceptanceOf, CLOCK_ACTOR, INBOX_ACTIONS, INBOX_ACTOR, INTAKE_UNSURE_STATE, MESSAGE_TYPE, messageOriginLinks, WAIT_OVER_ACTION, waitCameBack } from '../../shared/core/core-types'
import { restingTask, turnTiming } from '../../shared/core/turn-timing'
import { MEETING_ARRIVED_STATE, MEETING_ATTENDEES_ACTION, MEETING_TYPE } from '../../shared/core/minutes'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { NotificationRow } from '../ports/notifications'
import type { RecordAccessRow, RecordRow } from '../ports/records'
import type { AbsenceCover } from '../../shared/core/absences'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader } from './record-access'
import type { RecordChange } from './record-engine'
import { currentTypes } from './record-index'
import { waitingFor } from './records'

export interface NotificationServiceDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  accounts: Pick<AccountDirectory, 'byIds'>
  /** Tell these members their notices changed (push channel: kind + a fresh version only). */
  push: (companyId: string, userIds: string[]) => void
  /** The member's role in the company, or null (a notice goes only to someone who reads the record). */
  roleOf: (companyId: string, userId: string) => string | null
  /** The company's time zone for a due without one (records.md "Due with a time"); Japan by default. */
  timeZoneOf?: (companyId: string) => string
  /** The company's own days off (`YYYY-MM-DD`, task settings): an overdue notice waits for a business morning. */
  holidaysOf?: (companyId: string) => string[]
  /**
   * Stage 3 (E-26): Slack DMs for important notices plug in here
   * (services/slack-notices.ts, wired in composition.ts) — called with the
   * notices just written (no text: kind, record, member), whatever the bell's
   * kind switches: the DM is about 「あなたの番」 (like the Mac notification)
   * and has its own switch (Slack's 知らせの DM). Must not block.
   */
  outside?: (companyId: string, rows: NotificationRow[]) => void
  /**
   * Absence and the delegate (records.md "Absence and the delegate";
   * services/absences.ts, the one resolution point): who covers an absentee
   * today, whom a stop is told to (the managers of their departments) and
   * today's absences (the clock's check). Nobody is absent without them.
   */
  coverOf?: (companyId: string, userId: string) => AbsenceCover | null
  managersOf?: (companyId: string, userId: string) => string[]
  activeAbsences?: (companyId: string) => Array<{ userId: string; delegateId: string }>
  /** Every member of the company (the morning summary is per member). None without it: no summary. */
  membersOf?: (companyId: string) => string[]
  /** Whom the member covers today (their 「あなたの番」 holds those items too; services/absences.ts). */
  actsFor?: (companyId: string, userId: string) => string[]
}

/** Why an absentee's item reaches nobody (a `delegate_stopped` notice's dedupe key ends with it). */
type StopReason = 'cannot-read' | 'delegate-absent'

/** An overdue notice is written from this hour (company time) of the first business day after the due's day (A-2). */
export const OVERDUE_NOTICE_HOUR = 9

/**
 * The latest business morning that has begun (`YYYY-MM-DD`): today when it is
 * a business day and OVERDUE_NOTICE_HOUR has come, else the business day
 * before. A due whose day is before it has had its morning: notify (A-2,
 * 「翌朝」 — after a Friday or before a holiday, the next business day's).
 */
export function overdueMorning(nowMs: number, timeZone: string, holidays: string[]): string {
  const now = companyNow(nowMs, timeZone)
  let day = now.slice(0, 10)
  if (isBusinessDay(day, holidays) && Number(now.slice(11, 13)) >= OVERDUE_NOTICE_HOUR) return day
  // A year has at most ~130 days off; 400 steps cannot be reached by valid input.
  for (let i = 0; i < 400; i++) {
    day = addDays(day, -1)
    if (isBusinessDay(day, holidays)) return day
  }
  return day
}

/**
 * When a request still waiting for acceptance is reported to its requester:
 * the same time of day on the first business day after the day it began to
 * wait (company time; weekends, Japanese holidays and the company's own days
 * off skipped) — 「1営業日たっても引き受けられていない」. `waitingSince` is the
 * company's local `YYYY-MM-DDTHH:MM`; so is the answer (they compare as text).
 */
export function acceptanceReminderAt(waitingSince: string, holidays: string[]): string {
  return `${nextBusinessDay(waitingSince.slice(0, 10), new Set(holidays))}T${waitingSince.slice(11, 16)}`
}

/**
 * 「今日のあなたの番」 (owner decision 2026-11-03): written from this time of a
 * business morning (company time) by the server clock, and not after
 * MORNING_SUMMARY_UNTIL — a server that was down all morning skips the day
 * rather than greet the member in the evening. The app shows it as a Mac
 * notification only until then too (it opened late: no stale greeting).
 */
export const MORNING_SUMMARY_FROM = '08:30'
export const MORNING_SUMMARY_UNTIL = '15:00'
/** 「明日が期限」 is written from this time of the last business day before the due's day. */
export const DUE_TOMORROW_FROM = '09:00'
/** Being asked shows as a Mac notification only this long after it happened (an app opened days later stays quiet). */
export const ASKED_DESKTOP_FRESH_MS = 12 * 60 * 60_000

/**
 * The due days a 「明日が期限」 notice is written for today (`YYYY-MM-DD`,
 * company time): today is a business day and the due's day is after today
 * but not after the next business day — the due's eve, or, when the days
 * before the due are off (a Monday due, a due on a holiday), the last
 * business day before it. Null on a day off. `[from, toExclusive)` compare
 * as text with a date or a date + time due.
 */
export function dueTomorrowDays(today: string, holidays: string[]): { from: string; toExclusive: string } | null {
  if (!isBusinessDay(today, holidays)) return null
  return { from: addDays(today, 1), toExclusive: addDays(nextBusinessDay(today, new Set(holidays)), 1) }
}

/** Notices older than this are forgotten (when the member next reads). */
export const NOTIFICATION_KEEP_DAYS = 90
/** An AI turn that has not moved for this long is reported to the requester (C-18). */
export const AI_TURN_STUCK_MS = 24 * 60 * 60_000

/** Rows read per member before the kind and read filters (the list shows NOTIFICATION_LIST_MAX). */
const ROWS_READ = 500
/** Requests looked at per member for the computed notices. */
const MAX_COMPUTED_CANDIDATES = 2000

const READ_IDS_MAX = 200
const BAD_READ = 'Send { ids: [notice ids] } (up to 200) or { all: true }'
const BAD_SETTINGS = 'Send { kinds: { <kind>: true | false } }'

const str = (v: LedgerValue | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** The company's local date and time now in `timeZone`, `YYYY-MM-DDTHH:MM`. */
export function companyNow(nowMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(nowMs))
  const p = (type: Intl.DateTimeFormatPartTypes) => parts.find(x => x.type === type)?.value ?? '00'
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`
}

/** `2026-11-05` → 11月5日, `2026-11-05T15:00` → 11月5日 15:00. */
function dueText(due: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/.exec(due)
  if (!m) return due
  return `${Number(m[2])}月${Number(m[3])}日${m[4] ? ` ${m[4]}` : ''}`
}

/** An action's label in the past tense (完了にする → 完了にしました), or null when unsure. */
function pastTense(label: string): string | null {
  if (label.endsWith('する')) return `${label.slice(0, -2)}しました`
  if (/[えけせてねへめれげぜでべ]る$/.test(label)) return `${label.slice(0, -1)}ました`
  if (label.endsWith('す')) return `${label.slice(0, -1)}しました`
  return null
}

/**
 * Which kind of notice an entry is for this member (the owner's kinds, E-25).
 * Generic over types: final states and the `request` fields decide, plus the
 * core `approval` type's results.
 */
export function noticeKind(userId: string, change: RecordChange, final: ReadonlySet<string>): NotificationKind {
  const { entry, fields, type } = change
  const stateChanged = entry.fromState !== entry.toState
  // The server clock moved a wait that is over to the follow-up's turn (on by default).
  if (entry.action === WAIT_OVER_ACTION && entry.actorId === CLOCK_ACTOR.id) return 'wait_over'
  // The inbox (inbox.md): their reply came; a message's owner is asked to decide (確認待ち).
  if (entry.action === INBOX_ACTIONS.replyArrived && entry.actorId === INBOX_ACTOR.id) return 'reply_arrived'
  if (type === 'interaction' && stateChanged && entry.toState === INTAKE_UNSURE_STATE) return 'intake_unsure'
  // The mailbox (inbox.md "Mail archived in the mailbox"): closed here because it left the inbox there;
  // archived there because it was closed here. Each with ［元に戻す］.
  if (type === 'interaction' && entry.actorId === INBOX_ACTOR.id && entry.action === INBOX_ACTIONS.leftInbox) return 'mail_left_inbox'
  if (type === 'interaction' && entry.actorId === INBOX_ACTOR.id && entry.action === INBOX_ACTIONS.archivedThere) return 'mail_archived'
  if (type === 'approval' && stateChanged && entry.fromState !== null && str(fields.requested_by) === userId) return 'approval_result'
  // What the member asked was accepted (引き受ける, or accepted by itself on a change): the assignee's turn now.
  const acceptance = acceptanceOf(type)
  if (acceptance && stateChanged && entry.fromState === acceptance.state && entry.toState !== null && acceptance.working.includes(entry.toState) &&
    str(fields.requested_by) === userId && str(fields.assignee) !== userId) return 'request_accepted'
  if (stateChanged && entry.toState !== null && final.has(entry.toState)) {
    if (entry.changes.some(c => c.field === 'ok_by' && c.after === userId)) return 'ok_completed'
    if (str(fields.requested_by) === userId) return 'request_done'
  }
  // What the member asked came back to them (受けられない): not final, but now their turn again.
  if (stateChanged && str(fields.requested_by) === userId && str(fields.next_actor) === userId && str(fields.assignee) !== userId) return 'request_returned'
  if (str(fields.requested_by) === userId && entry.changes.some(c => c.field === 'due')) return 'due_changed'
  return 'others'
}

/**
 * Whether this entry asks `userId` something (`asked`, owner decision
 * 2026-11-03): a request type's entry that leaves them its assignee in a
 * person's turn, and either made them the assignee (a create, an `assign`) or
 * handed it over from a turn that told nobody (the AI's preparation, a
 * proposal: `noTurnStates`). The asker is the requester (else whoever made
 * them the assignee), never themselves. `since` is the version of the entry
 * that made them the assignee: one notice per assignment (dedupe key), so a
 * hand-over after a create that already told them tells nothing more.
 */
export function askedOf(userId: string, change: RecordChange, def: TypeDefinition | undefined, ledger: () => LedgerEntry[]): { asker: string; since: number } | null {
  if (!def || !def.implements.includes('request')) return null
  const { entry, fields } = change
  if (str(fields.assignee) !== userId || entry.toState === null) return null
  const quiet = noTurnStates(def)
  if (quiet.has(entry.toState)) return null
  const madeAssignee = entry.changes.some(c => c.field === 'assignee' && c.after === userId)
  const handedOver = entry.fromState !== null && entry.fromState !== entry.toState && quiet.has(entry.fromState) && !def.final.includes(entry.fromState)
  if (!madeAssignee && !handedOver) return null
  let since = entry.version
  let assignedBy: string | null = entry.actorId
  if (!madeAssignee) {
    const set = [...ledger()].reverse().find(e => e.changes.some(c => c.field === 'assignee' && c.after === userId))
    if (!set) return null
    since = set.version
    assignedBy = set.actorId
  }
  const asker = str(fields.requested_by) ?? assignedBy
  return asker === null || asker === userId ? null : { asker, since }
}

/**
 * 「議事録が届きました」 (minutes.md "Meetings for their attendees"): a meeting recorded in
 * `arrived`, or attendees joining it while it is still there. The minutes service names the
 * meeting's people; only those who read it get it (members-only: its list).
 */
export function minutesArrivedOf(change: RecordChange): boolean {
  return change.type === MEETING_TYPE && change.entry.toState === MEETING_ARRIVED_STATE &&
    (change.entry.action === 'create' || change.entry.action === MEETING_ATTENDEES_ACTION)
}

/**
 * Whether this entry is the member's own AI giving them a request it made from a message that came
 * in (`from_message`, owner FB #13: the AI turned a mail into the owner's task and nobody was told,
 * since the actor was "the owner"). Narrow on purpose: the AI made the record (its create entry is
 * the member's AI), the record names a message as its origin (`messageOriginLinks`), and this
 * entry leaves the member its assignee in a person's turn — at the create, or when the AI hands
 * its preparation over (`noTurnStates`). Not a person's own create, not the AI's other actions;
 * what someone else asked of them stays `asked`. Once per record (dedupe key).
 */
export function fromMessageOf(userId: string, change: RecordChange, def: TypeDefinition | undefined, ledger: () => LedgerEntry[], originIds: (names: string[]) => string[]): boolean {
  if (!def || !def.implements.includes('request')) return false
  const { entry, fields } = change
  if (entry.actorKind !== 'ai' || entry.actorId !== userId || str(fields.assignee) !== userId || entry.toState === null) return false
  const quiet = noTurnStates(def)
  if (quiet.has(entry.toState)) return false
  const handedOver = entry.fromState !== null && entry.fromState !== entry.toState && quiet.has(entry.fromState) && !def.final.includes(entry.fromState)
  if (entry.action !== 'create' && !handedOver) return false
  const made = entry.action === 'create' ? entry : ledger().find(e => e.action === 'create')
  if (!made || made.actorKind !== 'ai' || made.actorId !== userId) return false
  const names = messageOriginLinks(def)
  return names.length > 0 && originIds(names).length > 0
}

/**
 * Whether this entry is the member's own AI completing their task because their reply finished it
 * (`replied_done`, owner FB #19; the inbox's reply check, `INBOX_ACTIONS.repliedDone`): their AI is
 * the actor, they are the assignee, it reached a final state. The notice carries the entry's version,
 * so the app's ［元に戻す］ undoes exactly it.
 */
export function repliedDoneOf(userId: string, change: RecordChange, final: ReadonlySet<string>): boolean {
  const { entry, fields } = change
  return entry.action === INBOX_ACTIONS.repliedDone && entry.actorKind === 'ai' && entry.actorId === userId
    && str(fields.assignee) === userId && entry.toState !== null && final.has(entry.toState)
}

export function createNotificationService(deps: NotificationServiceDeps) {
  const { companyData, clock } = deps

  function kindsOf(handle: CompanyData, userId: string): Record<NotificationKind, boolean> {
    const kinds = { ...NOTIFICATION_DEFAULTS }
    const raw = handle.notifications.settings(userId)
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Record<string, unknown>
        for (const k of NOTIFICATION_KINDS) if (typeof saved[k] === 'boolean') kinds[k] = saved[k] as boolean
      } catch { /* a broken row reads as the defaults */ }
    }
    return kinds
  }

  /** Read checks of several members in one company (each their own reader, built once). */
  function readersIn(companyId: string, handle: CompanyData) {
    const scopes = handle.scopes.listWithRules()
    const readers = new Map<string, ReturnType<typeof recordReader> | null>()
    return (userId: string, rec: RecordAccessRow): boolean => {
      if (!readers.has(userId)) {
        const role = deps.roleOf(companyId, userId)
        readers.set(userId, role === null ? null : recordReader({ companyId, userId, role }, scopes))
      }
      return readers.get(userId)?.record(rec) ?? false
    }
  }

  /**
   * An absentee's item that reaches nobody — their delegate cannot read it
   * (「権限が足りない」) or is absent too (no chains) — told once to the
   * managers of the absentee's departments who can read it.
   */
  function stopRows(companyId: string, mayRead: (userId: string, rec: RecordAccessRow) => boolean, rec: RecordAccessRow, version: number, absenteeId: string, reason: StopReason): NotificationRow[] {
    const now = clock.now()
    return (deps.managersOf?.(companyId, absenteeId) ?? []).filter(m => mayRead(m, rec)).map(m => ({
      id: deps.ids.newId(), userId: m, kind: 'delegate_stopped', recordId: rec.id, recordVersion: version, action: '',
      actorId: null, actorKind: null, dedupeKey: `delegate_stopped:${rec.id}:${absenteeId}:${reason}`, createdAt: now, readAt: null, forUserId: absenteeId,
    }))
  }

  /**
   * The absentee's waiting items (their 「あなたの番」, read as them) that
   * their delegate cannot read now; with `tell`, the stop notices for them
   * (and for every item when the delegate is absent too).
   */
  function coverCheck(companyId: string, absenteeId: string, cover: AbsenceCover, tell: boolean, countFor: string = absenteeId): { cannotRead: number; written: number } {
    const handle = companyData.forCompany(companyId)
    if (!handle.records.settings().enabled) return { cannotRead: 0, written: 0 }
    const mayRead = readersIn(companyId, handle)
    const waiting = waitingFor(handle.records, [absenteeId], new Set(handle.plugins.oldConnectionRecordIds()))
      .filter(w => mayRead(absenteeId, w.row))
      .slice(0, MAX_COMPUTED_CANDIDATES)
    const versions = new Map(handle.records.states(waiting.map(w => w.row.id)).map(s => [s.recordId, s.version]))
    const blocked = cover.kind === 'stopped' ? waiting : waiting.filter(w => !mayRead(cover.delegateId, w.row))
    const cannotRead = blocked.filter(w => mayRead(countFor, w.row)).length
    if (!tell) return { cannotRead, written: 0 }
    const reason: StopReason = cover.kind === 'stopped' ? 'delegate-absent' : 'cannot-read'
    const rows = blocked.flatMap(w => stopRows(companyId, mayRead, w.row, versions.get(w.row.id) ?? 0, absenteeId, reason))
    return { cannotRead, written: writeComputed(companyId, handle, rows) }
  }

  /**
   * Overdue requests (A-2) and stuck AI turns (C-18) among `candidates`, as
   * notice rows for their requester — only a requester who can read the
   * record now (an owner-only record's requester is its owner, and a notice
   * goes to nobody else). One rule for the server clock's sweep and the
   * read-time safety net; the dedupe keys make the two meet once.
   */
  function dueRowsOf(companyId: string, handle: CompanyData, candidates: RecordAccessRow[], defs: Map<string, TypeDefinition>, requester: string | null): NotificationRow[] {
    if (candidates.length === 0) return []
    const nowMs = clock.nowMs()
    const now = clock.now()
    const timeZone = deps.timeZoneOf?.(companyId) ?? DEFAULT_COMPANY_TIME_ZONE
    const holidays = deps.holidaysOf?.(companyId) ?? []
    const morning = overdueMorning(nowMs, timeZone, holidays)
    const byId = new Map(candidates.map(r => [r.id, r]))
    const scopes = handle.scopes.listWithRules()
    const readers = new Map<string, ReturnType<typeof recordReader> | null>()
    const readerOf = (userId: string) => {
      if (!readers.has(userId)) {
        const role = deps.roleOf(companyId, userId)
        readers.set(userId, role === null ? null : recordReader({ companyId, userId, role }, scopes))
      }
      return readers.get(userId) ?? null
    }
    const rows: NotificationRow[] = []
    for (const s of handle.records.states(candidates.map(r => r.id))) {
      const rec = byId.get(s.recordId)
      const def = rec ? defs.get(rec.type) : undefined
      if (!rec || !def || s.state === null || def.final.includes(s.state)) continue
      let fields: Record<string, LedgerValue> = {}
      try { fields = JSON.parse(s.fields) as Record<string, LedgerValue> } catch { continue }
      const requestedBy = str(fields.requested_by)
      const assignee = str(fields.assignee)
      if (requestedBy === null || (requester !== null && requestedBy !== requester)) continue
      // What the member asked of someone else: their own work is already on their own list.
      if (assignee === null || assignee === requestedBy) continue
      if (!readerOf(requestedBy)?.record(rec)) continue
      const base = { userId: requestedBy, recordId: s.recordId, recordVersion: s.version, action: '', actorId: null, actorKind: null, createdAt: now, readAt: null }
      const due = str(fields.due)
      if (due !== null && due.slice(0, 10) < morning) {
        rows.push({ ...base, id: deps.ids.newId(), kind: 'overdue', dedupeKey: `overdue:${s.recordId}:${due}` })
      }
      // Still not accepted a business day after it began to wait: told once per wait (the entry that began it).
      if (s.state === acceptanceOf(rec.type)?.state) {
        const ledger = handle.records.ledger(rec.id)
        const began = [...ledger].reverse().find(e => e.toState === s.state && e.fromState !== s.state)
        if (began && companyNow(nowMs, timeZone) >= acceptanceReminderAt(companyNow(Date.parse(began.at), timeZone), holidays)) {
          rows.push({ ...base, id: deps.ids.newId(), kind: 'acceptance_waiting', dedupeKey: `acceptance_waiting:${s.recordId}:${began.version}` })
        }
      }
      if (aiTurnStates(def).has(s.state) && nowMs - Date.parse(s.updatedAt) >= AI_TURN_STUCK_MS) {
        rows.push({ ...base, id: deps.ids.newId(), kind: 'ai_turn_stuck', dedupeKey: `ai_turn_stuck:${s.recordId}:${s.version}` })
      }
    }
    return rows
  }

  function requestTypes(handle: CompanyData): Map<string, TypeDefinition> {
    return new Map([...currentTypes(handle.records)].filter(([, t]) => t.definition.implements.includes('request')).map(([n, t]) => [n, t.definition]))
  }

  /** Write computed rows (a dedupe key already there is skipped); signal the members who got a new one with its kind on. */
  function writeComputed(companyId: string, handle: CompanyData, rows: NotificationRow[]): number {
    if (rows.length === 0) return 0
    const written = new Set(handle.notifications.insert(rows))
    const fresh = rows.filter(r => written.has(r.id))
    if (fresh.length === 0) return 0
    const told = [...new Set(fresh.filter(r => kindsOf(handle, r.userId)[r.kind as NotificationKind]).map(r => r.userId))]
    if (told.length > 0) { try { deps.push(companyId, told) } catch { /* their own check catches up */ } }
    // The morning summary and 「明日が期限」 are the app's own reminders, not an outside message.
    const outside = fresh.filter(r => r.kind !== 'morning_summary' && r.kind !== 'due_tomorrow')
    if (outside.length > 0) { try { deps.outside?.(companyId, outside) } catch { /* never fails the notices */ } }
    return fresh.length
  }

  const zoneOf = (companyId: string) => deps.timeZoneOf?.(companyId) ?? DEFAULT_COMPANY_TIME_ZONE
  const holidaysOf = (companyId: string) => deps.holidaysOf?.(companyId) ?? []

  /**
   * The member's 「あなたの番」 this week — the same items the title bar counts
   * (`records.myTurn`: their own and those of whom they cover, read with
   * their reader; only `turnTiming` `now`, shared/core/turn-timing.ts: a task
   * not started with no due or one after this week is not counted) — with how
   * many are due today and past due (company day).
   */
  function turnCounts(companyId: string, handle: CompanyData, userId: string, mayRead: (userId: string, rec: RecordAccessRow) => boolean, today: string) {
    const waiting = waitingFor(handle.records, [userId, ...(deps.actsFor?.(companyId, userId) ?? [])], new Set(handle.plugins.oldConnectionRecordIds()))
      .filter(w => mayRead(userId, w.row))
    const types = new Map(waiting.map(w => [w.row.id, w.row.type]))
    let total = 0
    let dueToday = 0
    let overdue = 0
    for (const s of handle.records.states(waiting.map(w => w.row.id))) {
      let fields: Record<string, LedgerValue> = {}
      try { fields = JSON.parse(s.fields) as Record<string, LedgerValue> } catch { continue }
      const r = { type: types.get(s.recordId) ?? '', state: s.state, fields }
      // A resting task given back by the clock waits for the member (read the ledger only then).
      const back = restingTask(r) && waitCameBack(r.type, handle.records.ledger(s.recordId)) !== null
      if (turnTiming({ ...r, waitCameBack: back }, today) !== 'now') continue
      total++
      const day = str(fields.due)?.slice(0, 10)
      if (day === today) dueToday++
      else if (day !== undefined && day < today) overdue++
    }
    return { total, dueToday, overdue }
  }

  /**
   * 「今日のあなたの番」: on a business day between MORNING_SUMMARY_FROM and
   * MORNING_SUMMARY_UNTIL (company time), one notice per member who has
   * something in 「あなたの番」 and is not absent today (`morning_summary:<day>`;
   * no record — the counts are built when read). Nothing on a day off.
   */
  function morningRows(companyId: string, handle: CompanyData, limit: number): NotificationRow[] {
    const now = companyNow(clock.nowMs(), zoneOf(companyId))
    const today = now.slice(0, 10)
    const time = now.slice(11, 16)
    if (!isBusinessDay(today, holidaysOf(companyId)) || time < MORNING_SUMMARY_FROM || time >= MORNING_SUMMARY_UNTIL) return []
    const key = `morning_summary:${today}`
    const done = new Set(handle.notifications.usersWithKey(key))
    const mayRead = readersIn(companyId, handle)
    const rows: NotificationRow[] = []
    for (const userId of (deps.membersOf?.(companyId) ?? []).filter(u => !done.has(u)).slice(0, limit)) {
      if (deps.coverOf?.(companyId, userId)) continue // absent today: their delegate has it
      if (turnCounts(companyId, handle, userId, mayRead, today).total === 0) continue
      rows.push({
        id: deps.ids.newId(), userId, kind: 'morning_summary', recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
        dedupeKey: key, createdAt: clock.now(), readAt: null,
      })
    }
    return rows
  }

  /**
   * 「明日が期限」: from DUE_TOMORROW_FROM of the last business day before a
   * request's due day (`dueTomorrowDays`), to its assignee who can read it,
   * unless it is final (done, cancelled). Once per due value
   * (`due_tomorrow:<record>:<due>`): a due moved later is told again.
   */
  function dueTomorrowRows(companyId: string, handle: CompanyData, defs: Map<string, TypeDefinition>, limit: number): NotificationRow[] {
    const now = companyNow(clock.nowMs(), zoneOf(companyId))
    const days = dueTomorrowDays(now.slice(0, 10), holidaysOf(companyId))
    if (!days || now.slice(11, 16) < DUE_TOMORROW_FROM) return []
    const open = [...new Set([...defs.values()].flatMap(d => d.states.filter(st => !d.final.includes(st))))]
    const candidates = handle.records.candidates({ types: [...defs.keys()], states: open, ranges: [{ name: 'due', gte: days.from, lt: days.toExclusive }] }, limit)
    const byId = new Map(candidates.map(r => [r.id, r]))
    const mayRead = readersIn(companyId, handle)
    const rows: NotificationRow[] = []
    for (const st of handle.records.states(candidates.map(r => r.id))) {
      const rec = byId.get(st.recordId)
      const def = rec ? defs.get(rec.type) : undefined
      if (!rec || !def || st.state === null || def.final.includes(st.state)) continue
      let fields: Record<string, LedgerValue> = {}
      try { fields = JSON.parse(st.fields) as Record<string, LedgerValue> } catch { continue }
      const assignee = str(fields.assignee)
      const due = str(fields.due)
      if (assignee === null || due === null || !mayRead(assignee, rec)) continue
      rows.push({
        id: deps.ids.newId(), userId: assignee, kind: 'due_tomorrow', recordId: rec.id, recordVersion: st.version, action: '', actorId: null, actorKind: null,
        dedupeKey: `due_tomorrow:${rec.id}:${due}`, createdAt: clock.now(), readAt: null,
      })
    }
    return rows
  }

  /** The read-time safety net: what the member asked for, by the clock's rule (no duplicates: same keys). */
  function computeDue(member: Member, handle: CompanyData, reader: ReturnType<typeof recordReader>) {
    const defs = requestTypes(handle)
    if (defs.size === 0) return
    const candidates = handle.records.candidates({ types: [...defs.keys()], fields: [{ name: 'requested_by', values: [member.userId] }] }, MAX_COMPUTED_CANDIDATES)
      .filter(r => reader.record(r))
    writeComputed(member.companyId, handle, dueRowsOf(member.companyId, handle, candidates, defs, member.userId))
  }

  const personText = (id: string | null | undefined, names: Map<string, { email: string; name: string | null }>) => {
    const a = id ? names.get(id) : undefined
    return a ? `${a.name || a.email}さん` : 'だれか'
  }

  function actorText(row: NotificationRow, names: Map<string, { email: string; name: string | null }>): string {
    if (row.actorKind === 'external') return row.actorId === CLOCK_ACTOR.id ? 'ACB' : 'つないでいるサービス'
    const a = row.actorId ? names.get(row.actorId) : undefined
    const who = a ? `${a.name || a.email}さん` : 'だれか'
    return row.actorKind === 'ai' ? `${who}の AI` : who
  }

  function textOf(row: NotificationRow, rec: RecordRow, def: TypeDefinition | undefined, handle: CompanyData, names: Map<string, { email: string; name: string | null }>): string {
    const t = `「${rec.title}」`
    const actor = actorText(row, names)
    const entry = () => handle.records.ledger(rec.id).find(e => e.version === row.recordVersion)
    if (row.kind === 'delegate_stopped') {
      const who = personText(row.forUserId, names)
      return row.dedupeKey?.endsWith(':delegate-absent')
        ? `${who}も代わりの人も不在のため、${t}を受け持つ人がいません`
        : `${who}の不在中、代わりの人が${t}を見られないため止まっています（権限が足りない）`
    }
    const text = row.kind === 'asked' ? askedText(row, t, personText(row.actorId, names), def, entry) : textFor(row, t, actor, def, entry)
    return row.forUserId ? `（${personText(row.forUserId, names)}の代わり）${text}` : text
  }

  /** 「Aliceさんから「見積書」を頼まれました」 (+ the AI prepared it first; + 引き受け待ち asks to decide). */
  function askedText(row: NotificationRow, t: string, asker: string, def: TypeDefinition | undefined, entry: () => LedgerEntry | undefined): string {
    const since = Number(row.dedupeKey?.split(':').at(-1))
    const prepared = since !== row.recordVersion ? '（AI が用意しました）' : ''
    const awaiting = def !== undefined && entry()?.toState === acceptanceOf(def.name)?.state ? '。引き受けるか、受けられないかを決めてください' : ''
    return `${asker}から${t}を頼まれました${prepared}${awaiting}`
  }

  /** 「明日が期限」's due (from its dedupe key) and the words for it, relative to `today`. */
  function dueTomorrowWords(row: NotificationRow, today: string): { due: string; when: string } {
    const due = row.dedupeKey?.split(':').slice(2).join(':') ?? ''
    return { due, when: due.slice(0, 10) === addDays(today, 1) ? '明日' : dueText(due.slice(0, 10)) }
  }

  /** The morning summary's words: 「今日のあなたの番 5件（期限が今日 2件・期限を過ぎた 1件）」. */
  function morningText(c: { total: number; dueToday: number; overdue: number }): string {
    if (c.total === 0) return '今日のあなたの番は、いまはありません'
    const parts = [...(c.dueToday > 0 ? [`期限が今日 ${c.dueToday}件`] : []), ...(c.overdue > 0 ? [`期限を過ぎた ${c.overdue}件`] : [])]
    return `今日のあなたの番 ${c.total}件${parts.length > 0 ? `（${parts.join('・')}）` : ''}`
  }

  function textFor(row: NotificationRow, t: string, actor: string, def: TypeDefinition | undefined, entry: () => LedgerEntry | undefined): string {
    switch (row.kind as NotificationKind) {
      case 'approval_result': {
        const to = entry()?.toState
        if (to === 'approved') return `${t}が承認されました（${actor}）`
        if (to === 'sent_back') return `${t}が差し戻されました（${actor}）`
        if (to === 'withdrawn') return `${t}は取り下げられました`
        if (to === 'stale') return `${t}は中身が変わったため、使えなくなりました`
        if (to === 'failed') return `${t}は承認されましたが、実行できませんでした`
        return `${t}の状態が変わりました`
      }
      case 'request_accepted':
        return entry()?.action === 'accept' ? `${actor}が${t}を引き受けました` : `${t}は担当の人が受け持つことになりました（${actor}）`
      case 'acceptance_waiting':
        return `${t}は、頼んでから 1 営業日たってもまだ引き受けられていません。担当の人に声をかけるか、ほかの人に頼んでください`
      case 'ok_completed':
        return `${actor}が${t}を、あなたの OK で完了にしました`
      case 'request_done': {
        const label = def?.actions[row.action]?.label
        const past = label ? pastTense(label) : null
        return past ? `${actor}が${t}を${past}` : `${t}が終わりました（${actor}）`
      }
      case 'request_returned': {
        const label = def?.actions[row.action]?.label
        return `${actor}が${t}をあなたに戻しました${label ? `（${label}）` : ''}`
      }
      case 'due_changed': {
        const after = entry()?.changes.find(c => c.field === 'due')?.after
        return typeof after === 'string' ? `${actor}が${t}の期限を${dueText(after)}に変えました` : `${actor}が${t}の期限をなくしました`
      }
      case 'overdue': {
        const due = row.dedupeKey?.split(':').slice(2).join(':') ?? ''
        return `${t}が期限（${dueText(due)}）を過ぎています`
      }
      case 'reply_arrived':
        return `${t}に相手から返事が来ました。AI が終わりの条件と照らし合わせます`
      case 'from_message':
        return `来た連絡から、やることを作りました：${t}`
      case 'minutes_arrived':
        return `議事録が届きました：${t}`
      case 'replied_done':
        return `返事をしたので完了にしました：${t}`
      case 'mail_left_inbox':
        return `${entry()?.note || 'メールでアーカイブ済み'}のため、閉じました：${t}`
      case 'mail_archived':
        return `${entry()?.note || 'メールでもアーカイブしました'}：${t}`
      case 'intake_unsure':
        return `${t}は誰が受け持つか決めきれませんでした。自分の担当にするか、やることにしないかを決めてください`
      case 'ai_turn_stuck':
        return `${t}の AI の番が 24 時間以上進んでいません。担当の人のアプリが閉じているかもしれません`
      case 'wait_over': {
        const to = entry()?.toState
        const ai = to !== undefined && to !== null && def !== undefined && aiTurnStates(def).has(to)
        return `${t}の返事・届く見込みの日時が過ぎました。${ai ? 'AI が追いかけを用意します' : '追いかけてください'}`
      }
      default: {
        // Asked and waiting for the member's 「引き受ける」.
        if ((row.action === 'create' || row.action === 'assign') && entry()?.toState === acceptanceOf(def?.name ?? '')?.state) {
          return `${actor}から${t}を頼まれました。引き受けるか、受けられないかを決めてください`
        }
        if (row.action === 'create') return `${actor}が${t}であなたを担当にしました`
        if (row.action === 'undo') return `${actor}が${t}の変更を取り消しました`
        const label = def?.actions[row.action]?.label
        // 用意ができた: already a sentence about the record.
        if (label?.endsWith('た')) return `${t}の${label}（${actor}）`
        const past = label ? pastTense(label) : null
        return past ? `${actor}が${t}で${past}` : `${t}が動きました（${actor}）`
      }
    }
  }

  return {
    /**
     * The engine told these members about this entry (composition.ts): one
     * notice each (never the actor), then a content-free push to those who
     * have that kind on. Never throws into the engine.
     */
    recordChange(companyId: string, userIds: string[], change: RecordChange): void {
      const handle = companyData.forCompany(companyId)
      const def = currentTypes(handle.records).get(change.type)?.definition
      const final = new Set(def?.final ?? [])
      const now = clock.now()
      const rows: NotificationRow[] = []
      // Only members who can read the record now get a notice (and a signal): an owner-only
      // record's notice reaches its owner alone, admins included (records.md "Owner-only").
      const rec = handle.records.byIds([change.entry.recordId])[0]
      const scopes = handle.scopes.listWithRules()
      const mayRead = (userId: string) => {
        const role = deps.roleOf(companyId, userId)
        return rec !== undefined && role !== null && recordReader({ companyId, userId, role }, scopes).record(rec)
      }
      const recipients = new Set(userIds)
      const stops: NotificationRow[] = []
      const readerOf = readersIn(companyId, handle)
      let ledger: LedgerEntry[] | null = null
      const ledgerOf = () => (ledger ??= handle.records.ledger(change.entry.recordId))
      /** The messages the record names under these origin links (records of the message type only). */
      const originIdsOf = (names: string[]) => {
        const ids = handle.records.linksFrom([change.entry.recordId]).filter(l => names.includes(l.name) && l.targetId !== null).map(l => l.targetId as string)
        return handle.records.byIds(ids).filter(r => r.type === MESSAGE_TYPE).map(r => r.id)
      }
      for (const userId of recipients) {
        if (!mayRead(userId)) continue
        const asked = askedOf(userId, change, def, ledgerOf)
        const fromMessage = !asked && fromMessageOf(userId, change, def, ledgerOf, originIdsOf)
        // Their own AI completed what their reply finished (the inbox's reply check, owner FB #19).
        const repliedDone = !asked && !fromMessage && repliedDoneOf(userId, change, final)
        // Never the actor — except their own AI handing them what someone else asked, or what it
        // made them from a message that came in (they did not do that).
        if (userId === change.entry.actorId && !((asked || fromMessage || repliedDone) && change.entry.actorKind === 'ai')) continue
        // A meeting's minutes arrived (minutes.md): once per meeting and member, whoever's calendar found it.
        const arrived = !asked && !fromMessage && !repliedDone && minutesArrivedOf(change)
        const kind = asked ? 'asked' : fromMessage ? 'from_message' : repliedDone ? 'replied_done' : arrived ? 'minutes_arrived' : noticeKind(userId, change, final)
        const base = arrived
          ? {
            recordId: change.entry.recordId, recordVersion: change.entry.version, action: change.entry.action, actorId: change.entry.actorId,
            actorKind: change.entry.actorKind, dedupeKey: `minutes_arrived:${change.entry.recordId}`, createdAt: now, readAt: null,
          }
          : fromMessage
          ? {
            recordId: change.entry.recordId, recordVersion: change.entry.version, action: change.entry.action, actorId: change.entry.actorId,
            actorKind: change.entry.actorKind, dedupeKey: `from_message:${change.entry.recordId}`, createdAt: now, readAt: null,
          }
          : asked
          ? {
            // Once per assignment; the asker stands as the actor (「〇〇さんから頼まれました」).
            recordId: change.entry.recordId, recordVersion: change.entry.version, action: change.entry.action, actorId: asked.asker,
            actorKind: 'human' as const, dedupeKey: `asked:${change.entry.recordId}:${asked.since}`, createdAt: now, readAt: null,
          }
          : {
            recordId: change.entry.recordId, recordVersion: change.entry.version, action: change.entry.action, actorId: change.entry.actorId,
            actorKind: change.entry.actorKind, dedupeKey: null, createdAt: now, readAt: null,
          }
        rows.push({ id: deps.ids.newId(), userId, kind, ...base })
        // An absentee's notice also goes to their delegate (their own read check), or the stop to the managers.
        const cover = deps.coverOf?.(companyId, userId) ?? null
        if (!cover || rec === undefined) continue
        if (cover.kind === 'delegate' && mayRead(cover.delegateId)) {
          if (cover.delegateId !== change.entry.actorId && !recipients.has(cover.delegateId)) {
            rows.push({ id: deps.ids.newId(), userId: cover.delegateId, kind, ...base, forUserId: userId })
          }
        } else if (change.fields.next_actor === userId || (change.fields.next_actor == null && change.fields.assignee === userId)) {
          // Only an item that now waits for the absentee is stuck.
          stops.push(...stopRows(companyId, readerOf, rec, change.entry.version, userId, cover.kind === 'stopped' ? 'delegate-absent' : 'cannot-read'))
        }
      }
      if (stops.length > 0) writeComputed(companyId, handle, stops)
      if (rows.length === 0) return
      // An `asked` already told for this assignment, or a `from_message` for this record, is skipped (its dedupe key).
      const written = new Set(handle.notifications.insert(rows))
      const fresh = rows.filter(r => written.has(r.id))
      if (fresh.length === 0) return
      const told = [...new Set(fresh.filter(r => kindsOf(handle, r.userId)[r.kind as NotificationKind]).map(r => r.userId))]
      if (told.length > 0) deps.push(companyId, told)
      try { deps.outside?.(companyId, fresh) } catch { /* never fails the engine's write */ }
    },

    /**
     * The server clock's job (services/server-clock.ts): overdue and stuck-AI-turn
     * notices of one company, at most `limit` records looked at per kind (so one
     * company's backlog cannot hold up the others). Newest dues first: a due that
     * just had its morning is always within the limit. Returns the notices written.
     */
    sweep(companyId: string, limit: number): number {
      const handle = companyData.forCompany(companyId)
      if (!handle.records.settings().enabled) return 0
      const defs = requestTypes(handle)
      if (defs.size === 0) return 0
      const types = [...defs.keys()]
      const morning = overdueMorning(clock.nowMs(), deps.timeZoneOf?.(companyId) ?? DEFAULT_COMPANY_TIME_ZONE, deps.holidaysOf?.(companyId) ?? [])
      const open = [...new Set([...defs.values()].flatMap(d => d.states.filter(s => !d.final.includes(s))))]
      const overdue = handle.records.candidates({ types, states: open, ranges: [{ name: 'due', lt: morning }], sort: { field: 'due', order: 'desc' } }, limit)
      const aiTurn = [...new Set([...defs.values()].flatMap(d => [...aiTurnStates(d)]))]
      const stuck = aiTurn.length > 0 ? handle.records.candidates({ types, states: aiTurn }, limit) : []
      const awaiting = [...new Set(types.map(t => acceptanceOf(t)?.state).filter((x): x is string => x !== undefined))]
      const unaccepted = awaiting.length > 0 ? handle.records.candidates({ types: types.filter(t => acceptanceOf(t)), states: awaiting }, limit) : []
      const seen = new Map([...overdue, ...stuck, ...unaccepted].map(r => [r.id, r]))
      let written = writeComputed(companyId, handle, dueRowsOf(companyId, handle, [...seen.values()], defs, null))
      written += writeComputed(companyId, handle, dueTomorrowRows(companyId, handle, defs, limit))
      written += writeComputed(companyId, handle, morningRows(companyId, handle, limit))
      // Absences that began (or whose delegate became absent): what waits for the absentee and reaches nobody.
      for (const a of (deps.activeAbsences?.(companyId) ?? []).slice(0, limit)) {
        const cover = deps.coverOf?.(companyId, a.userId)
        if (cover) written += coverCheck(companyId, a.userId, cover, true).written
      }
      return written
    },

    /**
     * After an absence was set (services/absences.ts): how many of the
     * absentee's waiting items the delegate cannot read now; when the absence
     * has begun, the managers are told at once (else the clock tells them
     * when it begins).
     */
    delegateCannotRead(companyId: string, absenteeId: string, delegateId: string, setterId: string): number {
      const cover = deps.coverOf?.(companyId, absenteeId) ?? null
      const active = cover !== null && cover.delegateId === delegateId
      return coverCheck(companyId, absenteeId, active ? cover : { kind: 'delegate', delegateId }, active, setterId).cannotRead
    },

    /** `GET /me/notifications`: the member's notices they may see now, newest first. */
    list(member: Member): Outcome<NotificationList> {
      const handle = companyData.forCompany(member.companyId)
      if (!handle.records.settings().enabled) return ok({ available: false, unread: 0, items: [] })
      const reader = recordReader(member, handle.scopes.listWithRules())
      computeDue(member, handle, reader)
      handle.notifications.prune(member.userId, new Date(clock.nowMs() - NOTIFICATION_KEEP_DAYS * 86_400_000).toISOString())
      const kinds = kindsOf(handle, member.userId)
      const rows = handle.notifications.list(member.userId, ROWS_READ).filter(r => isNotificationKind(r.kind) && kinds[r.kind])
      const recordless = new Set<string>(RECORDLESS_NOTIFICATION_KINDS)
      const recs = new Map(handle.records.byIds([...new Set(rows.filter(r => r.recordId !== '').map(r => r.recordId))]).map(r => [r.id, r]))
      // Read access is checked now: a record the member can no longer read shows nothing.
      const visible = rows.filter(r => {
        if (recordless.has(r.kind)) return r.recordId === ''
        const rec = recs.get(r.recordId)
        return rec !== undefined && rec.removedAt === null && reader.record(rec)
      })
      const shown = visible.slice(0, NOTIFICATION_LIST_MAX)
      const types = currentTypes(handle.records)
      const names = deps.accounts.byIds([...new Set(shown.flatMap(r => [
        ...(r.actorId && r.actorKind !== 'external' ? [r.actorId] : []), ...(r.forUserId ? [r.forUserId] : []),
      ]))])
      // The company's clock decides what is still fresh enough for a Mac notification (`desktop`).
      const zone = zoneOf(member.companyId)
      const nowMs = clock.nowMs()
      const local = companyNow(nowMs, zone)
      const today = local.slice(0, 10)
      let counts: ReturnType<typeof turnCounts> | null = null
      const countsNow = () => (counts ??= turnCounts(member.companyId, handle, member.userId, (_, rec) => reader.record(rec), today))
      const dueStates = new Map(handle.records.states(shown.filter(r => r.kind === 'due_tomorrow').map(r => r.recordId)).map(st => [st.recordId, st]))
      const items: NotificationItem[] = shown.map(r => {
        const read = r.readAt !== null
        if (r.kind === 'morning_summary') {
          const day = r.dedupeKey?.split(':')[1] ?? ''
          // Built when read: today's shows the turn as it is now; an older one only says what it was.
          const text = day === today ? morningText(countsNow()) : `${dueText(day)}の「今日のあなたの番」（朝の知らせ）`
          const desktop = day === today && !read && local.slice(11, 16) < MORNING_SUMMARY_UNTIL && countsNow().total > 0
            ? { title: text, body: 'やることの一覧で確かめてください' } : undefined
          return { id: r.id, kind: r.kind, recordId: '', recordType: '', recordTitle: '', version: 0, text, createdAt: r.createdAt, read, ...(desktop ? { desktop } : {}) }
        }
        const rec = recs.get(r.recordId) as RecordRow
        const def = types.get(rec.type)?.definition
        let text: string
        let desktop: NotificationItem['desktop']
        if (r.kind === 'due_tomorrow') {
          const { due, when } = dueTomorrowWords(r, companyNow(Date.parse(r.createdAt), zone).slice(0, 10))
          text = when === '明日' ? `「${rec.title}」は明日（${dueText(due)}）が期限です` : `「${rec.title}」の期限は${dueText(due)}です（その前の最後の営業日のお知らせ）`
          const st = dueStates.get(rec.id)
          let current: string | null = null
          try { current = st ? str((JSON.parse(st.fields) as Record<string, LedgerValue>).due) : null } catch { current = null }
          // Still before the due's day, still this due, not finished.
          if (!read && st && st.state !== null && !def?.final.includes(st.state) && current === due && today < due.slice(0, 10)) {
            const now = dueTomorrowWords(r, today).when
            desktop = { title: now === '明日' ? '明日が期限です' : `${now}が期限です`, body: rec.title }
          }
        } else {
          text = textOf(r, rec, def, handle, names)
          if (r.kind === 'asked' && !read && nowMs - Date.parse(r.createdAt) < ASKED_DESKTOP_FRESH_MS) {
            desktop = { title: `${personText(r.actorId, names)}から頼まれました`, body: rec.title }
          }
        }
        return {
          id: r.id, kind: r.kind as NotificationKind, recordId: rec.id, recordType: rec.type, recordTitle: rec.title,
          version: r.recordVersion, text, createdAt: r.createdAt, read, ...(r.forUserId ? { forUserId: r.forUserId } : {}), ...(desktop ? { desktop } : {}),
        }
      })
      return ok({ available: true, unread: visible.filter(r => r.readAt === null).length, items })
    },

    /** `POST /me/notifications/read`: { ids } or { all: true } — the member's own only. */
    markRead(member: Member, body: unknown): Outcome<{ changed: number }> {
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return refuse('bad-request', BAD_READ, { code: 'BAD_REQUEST' })
      const handle = companyData.forCompany(member.companyId)
      if (b.all === true && Object.keys(b).length === 1) return ok({ changed: handle.notifications.markRead(member.userId, null, clock.now()) })
      const ids = b.ids
      if (Object.keys(b).length !== 1 || !Array.isArray(ids) || ids.length > READ_IDS_MAX || !ids.every(i => typeof i === 'string' && i.length > 0 && i.length <= 100)) {
        return refuse('bad-request', BAD_READ, { code: 'BAD_REQUEST' })
      }
      const changed = handle.notifications.markRead(member.userId, ids as string[], clock.now())
      // The member's other PCs re-read (the unread dot goes away there too).
      if (changed > 0) { try { deps.push(member.companyId, [member.userId]) } catch { /* their own check catches up */ } }
      return ok({ changed })
    },

    settings(member: Member): Outcome<NotificationSettings> {
      return ok({ kinds: kindsOf(companyData.forCompany(member.companyId), member.userId) })
    },

    /** `PUT /me/notifications/settings` { kinds: { <kind>: boolean } } — kinds left out keep their value. */
    setSettings(member: Member, body: unknown): Outcome<NotificationSettings> {
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b) || Object.keys(b).length !== 1) return refuse('bad-request', BAD_SETTINGS, { code: 'BAD_REQUEST' })
      const k = b.kinds as Record<string, unknown> | null
      if (typeof k !== 'object' || k === null || Array.isArray(k)) return refuse('bad-request', BAD_SETTINGS, { code: 'BAD_REQUEST' })
      for (const [name, value] of Object.entries(k)) {
        if (!isNotificationKind(name) || typeof value !== 'boolean') return refuse('bad-request', BAD_SETTINGS, { code: 'BAD_REQUEST' })
      }
      const handle = companyData.forCompany(member.companyId)
      const kinds = { ...kindsOf(handle, member.userId), ...(k as Partial<Record<NotificationKind, boolean>>) }
      handle.notifications.setSettings(member.userId, JSON.stringify(kinds), clock.now())
      try { deps.push(member.companyId, [member.userId]) } catch { /* their own check catches up */ }
      return ok({ kinds })
    },
  }
}

export type NotificationService = ReturnType<typeof createNotificationService>
