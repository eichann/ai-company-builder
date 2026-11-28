// A rich reply with its three buttons (chat-ui-and-history.md "Rich replies: ［大きく見る］［ページとして残す］
// ［コードとして見る］"), small icons at its top right shown only while the pointer is over the reply or a button has the
// keyboard's focus (always in the tab order). ［大きく見る］ and ［ページとして残す］ keep the reply as a page in the
// member's 今日のフォルダ (main decides where, ReplyPagesContext); the first then opens it in the HTML viewer
// (`editor.viewDocument`, the command: the editor is not imported), the second shows it as a page card.
// ［コードとして見る］ shows the reply as the chat's ordinary Markdown, its blocks as code.
import { useContext, useState } from 'react'
import { ArrowsOut, BookmarkSimple, Code, TextAa } from '@phosphor-icons/react'
import { runCommand, useCommandAvailable } from '../../../shared/commands/commands'
import { useAppStore } from '../../../stores/appStore'
import { ReplyPagesContext } from '../replyPages'
import { replyPageDocument } from '../richReplyPage'
import { ChatRichReply } from './ChatRichReply'
import { ChatPageCard } from './ChatPageCard'
import { MarkdownMessage } from './MarkdownMessage'

interface KeptPage { path: string; name: string }
/** Pages already kept, per conversation and reply text: the same reply opens the same file (≤ 100 kept). */
const keptPages = new Map<string, KeptPage>()
function remember(key: string, page: KeptPage) {
  keptPages.set(key, page)
  if (keptPages.size > 100) keptPages.delete(keptPages.keys().next().value as string)
}

const BUTTON = 'inline-flex h-7 w-7 items-center justify-center rounded-control text-text-muted hover:bg-surface-sunken hover:text-text focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring'

export function ChatRichReplyView({ text, writing = false }: { text: string; /** Still being written: nothing to keep yet. */ writing?: boolean }) {
  const pages = useContext(ReplyPagesContext)
  const isDark = useAppStore(s => s.theme) === 'dark'
  const inEditor = useCommandAvailable('editor.viewDocument')
  const [asCode, setAsCode] = useState(false)
  const [card, setCard] = useState<KeptPage | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const keep = async (): Promise<KeptPage | null> => {
    if (!pages) return null
    const key = `${pages.scope()}|${text}`
    setBusy(true)
    try {
      // Kept before and still there: the same file (moved or deleted by the member: kept again).
      const known = keptPages.get(key)
      if (known && await pages.stillThere(known.path)) return known
      const saved = await pages.save(replyPageDocument(text, 'AI の返事', isDark))
      if (!saved.success) { setProblem(saved.error); return null }
      const page = { path: saved.path, name: saved.name }
      remember(key, page)
      setProblem(null)
      return page
    } catch {
      setProblem('ページを保存できませんでした。もう一度試してください。')
      return null
    } finally {
      setBusy(false)
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
        : <ChatRichReply content={text} fallback={<MarkdownMessage content={text} />} onOpenLarge={pages ? () => void openLarge() : undefined} />}
      {/* After the reply in the page's order: drawn over its frame without a z-index of its own. Tab reaches it after the reply. */}
      <div
        role="toolbar"
        aria-label="この返事の表示"
        className="absolute -top-1 right-0 flex gap-0.5 rounded-control border border-[color:var(--color-border)] bg-surface-raised p-0.5 opacity-0 shadow-pop transition-opacity focus-within:opacity-100 group-hover/rich:opacity-100"
      >
        {pages && (
          <>
            <button type="button" className={BUTTON} disabled={busy || writing} onClick={() => void openLarge()} aria-label="大きく見る" title="大きく見る（真ん中のタブで開きます）">
              <ArrowsOut size={15} aria-hidden />
            </button>
            <button type="button" className={BUTTON} disabled={busy || writing} onClick={() => void keepAsPage()} aria-label="ページとして残す" title="ページとして残す（今日のフォルダに置きます。あなただけに見えます）">
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
