import { useEffect } from 'react'
import { useLatestRef } from './useLatestRef'

/**
 * Receives an event from the main process while mounted (and `enabled`):
 * `subscribe` is a data-layer function that takes a listener and returns the
 * function that stops it (`onChatHistoryChanged`, …). The latest `handler` is
 * called without re-subscribing.
 */
export function useIpcEvent<T>(
  subscribe: (listener: (payload: T) => void) => (() => void) | void,
  handler: (payload: T) => void,
  enabled = true,
): void {
  const handlerRef = useLatestRef(handler)
  useEffect(() => {
    if (!enabled) return
    return subscribe(payload => handlerRef.current(payload)) ?? undefined
  }, [subscribe, enabled, handlerRef])
}
