import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEventListener } from '../hooks/useEventListener'

const GAP = 6
const MARGIN = 8

/**
 * A tooltip that opens on hover or focus of its trigger and is drawn on document.body with
 * position: fixed, so a clipping ancestor (a header with overflow-hidden) cannot cut it off.
 * Closes on leave, blur, Escape and scroll; stays inside the window.
 */
export function HoverTooltip({ trigger, children, className = '' }: {
  /** Renders the trigger; pass `describedBy` to its aria-describedby. */
  trigger: (describedBy: string | undefined) => ReactNode
  children: ReactNode
  /** The panel's look (width, padding, colours); placement is handled here. */
  className?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setOpen(true)
  }, [])
  // A short delay lets the pointer cross the gap into the panel.
  const hideSoon = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false) }, 120)
  }, [])
  const hideNow = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setOpen(false)
  }, [])

  useEventListener<KeyboardEvent>(document, 'keydown', e => { if (e.key === 'Escape') hideNow() }, { enabled: open })
  useEventListener(window, 'scroll', hideNow, { capture: true, enabled: open })
  useEventListener(window, 'resize', hideNow, { enabled: open })

  // Placed before paint from the trigger's box: below it (above when there is no room), and
  // shifted left to stay inside the window.
  const place = useCallback((panel: HTMLDivElement | null) => {
    const anchor = anchorRef.current
    if (!panel || !anchor) return
    const a = anchor.getBoundingClientRect()
    const { offsetWidth: w, offsetHeight: h } = panel
    const left = Math.max(MARGIN, Math.min(a.left, window.innerWidth - w - MARGIN))
    const below = a.bottom + GAP
    const top = below + h > window.innerHeight - MARGIN && a.top - GAP - h >= MARGIN ? a.top - GAP - h : below
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  }, [])

  return (
    <div
      ref={anchorRef}
      className="relative flex-shrink-0"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={show}
      onBlur={hideNow}
    >
      {trigger(open ? id : undefined)}
      {open && createPortal(
        <div
          ref={place}
          id={id}
          role="tooltip"
          onMouseEnter={show}
          onMouseLeave={hideSoon}
          className={`fixed z-50 max-w-[calc(100vw-1rem)] ${className}`}
          style={{ left: 0, top: 0 }}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  )
}
