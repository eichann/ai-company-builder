import { useEffect, useState } from 'react'
import type { RecordListResult } from '../../../../shared/record-views'
import { getRecordsForFile } from '../api'

/** Loads the records linked to one file (null while loading). The caller keys the component by path. */
export function useFileRecords(companyId: string, companyPath: string): RecordListResult | null {
  const [result, setResult] = useState<RecordListResult | null>(null)
  useEffect(() => {
    let current = true
    getRecordsForFile(companyId, companyPath)
      .then(r => { if (current) setResult(r) })
      .catch(() => { if (current) setResult({ success: false, offline: true, error: '表示できませんでした。' }) })
    return () => { current = false }
  }, [companyId, companyPath])
  return result
}
