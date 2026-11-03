/**
 * The member's own calendar for today (stage 2 S7a, `.claude/rules/calendar.md`):
 * the task list shows today's meetings next to the tasks, read now and never
 * stored. Provider-neutral on purpose — Google today, the core role
 * 「予定を読む」 (stage 3) later — so nothing here names a service.
 */

/**
 * The time zone "today" is taken in. There is no per-company setting yet;
 * every company works in Japan time until one exists (the server asks
 * `timeZoneOf(companyId)`, so a setting replaces this in one place).
 */
export const DEFAULT_COMPANY_TIME_ZONE = 'Asia/Tokyo'

/**
 * Why today's list is empty without being "no meetings" — a plain flag, never an error:
 * - `not-connected`: the member has not allowed reading their calendar (or the permission ended);
 * - `stopped`: the company's connection is off, not set up or stopped;
 * - `unavailable`: the calendar could not be read just now.
 */
export type CalendarTodayReason = 'not-connected' | 'stopped' | 'unavailable'

/** One meeting of the member's own calendar. No attendee address or name, ever. */
export interface CalendarEvent {
  /** The calendar's own opaque id of the event (for list keys and later links). */
  id: string
  title: string
  /** ISO 8601 (UTC). An all-day event spans the whole day it covers within today's window. */
  start: string
  end: string
  allDay: boolean
  /** It has a video call (Meet and the like) rather than only a place. */
  online: boolean
  /** People invited, the member included (rooms and other resources not counted). */
  attendeeCount: number
  /** Someone outside the company's own domain is invited. */
  hasExternalAttendees: boolean
}

/** The offset of `timeZone` from UTC at instant `atMs`, in milliseconds. */
function offsetMs(timeZone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(atMs))
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return asUtc - Math.floor(atMs / 1000) * 1000
}

/** Local midnight of the calendar day (y, m, d) in `timeZone`, as an instant. */
function midnight(timeZone: string, y: number, m: number, d: number, nearMs: number): number {
  const guess = Date.UTC(y, m, d) - offsetMs(timeZone, nearMs)
  return Date.UTC(y, m, d) - offsetMs(timeZone, guess)
}

/** Today in `timeZone` at `nowMs`: its date (`YYYY-MM-DD`) and [from, to) as instants. */
export function dayWindow(nowMs: number, timeZone: string): { date: string; from: number; to: number } {
  const local = new Date(nowMs + offsetMs(timeZone, nowMs))
  const y = local.getUTCFullYear()
  const m = local.getUTCMonth()
  const d = local.getUTCDate()
  const from = midnight(timeZone, y, m, d, nowMs)
  const to = midnight(timeZone, y, m, d + 1, from + 24 * 60 * 60 * 1000)
  const date = `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return { date, from, to }
}
