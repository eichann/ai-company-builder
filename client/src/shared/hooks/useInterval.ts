import { useEffect } from 'react'
import { useLatestRef } from './useLatestRef'

/** Calls the latest `callback` every `ms` milliseconds; `null` stops it. */
export function useInterval(callback: () => void, ms: number | null): void {
  const callbackRef = useLatestRef(callback)
  useEffect(() => {
    if (ms === null) return
    const timer = setInterval(() => callbackRef.current(), ms)
    return () => clearInterval(timer)
  }, [ms, callbackRef])
}
