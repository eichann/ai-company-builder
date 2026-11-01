// 「今日の予定」 in the app (stage 2 S7a, .claude/rules/calendar.md): the IPC result and the
// words built from status codes only. The server's answer is CalendarToday
// (shared/types/calendar.ts); not being able to read the calendar is part of
// that answer (an empty list with a reason), not a failure here.
import type { CalendarToday } from '../../shared/types/calendar'

export type { CalendarEvent, CalendarToday, CalendarTodayReason } from '../../shared/types/calendar'

export type CalendarTodayResult =
  | { success: true; data: CalendarToday }
  | { success: false; offline: boolean; error: string }

export const CALENDAR_OFFLINE_TEXT = 'サーバーに接続できませんでした。時間をおいてもう一度お試しください。'

/** A refusal as plain Japanese, from the status only (never the server's text). */
export function calendarErrorText(status: number): string {
  if (status === 401) return 'サインインし直してから、もう一度お試しください。'
  if (status === 404) return 'このサーバーは今日の予定にまだ対応していません。'
  return `今日の予定を読めませんでした（サーバーの応答 ${status}）。`
}

const isEvent = (v: unknown): boolean => {
  const e = v as Record<string, unknown> | null
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.title === 'string'
    && typeof e.start === 'string' && typeof e.end === 'string' && typeof e.allDay === 'boolean'
    && typeof e.online === 'boolean' && typeof e.attendeeCount === 'number' && typeof e.hasExternalAttendees === 'boolean'
}

/** The server's answer, when it has the expected shape. */
export function isCalendarToday(v: unknown): v is CalendarToday {
  const t = v as Record<string, unknown> | null
  return !!t && typeof t === 'object' && typeof t.date === 'string' && typeof t.timeZone === 'string'
    && Array.isArray(t.events) && t.events.every(isEvent)
    && (t.reason === null || t.reason === 'not-connected' || t.reason === 'stopped' || t.reason === 'unavailable')
}
