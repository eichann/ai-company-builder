import { useRef, type MutableRefObject } from 'react'

/**
 * A ref that always holds the value of the latest render, for callbacks made
 * once (a CodeMirror extension, a timer, a listener) that must call the
 * current prop. Replaces an effect that only copies `xRef.current = x`
 * (renderer-structure.md "Effects"). Read it in event handlers and effects,
 * not during render.
 */
export function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value)
  ref.current = value
  return ref
}
