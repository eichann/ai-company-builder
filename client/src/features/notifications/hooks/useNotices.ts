import { useCallback, useState } from 'react'
import { NO_NOTICES, type NoticesState } from '../../../../shared/notifications-app'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getNoticesState, subscribeNotices, subscribeOpenTasks } from '../api'

/**
 * The company's 「あなたの番」 and notices: while mounted, main checks them for
 * this company (start, every 5 minutes, on the push channel's signals) and
 * tells when they may have changed; they are read again then.
 */
export function useNotices(companyId: string | undefined) {
  const [state, setState] = useState<{ companyId: string | undefined; value: NoticesState }>({ companyId, value: NO_NOTICES })
  const subscribe = useCallback((listener: (payload: undefined) => void) =>
    companyId ? subscribeNotices(companyId, () => listener(undefined)) : undefined, [companyId])
  useIpcEvent(subscribe, () => {
    if (!companyId) return
    void getNoticesState(companyId).then(value => setState({ companyId, value }), () => {})
  }, !!companyId)
  // Another company's never show here (the answer may arrive after a switch).
  return state.companyId === companyId ? state.value : NO_NOTICES
}

/** The morning's 「今日のあなたの番」 Mac notification was clicked for this company: `open` shows the task list. */
export function useOpenTasksRequest(companyId: string | undefined, open: () => void) {
  const subscribe = useCallback((listener: (payload: undefined) => void) =>
    companyId ? subscribeOpenTasks(companyId, () => listener(undefined)) : undefined, [companyId])
  useIpcEvent(subscribe, () => open(), !!companyId)
}
