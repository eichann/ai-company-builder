import type { StopMeaning } from '../../../../shared/design-tokens/stop-meaning'

// The colours of a state box drawn by hand — a card's frame, a one-line notice under it
// (design-system.md "Callouts and status badges (P2b, done)"): only the bg + border of one token
// set, no palette colour or free opacity. A box with an icon and a title is the `Callout`
// (primitives.tsx). `info` is also how an offline result looks (grey, not amber: amber is warning
// and awaiting approval only).
export const STATE_BOX = {
  ok: 'border-success-border bg-success-bg',
  warn: 'border-warning-border bg-warning-bg',
  error: 'border-danger-border bg-danger-bg',
  failed: 'border-failed-border bg-failed-bg',
  awaiting: 'border-awaiting-border bg-awaiting-bg',
  info: 'border-info-border bg-info-bg',
  plain: 'border-[color:var(--color-border)]',
} as const
export type StateBoxTone = keyof typeof STATE_BOX

// A stop's icon and text colour for a hand-drawn mark (a row's icon, a one-line notice, a button's
// icon), by what the stop means for the member (`STOP_LOOK`, design-system.md 「止まっている」の色).
// Complete class names, so the design lint and Tailwind read them.
export const STOP_ICON: Record<StopMeaning, string> = {
  needsAction: 'text-warning-icon',
  stoppedOnPurpose: 'text-paused-icon',
  failed: 'text-failed-icon',
  awaitingApproval: 'text-awaiting-icon',
}
export const STOP_TEXT: Record<StopMeaning, string> = {
  needsAction: 'text-warning-text',
  stoppedOnPurpose: 'text-paused-text',
  failed: 'text-failed-text',
  awaitingApproval: 'text-awaiting-text',
}
