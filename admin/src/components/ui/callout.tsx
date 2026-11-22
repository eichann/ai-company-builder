import * as React from 'react'
import { CheckCircle, Hourglass, Info, PauseCircle, Warning, WarningCircle, WarningOctagon, type Icon } from '@phosphor-icons/react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

// The callout (design-system.md "Callouts and status badges (P2b, done)"): the one box for a note,
// a warning, an error or a success, the same look as the app's `Callout`. Only its token set (bg,
// border, text, icon) — no free opacities, one corner (`control`), one padding (`callout`). The
// stopped states as boxes: `paused` (a person stopped it: grey), `failed` (a failure: red),
// `awaiting` (approval: amber).
const calloutVariants = cva('flex items-start gap-2.5 rounded-control border p-callout text-body', {
  variants: {
    variant: {
      info: 'border-info-border bg-info-bg text-info-text',
      warning: 'border-warning-border bg-warning-bg text-warning-text',
      danger: 'border-danger-border bg-danger-bg text-danger-text',
      success: 'border-success-border bg-success-bg text-success-text',
      paused: 'border-paused-border bg-paused-bg text-paused-text',
      failed: 'border-failed-border bg-failed-bg text-failed-text',
      awaiting: 'border-awaiting-border bg-awaiting-bg text-awaiting-text',
    },
  },
  defaultVariants: { variant: 'info' },
})

export type CalloutVariant = NonNullable<VariantProps<typeof calloutVariants>['variant']>

const ICON: Record<CalloutVariant, { icon: Icon; className: string }> = {
  info: { icon: Info, className: 'text-info-icon' },
  warning: { icon: Warning, className: 'text-warning-icon' },
  danger: { icon: WarningCircle, className: 'text-danger-icon' },
  success: { icon: CheckCircle, className: 'text-success-icon' },
  paused: { icon: PauseCircle, className: 'text-paused-icon' },
  failed: { icon: WarningOctagon, className: 'text-failed-icon' },
  awaiting: { icon: Hourglass, className: 'text-awaiting-icon' },
}

/**
 * `title` is the bold first line; `action` sits at the right (a button). `icon={null}` drops the
 * icon (a one-line note under a field). Without a `role`, a danger or failed callout is an alert.
 */
function Callout({
  className,
  variant,
  title,
  action,
  icon,
  children,
  role,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & VariantProps<typeof calloutVariants> & { title?: React.ReactNode; action?: React.ReactNode; icon?: Icon | null }) {
  const v = variant ?? 'info'
  const Glyph = icon === undefined ? ICON[v].icon : icon
  return (
    <div
      data-slot="callout"
      data-callout={v}
      role={role ?? (v === 'danger' || v === 'failed' ? 'alert' : undefined)}
      className={cn(calloutVariants({ variant }), className)}
      {...props}
    >
      {Glyph && <Glyph size={18} weight={v === 'info' ? 'regular' : 'fill'} aria-hidden className={cn('mt-0.5 shrink-0', ICON[v].className)} />}
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-strong">{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export { Callout, calloutVariants }
