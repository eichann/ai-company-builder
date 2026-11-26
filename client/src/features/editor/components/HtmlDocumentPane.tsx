// The 見る side of an .html tab (doc-frame.md "The viewer (A2)"): the toolbar and the area the
// document's own view covers, and its review ("Review in the document view"). The document is never
// drawn by this page; `DocViewSession` owns it.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowsIn, ArrowsOut, ChatCircleDots, Eye, LockSimple, Minus, Plus, Stop, ArrowClockwise, X } from '@phosphor-icons/react'
import { ReviewBanner } from '../../doc-review/components/ReviewBanner'
import { ReviewSaveError } from '../../doc-review/components/ReviewSaveError'
import { CompletedReviewBanner } from '../../doc-review/components/CompletedReviewBanner'
import { ReviewHistoryDropdown } from '../../doc-review/components/ReviewHistoryDropdown'
import { ReviewSidePanel } from '../../doc-review/components/ReviewSidePanel'
import { CommentPopover } from '../../doc-review/components/CommentPopover'
import { MarkdownDiffView, type MarkdownDiffViewHandle } from '../../doc-review/components/MarkdownDiffView'
import type { EditorReview } from '../hooks/useEditorReview'
import { anchorHtmlQuote, htmlReadableText, htmlReviewMarks } from '../htmlReview'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { docViewPorts } from '../api'
import { DocViewSession, fileDocument } from '../docViewSession'
import { rebuildRequestOf } from '../htmlViewer'
import { runCommand, useCommandAvailable } from '../../../shared/commands/commands'
import { useAppStore } from '../../../stores/appStore'
import { BlockedPartsBand } from './BlockedPartsBand'
import { HTML_TAB_BAR, HtmlViewToggle } from './HtmlViewToggle'

const TOOL = 'inline-flex items-center gap-1 h-control-sm px-control-sm-x rounded-control text-small text-text-muted hover:text-text hover:bg-surface-sunken disabled:opacity-disabled disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring'

/** The web address's host as the member should read it (punycode for a look-alike name). */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

interface HtmlDocumentPaneProps {
  filePath: string
  /** ［中身］: the file's source in the code editor. */
  onShowSource: () => void
  /**
   * Whether the view, as it closes, is being left for 中身 (asked then): main keeps where the document
   * was scrolled and its next open starts there. Another tab, the tab closed, ［止める］: from the top.
   */
  leavingForSource?: () => boolean
  /** The tab's zoom, kept by the panel while this pane comes and goes. */
  zoom?: number
  onZoom?: (zoom: number) => void
  /** The document's review (as a Markdown preview's) and the file's text its quotes are found in. */
  review?: EditorReview['review']
  content?: string
}

/** What the member is told when a comment's place cannot be shown in the document right now. */
const NOT_SHOWN: Readonly<Record<'hidden' | 'missing', string>> = {
  hidden: 'この部分はいま隠れています（資料の中のタブや折りたたみの中かもしれません）。表示を切り替えてから、もう一度押してください。',
  missing: 'この部分はいまの表示では見つかりません。資料の中のタブなどを切り替えてから、もう一度押してください。',
}

