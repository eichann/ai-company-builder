import { useCallback, useRef, useState } from 'react'

/**
 * How the chat header gives way as its pane narrows, one step at a time and always in this order
 * (owner FB 2026-11-26: the usage meter was drawn over the model picker and the header shook left
 * and right). Each step starts below its width, the header's border box in px:
 *
 * 1. `meterCompact` — the usage meter shows only its fullest window (bar + %); the agent badge
 *    and the status words go (the dot stays).
 * 2. `meterBar`     — the meter is its bar only (the % stays in its name and its popover); the
 *    sparkle goes and the padding tightens.
 * 3. `shortSelects` — the model and effort pickers are capped narrower (their labels clip).
 * 4. `menu`         — the Markdown toggle and 「別ウィンドウで開く」 move into 「…」.
 * 5. `effortInMenu` — the effort picker moves into 「…」 too (a pane at its narrowest, 280 px).
 *
 * ＋, the list and settings never move. Each width is what the roomier layout needs when idle
 * (Claude Code, measured in tests/ui/chat-header-fit.spec.ts) plus a little; a turn's stop button
 * takes its room from the pickers (they shrink, and the model is locked meanwhile), never from
 * the buttons.
 */
const STEPS = [
  ['meterCompact', 720],
  ['meterBar', 520],
  ['shortSelects', 420],
  ['menu', 400],
  ['effortInMenu', 370],
] as const

export type HeaderStep = typeof STEPS[number][0]
export type HeaderFit = Record<HeaderStep, boolean>

export function headerFit(width: number): HeaderFit {
  return Object.fromEntries(STEPS.map(([step, below]) => [step, width < below])) as HeaderFit
}

const ROOMY = headerFit(Infinity)

/**
 * The header's fit, from its own border-box width. The border box is set by the pane, not by the
 * header's content or padding, so a step taken cannot change the width that chose it. (Measuring
 * the content box did: the tighter padding of the narrow layout widened the content box past the
 * breakpoint, which brought the roomy padding back — the header flipped every frame.)
 */
export function useHeaderFit<T extends Element>(): [ref: (element: T | null) => void, fit: HeaderFit] {
  const [width, setWidth] = useState(Infinity)
  const observerRef = useRef<ResizeObserver | null>(null)
  const ref = useCallback((element: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize?.[0]
      setWidth(Math.round(box ? box.inlineSize : entry.target.getBoundingClientRect().width))
    })
    observer.observe(element)
    observerRef.current = observer
  }, [])
  return [ref, width === Infinity ? ROOMY : headerFit(width)]
}
