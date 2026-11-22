import type { ReactNode } from 'react'
import { X } from '@phosphor-icons/react'

/**
 * What a feature shows in the bottom panel (the inbox, I1): its name and its body. The panel has
 * one body, no tabs (owner, 2026-11-22). Without content there is no panel, no title bar button and
 * ⌘J does nothing: an empty frame is never shown.
 */
export interface BottomPanelContent {
  title: string
  /** Beside the name in the heading (the inbox's chips). */
  heading?: ReactNode
  body: ReactNode
}

interface Props {
  content: BottomPanelContent
  onClose: () => void
}

/** The panel under the middle: a heading with the content's name and 閉じる, then the content. */
export function BottomPanel({ content, onClose }: Props) {
  return (
    <section aria-label={content.title} className="h-full flex flex-col min-h-0 bg-[var(--color-surface)] border-t border-[color:var(--color-border)]">
      <div className="flex-shrink-0 flex items-center gap-2 pl-3 pr-1 py-1 border-b border-[color:var(--color-border)] bg-bg">
        <h2 className={`${content.heading ? 'flex-shrink-0' : 'flex-1 min-w-0 truncate'} text-small font-semibold text-text`}>{content.title}</h2>
        {content.heading && <div className="flex-1 min-w-0">{content.heading}</div>}
        <button type="button" onClick={onClose} title="閉じる (⌘J)" aria-label="下のパネルを閉じる (⌘J)"
          className="p-1.5 rounded-control text-text-subtle hover:bg-surface-sunken hover:text-text transition-colors">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{content.body}</div>
    </section>
  )
}
