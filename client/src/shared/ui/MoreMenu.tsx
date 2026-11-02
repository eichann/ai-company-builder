import { useRef, useState, type ReactNode } from 'react'
import { DotsThreeVertical } from '@phosphor-icons/react'
import { useEventListener } from '../hooks/useEventListener'

export interface MoreMenuItem {
  label: string
  /** One line on what happens (「消しません。『しまったもの』から戻せます」). */
  hint?: string
  danger?: boolean
  icon?: ReactNode
  onClick: () => void
}

interface Props {
  items: MoreMenuItem[]
  /** The button's name for screen readers and the tooltip. */
  label?: string
  /** Only the 「…」 (list rows); otherwise 「… その他の操作」. */
  compact?: boolean
  align?: 'left' | 'right'
}

/** 「…」: the secondary actions behind the one main button, each with a one-line hint. */
export function MoreMenu({ items, label = 'その他の操作', compact, align = 'right' }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEventListener<MouseEvent>(document, 'mousedown', e => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }, { enabled: open })
  useEventListener<KeyboardEvent>(document, 'keydown', e => { if (e.key === 'Escape') setOpen(false) }, { enabled: open })
  if (items.length === 0) return null
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button" data-more aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        className={compact
          ? 'p-1 rounded text-gray-500 hover:bg-gray-200/70 dark:hover:bg-zinc-700'
          : 'inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2 py-1 text-[11.5px] text-gray-700 dark:text-zinc-200 hover:border-accent hover:text-accent'}
      >
        <DotsThreeVertical size={compact ? 15 : 14} weight="bold" />{!compact && label}
      </button>
      {open && (
        <div role="menu" className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full mt-1 z-40 w-[280px] rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-xl p-1 text-left`}>
          {items.map(i => (
            <button
              key={i.label} type="button" role="menuitem"
              onClick={e => { e.stopPropagation(); setOpen(false); i.onClick() }}
              className="w-full rounded-md px-2.5 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-zinc-700"
            >
              <span className={`flex items-center gap-1.5 text-[12.5px] ${i.danger ? 'text-rose-600 dark:text-rose-400' : 'text-gray-800 dark:text-zinc-100'}`}>{i.icon}{i.label}</span>
              {i.hint && <span className="block text-[10.5px] leading-snug text-gray-500 dark:text-zinc-400">{i.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
