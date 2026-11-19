// 「今日の予定」 asked once when the task list and 「確かめること」 (`CorePressPanel`) both ask for it
// at the same moment (plan 「問い合わせを減らす計画」 段1). main.ts hands in the calendar feature's
// own read (`features/calendar/ipc.ts`, the session stays there) and registers the shared one.

import type { CalendarTodayResult } from '../../shared/calendar'
import { CALENDAR_OFFLINE_TEXT } from '../../shared/calendar'
import type { InFlightReads } from './in-flight-reads'

export interface CalendarTodayReads {
  today(companyId: string): Promise<CalendarTodayResult>
}

export function createCalendarTodayReads(deps: { reads: InFlightReads; read: (companyId: string) => Promise<CalendarTodayResult> }): CalendarTodayReads {
  return {
    async today(companyId) {
      const shared = await deps.reads.read(companyId, 'calendar-today', () => deps.read(companyId))
      // Asked by another session or server than now: never shown.
      return shared.discarded ? { success: false, offline: true, error: CALENDAR_OFFLINE_TEXT } : shared.value
    },
  }
}
