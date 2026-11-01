/**
 * The company's task settings (やることの一覧の会社の設定, stage 2 S6) — one copy
 * of their shape, defaults and validation for the server (storage, the API),
 * the admin console (the page that edits them) and the desktop app (the task
 * list, the AI's turn), plus `replyTarget`, the reply 目安 (when a message
 * without a deadline should be answered).
 *
 * Owner decisions (2026-11-01, plan「段階2・3 作業の分け方」):
 * - which departments show the task list;
 * - 返事の目安: 翌営業日 (default) or 当日中 with a cutoff (default 17:00; a
 *   message received at or after the cutoff → the next business day);
 * - 自動で進める (the AI's turn runs without a press) on (default) / off, with a daily run
 *   limit and "stop after N failures in a row"; sending and approving are
 *   always pressed by a person;
 * - business days: weekends and Japanese public holidays are off, plus the
 *   company's own holidays (business-days.ts);
 * - 引き受け (stage 2, owner decision 2026-11-01): when a request is accepted
 *   by itself and when it waits for the assignee's 「引き受ける」
 *   (`AcceptanceSettings`; asking someone in another department waits).
 *
 * Times are Japan time (UTC+9, no daylight saving): the reply 目安 is about
 * the company's working day, not the server's clock zone.
 *
 * Pure: imports only shared/core (server/tests/unit/core-purity.test.ts).
 */
import { isBusinessDay, isCalendarDate, nextBusinessDay } from './business-days'

/** `next-business-day` = 翌営業日; `same-day` = 当日中 (before the cutoff). */
export type ReplyRule = 'next-business-day' | 'same-day'
export const REPLY_RULES: readonly ReplyRule[] = ['next-business-day', 'same-day']

export interface ReplySettings {
  rule: ReplyRule
  /** `HH:MM` Japan time; used only by `same-day`. */
  sameDayCutoff: string
}

export interface AutoRunSettings {
  /** The AI's turn runs by itself (on the member's open app, S10). */
  enabled: boolean
  /** At most this many automatic runs per member per day. */
  dailyLimit: number
  /** Stop running automatically after this many failures in a row. */
  stopAfterFailures: number
}

/**
 * When a request someone else is asked to do counts as accepted by itself
 * (records.md "Acceptance"). Each switch on = that case needs no 「引き受ける」;
 * anything none of them covers — asking someone in another department —
 * waits in 「引き受け待ち」. A task for oneself (and an owner-only one) never waits.
 */
export interface AcceptanceSettings {
  /** The asker and the assignee belong to a common department (所属, tasks.md). */
  sameDepartment: boolean
  /** The asker manages a department the assignee belongs to. */
  managerToMember: boolean
  /** The AI made it as homework of a meeting the assignee attended (the task links that meeting). */
  meetingHomework: boolean
}

export interface CompanyHoliday {
  /** `YYYY-MM-DD` (Japan). */
  date: string
  /** What the admin called it (e.g. 夏季休業), may be empty. */
  name: string
}

export interface TaskSettings {
  /** Departments that show the task list; null = every department. */
  taskListDepartmentIds: string[] | null
  reply: ReplySettings
  autoRun: AutoRunSettings
  acceptance: AcceptanceSettings
  /** The company's own days off, by date. */
  companyHolidays: CompanyHoliday[]
}

export const TASK_SETTINGS_LIMITS = {
  departments: 500,
  holidays: 400,
  holidayNameLength: 50,
  dailyLimit: { min: 1, max: 500 },
  stopAfterFailures: { min: 1, max: 20 },
  /** Holidays outside these years are refused (typing mistakes such as 20026). */
  holidayYears: { min: 2000, max: 2100 },
} as const

export const DEFAULT_TASK_SETTINGS: TaskSettings = Object.freeze({
  taskListDepartmentIds: null,
  reply: Object.freeze({ rule: 'next-business-day', sameDayCutoff: '17:00' }) as ReplySettings,
  // 自動で進める is on unless the company turns it off (owner decision 2026-11-01).
  autoRun: Object.freeze({ enabled: true, dailyLimit: 30, stopAfterFailures: 3 }) as AutoRunSettings,
  // Owner decision 2026-11-01: only asking someone in another department waits for 「引き受ける」.
  acceptance: Object.freeze({ sameDepartment: true, managerToMember: true, meetingHomework: true }) as AcceptanceSettings,
  companyHolidays: [],
}) as TaskSettings

/** A fresh, mutable copy of the defaults. */
export function defaultTaskSettings(): TaskSettings {
  return {
    taskListDepartmentIds: null,
    reply: { ...DEFAULT_TASK_SETTINGS.reply },
    autoRun: { ...DEFAULT_TASK_SETTINGS.autoRun },
    acceptance: { ...DEFAULT_TASK_SETTINGS.acceptance },
    companyHolidays: [],
  }
}

