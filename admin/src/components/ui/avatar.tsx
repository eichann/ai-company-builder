import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/**
 * Initials avatar. Members have no profile images in this product, so this is
 * a plain element rather than Radix Avatar (which only adds image loading).
 * The hue is derived from the seed so a person keeps the same colour
 * everywhere.
 */
function Avatar({
  name,
  seed,
  className,
}: {
  name: string
  seed?: string
  className?: string
}) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?'
  const hue = hash(seed ?? name) % 360
  return (
    <span
      aria-hidden="true"
      data-slot="avatar"
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold select-none',
        'bg-[oklch(0.92_0.045_var(--avatar-hue))] text-[oklch(0.36_0.08_var(--avatar-hue))]',
        'dark:bg-[oklch(0.36_0.06_var(--avatar-hue))] dark:text-[oklch(0.92_0.04_var(--avatar-hue))]',
        className
      )}
      style={{ '--avatar-hue': hue } as CSSProperties}
    >
      {initial}
    </span>
  )
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export { Avatar }
