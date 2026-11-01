// The task list's access to the main process (stage 2, renderer-structure.md): small
// ports, each function taking its port last (default window.electronAPI).
// 「今日の予定」 (calendar.md): main asks the company server with the member's
// session; the server reads the member's own calendar now and keeps nothing.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { CalendarTodayResult } from '../../../shared/calendar'

/** Reading the member's own meetings today (no attendee address ever comes back). */
export type CalendarReads = ElectronPort<'getCalendarToday'>

/**
 * Today's meetings of the member in `companyId`. A calendar that cannot be read
 * (no permission, the connection off) is `success: true` with an empty list and
 * `data.reason`; `success: false` only when the server could not answer.
 */
export function getCalendarToday(companyId: string, reads: CalendarReads = window.electronAPI): Promise<CalendarTodayResult> {
  return reads.getCalendarToday(companyId)
}
