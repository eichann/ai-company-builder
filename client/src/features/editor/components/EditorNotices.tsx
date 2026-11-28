import { X, Warning } from '@phosphor-icons/react'
import { ReadOnlyBadge } from '../../../shared/ui/ReadOnlyBadge'
import type { OpenFile } from '../hooks/useOpenFiles'

/** 閲覧のみ: the member may not write this file's folder (per-folder write rules). */
export function ReadOnlyNotice() {
  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-readonly-border bg-readonly-bg text-caption font-normal text-readonly-text">
      <ReadOnlyBadge />
      <span className="truncate">このフォルダは閲覧のみです。変更しても共有されず、同期すると元に戻ります（変更は［バックアップ履歴］に保存されます）。</span>
    </div>
  )
}

/** The open file (no edits) was deleted or moved on disk. */
export function MissingFileNotice() {
  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-warning-border bg-warning-bg text-caption font-normal text-warning-text">
      <Warning size={12} className="flex-shrink-0 text-warning-icon" />
      <span className="truncate">このファイルは削除されたか、移動されました。表示しているのは開いていたときの内容です。</span>
    </div>
  )
}

interface ExternalChangeBannerProps {
  file: OpenFile & { external: NonNullable<OpenFile['external']> }
  onSave: () => void
  onToggleCompare: () => void
}

/**
 * The file changed (or was deleted) on disk while this tab has edits: nothing is
 * overwritten until the member decides. A change offers one thing, ［比べて選ぶ］:
 * the compare view holds both choices (owner decision 2026-11-28, UX 点検 10).
 */
export function ExternalChangeBanner({ file, onSave, onToggleCompare }: ExternalChangeBannerProps) {
  return (
    <div role="alert" data-external-change={file.external.kind} className="flex-shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-warning-border bg-warning-bg text-xs text-warning-text">
      <Warning size={14} className="flex-shrink-0 text-warning-icon" />
      <span className="min-w-0 flex-1">
        {file.external.kind === 'deleted'
          ? 'ファイルは削除されました。保存すると作り直します'
          : 'このファイルは外部で変更されました。あなたの編集はまだ保存していません（自動保存は止めています）'}
      </span>
      <div className="flex items-center gap-1.5">
        {file.external.kind === 'deleted' ? (
          <button
            onClick={onSave}
            className="px-2 py-1 rounded-md bg-amber-500/90 text-white hover:bg-amber-500 transition-colors"
          >
            保存して作り直す
          </button>
        ) : (
          <button
            onClick={onToggleCompare}
            aria-pressed={!!file.comparing}
            className={`px-2 py-1 rounded-md border border-amber-500/40 transition-colors ${file.comparing ? 'bg-amber-500/20' : 'hover:bg-amber-500/15'}`}
          >
            {file.comparing ? '比べるのをやめる' : '比べて選ぶ'}
          </button>
        )}
      </div>
    </div>
  )
}

/** A note that can be dismissed (e.g. where the overwritten version was backed up). */
export function EditorNotice({ notice, onDismiss }: { notice: string; onDismiss: () => void }) {
  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-info-border bg-info-bg text-caption font-normal text-info-text">
      <span className="min-w-0 flex-1 truncate" title={notice}>{notice}</span>
      <button onClick={onDismiss} className="hover:text-gray-900 dark:hover:text-zinc-100" aria-label="閉じる">
        <X size={12} />
      </button>
    </div>
  )
}

export function EditorError({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-danger-bg border-b border-danger-border text-danger-text text-xs">
      <Warning size={14} className="text-danger-icon" />
      {error}
      <button
        onClick={onDismiss}
        className="ml-auto hover:text-text"
      >
        <X size={12} />
      </button>
    </div>
  )
}
