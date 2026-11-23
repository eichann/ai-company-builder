// 「使い方」 (the user manual) in the middle panel (files-and-editor.md "The user manual"): the server's
// manual shown in a document view of its own, like an HTML file's 見る (doc-frame.md), with
// ［書き出す］ that writes it to a folder the member picks. The page is never drawn by this page.
import { useState, useSyncExternalStore } from 'react'
import { ArrowClockwise, DownloadSimple, Minus, Plus } from '@phosphor-icons/react'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { docViewPorts, manualPorts } from '../api'
import { DocViewSession } from '../docViewSession'

const TOOL = 'inline-flex items-center gap-1 h-control-sm px-control-sm-x rounded-control text-small text-text-muted hover:text-text hover:bg-surface-sunken disabled:opacity-disabled disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

interface ManualPaneProps {
  /** The page id (`manual/pages/<id>.md`). */
  page: string
  /** A heading's id on it, or null for the top. */
  anchor: string | null
}

export function ManualPane({ page, anchor }: ManualPaneProps) {
  const [manual] = useState(() => manualPorts())
  // One session per pane (keyed by the request): it owns the page's view.
  const [session] = useState(() => {
    const ports = docViewPorts()
    return new DocViewSession({ open: () => manual.openManual(page, anchor) }, ports.views, ports.links)
  })
  const { status, zoom, link } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null)
  const running = status.kind === 'shown' || status.kind === 'opening'

  const exportManual = async () => {
    setExporting(true)
    setExported(null)
    const result = await manual.exportManual().catch(() => null)
    setExporting(false)
    if (!result) setExported({ ok: false, text: 'いまは書き出せません。もう一度お試しください。' })
    else if (result.ok) setExported({ ok: true, text: `「${result.folder}」に書き出しました。中の index.html をブラウザで開くと、インターネットなしでも読めます。` })
    else if (!result.cancelled) setExported({ ok: false, text: result.message })
  }

  return (
    <div data-testid="manual-viewer" className="h-full flex flex-col min-w-0">
      <div role="toolbar" aria-label="使い方の表示" className="flex-shrink-0 flex flex-wrap items-center gap-1 px-2 py-1 border-b border-[color:var(--color-border)] bg-surface-raised">
        <span className="px-1 text-small text-text">使い方</span>
        <span aria-hidden className="mx-1 h-4 border-l border-[color:var(--color-border)]" />
        <button type="button" className={TOOL} title="縮小" aria-label="縮小" disabled={!running} onClick={() => session.zoomBy(-1)}><Minus size={14} aria-hidden /></button>
        <span aria-live="polite" className="text-small text-text-muted tabular-nums">{Math.round(zoom * 100)}%</span>
        <button type="button" className={TOOL} title="拡大" aria-label="拡大" disabled={!running} onClick={() => session.zoomBy(1)}><Plus size={14} aria-hidden /></button>
        <span className="flex-1" />
        <button type="button" className={TOOL} disabled={exporting} onClick={() => { void exportManual() }}
          title="使い方（ページと画像）を、選んだフォルダに書き出します。会社のフォルダには書き出せません。">
          <DownloadSimple size={14} aria-hidden />{exporting ? '書き出しています…' : '書き出す'}
        </button>
        {!running && <button type="button" className={TOOL} onClick={() => session.restart()}><ArrowClockwise size={14} aria-hidden />もう一度表示する</button>}
      </div>
      {exported && (
        // Not role="status": the viewer treats a status region as an overlay and would hide the page.
        <p aria-live="polite" data-testid="manual-export-result" className={`flex-shrink-0 px-3 py-1.5 text-small border-b border-[color:var(--color-border)] ${exported.ok ? 'text-success-text' : 'text-danger-text'}`}>
          {exported.text}
        </p>
      )}
      <div ref={session.attachArea} data-testid="manual-area" className="flex-1 min-h-0 min-w-0 flex items-center justify-center p-card bg-surface-sunken text-small text-text-muted">
        {status.kind === 'opening' && <p>使い方を読み込んでいます…</p>}
        {status.kind === 'shown' && status.covered && <p>メニューやダイアログを閉じると、使い方に戻ります。</p>}
        {status.kind === 'refused' && <p role="alert" className="max-w-md text-center text-body text-text">{status.message}</p>}
        {status.kind === 'gone' && <p role="alert" className="max-w-md text-center text-body text-text">表示が止まりました。［もう一度表示する］で最初から表示します。</p>}
      </div>
      <ConfirmDialog
        isOpen={link !== null}
        title="外のサイトを開きますか？"
        message="使い方の中のリンクです。ブラウザで開きます。"
        detail={link && (
          <div className="mt-3">
            <p className="text-heading text-text break-all">{hostOf(link)}</p>
            <p className="mt-1 text-caption text-text-subtle break-all">{link}</p>
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
