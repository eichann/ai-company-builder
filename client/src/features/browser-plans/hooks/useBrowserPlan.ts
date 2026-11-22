import { useCallback, useSyncExternalStore } from 'react'
import { getBrowserPlan, type BrowserPlanReads } from '../api'
import { planEntry, planKey, reloadPlan, subscribePlan } from '../planStore'
import { useAuthStore } from '../../../stores/authStore'

/** One plan as main last answered it (the server's fixed view + this PC's readiness), loaded when first shown. */
export function useBrowserPlan(companyId: string, planId: string, reads?: BrowserPlanReads) {
  // Per signed-in member: another account on this PC never sees a copy the previous one was shown.
  const userId = useAuthStore(s => s.user?.id ?? '')
  const key = planKey(userId, companyId, planId)
  const load = useCallback(() => (reads ? getBrowserPlan(companyId, planId, reads) : getBrowserPlan(companyId, planId)), [companyId, planId, reads])
  const subscribe = useCallback((listener: () => void) => subscribePlan(key, load, listener), [key, load])
  const entry = useSyncExternalStore(subscribe, () => planEntry(key), () => planEntry(key))
  const reload = useCallback(() => reloadPlan(key, load), [key, load])
  return { ...entry, reload }
}