const CUTOFF_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isCutoff(value: unknown): value is string {
  return typeof value === 'string' && CUTOFF_RE.test(value)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/**
 * Validate a whole settings document (PUT body, stored row). Department ids
 * are checked for shape only; whether they are the company's departments is
 * the server's check. Holidays come back sorted by date, names trimmed.
 */
export function parseTaskSettings(input: unknown): { value: TaskSettings } | { error: string } {
  if (!isObject(input)) return { error: 'Settings must be an object' }
  const L = TASK_SETTINGS_LIMITS

  const ids = input.taskListDepartmentIds
  let taskListDepartmentIds: string[] | null
  if (ids === null) taskListDepartmentIds = null
  else if (Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100)) {
    taskListDepartmentIds = [...new Set(ids as string[])]
    if (taskListDepartmentIds.length > L.departments) return { error: `At most ${L.departments} departments` }
  } else return { error: 'taskListDepartmentIds must be null (every department) or an array of department ids' }

  const reply = input.reply
  if (!isObject(reply)) return { error: 'reply is required' }
  if (!(REPLY_RULES as readonly unknown[]).includes(reply.rule)) return { error: 'reply.rule must be next-business-day or same-day' }
  if (!isCutoff(reply.sameDayCutoff)) return { error: 'reply.sameDayCutoff must be HH:MM (00:00–23:59)' }

  const auto = input.autoRun
  if (!isObject(auto)) return { error: 'autoRun is required' }
  if (typeof auto.enabled !== 'boolean') return { error: 'autoRun.enabled must be true or false' }
  if (!isInt(auto.dailyLimit, L.dailyLimit.min, L.dailyLimit.max)) return { error: `autoRun.dailyLimit must be an integer ${L.dailyLimit.min}–${L.dailyLimit.max}` }
  if (!isInt(auto.stopAfterFailures, L.stopAfterFailures.min, L.stopAfterFailures.max)) {
    return { error: `autoRun.stopAfterFailures must be an integer ${L.stopAfterFailures.min}–${L.stopAfterFailures.max}` }
  }

  // Added after the first release of the page: a document saved before it (or an older admin
  // console's PUT) has none and takes the defaults rather than failing as a whole.
  const acc = input.acceptance === undefined ? { ...DEFAULT_TASK_SETTINGS.acceptance } : input.acceptance
  if (!isObject(acc)) return { error: 'acceptance must be an object' }
  for (const k of ['sameDepartment', 'managerToMember', 'meetingHomework'] as const) {
    if (typeof acc[k] !== 'boolean') return { error: `acceptance.${k} must be true or false` }
  }

  const holidays = input.companyHolidays
  if (!Array.isArray(holidays)) return { error: 'companyHolidays must be an array' }
  if (holidays.length > L.holidays) return { error: `At most ${L.holidays} company holidays` }
  const seen = new Set<string>()
  const companyHolidays: CompanyHoliday[] = []
  for (const h of holidays) {
    if (!isObject(h) || !isCalendarDate(h.date)) return { error: 'Each company holiday needs a date (YYYY-MM-DD)' }
    const year = Number(h.date.slice(0, 4))
    if (year < L.holidayYears.min || year > L.holidayYears.max) return { error: `Company holidays must be in ${L.holidayYears.min}–${L.holidayYears.max}` }
    const name = h.name === undefined ? '' : h.name
    if (typeof name !== 'string' || name.trim().length > L.holidayNameLength) return { error: `A holiday name is at most ${L.holidayNameLength} characters` }
    if (seen.has(h.date)) return { error: `The date ${h.date} is listed twice` }
    seen.add(h.date)
    companyHolidays.push({ date: h.date, name: name.trim() })
  }
  companyHolidays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  return {
    value: {
      taskListDepartmentIds,
      reply: { rule: reply.rule as ReplyRule, sameDayCutoff: reply.sameDayCutoff },
      autoRun: { enabled: auto.enabled, dailyLimit: auto.dailyLimit, stopAfterFailures: auto.stopAfterFailures },
      acceptance: { sameDepartment: acc.sameDepartment as boolean, managerToMember: acc.managerToMember as boolean, meetingHomework: acc.meetingHomework as boolean },
      companyHolidays,
    },
  }
}

/** Japan is UTC+9 all year. */
const JAPAN_OFFSET_MS = 9 * 60 * 60 * 1000

/** The Japan calendar date and minutes since midnight of an instant. */
export function japanDateTime(at: Date): { date: string; minutes: number } {
  const local = new Date(at.getTime() + JAPAN_OFFSET_MS)
  const date = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`
  return { date, minutes: local.getUTCHours() * 60 + local.getUTCMinutes() }
}

export interface ReplyTarget {
  /** The business day the reply is due, `YYYY-MM-DD` (Japan). */
  date: string
  /** The end of that day in Japan (23:59:59.999 +09:00), as an ISO instant. */
  dueAt: string
}

/**
 * The reply 目安 of a message received at `receivedAt` (an ISO instant or a
 * Date) that names no deadline of its own:
 *
 * - 翌営業日 (`next-business-day`): the first business day after the day it
 *   arrived (Japan date) — a message on Friday or Saturday → Monday, unless
 *   Monday is a holiday.
 * - 当日中 (`same-day`): received on a business day before the cutoff → that
 *   day; at or after the cutoff, or on a day off → the next business day.
 *
 * `companyHolidays`: the company's own days off (`YYYY-MM-DD`), on top of
 * weekends and Japanese public holidays. Throws on an invalid `receivedAt`.
 */
export function replyTarget(
  receivedAt: string | Date,
  settings: ReplySettings,
  companyHolidays: Iterable<string> = [],
): ReplyTarget {
  const at = receivedAt instanceof Date ? receivedAt : new Date(receivedAt)
  if (Number.isNaN(at.getTime())) throw new Error('replyTarget: receivedAt is not a valid time')
  const own = new Set(companyHolidays)
  const { date, minutes } = japanDateTime(at)
  let due: string
  if (settings.rule === 'same-day') {
    const [h, m] = (isCutoff(settings.sameDayCutoff) ? settings.sameDayCutoff : DEFAULT_TASK_SETTINGS.reply.sameDayCutoff).split(':').map(Number)
    due = isBusinessDay(date, own) && minutes < h * 60 + m ? date : nextBusinessDay(date, own)
  } else {
    due = nextBusinessDay(date, own)
  }
  const [y, mo, d] = due.split('-').map(Number)
  const dueAt = new Date(Date.UTC(y, mo - 1, d + 1) - JAPAN_OFFSET_MS - 1).toISOString()
  return { date: due, dueAt }
}
