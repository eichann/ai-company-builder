import * as React from 'react'
import { Slot as SlotPrimitive } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { Hourglass, Lock, Pause, Sparkle, WarningOctagon, type Icon } from '@phosphor-icons/react'

import { cn } from '@/lib/utils'

// The status badge (design-system.md "Callouts and status badges (P2b, done)"): a mark that cannot be
// pressed, one variant per meaning, each drawn only from its token set. The three stopped states are
// separate (owner decision 2026-11-21): `paused` stopped by a person (grey, 「止めています」), `failed`
// stopped by a failure (red, 「止まりました」), `awaiting` awaiting approval (amber); a stop the admin has to
// act on is `warning` (`STOP_LOOK`, shared/design-tokens/stop-meaning.ts). Amber is warning and awaiting only. `selected` is a picked or highlighted role (管理者, 個別の設定), `neutral` a plain one.
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-small border px-badge-x py-0.5 text-small font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        neutral: 'border-transparent bg-surface-sunken text-text-muted',
        outline: 'text-foreground',
        info: 'border-info-border bg-info-bg text-info-text [&>svg]:text-info-icon',
        success: 'border-success-border bg-success-bg text-success-text [&>svg]:text-success-icon',
        warning: 'border-warning-border bg-warning-bg text-warning-text [&>svg]:text-warning-icon',
        danger: 'border-danger-border bg-danger-bg text-danger-text [&>svg]:text-danger-icon',
        paused: 'border-paused-border bg-paused-bg text-paused-text [&>svg]:text-paused-icon',
        failed: 'border-failed-border bg-failed-bg text-failed-text [&>svg]:text-failed-icon',
        awaiting: 'border-awaiting-border bg-awaiting-bg text-awaiting-text [&>svg]:text-awaiting-icon',
        ai: 'border-ai-border bg-ai-bg text-ai-text [&>svg]:text-ai-icon',
        selected: 'border-selected-border bg-selected-bg text-selected-text [&>svg]:text-selected-icon',
        readonly: 'border-readonly-border bg-readonly-bg text-readonly-text [&>svg]:text-readonly-icon',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  }
)

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>

/** Default icons: the three stopped states differ in more than colour; 閲覧のみ carries its padlock. */
const BADGE_ICON: Partial<Record<BadgeVariant, Icon>> = {
  paused: Pause, failed: WarningOctagon, awaiting: Hourglass, readonly: Lock, ai: Sparkle,
}

function Badge({
  className,
  variant,
  icon,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean; icon?: Icon | null }) {
  const Comp = asChild ? SlotPrimitive.Slot : 'span'
  const Glyph = icon === undefined ? BADGE_ICON[variant ?? 'neutral'] : icon
  return (
    <Comp data-slot="badge" data-badge={variant ?? 'neutral'} className={cn(badgeVariants({ variant }), className)} {...props}>
      {Glyph && !asChild && <Glyph weight="bold" aria-hidden />}
      {children}
    </Comp>
  )
}

export { Badge, badgeVariants }
