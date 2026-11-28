// A reply with ```acb-html / ```acb-slide blocks, drawn whole — its words too — in one closed frame with no line or
// background of its own (chat-ui-and-history.md "Rich replies: the reply's closed frame").
//   - The frame shown is replaced, never rewritten (no script runs in it and the chat cannot reach into it): a new one
//     is loaded out of sight and shown in the old one's place once drawn, at most every RICH_UPDATE_MS, so a reply
//     being written grows without a blank moment, and a theme switch follows at once.
//   - Its height is its content's, measured on a hidden inert copy (richReplyFrame.ts `measureReply`); over
//     RICH_MAX_HEIGHT it stops there and says where the rest is. Taller content makes the list follow the bottom only
//     when it was following (ChatFollowContext).
//   - Drawn only near the screen; taken down far away, keeping its height (the reading position does not move).
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { ChatFollowContext } from '../chatFollow'
import { RICH_MAX_HEIGHT, RICH_UPDATE_MS, richPiecesOf } from '../richReply'
import { frameContentOf, frameDocument, measureReply, shownFrame } from '../richReplyFrame'

/** Heights already measured, by width, theme and text: a reply drawn again (scrolled back, the window moved) keeps its place. */
const knownHeights = new Map<string, number>()
const heightKey = (width: number, isDark: boolean, content: string) => `${Math.round(width)}|${isDark ? 'd' : 'l'}|${content}`
function rememberHeight(key: string, height: number) {
  knownHeights.set(key, height)
  if (knownHeights.size > 200) knownHeights.delete(knownHeights.keys().next().value as string)
}

/** Within this of the screen a reply is drawn; farther away its frame is taken down. */
const NEAR_MARGIN = '600px 0px'
const observers = new Map<Element | null, IntersectionObserver>()
const nearWatchers = new Map<Element, (near: boolean) => void>()
function scrollParent(element: Element): Element | null {
  for (let el = element.parentElement; el; el = el.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el
  }
  return null
}
/** One observer per scrolling list (a margin on the window would be clipped by the list). */
function watchNear(element: Element, onChange: (near: boolean) => void): () => void {
  const root = scrollParent(element)
  let observer = observers.get(root)
  if (!observer) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) nearWatchers.get(entry.target)?.(entry.isIntersecting)
    }, { root, rootMargin: NEAR_MARGIN })
    observers.set(root, observer)
  }
  nearWatchers.set(element, onChange)
  observer.observe(element)
  return () => { nearWatchers.delete(element); observer.unobserve(element) }
}

export function ChatRichReply({ content, fallback, onOpenLarge }: {
  content: string
  /** The reply as the chat draws it otherwise, shown until the frame has drawn once (no blank moment). */
  fallback: ReactNode
  /** ［大きく見る］ (PR4): with it, the over-height line offers the button. */
  onOpenLarge?: () => void
}) {
  const isDark = useAppStore(s => s.theme) === 'dark'
  const follow = useContext(ChatFollowContext)
  const wrapRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const latest = useLatestRef({ content, isDark, follow, near })
  const draw = useRef({ shownDoc: '', running: false, again: false, lastStart: 0, timer: null as number | null, shown: null as HTMLIFrameElement | null })

  const fill = useRef(async () => {})
  const schedule = useRef(() => {})

  const knownHeight = width ? knownHeights.get(heightKey(width, isDark, content)) : undefined
  const shownHeight = height ?? knownHeight ?? null

  // Near the screen or not; the width the frame is laid out at.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const stopNear = watchNear(wrap, setNear)
    const resize = new ResizeObserver(() => setWidth(wrap.clientWidth))
    resize.observe(wrap)
    setWidth(wrap.clientWidth)
    return () => { stopNear(); resize.disconnect() }
  }, [])

  schedule.current = () => {
    const state = draw.current
    if (state.timer !== null) return
    const wait = Math.max(0, RICH_UPDATE_MS - (performance.now() - state.lastStart))
    state.timer = window.setTimeout(() => { state.timer = null; void fill.current() }, wait)
  }

  // Draw what the reply says now (only one drawing at a time; words that arrive meanwhile are drawn next).
  fill.current = async () => {
    const state = draw.current
    const host = hostRef.current
    if (state.running) { state.again = true; return }
    if (!host) return
    state.running = true
    state.lastStart = performance.now()
    try {
      const { content: text, isDark: dark } = latest.current
      const frameContent = frameContentOf(richPiecesOf(text), dark)
      const doc = frameDocument(frameContent, dark)
      const at = host.clientWidth
      const key = heightKey(at, dark, text)
      const measured = knownHeights.get(key) ?? await measureReply(frameContent, at, dark)
      rememberHeight(key, measured)
      const visible = Math.min(measured, RICH_MAX_HEIGHT)
      if (!hostRef.current || !latest.current.near) return
      if (doc !== state.shownDoc) {
        const next = shownFrame(visible, dark)
        await new Promise<void>(resolve => {
          next.onload = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          next.srcdoc = doc
          host.append(next)
        })
        // Gone or far away meanwhile: what was loaded is not shown.
        if (!hostRef.current || !latest.current.near) { next.remove(); return }
        next.style.visibility = 'visible'
        state.shown?.remove()
        state.shown = next
        state.shownDoc = doc
      } else if (state.shown) {
        state.shown.style.height = `${visible}px`
      }
      setHeight(measured)
      setReady(true)
    } finally {
      state.running = false
      if (state.again) { state.again = false; schedule.current() }
    }
  }
  // New words, another theme or width, or back near the screen: draw again. Far away: take the frame down.
  useLayoutEffect(() => {
    const state = draw.current
    if (!near || !width) {
      state.shown?.remove()
      state.shown = null
      state.shownDoc = ''
      setReady(false)
      return
    }
    schedule.current()
  }, [near, width, content, isDark])
  useLayoutEffect(() => () => {
    const state = draw.current
    if (state.timer !== null) window.clearTimeout(state.timer)
    state.shown?.remove()
    state.shown = null
  }, [])

  // A new height: follow the bottom if the list was following.
  useLayoutEffect(() => { if (height !== null) latest.current.follow() }, [height, latest])

  const over = shownHeight !== null && shownHeight > RICH_MAX_HEIGHT
  const boxHeight = shownHeight === null ? undefined : Math.min(shownHeight, RICH_MAX_HEIGHT)
  return (
    <div data-rich-reply data-rich-reply-state={ready ? 'frame' : shownHeight !== null ? 'placeholder' : 'fallback'}>
      <div ref={wrapRef} className="relative" style={ready || shownHeight !== null ? { height: boxHeight } : undefined}>
        {!ready && shownHeight === null && fallback}
        <div ref={hostRef} className="absolute inset-0 overflow-hidden" style={ready ? undefined : { pointerEvents: 'none' }} />
      </div>
      {over && (
        <p role="status" className="mt-2 text-small text-text-muted" data-rich-reply-over>
          この返事は長いため、途中までを表示しています。続きは［大きく見る］で見られます。
          {onOpenLarge && (
            <button type="button" onClick={onOpenLarge} className="ml-1 text-link underline underline-offset-2">大きく見る</button>
          )}
        </p>
      )}
    </div>
  )
}
