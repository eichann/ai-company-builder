import { useCallback, useSyncExternalStore } from 'react'
import { getBrowserInspection, type BrowserInspectionReads } from '../api'
import { inspectionEntry, inspectionKey, subscribeInspection } from '../inspectionStore'
import { useAuthStore } from '../../../stores/authStore'

const UNREADABLE = 'この点検のカードを読み込めませんでした。'

/** One inspection's card as main holds it, loaded when first shown (per signed-in member). */
export function useBrowserInspection(companyId: string, planId: string, reads?: BrowserInspectionReads) {
  const userId = useAuthStore(s => s.user?.id ?? '')
  const key = inspectionKey(userId, companyId, planId)
  const load = useCallback(() => (reads ? getBrowserInspection(companyId, planId, reads) : getBrowserInspection(companyId, planId)), [companyId, planId, reads])
  const subscribe = useCallback((listener: () => void) => subscribeInspection(key, load, UNREADABLE, listener), [key, load])
  return useSyncExternalStore(subscribe, () => inspectionEntry(key), () => inspectionEntry(key))
}
