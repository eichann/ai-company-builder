// An .html tab's ［見る｜中身］ (doc-frame.md "The viewer (A2)"): the same toggle at the same top-left
// place on both sides, so 中身 always has its way back (the owner, 2026-11-23: 「中身に切り替えたら、
// 戻らなくなっちゃいました」). ⌘⇧V switches too.
import { Code, Eye } from '@phosphor-icons/react'

const SIDE = 'inline-flex items-center gap-1 h-control-sm px-control-sm-x text-small'
const CHOSEN = `${SIDE} bg-selected-bg text-selected-text`
const OTHER = `${SIDE} text-text-muted hover:text-text hover:bg-surface-sunken`

/** The band over each side of an .html tab (its look: the document's toolbar). */
export const HTML_TAB_BAR = 'flex-shrink-0 flex flex-wrap items-center gap-1 px-2 py-1 border-b border-[color:var(--color-border)] bg-surface-raised'

interface HtmlViewToggleProps {
  showing: 'document' | 'source'
  onShowDocument?: () => void
  onShowSource?: () => void
}

export function HtmlViewToggle({ showing, onShowDocument, onShowSource }: HtmlViewToggleProps) {
  const document = showing === 'document'
  return (
    <div role="group" aria-label="表示の切り替え" className="flex rounded-control border border-border-control overflow-hidden">
      <button type="button" aria-pressed={document} onClick={document ? undefined : onShowDocument} className={document ? CHOSEN : OTHER}>
        <Eye size={14} aria-hidden />見る
      </button>
      <button type="button" aria-pressed={!document} onClick={document ? onShowSource : undefined} className={document ? OTHER : CHOSEN}>
        <Code size={14} aria-hidden />中身
      </button>
    </div>
  )
}

/** 中身 of an .html tab: the band with the toggle above the code editor, where the document's toolbar was. */
export function HtmlSourceBar({ onShowDocument }: { onShowDocument: () => void }) {
  return (
    <div role="toolbar" aria-label="資料の中身" className={HTML_TAB_BAR}>
      <HtmlViewToggle showing="source" onShowDocument={onShowDocument} />
    </div>
  )
}
