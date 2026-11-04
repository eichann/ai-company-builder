import { useEffect, useState } from 'react'
import type { RecordCardResult, RecordViewSummary } from '../../../../shared/record-views'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { useShown } from '../../../shared/hooks/useShown'
import { createShownCache } from '../../../shared/lib/shownCache'
import { getRecordCard } from '../api'

/** The cards shown before, so a tab switched back to shows its card at once and reads it again (owner FB #14). */
const shownCards = createShownCache<RecordCardResult>()

/**
 * Loads one record's card (null while nothing was shown before) and again on `reload`; `onLoaded` gets the record
 * once read (its tab's title and kind). Mounted again, it starts from the card shown last while it
 * reads again; a failure keeps what is shown, a card read as gone is forgotten. The caller keys the component by record id.
 */
export function useRecordCard(companyId: string, recordId: string, onLoaded?: (record: RecordViewSummary) => void): { result: RecordCardResult | null; reload: () => void } {
  const [result, show] = useShown(shownCards, companyId, recordId)
  const [rev, setRev] = useState(0)
  const loadedRef = useLatestRef(onLoaded)
  useEffect(() => {
    let current = true
    getRecordCard(companyId, recordId)
      .then(r => {
        if (!current) return
        show(r)
        if (r.success && rev === 0) loadedRef.current?.(r.card.record)
      })
      .catch(() => { if (current) show({ success: false, offline: true, error: '表示できませんでした。' }) })
    return () => { current = false }
  }, [companyId, recordId, loadedRef, rev, show])
  return { result, reload: () => setRev(v => v + 1) }
}
