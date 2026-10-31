import { useCallback, useState } from 'react'
import type { MinutesNoticesResult } from '../../../../shared/minutes-app'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getMinutesNotices, subscribeMinutes } from '../api'

const NONE: MinutesNoticesResult = { available: false, notices: [] }

/**
 * The company's received minutes waiting for the member (「議事録が届きました」):
 * while mounted, main checks for new minutes for this company (start, every
 * 10 minutes) and tells when the notices may have changed; they are read again then.
 */
export function useMinutesNotices(companyId: string | undefined) {
  const [state, setState] = useState<{ companyId: string | undefined; value: MinutesNoticesResult }>({ companyId, value: NONE })
  const subscribe = useCallback((listener: (payload: undefined) => void) =>
    companyId ? subscribeMinutes(companyId, () => listener(undefined)) : undefined, [companyId])
  useIpcEvent(subscribe, () => {
    if (!companyId) return
    void getMinutesNotices(companyId).then(value => setState({ companyId, value }), () => {})
  }, !!companyId)
  // Another company's notices never show here (the answer may arrive after a switch).
  return state.companyId === companyId ? state.value : NONE
}
