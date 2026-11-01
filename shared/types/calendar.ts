/**
 * API contract of today's calendar (stage 2 S7a, `.claude/rules/calendar.md`).
 */
import type { CalendarEvent, CalendarTodayReason } from '../core/calendar'

export type { CalendarEvent, CalendarTodayReason } from '../core/calendar'

/**
 * `GET /api/companies/:id/me/calendar/today` — the member's own meetings today,
 * read now (nothing stored). Not being able to read is not an error: the list is
 * empty and `reason` says why (null when the calendar was read).
 */
export interface CalendarToday {
  /** Today in the company's time zone, `YYYY-MM-DD`. */
  date: string
  /** The IANA time zone "today" was taken in (`Asia/Tokyo`). */
  timeZone: string
  /** All-day events first, then by start time. */
  events: CalendarEvent[]
  reason: CalendarTodayReason | null
}
