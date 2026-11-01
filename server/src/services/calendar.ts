/**
 * 「今日の予定」 (stage 2 S7a, `.claude/rules/calendar.md`): the member's own
 * meetings today, for the task list. Provider-neutral — the reader behind the
 * `CalendarReader` port is the core role 「予定を読む」, served by Google today
 * (`google-calendar.ts`, `connector-roles.md`).
 *
 * - Only the signed-in member's own calendar: the member comes from the
 *   session, and nothing in the request can name another person.
 * - "Today" is the company's day (`timeZoneOf`, Japan time until a company
 *   setting exists).
 * - Read now, **nothing stored**, nothing logged (no titles, no attendees).
 * - Not being able to read (no permission, the connection off or stopped,
 *   the calendar not answering) is not an error: an empty list with a reason.
 */
import { dayWindow, type CalendarEvent } from '../../shared/core/calendar'
import type { CalendarToday } from '../../shared/types/calendar'
import type { CalendarReader } from '../ports/calendar'
import type { Clock } from '../ports/clock'
import type { Member } from './access'
import { ok, type Outcome } from './outcome'

export interface CalendarServiceDeps {
  reader: CalendarReader
  clock: Clock
  /** The IANA time zone of the company's day. */
  timeZoneOf: (companyId: string) => string
}

const byDay = (a: CalendarEvent, b: CalendarEvent) =>
  Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end)

export function createCalendarService(deps: CalendarServiceDeps) {
  return {
    /** `GET /me/calendar/today`. Always answers (a member); an unreadable calendar is an empty list with a reason. */
    async today(member: Member): Promise<Outcome<CalendarToday>> {
      const timeZone = deps.timeZoneOf(member.companyId)
      const { date, from, to } = dayWindow(deps.clock.nowMs(), timeZone)
      const read = await deps.reader.eventsBetween(member.companyId, member.userId, from, to)
        .catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
      if (!read.ok) return ok({ date, timeZone, events: [], reason: read.reason })
      return ok({ date, timeZone, events: [...read.events].sort(byDay), reason: null })
    },
  }
}

export type CalendarService = ReturnType<typeof createCalendarService>
