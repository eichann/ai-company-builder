import { useEffect, useState } from 'react'
import type { RecordCardResult } from '../../../../shared/record-views'
import { getRecordCard } from '../api'

/** Loads one record's card (null while loading). The caller keys the component by record id. */
export function useRecordCard(companyId: string, recordId: string): RecordCardResult | null {
  const [result, setResult] = useState<RecordCardResult | null>(null)
  useEffect(() => {
    let current = true
    getRecordCard(companyId, recordId)
      .then(r => { if (current) setResult(r) })
      .catch(() => { if (current) setResult({ success: false, offline: true, error: '表示できませんでした。' }) })
    return () => { current = false }
  }, [companyId, recordId])
  return result
}
