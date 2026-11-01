// 「今日の予定」 (stage 2 S7a, .claude/rules/calendar.md):
//   calendar:today    the member's own meetings today, read now by the server with
//                     their own permission (nothing stored on either side)
// Provider-neutral: the app never knows which calendar service answers (Google
// today, the role 「予定を読む」 later). The session cookie stays here; the
// renderer gets the server's CalendarToday or a sentence built from the status
// only. Logged: the status, never a title.

import { CALENDAR_OFFLINE_TEXT, calendarErrorText, isCalendarToday, type CalendarTodayResult } from '../../../shared/calendar'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface CalendarDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
}

const offline = { success: false, offline: true, error: CALENDAR_OFFLINE_TEXT } as const
const invalid = { success: false, offline: false, error: '入力が正しくありません。' } as const

export function createCalendarApi(deps: CalendarDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  return {
    async today(companyId: string): Promise<CalendarTodayResult> {
      const base = deps.baseUrl()
      if (!base) return offline
      let res: Response
      let json: unknown
      try {
        res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/calendar/today`, {
          method: 'GET', headers: { Cookie: deps.cookies().join('; ') },
        })
        json = await res.json().catch(() => null)
      } catch {
        log.warn('[calendar] GET today: the server could not be reached')
        return offline
      }
      const data = (json as { data?: unknown } | null)?.data
      if (res.ok && isCalendarToday(data)) return { success: true, data }
      log.warn(`[calendar] GET today: answered ${res.status}`)
      return { success: false, offline: false, error: calendarErrorText(res.status) }
    },
  }
}

export function registerCalendarIpc(ipc: IpcRegistrar, deps: CalendarDeps): void {
  const api = createCalendarApi(deps)
  ipc.handle('calendar:today', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId || companyId.length > 200) return invalid
    return api.today(companyId)
  })
}
