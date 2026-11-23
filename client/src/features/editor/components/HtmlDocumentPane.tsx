// The 見る side of an .html tab (doc-frame.md "The viewer (A2)"): the toolbar and the area the
// document's own view covers. The document is never drawn by this page; `DocViewSession` owns it.
import { useState, useSyncExternalStore } from 'react'
import { ArrowsIn, ArrowsOut, Eye, LockSimple, Minus, Plus, Stop, ArrowClockwise } from '@phosphor-icons/react'
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
}

export function HtmlDocumentPane({ filePath, onShowSource, leavingForSource, zoom: tabZoom, onZoom }: HtmlDocumentPaneProps) {
  // One session per file (the pane is keyed by file): it owns the document's view.
  const [session] = useState(() => {
    const ports = docViewPorts()
    return new DocViewSession(fileDocument(filePath, ports.views, leavingForSource), ports.views, ports.links, tabZoom, onZoom)
  })
  const { status, zoom, fullScreen, refreshed, link, blocked, bandShown } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const canAskAi = useCommandAvailable('chat.insertText')
  const rootPath = useAppStore(s => s.currentCompany?.rootPath ?? null)
  const running = status.kind === 'shown' || status.kind === 'opening'

  return (
    <div
      data-testid="html-viewer"
      className={fullScreen ? 'fixed inset-0 z-overlay flex flex-col bg-bg' : 'h-full flex flex-col min-w-0'}
    >
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
      {bandShown && blocked && (
        <BlockedPartsBand
          parts={blocked}
          onDismiss={() => session.dismissBand()}
          onAskAi={canAskAi ? () => void runCommand('chat.insertText', { text: rebuildRequestOf(filePath, rootPath) }) : undefined}
        />
      )}
      {/* The document's own view is placed over this area; what is written here shows only when it is not. */}
      <div ref={session.attachArea} data-testid="html-viewer-area" className="flex-1 min-h-0 min-w-0 flex items-center justify-center p-card bg-surface-sunken text-small text-text-muted">
        {status.kind === 'opening' && <p>表示しています…</p>}
        {status.kind === 'shown' && status.covered && <p>メニューやダイアログを閉じると、資料に戻ります。</p>}
        {status.kind === 'refused' && <p role="alert" className="max-w-md text-center text-body text-text">{status.message}</p>}
        {status.kind === 'stopped' && <p className="max-w-md text-center">資料を止めました。［もう一度表示する］で最初から表示します。</p>}
        {status.kind === 'gone' && <p role="alert" className="max-w-md text-center text-body text-text">資料の表示が止まりました（重すぎたのかもしれません）。［もう一度表示する］で最初から表示します。</p>}
      </div>
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
