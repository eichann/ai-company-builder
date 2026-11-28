import { useCallback, useRef } from 'react'
import { useLatestRef } from './useLatestRef'

/**
 * Calls `onVisible` when an element comes into view (inside every scrolling ancestor), kept current with an
 * IntersectionObserver. Returns a callback ref for the element: observing starts when it mounts and stops when it goes,
 * with no effect. Give the element a new `key` to be told again while it stays in view.
 */
export function useWhenVisible<T extends Element>(onVisible: () => void): (element: T | null) => void {
  const latest = useLatestRef(onVisible)
  const observerRef = useRef<IntersectionObserver | null>(null)
  return useCallback((element: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) latest.current() })
    observer.observe(element)
    observerRef.current = observer
  }, [latest])
}
