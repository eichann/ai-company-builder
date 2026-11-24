import { useCallback, useState } from 'react'
import type { MinutesNoticesResult } from '../../../../shared/minutes-app'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { googlePermission } from '../../../shared/lib/googlePermission'
import { checkMinutes, getMinutesNotices, subscribeMinutes } from '../api'

const NONE: MinutesNoticesResult = { available: false, notices: [] }

/**
 * The company's received minutes waiting for the member (the AI turn runner's queue):
 * while mounted, main checks for new minutes for this company (start, every
 * 10 minutes, and once when the member's Google permission changes here) and tells when the notices may have
 * changed; they are read again then.
 */
export function useMinutesNotices(companyId: string | undefined) {
  const [state, setState] = useState<{ companyId: string | undefined; value: MinutesNoticesResult }>({ companyId, value: NONE })
  const subscribe = useCallback((listener: (payload: undefined) => void) =>
    companyId ? subscribeMinutes(companyId, () => listener(undefined)) : undefined, [companyId])
  useIpcEvent(subscribe, () => {
    if (!companyId) return
    void getMinutesNotices(companyId).then(value => setState({ companyId, value }), () => {})
  }, !!companyId)
  // Google allowed (or stopped) here (設定 →「Google」, 「仕事の道具をつなぐ」): main checks once at once, so 「議事録を確かめる」
  // shows without waiting for its 10-minute look (使い心地のメモ #38); its answer comes back as `minutes:changed`.
  useIpcEvent(googlePermission.subscribe, changed => {
    if (companyId && changed === companyId) void Promise.resolve(checkMinutes(companyId)).catch(() => {})
  }, !!companyId)
  // Another company's notices never show here (the answer may arrive after a switch).
  return state.companyId === companyId ? state.value : NONE
}
