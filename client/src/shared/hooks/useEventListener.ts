import { useEffect } from 'react'
import { useLatestRef } from './useLatestRef'

type Target = Window | Document | HTMLElement

/**
 * Listens to `type` on `target` while mounted and `enabled`; the latest
 * `handler` is called without re-subscribing. `target` may be a function, read
 * when subscribing (an element behind a ref).
 */
export function useEventListener<E extends Event = Event>(
  target: Target | null | undefined | (() => Target | null | undefined),
  type: string,
  handler: (event: E) => void,
  { capture = false, passive, enabled = true }: { capture?: boolean; passive?: boolean; enabled?: boolean } = {},
): void {
  const handlerRef = useLatestRef(handler)
  useEffect(() => {
    const element = typeof target === 'function' ? target() : target
    if (!element || !enabled) return
    const listener = (event: Event) => handlerRef.current(event as E)
    element.addEventListener(type, listener, { capture, passive })
    return () => element.removeEventListener(type, listener, { capture })
  }, [target, type, capture, passive, enabled, handlerRef])
}
