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
 * - Overdue (A-2: to the requester, once per due) and a stuck AI turn (C-18:
 *   24 h, to the requester, once per version) are computed when the member
 *   reads — there is no timer on the server.
 * - The push channel carries only `{ kind: 'notifications', version }`, a
 *   fresh value: the app asks again; it never acts on the signal.
 */
import { isNotificationKind, NOTIFICATION_DEFAULTS, NOTIFICATION_KINDS, NOTIFICATION_LIST_MAX } from '../../shared/types/notifications'
import type { NotificationItem, NotificationKind, NotificationList, NotificationSettings } from '../../shared/types/notifications'
import { DEFAULT_COMPANY_TIME_ZONE } from '../../shared/core/calendar'
import type { LedgerValue } from '../../shared/core/record-ledger'
import type { TypeDefinition } from '../../shared/core/record-types'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { NotificationRow } from '../ports/notifications'
import type { RecordRow } from '../ports/records'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader } from './record-access'
import type { RecordChange } from './record-engine'
import { currentTypes } from './record-index'

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

/** Has this due passed? A date-only due passes when its day is over; one with a time, at that minute. */
export function duePassed(due: string, nowMs: number, timeZone: string = DEFAULT_COMPANY_TIME_ZONE): boolean {
  const now = companyNow(nowMs, timeZone)
  return due.length === 10 ? due < now.slice(0, 10) : due < now
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
  if (type === 'approval' && stateChanged && entry.fromState !== null && str(fields.requested_by) === userId) return 'approval_result'
  if (stateChanged && entry.toState !== null && final.has(entry.toState)) {
    if (entry.changes.some(c => c.field === 'ok_by' && c.after === userId)) return 'ok_completed'
    if (str(fields.requested_by) === userId) return 'request_done'
  }
  // What the member asked came back to them (受けられない): not final, but now their turn again.
  if (stateChanged && str(fields.requested_by) === userId && str(fields.next_actor) === userId && str(fields.assignee) !== userId) return 'request_returned'
  if (str(fields.requested_by) === userId && entry.changes.some(c => c.field === 'due')) return 'due_changed'
  return 'others'
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

  /** Overdue requests and stuck AI turns of what the member asked for, as notices (once each). */
  function computeDue(member: Member, handle: CompanyData, reader: ReturnType<typeof recordReader>) {
    const records = handle.records
    const types = [...currentTypes(records)].filter(([, t]) => t.definition.implements.includes('request'))
    if (types.length === 0) return
    const defs = new Map(types.map(([n, t]) => [n, t.definition]))
    const candidates = records.candidates({ types: [...defs.keys()], fields: [{ name: 'requested_by', values: [member.userId] }] }, MAX_COMPUTED_CANDIDATES)
      .filter(r => reader.record(r))
    if (candidates.length === 0) return
    const nowMs = clock.nowMs()
    const now = clock.now()
    const timeZone = deps.timeZoneOf?.(member.companyId) ?? DEFAULT_COMPANY_TIME_ZONE
    const rows: NotificationRow[] = []
    for (const s of records.states(candidates.map(r => r.id))) {
      const def = defs.get(candidates.find(r => r.id === s.recordId)?.type ?? '') as TypeDefinition
      if (!def || s.state === null || def.final.includes(s.state)) continue
      let fields: Record<string, LedgerValue> = {}
      try { fields = JSON.parse(s.fields) as Record<string, LedgerValue> } catch { continue }
      const assignee = str(fields.assignee)
      // What the member asked of someone else: their own work is already on their own list.
      if (assignee === null || assignee === member.userId) continue
      const base = { userId: member.userId, recordId: s.recordId, recordVersion: s.version, action: '', actorId: null, actorKind: null, createdAt: now, readAt: null }
      const due = str(fields.due)
      if (due !== null && duePassed(due, nowMs, timeZone)) {
        rows.push({ ...base, id: deps.ids.newId(), kind: 'overdue', dedupeKey: `overdue:${s.recordId}:${due}` })
      }
      const aiOnly = Object.values(def.actions).some(a => a.who.length === 1 && a.who[0] === 'ai' && (a.from ?? def.states).includes(s.state as string))
      if (aiOnly && nowMs - Date.parse(s.updatedAt) >= AI_TURN_STUCK_MS) {
        rows.push({ ...base, id: deps.ids.newId(), kind: 'ai_turn_stuck', dedupeKey: `ai_turn_stuck:${s.recordId}:${s.version}` })
      }
    }
    if (rows.length > 0) handle.notifications.insert(rows)
  }

  function actorText(row: NotificationRow, names: Map<string, { email: string; name: string | null }>): string {
    if (row.actorKind === 'external') return 'つないでいるサービス'
    const a = row.actorId ? names.get(row.actorId) : undefined
    const who = a ? `${a.name || a.email}さん` : 'だれか'
    return row.actorKind === 'ai' ? `${who}の AI` : who
  }

  function textOf(row: NotificationRow, rec: RecordRow, def: TypeDefinition | undefined, handle: CompanyData, names: Map<string, { email: string; name: string | null }>): string {
    const t = `「${rec.title}」`
    const actor = actorText(row, names)
    const entry = () => handle.records.ledger(rec.id).find(e => e.version === row.recordVersion)
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
      case 'ai_turn_stuck':
        return `${t}の AI の番が 24 時間以上進んでいません。担当の人のアプリが閉じているかもしれません`
      default: {
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
      for (const userId of new Set(userIds)) {
        if (userId === change.entry.actorId || !mayRead(userId)) continue
        rows.push({
          id: deps.ids.newId(), userId, kind: noticeKind(userId, change, final), recordId: change.entry.recordId,
          recordVersion: change.entry.version, action: change.entry.action, actorId: change.entry.actorId,
          actorKind: change.entry.actorKind, dedupeKey: null, createdAt: now, readAt: null,
        })
      }
      if (rows.length === 0) return
      handle.notifications.insert(rows)
      const told = rows.filter(r => kindsOf(handle, r.userId)[r.kind as NotificationKind]).map(r => r.userId)
      if (told.length > 0) deps.push(companyId, told)
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
      const recs = new Map(handle.records.byIds([...new Set(rows.map(r => r.recordId))]).map(r => [r.id, r]))
      // Read access is checked now: a record the member can no longer read shows nothing.
      const visible = rows.filter(r => {
        const rec = recs.get(r.recordId)
        return rec !== undefined && rec.removedAt === null && reader.record(rec)
      })
      const shown = visible.slice(0, NOTIFICATION_LIST_MAX)
      const types = currentTypes(handle.records)
      const names = deps.accounts.byIds([...new Set(shown.flatMap(r => (r.actorId && r.actorKind !== 'external' ? [r.actorId] : [])))])
      const items: NotificationItem[] = shown.map(r => {
        const rec = recs.get(r.recordId) as RecordRow
        return {
          id: r.id, kind: r.kind as NotificationKind, recordId: rec.id, recordType: rec.type, recordTitle: rec.title,
          version: r.recordVersion, text: textOf(r, rec, types.get(rec.type)?.definition, handle, names),
          createdAt: r.createdAt, read: r.readAt !== null,
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
