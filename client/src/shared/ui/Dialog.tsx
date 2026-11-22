import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { X } from '@phosphor-icons/react'
import { useEventListener } from '../hooks/useEventListener'
import { useLatestRef } from '../hooks/useLatestRef'

/** Widths of the three dialog sizes (tokens `--size-dialog-sm|md|lg`: 400 / 480 / 640). */
export type DialogSize = 'sm' | 'md' | 'lg' | 'custom'
const WIDTH: Record<DialogSize, string> = {
  sm: 'max-w-[var(--size-dialog-sm)]',
  md: 'max-w-[var(--size-dialog-md)]',
  lg: 'max-w-[var(--size-dialog-lg)]',
  // A wide two-pane dialog (copying a Skill, the settings): the caller gives the width.
  custom: '',
}

/** The frame's look, one copy: tests and the hand-drawn exceptions read it. */
export const DIALOG_SCRIM = 'fixed inset-0 z-dialog flex items-center justify-center bg-scrim p-6'
export const DIALOG_PANEL = 'w-full bg-surface-raised text-text border border-[color:var(--color-border)] rounded-card shadow-dialog outline-none'

interface DialogProps {
  /** Esc, and a scrim click when `closeOnScrim`. */
  onClose: () => void
  /** `alertdialog` for a question about deleting or losing something: the scrim does not close it. */
  role?: 'dialog' | 'alertdialog'
  /** The id of the visible title (`DialogTitle`), or `label` when the dialog has none. */
  labelledBy?: string
  label?: string
  describedBy?: string
  size?: DialogSize
  /** Default: an ordinary dialog closes on a scrim click, an alertdialog does not. */
  closeOnScrim?: boolean
  /** False while something runs: Esc and the scrim do nothing until it ends. */
  dismissible?: boolean
  /**
   * Where focus starts. Default: a field the dialog focused itself (`autoFocus`), else the dialog
   * itself, so a key typed while it opens answers nothing.
   */
  initialFocus?: RefObject<HTMLElement | null>
  /** Inner padding `dialog` (20px) with the title, body and footer spacing; off for list pickers. */
  padded?: boolean
  /** Panel extras: height, overflow, flex layout. Never a colour, radius or shadow of its own. */
  className?: string
  children: ReactNode
}

/** Open dialogs, last opened on top. Only the top one keeps focus and answers keys. */
const openDialogs: HTMLElement[] = []
const isTop = (el: HTMLElement) => openDialogs[openDialogs.length - 1] === el

const FOCUSABLE = 'button:not([disabled]), [href], iframe, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The one dialog frame of the app (.claude/rules/design-system.md, P2c): scrim `scrim`, surface
 * `surface-raised`, corner `card`, shadow `dialog`, padding `dialog`, three widths. Keyboard rules
 * from the owner's proposal (P1a, components.html 確認ダイアログ): Tab / Shift+Tab stay inside;
 * Esc closes and does not reach what is underneath; a scrim click never takes focus out; nothing
 * listens for Enter on the document; focus returns to what opened it; stacked dialogs: only the top
 * one acts. Mounted only while open.
 */
export function Dialog({
  onClose,
  role = 'dialog',
  labelledBy,
  label,
  describedBy,
  size = 'md',
  closeOnScrim = role === 'dialog',
  dismissible = true,
  initialFocus,
  padded = true,
  className = '',
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  // What had focus when the dialog opened, read while rendering: a field inside that focuses itself
  // (autoFocus, a callback ref) does so before any effect runs.
  const [opener] = useState(() => document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null)
  const startRef = useLatestRef(() => {
    const panel = panelRef.current
    if (initialFocus?.current) return initialFocus.current
    const active = document.activeElement
    return panel && active instanceof HTMLElement && panel.contains(active) ? active : panel
  })
  const closeRef = useLatestRef(() => { if (dismissible) onClose() })
  // Where focus went at opening: focus that strays out of the top dialog comes back here.
  const startedOn = useRef<HTMLElement | null>(null)

  // Open: remember the opener, go on top, move focus in. Close: give focus back to the opener.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    openDialogs.push(panel)
    startedOn.current = startRef.current()
    startedOn.current?.focus()
    return () => {
      const i = openDialogs.indexOf(panel)
      if (i >= 0) openDialogs.splice(i, 1)
      const now = document.activeElement
      const focusStillOurs = !now || now === document.body || panel.contains(now)
      if (opener?.isConnected && focusStillOurs) opener.focus()
    }
    // Runs once per opening: the dialog is mounted only while open; the ref and opener never change.
  }, [startRef, opener])

  // Focus that lands outside the top dialog (a click elsewhere, a script) is brought back in.
  useEventListener<FocusEvent>(document, 'focusin', e => {
    const panel = panelRef.current
    if (!panel || !isTop(panel) || panel.contains(e.target as Node)) return
    const start = startedOn.current
    ;(start?.isConnected && panel.contains(start) ? start : panel).focus()
  })

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current
    // A dialog drawn inside this one handles its own keys.
    if (!panel || (e.target as Element).closest('[data-dialog-panel]') !== panel) return
    if (e.key === 'Escape') {
      // Ours alone: a dialog or panel underneath must not close on the same key.
      e.stopPropagation()
      e.preventDefault()
      closeRef.current()
      return
    }
    if (e.key === 'Tab') {
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) { e.preventDefault(); return }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || active === panel)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <div
      data-dialog-scrim
      className={DIALOG_SCRIM}
      // A click on the scrim never takes focus out of the dialog; it closes an ordinary one.
      onMouseDown={e => {
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        if (closeOnScrim) closeRef.current()
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-dialog-panel
        className={`${DIALOG_PANEL} ${WIDTH[size]} ${padded ? 'p-dialog' : ''} ${className}`}
      >
        {children}
      </div>
    </div>
  )
}

/** The dialog's heading: type `title` (15px, 600). */
export function DialogTitle({ id, children, className = '' }: { id?: string, children: ReactNode, className?: string }) {
  return <h2 id={id} className={`text-title text-text ${className}`}>{children}</h2>
}

/** The buttons row: right-aligned, 「やめる」 first (left), the main action last (right). */
export function DialogFooter({ children, className = '' }: { children: ReactNode, className?: string }) {
  return <div data-dialog-footer className={`mt-5 flex items-center justify-end gap-2 ${className}`}>{children}</div>
}

/** 「閉じる」 (×) at the title's right. */
export function DialogCloseButton({ onClick, disabled }: { onClick: () => void, disabled?: boolean }) {
  return (
    <button type="button" aria-label="閉じる" onClick={onClick} disabled={disabled}
      className="flex size-7 shrink-0 items-center justify-center rounded-control text-text-subtle hover:bg-surface-sunken hover:text-text disabled:opacity-disabled focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring">
      <X size={14} />
    </button>
  )
}
