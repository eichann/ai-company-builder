import { useCallback, useState } from 'react'
import type { CalendarToday } from '../../../../shared/calendar'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useInterval } from '../../../shared/hooks/useInterval'
import { googlePermission } from '../../../shared/lib/googlePermission'
import { getCalendarToday } from '../api'

const REFRESH_MS = 10 * 60_000

/**
 * The member's meetings today (read by the server now, kept nowhere): at mount, every 10 minutes,
 * and at once when the app sees the member's Google permission change (allowed, stopped).
 */
export function useCalendarToday(companyId: string | undefined): CalendarToday | null {
  const [state, setState] = useState<{ companyId: string | undefined; today: CalendarToday | null }>({ companyId, today: null })
  const load = useCallback(() => {
    if (!companyId) return
    void getCalendarToday(companyId).then(r => { if (r?.success) setState({ companyId, today: r.data }) }, () => {})
  }, [companyId])
  // The first read through useIpcEvent with nothing to listen to: the renderer's effect count is capped.
  const once = useCallback((listener: (payload: undefined) => void) => { listener(undefined) }, [])
  useIpcEvent(once, load, !!companyId)
  useIpcEvent(googlePermission.subscribe, changed => { if (changed === companyId) load() }, !!companyId)
  useInterval(load, companyId ? REFRESH_MS : null)
  return state.companyId === companyId ? state.today : null
}
