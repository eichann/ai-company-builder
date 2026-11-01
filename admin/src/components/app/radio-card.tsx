'use client'

import { cn } from '@/lib/utils'

/** One choice of a `role="radiogroup"`: a card with a label and a line of help. */
export function RadioCard({ checked, onSelect, label, help }: { checked: boolean; onSelect: () => void; label: string; help: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'flex flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
        checked ? 'border-brand ring-1 ring-brand/40' : 'hover:border-foreground/20'
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <span aria-hidden="true" className={cn('flex size-4 items-center justify-center rounded-full border', checked ? 'border-brand' : 'border-input')}>
          {checked && <span className="size-2 rounded-full bg-brand" />}
        </span>
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{help}</span>
    </button>
  )
}
