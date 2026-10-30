import { X, Warning } from '@phosphor-icons/react'
import { ReadOnlyBadge } from '../../../shared/ui/ReadOnlyBadge'
import type { OpenFile } from '../hooks/useOpenFiles'

/** 閲覧のみ: the member may not write this file's folder (per-folder write rules). */
export function ReadOnlyNotice() {
  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-gray-200 dark:border-zinc-800/50 bg-gray-50 dark:bg-zinc-900/40 text-[11px] text-gray-500 dark:text-zinc-400">
      <ReadOnlyBadge />
      <span className="truncate">このフォルダは閲覧のみです。変更しても共有されず、同期すると元に戻ります（変更は .backups/ に保存されます）。</span>
    </div>
  )
}

/** The open file (no edits) was deleted or moved on disk. */
export function MissingFileNotice() {
  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-amber-500/20 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300">
      <Warning size={12} className="flex-shrink-0" />
      <span className="truncate">このファイルは削除されたか、移動されました。表示しているのは開いていたときの内容です。</span>
    </div>
  )
}

interface ExternalChangeBannerProps {
  file: OpenFile & { external: NonNullable<OpenFile['external']> }
  diffOpen: boolean
  onSave: () => void
  onLoadDisk: () => void
  onToggleDiff: () => void
  onKeepMine: () => void
}

/** The file changed (or was deleted) on disk while this tab has edits: nothing is overwritten until the member decides. */
export function ExternalChangeBanner({ file, diffOpen, onSave, onLoadDisk, onToggleDiff, onKeepMine }: ExternalChangeBannerProps) {
  return (
    <div role="alert" data-external-change={file.external.kind} className="flex-shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-amber-500/30 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-200">
      <Warning size={14} className="flex-shrink-0" />
      <span className="min-w-0 flex-1">
        {file.external.kind === 'deleted'
          ? 'ファイルは削除されました。保存すると作り直します'
          : file.keepMine
            ? 'このファイルは外部で変更されました。編集を続けられます（自動保存は止めています）。保存（⌘S）するときに上書きしてよいか確認します'
            : 'このファイルは外部で変更されました。あなたの編集はまだ保存していません'}
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
          <>
            <button
              onClick={onLoadDisk}
              className="px-2 py-1 rounded-md border border-amber-500/40 hover:bg-amber-500/15 transition-colors"
            >
              ディスクの内容を読み込む
            </button>
            <button
              onClick={onToggleDiff}
              aria-pressed={diffOpen}
              className={`px-2 py-1 rounded-md border border-amber-500/40 transition-colors ${diffOpen ? 'bg-amber-500/20' : 'hover:bg-amber-500/15'}`}
            >
              {diffOpen ? '差分を閉じる' : '差分を見る'}
            </button>
            {file.keepMine ? (
              <button
                onClick={onSave}
                className="px-2 py-1 rounded-md bg-amber-500/90 text-white hover:bg-amber-500 transition-colors"
              >
                保存…
              </button>
            ) : (
              <button
                onClick={onKeepMine}
                className="px-2 py-1 rounded-md bg-amber-500/90 text-white hover:bg-amber-500 transition-colors"
              >
                自分の編集を残す
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** A note that can be dismissed (e.g. where the overwritten version was backed up). */
export function EditorNotice({ notice, onDismiss }: { notice: string; onDismiss: () => void }) {
  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-gray-200 dark:border-zinc-800/50 bg-gray-50 dark:bg-zinc-900/40 text-[11px] text-gray-600 dark:text-zinc-300">
      <span className="min-w-0 flex-1 truncate" title={notice}>{notice}</span>
      <button onClick={onDismiss} className="hover:text-gray-900 dark:hover:text-zinc-100" aria-label="閉じる">
        <X size={12} />
      </button>
    </div>
  )
}

export function EditorError({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs">
      <Warning size={14} />
      {error}
      <button
        onClick={onDismiss}
        className="ml-auto hover:text-red-300"
      >
        <X size={12} />
      </button>
    </div>
  )
}
