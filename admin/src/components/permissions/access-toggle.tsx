'use client'

import { useRef } from 'react'
import { Eye, PencilSimple } from '@phosphor-icons/react'

import { cn } from '@/lib/utils'

const OPTIONS = [
  { value: true, label: '編集できる', icon: PencilSimple },
  { value: false, label: '閲覧のみ', icon: Eye },
] as const

/**
 * Segmented 編集できる / 閲覧のみ control (a radio group: arrow keys move
 * between the two, as for native radios).
 */
export function AccessToggle({
  canWrite,
  onChange,
  disabled,
  label,
  size = 'default',
}: {
  canWrite: boolean
  onChange: (canWrite: boolean) => void
  disabled?: boolean
  /** Accessible name, e.g. "田中 太郎 の権限". */
  label: string
  size?: 'default' | 'sm'
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn('inline-flex shrink-0 rounded-md border bg-muted/50 p-0.5', disabled && 'opacity-60')}
      onKeyDown={(e) => {
        if (disabled) return
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault()
          const next = !canWrite
          onChange(next)
          refs.current[next ? 0 : 1]?.focus()
        }
      }}
    >
      {OPTIONS.map((o, i) => {
        const checked = o.value === canWrite
        const IconComponent = o.icon
        return (
          <button
            key={o.label}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => !checked && onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[5px] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-xs sm:text-sm',
              checked && 'bg-background text-foreground shadow-xs',
              !checked && !disabled && 'hover:text-foreground'
            )}
          >
            <IconComponent size={14} weight={checked ? 'bold' : 'regular'} />
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
