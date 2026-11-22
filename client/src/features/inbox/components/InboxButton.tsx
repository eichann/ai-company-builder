import { Tray } from '@phosphor-icons/react'
import { NewDot } from '../../../shared/ui/primitives'
import { countText } from '../model'

interface Props {
  /** あなた待ち, counted as the list counts it (`InboxView.counts.waiting`). */
  waiting: number
  /** Something new since the inbox was last on screen (`hasInboxNews`). */
  news: boolean
  open: boolean
  onToggle: () => void
}

/**
 * The title bar's one ［受け箱］ (I2, owner decision ①): where 「あなたの番 N」 and the bell were. The number
 * is あなた待ち, the dot says something new came; pressing it opens or closes the bottom panel (⌘J).
 */
export function InboxButton({ waiting, news, open, onToggle }: Props) {
  const label = `受け箱（あなた待ち ${waiting} 件${news ? '・新着あり' : ''}）`
  return (
    <button type="button" onClick={onToggle} aria-pressed={open} aria-label={label} title={open ? '受け箱を閉じる (⌘J)' : '受け箱を開く (⌘J)'}
      data-inbox-button
      className="relative flex items-center gap-1.5 rounded-control px-control-sm-x py-1.5 text-small text-text-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-text aria-pressed:text-selected-text">
      <Tray size={18} weight={open ? 'fill' : 'regular'} aria-hidden />
      <span>受け箱</span>
      {waiting > 0 && <b data-inbox-count className="min-w-5 rounded-full bg-primary px-1.5 text-center text-caption font-strong tabular-nums text-on-primary">{countText(waiting)}</b>}
      {news && <NewDot testId="inbox-news-dot" label="新着があります" className="absolute left-5 top-1" />}
    </button>
  )
}
