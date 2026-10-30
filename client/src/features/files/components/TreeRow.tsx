import { memo } from 'react'
import { CaretRight, SpinnerGap, CloudArrowDown, FolderSimpleDashed, LockSimple } from '@phosphor-icons/react'
import { FolderIcon } from '../../../shared/ui/FileIcons'
import { getFileIcon } from '../../../shared/ui/fileIcon'
import { ReadOnlyBadge } from '../../../shared/ui/ReadOnlyBadge'
import { viewersLabel, type MyPrivateFolder } from '../../../../shared/private-folder-ui'
import type { FileEntry } from '../fileTreeModel'

export type ReviewBadge = 'request' | 'unseen' | 'seen' | null

/** Everything a row does, behind one stable ref so memoised rows never re-render for new callbacks. */
export interface RowActions {
  click: (entry: FileEntry, e: React.MouseEvent) => void
  doubleClick: (entry: FileEntry) => void
  contextMenu: (entry: FileEntry, e: React.MouseEvent) => void
  keyDown: (entry: FileEntry, e: React.KeyboardEvent) => void
  dragStart: (entry: FileEntry, e: React.DragEvent) => void
  dragEnd: () => void
  dragOver: (entry: FileEntry, e: React.DragEvent) => void
  dragLeave: (entry: FileEntry, e: React.DragEvent) => void
  drop: (entry: FileEntry, e: React.DragEvent) => void
  download: (entry: FileEntry) => void
  clearSelection: () => void
}

interface TreeRowProps {
  entry: FileEntry
  depth: number
  isExpanded: boolean
  isHighlighted: boolean
  isLoading: boolean
  isDragOver: boolean
  isDragSource: boolean
  showReadOnly: boolean
  privateRoot: MyPrivateFolder | null
  review: ReviewBadge
  downloading: boolean
  actions: React.MutableRefObject<RowActions>
}

export const TreeRow = memo(function TreeRow({
  entry, depth, isExpanded, isHighlighted, isLoading, isDragOver, isDragSource,
  showReadOnly, privateRoot, review, downloading, actions,
}: TreeRowProps) {
  // A folder this computer does not download: muted, not expandable, not a
  // drop target; one click downloads it.
  if (entry.notDownloaded) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`${entry.name}（未ダウンロード）`}
        title="このフォルダはこのPCにダウンロードしていません。サーバーにはあります。"
        onClick={() => actions.current.clearSelection()}
        onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !downloading) { e.preventDefault(); actions.current.download(entry) } }}
        onContextMenu={e => actions.current.contextMenu(entry, e)}
        className="group w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm rounded-md outline-none transition-colors focus:ring-1 focus:ring-accent/50 text-gray-400 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-white/[0.04]"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        <span className="flex-shrink-0 w-3 h-4" />
        <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
          <FolderSimpleDashed size={14} className="text-gray-400 dark:text-zinc-500" />
        </span>
        <span className="truncate" title={entry.name}>{entry.name}</span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-1 pl-2">
          {downloading ? (
            <span className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-zinc-400">
              <SpinnerGap size={11} className="animate-spin" />ダウンロード中…
            </span>
          ) : (
            <>
              <span className="text-[11px] text-gray-400 dark:text-zinc-500 group-hover:hidden group-focus-within:hidden">未ダウンロード</span>
              <button
                type="button"
                tabIndex={-1}
                onClick={e => { e.stopPropagation(); actions.current.download(entry) }}
                className="hidden items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10 group-hover:flex group-focus-within:flex"
              >
                <CloudArrowDown size={12} />ダウンロード
              </button>
            </>
          )}
        </span>
      </div>
    )
  }

  const FileIc = entry.isDirectory ? null : getFileIcon(entry.name, false)
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={e => actions.current.dragStart(entry, e)}
      onDragEnd={() => actions.current.dragEnd()}
      onDragOver={e => actions.current.dragOver(entry, e)}
      onDragLeave={e => { if (isDragOver) actions.current.dragLeave(entry, e) }}
      onDrop={e => actions.current.drop(entry, e)}
      onClick={e => actions.current.click(entry, e)}
      onDoubleClick={() => actions.current.doubleClick(entry)}
      onContextMenu={e => actions.current.contextMenu(entry, e)}
      onKeyDown={e => actions.current.keyDown(entry, e)}
      className={`
        w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm cursor-pointer
        rounded-md transition-colors outline-none focus:ring-1 focus:ring-accent/50
        ${isHighlighted
          ? 'bg-accent/20 text-gray-900 dark:text-zinc-100'
          : 'text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-white/[0.04] hover:text-gray-900 dark:hover:text-zinc-200'
        }
        ${isDragOver && entry.isDirectory ? 'ring-2 ring-accent bg-accent/10' : ''}
        ${isDragSource ? 'opacity-50' : ''}
      `}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <span className="flex-shrink-0 w-3 h-4 flex items-center justify-center">
        {entry.isDirectory && (
          isLoading ? (
            <SpinnerGap size={10} className="text-gray-400 dark:text-zinc-500 animate-spin" />
          ) : (
            <CaretRight
              size={10}
              className={`text-gray-400 dark:text-zinc-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
          )
        )}
      </span>
      <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
        {FileIc ? <FileIc size={14} /> : <FolderIcon size={14} isOpen={isExpanded} />}
      </span>
      <span className="truncate" title={entry.name}>{entry.name}</span>
      {privateRoot && (
        <span
          className="flex-shrink-0 text-indigo-500 dark:text-indigo-400"
          title={viewersLabel(privateRoot)}
          aria-label={`非公開（${privateRoot.viewerCount}人だけが見られます）`}
          data-private-folder
        >
          <LockSimple size={12} weight="fill" />
        </span>
      )}
      {showReadOnly && <ReadOnlyBadge compact />}
      {/* 依頼バッジ: UIからの依頼ボタンは非表示にしたが、
          Slack通知連携で review-request を再利用予定のため残してある */}
      {review === 'request' && (
        <span className="flex-shrink-0 ml-auto text-[9px] px-1 rounded bg-amber-500/20 text-amber-400" title="レビュー依頼あり">依頼</span>
      )}
      {review === 'unseen' && (
        <span className="flex-shrink-0 ml-auto w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="新しいレビューあり" />
      )}
      {review === 'seen' && (
        <span className="flex-shrink-0 ml-auto w-1.5 h-1.5 rounded-full bg-blue-400" title="レビューあり" />
      )}
    </div>
  )
})

export type TreeRowItem =
  | { kind: 'entry'; entry: FileEntry; depth: number }
  | { kind: 'empty'; key: string; depth: number }
