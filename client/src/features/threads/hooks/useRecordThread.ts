import { useCallback, useState } from 'react'
import type { RecordThreadResult } from '../../../../shared/threads'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getRecordThread, type ThreadReads } from '../api'

/** A record's original thread, read once when the card opens (null while loading). The caller keys the component by record id. */
export function useRecordThread(companyId: string, recordId: string, reads?: ThreadReads): RecordThreadResult | null {
  const [result, setResult] = useState<RecordThreadResult | null>(null)
  // A read with nothing to listen to goes through useIpcEvent: the renderer's effect count is capped.
  const once = useCallback((listener: (payload: undefined) => void) => { listener(undefined) }, [])
  useIpcEvent(once, () => {
    void getRecordThread(companyId, recordId, reads).then(setResult, () => setResult({ success: false, none: false, offline: true, error: '表示できませんでした。' }))
  })
  return result
}
