import { useEffect, useState } from 'react'
import type { RecordCardResult, RecordViewSummary } from '../../../../shared/record-views'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { getRecordCard } from '../api'

/**
 * Loads one record's card (null while loading) and again on `reload`; `onLoaded` gets the record
 * once read (its tab's title and kind). The caller keys the component by record id.
 */
export function useRecordCard(companyId: string, recordId: string, onLoaded?: (record: RecordViewSummary) => void): { result: RecordCardResult | null; reload: () => void } {
  const [result, setResult] = useState<RecordCardResult | null>(null)
  const [rev, setRev] = useState(0)
  const loadedRef = useLatestRef(onLoaded)
  useEffect(() => {
    let current = true
    getRecordCard(companyId, recordId)
      .then(r => {
        if (!current) return
        setResult(r)
        if (r.success && rev === 0) loadedRef.current?.(r.card.record)
      })
      .catch(() => { if (current) setResult({ success: false, offline: true, error: '表示できませんでした。' }) })
    return () => { current = false }
  }, [companyId, recordId, loadedRef, rev])
  return { result, reload: () => setRev(v => v + 1) }
}
