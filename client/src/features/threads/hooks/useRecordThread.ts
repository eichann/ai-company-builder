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
    // No answer at all (a setup without the channel) is no 連絡: the slot stays empty.
    void getRecordThread(companyId, recordId, reads).then(r => setResult(r ?? { success: false, none: true }), () => setResult({ success: false, none: false, offline: true, error: '表示できませんでした。' }))
  })
  return result
}
