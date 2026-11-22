import * as React from 'react'

import { cn } from '@/lib/utils'

// The on / off switch (design-system.md "Sizes, type and corners (P3, done)"), the same as the app's
// `Switch`: 36×20, "on" the primary colour, "off" `border-strong` (3:1 on the page), the thumb
// `on-primary`. The caller says what pressing does (some ask before turning off).
export function Switch({ checked, className, ...props }: Omit<React.ComponentProps<'button'>, 'role' | 'type'> & { checked: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      className={cn(
        'relative inline-flex h-(--size-switch-h) w-(--size-switch-w) shrink-0 items-center rounded-full transition-colors duration-fast outline-none focus-visible:ring-focus focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-disabled',
        checked ? 'bg-primary' : 'bg-border-strong',
        className,
      )}
      {...props}
    >
      <span className={cn('absolute left-0.5 size-4 rounded-full bg-on-primary shadow-card transition-transform duration-fast', checked ? 'translate-x-4' : 'translate-x-0')} />
    </button>
  )
}
