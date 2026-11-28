import { useState } from 'react'
import { CaretDown, ChatCircleText, Code, LinkBreak, LinkSimple, TextB, TextItalic, TextStrikethrough } from '@phosphor-icons/react'
import { Button } from '../../../shared/ui/primitives'
import type { InPlaceMark, InPlaceSelection, TextSize } from '../inPlaceEditing'

/** The bubble's decorations with their keys (the command catalog's: editor.toggleBold …). */
const MARKS: Array<{ mark: InPlaceMark; label: string; keys: string; Icon: typeof TextB }> = [
  { mark: 'strong', label: '太字', keys: '⌘B', Icon: TextB },
  { mark: 'emphasis', label: '斜体', keys: '⌘I', Icon: TextItalic },
  { mark: 'strike', label: '取り消し線', keys: '⌘⇧S', Icon: TextStrikethrough },
  { mark: 'code', label: 'コード', keys: '⌘E', Icon: Code },
]

const TEXT_SIZES: Array<{ size: TextSize; label: string; keys: string }> = [
  { size: 0, label: '本文', keys: '⌘⌥0' },
  { size: 1, label: '見出し1', keys: '⌘⌥1' },
  { size: 2, label: '見出し2', keys: '⌘⌥2' },
  { size: 3, label: '見出し3', keys: '⌘⌥3' },
]

export type BubbleMode = 'tools' | 'size' | 'link' | 'comment'

const TOOL = 'inline-flex h-control-sm min-w-[var(--size-control-sm)] items-center justify-center gap-1 rounded-small px-1.5 text-small text-text hover:bg-surface-sunken aria-pressed:bg-selected-bg aria-pressed:text-selected-text'

interface Props {
  selection: InPlaceSelection
  mode: BubbleMode
  onMode: (mode: BubbleMode) => void
  onMark: (mark: InPlaceMark) => void
  onSize: (size: TextSize) => void
  onLink: (href: string | null) => void
  /** ［コメント］ shown only when the screen hands in the review's comment box. */
  canComment: boolean
}

/**
 * The one bubble over selected words (owner decision 2026-11-28, 案A): decorations, the text size,
 * a link, ［コメント］. A press never takes the focus from the document (mouse down is held), so the
 * selection stays; the link's address box is the one field.
 */
export function SelectionBubble({ selection, mode, onMode, onMark, onSize, onLink, canComment }: Props) {
  const top = selection.box.top - 44 < 8 ? selection.box.bottom + 8 : selection.box.top - 44
  const left = Math.max(8, Math.min(selection.box.left, window.innerWidth - 480))
  return (
    <div
      role="toolbar"
      aria-label="選んだ文字の飾り"
      data-selection-bubble
      className="fixed z-menu flex items-center gap-0.5 rounded-control border border-[color:var(--color-border)] bg-surface-raised p-1 shadow-pop"
      style={{ left, top }}
      onMouseDown={e => { if (!(e.target as HTMLElement).closest('input')) e.preventDefault() }}
    >
      {mode === 'link' ? (
        <LinkField initial={selection.link ?? ''} onDone={href => { onMode('tools'); if (href !== null) onLink(href) }} />
      ) : (
        <>
          {MARKS.map(({ mark, label, keys, Icon }) => (
            <button key={mark} type="button" className={TOOL} aria-pressed={selection.marks[mark]} aria-label={label} title={`${label}（${keys}）`} onClick={() => onMark(mark)}>
              <Icon size={16} weight={selection.marks[mark] ? 'bold' : 'regular'} />
            </button>
          ))}
          <button
            type="button"
            className={TOOL}
            aria-pressed={!!selection.link}
            aria-label={selection.link ? 'リンクを外す' : 'リンク'}
            title={selection.link ? `リンクを外す（${selection.link}）` : 'リンク（⌘K）'}
            onClick={() => (selection.link ? onLink(null) : onMode('link'))}
          >
            {selection.link ? <LinkBreak size={16} /> : <LinkSimple size={16} />}
          </button>
          {selection.size !== null && (
            <div className="relative">
              <button type="button" className={TOOL} aria-haspopup="menu" aria-expanded={mode === 'size'} title="文字の大きさ（⌘⌥0〜3）" onClick={() => onMode(mode === 'size' ? 'tools' : 'size')}>
                {TEXT_SIZES.find(s => s.size === selection.size)?.label}<CaretDown size={12} />
              </button>
              {mode === 'size' && (
                <div role="menu" aria-label="文字の大きさ" className="absolute left-0 top-full mt-1 w-40 rounded-control border border-[color:var(--color-border)] bg-surface-raised py-1 shadow-pop">
                  {TEXT_SIZES.map(s => (
                    <button
                      key={s.size}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selection.size === s.size}
                      className="flex w-full items-center justify-between px-3 py-1 text-small text-text hover:bg-surface-sunken aria-checked:text-selected-text"
                      onClick={() => { onMode('tools'); onSize(s.size) }}
                    >
                      <span>{s.label}</span><span className="text-caption text-text-subtle">{s.keys}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {canComment && (
            <>
              <span className="mx-0.5 h-4 w-px bg-[color:var(--color-border)]" aria-hidden />
              <button type="button" className={TOOL} onClick={() => onMode('comment')}>
                <ChatCircleText size={15} />コメント
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}

function LinkField({ initial, onDone }: { initial: string; onDone: (href: string | null) => void }) {
  const [href, setHref] = useState(initial)
  const ok = /^(https?:\/\/|mailto:|\.{0,2}\/|[^\s:]+\.(md|html?|pdf)$)/i.test(href.trim())
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={e => { e.preventDefault(); if (ok) onDone(href.trim()) }}
    >
      <input
        autoFocus
        aria-label="リンク先"
        placeholder="https://… や ./資料.md"
        className="h-control-sm w-64 rounded-small border border-border-control bg-bg px-2 text-small text-text outline-none focus:border-focus-border"
        value={href}
        onChange={e => setHref(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onDone(null) } }}
      />
      <Button type="submit" size="sm" variant="primary" disabled={!ok}>付ける</Button>
    </form>
  )
}
