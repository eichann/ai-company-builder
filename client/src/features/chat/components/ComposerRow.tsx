import type { ReactNode } from 'react'
import { ArrowUp } from '@phosphor-icons/react'
import { PRIMARY_ACTION } from '../../../shared/ui/buttonStyles'

/**
 * The bottom row inside the input's frame (both text inputs): voice input on the left, then the
 * suggestion's keys while one is offered, the model switch and send on the right. It wraps instead
 * of clipping, so nothing in it is ever cut off at the pane's 280 px.
 */
export function ComposerRow({ start, hint, end, children }: { start?: ReactNode; hint?: string; end?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1">
      {start}
      {hint && <span data-composer-hint className="min-w-0 text-caption font-normal text-text-subtle">{hint}</span>}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
        {end}
        {children}
      </div>
    </div>
  )
}

export function SendButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="送る"
      title="送る（⌘+Enter）"
      className={`flex-shrink-0 h-control w-8 rounded-control disabled:cursor-not-allowed flex items-center justify-center transition-colors ${PRIMARY_ACTION}`}
    >
      <ArrowUp size={16} weight="bold" />
    </button>
  )
}
