import { useCallback, useState } from 'react'
import { useLatestRef } from './useLatestRef'
import { settleShown, type ShownAnswer, type ShownCache } from '../lib/shownCache'

/**
 * A server answer a view shows, starting from what it showed last time (`cache`) so a view mounted
 * again is never blank while it reads again. `show(next, settle?)` puts a new answer on screen and
 * in the cache; `settle` decides between the shown one and the new one (default `settleShown`).
 */
export function useShown<T extends ShownAnswer>(cache: ShownCache<T>, scope: string, key: string) {
  const [state, setState] = useState(() => ({ scope, key, value: cache.shown(scope, key) ?? null }))
  // Another record or company without a remount: start from its own remembered answer (adjusted while rendering).
  const current = state.scope === scope && state.key === key ? state : { scope, key, value: cache.shown(scope, key) ?? null }
  if (current !== state) setState(current)
  const latest = useLatestRef(current)
  const show = useCallback((next: T, settle: (shown: T | null, next: T) => T = settleShown) => {
    const now = latest.current
    if (now.scope !== scope || now.key !== key) return
    const value = settle(now.value, next)
    cache.remember(scope, key, value)
    latest.current = { scope, key, value }
    setState(latest.current)
  }, [cache, scope, key, latest])
  return [current.value, show] as const
}
