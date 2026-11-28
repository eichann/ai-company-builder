import type { ReactNode } from 'react'
import { Browser, Eye } from '@phosphor-icons/react'
import { runCommand, useCommandAvailable } from '../../../shared/commands/commands'
import type { PageCard } from '../pageCards'

/**
 * A page the AI made, as a card in its reply (chat-ui-and-history.md "Page cards in a reply"). Pressing it shows
 * the page in the HTML viewer (doc-frame.md: its own isolated view, no network, nothing of the app); nothing of
 * the page is read or drawn here. In a consultation's own window (no editor) `file.open` asks the main window.
 * A button inside the paragraph (phrasing content), so a card in the middle of a sentence stays valid HTML.
 */
export function ChatPageCard({ card, children }: { card: PageCard; children: ReactNode }) {
  const inEditor = useCommandAvailable('editor.viewDocument')
  const open = () => void (inEditor
    ? runCommand('editor.viewDocument', { path: card.path })
    : runCommand('file.open', { path: card.path }))
  return (
    <button
      type="button"
      data-chat-page-card
      onClick={open}
      title="このページを真ん中のタブで見ます"
      className="not-prose my-1 inline-flex max-w-full items-center gap-3 rounded-card border border-[color:var(--color-border)] bg-surface-raised px-3 py-2 text-left align-middle no-underline hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring"
    >
      <Browser size={22} className="flex-shrink-0 text-text-muted" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body font-medium text-text">{children}</span>
        <span className="truncate text-small text-text-muted">
          {card.personal ? 'ページ・あなただけに見えます' : 'ページ'}・{card.name}
        </span>
      </span>
      <span className="ml-2 inline-flex flex-shrink-0 items-center gap-1 text-small text-link">
        <Eye size={13} aria-hidden />見る
      </span>
    </button>
  )
}
