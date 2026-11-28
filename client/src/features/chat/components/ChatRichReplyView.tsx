// A rich reply with its three buttons (chat-ui-and-history.md "Rich replies: ［大きく見る］［ページとして残す］
// ［コードとして見る］"), small icons at its top right shown only while the pointer is over the reply or a button has the
// keyboard's focus (always in the tab order). ［大きく見る］ and ［ページとして残す］ keep the reply as a page in the
// member's 今日のフォルダ (main decides where, ReplyPagesContext); the first then opens it in the HTML viewer
// (`editor.viewDocument`, the command: the editor is not imported), the second shows it as a page card.
// ［コードとして見る］ shows the reply as the chat's ordinary Markdown, its blocks as code.
import { useContext, useRef, useState } from 'react'
import { ArrowsOut, BookmarkSimple, Code, TextAa } from '@phosphor-icons/react'
import { runCommand, useCommandAvailable } from '../../../shared/commands/commands'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { useAppStore } from '../../../stores/appStore'
import { ReplyPagesContext, keepReplyPage, type KeptPage } from '../replyPages'
import { replyPageDocument } from '../richReplyPage'
import { ChatRichReply } from './ChatRichReply'
import { ChatPageCard } from './ChatPageCard'
import { MarkdownMessage } from './MarkdownMessage'

const BUTTON = 'inline-flex h-7 w-7 items-center justify-center rounded-control text-text-muted hover:bg-surface-sunken hover:text-text focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring'

export function ChatRichReplyView({ text, writing = false }: { text: string; /** Still being written: nothing to keep yet. */ writing?: boolean }) {
  const pages = useContext(ReplyPagesContext)
  const isDark = useAppStore(s => s.theme) === 'dark'
  const inEditor = useCommandAvailable('editor.viewDocument')
  const [asCode, setAsCode] = useState(false)
  const [card, setCard] = useState<KeptPage | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const writingNow = useLatestRef(writing)
  // What the buttons show; `keepReplyPage` decides again for every press (it is the one way in).
  const blocked = busy || writing
  const running = useRef(0)

  const keep = async (): Promise<KeptPage | null> => {
    if (!pages) return null
    running.current++
    setBusy(true)
    try {
      const outcome = await keepReplyPage(pages, text, writingNow.current, () => replyPageDocument(text, 'AI の返事', isDark))
      if (outcome.kind === 'failed') setProblem(outcome.error)
      if (outcome.kind !== 'kept') return null
      setProblem(null)
      return outcome.page
    } finally {
      if (--running.current === 0) setBusy(false)
    }
  }
  const openLarge = async () => {
    const page = await keep()
    if (page) void runCommand(inEditor ? 'editor.viewDocument' : 'file.open', { path: page.path })
  }
  const keepAsPage = async () => {
    const page = await keep()
    if (page) setCard(page)
  }

  return (
    <div className="group/rich relative" data-rich-reply-view>
      {asCode
        ? <MarkdownMessage content={text} />
        : <ChatRichReply content={text} fallback={<MarkdownMessage content={text} />} onOpenLarge={pages ? () => void openLarge() : undefined} openLargeDisabled={blocked} />}
      {/* After the reply in the page's order: drawn over its frame without a z-index of its own. Tab reaches it after the reply. */}
      <div
        role="toolbar"
        aria-label="この返事の表示"
        className="absolute -top-1 right-0 flex gap-0.5 rounded-control border border-[color:var(--color-border)] bg-surface-raised p-0.5 opacity-0 shadow-pop transition-opacity focus-within:opacity-100 group-hover/rich:opacity-100"
      >
        {pages && (
          <>
            <button type="button" className={BUTTON} disabled={blocked} onClick={() => void openLarge()} aria-label="大きく見る" title="大きく見る（真ん中のタブで開きます）">
              <ArrowsOut size={15} aria-hidden />
            </button>
            <button type="button" className={BUTTON} disabled={blocked} onClick={() => void keepAsPage()} aria-label="ページとして残す" title="ページとして残す（今日のフォルダに置きます。あなただけに見えます）">
              <BookmarkSimple size={15} aria-hidden />
            </button>
          </>
        )}
        <button type="button" className={BUTTON} aria-pressed={asCode} onClick={() => setAsCode(on => !on)}
          aria-label={asCode ? '整えた表示に戻す' : 'コードとして見る'} title={asCode ? '整えた表示に戻す' : 'コードとして見る'}>
          {asCode ? <TextAa size={15} aria-hidden /> : <Code size={15} aria-hidden />}
        </button>
      </div>
      {card && (
        <p className="mt-2">
          <ChatPageCard card={{ path: card.path, name: card.name, personal: true }}>ページとして残しました</ChatPageCard>
        </p>
      )}
      {problem && <p role="alert" className="mt-2 text-small text-danger-text">{problem}</p>}
    </div>
  )
}
