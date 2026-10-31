import { useCallback, useRef, useState } from 'react'

/**
 * Whether an element is narrower than `breakpoint` pixels, kept current with
 * a ResizeObserver. Returns a callback ref for the element: observing starts
 * when it mounts and stops when it goes, with no effect.
 */
export function useIsNarrowerThan<T extends Element>(breakpoint: number): [ref: (element: T | null) => void, narrow: boolean] {
  const [narrow, setNarrow] = useState(false)
  const observerRef = useRef<ResizeObserver | null>(null)
  const ref = useCallback((element: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < breakpoint))
    observer.observe(element)
    observerRef.current = observer
  }, [breakpoint])
  return [ref, narrow]
}
