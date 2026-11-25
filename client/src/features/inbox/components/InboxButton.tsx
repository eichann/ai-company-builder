import { Tray } from '@phosphor-icons/react'
import { countText, inboxButtonName } from '../model'

interface Props {
  /** 新着: notices not looked at yet (`InboxView.counts.news`). */
  news: number
  /** あなた待ち, counted as the list counts it (`InboxView.counts.waiting`). */
  waiting: number
  open: boolean
  onToggle: () => void
}

/**
 * The title bar's ［受け箱］ (owner decision 2026-11-26, look 「2」): the tray icon, a soft blue count of 新着 and a soft red
 * count of あなた待ち — no word, no solid pill; a count of 0 is not shown. Pressing it opens or closes the bottom panel (⌘J).
 */
export function InboxButton({ news, waiting, open, onToggle }: Props) {
  const name = inboxButtonName(news, waiting)
  return (
    <button type="button" onClick={onToggle} aria-pressed={open} aria-label={name} title={name} data-inbox-button
      className="relative flex h-8 items-center gap-1 rounded-control px-1.5 text-text-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-text aria-pressed:text-selected-text">
      <Tray size={18} weight={open ? 'fill' : 'regular'} aria-hidden />
      {news > 0 && <span data-inbox-news className="rounded-full bg-selected-bg px-1.5 text-caption font-strong tabular-nums text-selected-text">{countText(news)}</span>}
      {waiting > 0 && <span data-inbox-waiting className="rounded-full bg-danger-bg px-1.5 text-caption font-strong tabular-nums text-danger-text">{countText(waiting)}</span>}
    </button>
  )
}
