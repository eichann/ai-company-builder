import { useCallback, useState } from 'react'
import type { FindHomeResult } from '../../../../shared/record-views'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useInterval } from '../../../shared/hooks/useInterval'
import { findRecordsHome } from '../api'
import { localDay } from '../find'

const REFRESH_MS = 5 * 60_000

/** 探す with nothing typed: the member's unfinished 案件 and this week's meetings, read at mount and every 5 minutes. */
export function useFindHome(companyId: string | undefined): Extract<FindHomeResult, { success: true }> | null {
  const [state, setState] = useState<{ companyId: string | undefined; home: Extract<FindHomeResult, { success: true }> | null }>({ companyId, home: null })
  const load = useCallback(() => {
    if (!companyId) return
    const now = new Date()
    // 「この1週間」: from yesterday to six days ahead.
    void findRecordsHome(companyId, localDay(now), localDay(now, -1), localDay(now, 7))
      .then(r => { if (r?.success) setState({ companyId, home: r }) }, () => {})
  }, [companyId])
  // The first read (again for another company) through useIpcEvent with nothing to listen to: the renderer's effect count is capped.
  const once = useCallback((listener: (payload: undefined) => void) => { if (companyId) listener(undefined) }, [companyId])
  useIpcEvent(once, load, !!companyId)
  useInterval(load, companyId ? REFRESH_MS : null)
  return state.companyId === companyId ? state.home : null
}
