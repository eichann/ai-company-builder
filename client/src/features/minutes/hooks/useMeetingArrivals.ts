import { useCallback, useState } from 'react'
import type { MeetingArrivalsResult } from '../../../../shared/minutes-app'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useInterval } from '../../../shared/hooks/useInterval'
import { getMeetingArrivals, onMeetingsMayHaveChanged } from '../api'

/** Read again at least this often (a meeting found by the server clock reaches no signal of ours). */
const REFRESH_MS = 2 * 60_000
const NONE: MeetingArrivalsResult = { available: false, items: [] }

/**
 * The member's meetings of the last days (「議事録が届きました」), read at mount, when the meetings may
 * have changed, every 2 minutes and on `reload`. The last good answer stays while a read fails.
 */
export function useMeetingArrivals(companyId: string | undefined): { arrivals: MeetingArrivalsResult; reload: () => void } {
  const [state, setState] = useState<{ companyId: string | undefined; value: MeetingArrivalsResult }>({ companyId, value: NONE })
  const reload = useCallback(() => {
    if (!companyId) return
    void getMeetingArrivals(companyId).then(value => {
      setState(s => (value.available || s.companyId !== companyId ? { companyId, value } : s))
    }, () => {})
  }, [companyId])
  const subscribe = useCallback((listener: (payload: undefined) => void) => {
    if (!companyId) return undefined
    listener(undefined)
    return onMeetingsMayHaveChanged(companyId, () => listener(undefined))
  }, [companyId])
  useIpcEvent(subscribe, reload, !!companyId)
  useInterval(reload, companyId ? REFRESH_MS : null)
  // Another company's meetings never show here (an answer may arrive after a switch).
  return { arrivals: state.companyId === companyId ? state.value : NONE, reload }
}