export function HtmlDocumentPane({ filePath, onShowSource, leavingForSource, zoom: tabZoom, onZoom, review, content = '' }: HtmlDocumentPaneProps) {
  // One session per file (the pane is keyed by file): it owns the document's view.
  const [session] = useState(() => {
    const ports = docViewPorts()
    return new DocViewSession(fileDocument(filePath, ports.views, leavingForSource), ports.views, ports.links, tabZoom, onZoom)
  })
  const { status, zoom, fullScreen, refreshed, link, blocked, driveVideos, bandShown, selection, elsewhere } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const canAskAi = useCommandAvailable('chat.insertText')
  const rootPath = useAppStore(s => s.currentCompany?.rootPath ?? null)
  const running = status.kind === 'shown' || status.kind === 'opening'
  const [showDiff, setShowDiff] = useState(false)
  const [notShown, setNotShown] = useState<string | null>(null)
  const sideRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<MarkdownDiffViewHandle | null>(null)
  const reviewing = !!review?.isReviewing
  const viewingCompleted = !!review?.isViewingCompleted
  const activeReview = review?.activeReview ?? null
  // The marks the view draws: the shown review's comments, quoted text only.
  const marks = useMemo(() => htmlReviewMarks(content, (reviewing || viewingCompleted) ? activeReview?.comments ?? [] : []), [content, reviewing, viewingCompleted, activeReview])
  // Writes to the document's view (an external store): selections reported only while reviewing.
  useEffect(() => {
    session.setReview(reviewing || viewingCompleted ? { selecting: reviewing, quotes: marks.quotes } : null)
  }, [session, reviewing, viewingCompleted, marks])
  const showComment = (commentId: string, quote: string) => {
    if (showDiff) { diffRef.current?.scrollToText(quote); return }
    const index = marks.ids.indexOf(commentId)
    if (index < 0 || elsewhere) return
    void session.findQuote(index).then(found => setNotShown(found === 'shown' ? null : NOT_SHOWN[found]))
  }
  // The comment box sits over the side panel, never over the document (the view is drawn above the page).
  const side = selection && reviewing ? sideRef.current?.getBoundingClientRect() : null

  return (
    <div
      data-testid="html-viewer"
      className={fullScreen ? 'fixed inset-0 z-overlay flex flex-col bg-bg' : 'h-full flex flex-col min-w-0'}
    >
      {review?.saveError && <ReviewSaveError failure={review.saveError} onDismiss={review.dismissSaveError} />}
      {review && reviewing && activeReview && <ReviewBanner activeReview={activeReview} onComplete={review.completeReview} onCancel={review.cancelReview} />}
      {review && viewingCompleted && activeReview && (
        <CompletedReviewBanner
          activeReview={activeReview}
          onClose={() => { review.closeViewingReview(); setShowDiff(false); setNotShown(null) }}
          showDiff={showDiff}
          onToggleDiff={() => setShowDiff(prev => !prev)}
        />
      )}
      <div role="toolbar" aria-label="資料の表示" className={HTML_TAB_BAR}>
        <HtmlViewToggle showing="document" onShowSource={onShowSource} />
        <span aria-hidden className="mx-1 h-4 border-l border-[color:var(--color-border)]" />
        <button type="button" className={TOOL} title="縮小" aria-label="縮小" disabled={!running} onClick={() => session.zoomBy(-1)}><Minus size={14} aria-hidden /></button>
        <span aria-live="polite" className="text-small text-text-muted tabular-nums">{Math.round(zoom * 100)}%</span>
        <button type="button" className={TOOL} title="拡大" aria-label="拡大" disabled={!running} onClick={() => session.zoomBy(1)}><Plus size={14} aria-hidden /></button>
        <button type="button" className={TOOL} disabled={!running || zoom === 1} onClick={() => session.setZoom(1)}>元の大きさ</button>
        <span className="ml-1 inline-flex items-center gap-1 text-small text-text-muted" aria-live="polite">
          {refreshed ? <><ArrowClockwise size={12} aria-hidden className="text-success-icon" />ファイルが変わったので、表示を新しくしました</> : <><span aria-hidden className="size-icon-sm inline-flex items-center justify-center"><span className="block h-1.5 w-1.5 rounded-full bg-success-icon" /></span>変わったら自動で更新</>}
        </span>
        <span className="flex-1" />
        {review && !reviewing && !viewingCompleted && (
          <>
            <ReviewHistoryDropdown reviews={review.completedReviews} onSelectReview={review.viewReview} />
            <button type="button" className={TOOL} onClick={() => void review.startReview()} title="新しいレビューを開始する">
              <ChatCircleDots size={14} aria-hidden />レビューする
            </button>
          </>
        )}
        <span className="inline-flex items-center gap-1 text-caption text-text-subtle" title="この資料はインターネット・アプリ・ほかのファイルに届きません">
          <LockSimple size={12} aria-hidden />資料の中だけで動いています
        </span>
        <button type="button" className={TOOL} disabled={!running} onClick={() => session.setFullScreen(!fullScreen)}>
          {fullScreen ? <><ArrowsIn size={14} aria-hidden />全画面を終える</> : <><ArrowsOut size={14} aria-hidden />全画面</>}
        </button>
        {running
          ? <button type="button" className={TOOL} onClick={() => session.stop()} title="資料の中のプログラムを止めます"><Stop size={14} aria-hidden />止める</button>
          : <button type="button" className={TOOL} onClick={() => session.restart()}><Eye size={14} aria-hidden />もう一度表示する</button>}
      </div>
      {bandShown && (
        <BlockedPartsBand
          parts={blocked}
          driveVideos={driveVideos}
          onOpenDriveVideo={index => session.openDriveVideo(index)}
          onDismiss={() => session.dismissBand()}
          onAskAi={canAskAi ? () => void runCommand('chat.insertText', { text: rebuildRequestOf(filePath, rootPath) }) : undefined}
        />
      )}
      {elsewhere && (reviewing || viewingCompleted) && (
        <p aria-live="polite" className="px-card py-1 border-b border-[color:var(--color-border)] text-small text-text-muted">
          いまは資料の中の別のページを表示しているため、レビューを止めています。元の資料に戻ると再開します。
        </p>
      )}
      {notShown && !elsewhere && (
        <p aria-live="polite" className="flex items-center gap-2 px-card py-1 border-b border-[color:var(--color-border)] text-small text-text-muted">
          <span className="flex-1">{notShown}</span>
          <button type="button" className={TOOL} aria-label="閉じる" onClick={() => setNotShown(null)}><X size={12} aria-hidden /></button>
        </p>
      )}
      <div className="flex-1 min-h-0 min-w-0 flex">
        {showDiff && activeReview?.snapshot ? (
          // 「変更を確認」: the page's words then (the snapshot keeps them, `htmlReading`) and now; the view closes meanwhile.
          <div className="flex-1 min-w-0 overflow-hidden">
            <MarkdownDiffView ref={diffRef} snapshot={activeReview.snapshot} current={htmlReadableText(content)} />
          </div>
        ) : (
          // The document's own view is placed over this area; what is written here shows only when it is not.
          <div ref={session.attachArea} data-testid="html-viewer-area" className="flex-1 min-h-0 min-w-0 flex items-center justify-center p-card bg-surface-sunken text-small text-text-muted">
            {status.kind === 'opening' && <p>表示しています…</p>}
            {status.kind === 'shown' && status.covered && <p>メニューやダイアログを閉じると、資料に戻ります。</p>}
            {status.kind === 'refused' && <p role="alert" className="max-w-md text-center text-body text-text">{status.message}</p>}
            {status.kind === 'stopped' && <p className="max-w-md text-center">資料を止めました。［もう一度表示する］で最初から表示します。</p>}
            {status.kind === 'gone' && <p role="alert" className="max-w-md text-center text-body text-text">資料の表示が止まりました（重すぎたのかもしれません）。［もう一度表示する］で最初から表示します。</p>}
          </div>
        )}
        {review && (reviewing || viewingCompleted) && activeReview && (
          <div ref={sideRef} className="flex min-h-0">
            <ReviewSidePanel
              review={activeReview}
              onDeleteComment={reviewing ? review.deleteComment : undefined}
              onToggleResolved={review.toggleResolved}
              onClickComment={comment => showComment(comment.id, comment.selectedText)}
              onAddReply={review.addReply}
              readOnly={viewingCompleted}
            />
          </div>
        )}
      </div>
      {review && selection && reviewing && (
        <CommentPopover
          key={selection.seq}
          position={{ x: side ? side.left : window.innerWidth - 300, y: side ? side.top + 32 : 80 }}
          selectedText={selection.text}
          onSubmit={async (body, severity) => {
            const at = anchorHtmlQuote(content, selection)
            const saved = await review.addComment(selection.text, at?.start ?? 0, at?.end ?? 0, body, severity)
            if (saved) session.clearSelection()
            return saved
          }}
          onClose={() => session.clearSelection()}
        />
      )}
      <ConfirmDialog
        isOpen={link !== null}
        title="外のサイトを開きますか？"
        message="資料の中のリンクです。ブラウザで開きます。"
        detail={link && (
          <div className="mt-3">
            <p className="text-heading text-text break-all" data-testid="link-host">{hostOf(link)}</p>
            <p className="mt-1 text-caption text-text-subtle break-all">{link}</p>
            <p className="mt-3 text-small text-text-muted">この資料は AI やほかの人が作ったものです。知らないサイトなら開かないでください。</p>
          </div>
        )}
        confirmText="ブラウザで開く"
        cancelText="やめる"
        confirmOnEnter={false}
        onConfirm={() => session.answerLink(true)}
        onCancel={() => session.answerLink(false)}
      />
    </div>
  )
}
