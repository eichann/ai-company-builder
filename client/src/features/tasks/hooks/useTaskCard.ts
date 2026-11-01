import { useCallback, useState } from 'react'
import type { TaskCardResult } from '../../../../shared/task-card'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getTaskCard, onTasksMayHaveChanged } from '../api'

/**
 * One task's card, read from main (null while loading): at mount, when the member's turn or
 * notices may have changed, and on `reload` after the member's own change. A failed re-read
 * keeps the card on screen. The caller keys the component by record id.
 */
export function useTaskCard(companyId: string, recordId: string) {
  const [result, setResult] = useState<TaskCardResult | null>(null)
  const reload = useCallback(() => {
    void getTaskCard(companyId, recordId).then(
      r => { if (r) setResult(prev => (!r.success && prev?.success && !r.notFound ? prev : r)) },
      () => setResult(prev => prev ?? { success: false, offline: true, error: '表示できませんでした。' }),
    )
  }, [companyId, recordId])
  const subscribe = useCallback((listener: (payload: undefined) => void) => {
    listener(undefined)
    return onTasksMayHaveChanged(companyId, () => listener(undefined))
  }, [companyId])
  useIpcEvent(subscribe, reload)
  return { result, reload }
}
