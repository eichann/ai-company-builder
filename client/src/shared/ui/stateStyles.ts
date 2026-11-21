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
