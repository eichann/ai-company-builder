import { useEffect } from 'react'
import type { RecordListResult } from '../../../../shared/record-views'
import { getRecordsForFile } from '../api'
import { useShown } from '../../../shared/hooks/useShown'
import { createShownCache } from '../../../shared/lib/shownCache'

/** What each file's 「つながっているもの」 showed last, so switching back to a file shows it at once (owner FB #14). */
const shownLinks = createShownCache<RecordListResult>()

/**
 * Loads the records linked to one file (null while nothing was shown before: mounted again, it starts
 * from what it showed last while it reads again). The caller keys the component by path.
 */
export function useFileRecords(companyId: string, companyPath: string): RecordListResult | null {
  const [result, show] = useShown(shownLinks, companyId, companyPath)
  useEffect(() => {
    let current = true
    getRecordsForFile(companyId, companyPath)
      .then(r => { if (current) show(r) })
      .catch(() => { if (current) show({ success: false, offline: true, error: '表示できませんでした。' }) })
    return () => { current = false }
  }, [companyId, companyPath, show])
  return result
}
