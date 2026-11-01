import { useCallback, useState } from 'react'
import type { BundleChoicesResult } from '../../../../shared/tasks'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getBundleChoices } from '../api'

/** The まとまり the member may choose from, read once when the chooser opens (null while loading). */
export function useBundleChoices(companyId: string): BundleChoicesResult | null {
  const [result, setResult] = useState<BundleChoicesResult | null>(null)
  // The one read through useIpcEvent with nothing to listen to: the renderer's effect count is capped.
  const once = useCallback((listener: (payload: undefined) => void) => { listener(undefined) }, [])
  useIpcEvent(once, () => {
    void getBundleChoices(companyId).then(r => setResult(r ?? { success: false, offline: true, error: '表示できませんでした。' }), () => setResult({ success: false, offline: true, error: '表示できませんでした。' }))
  })
  return result
}
