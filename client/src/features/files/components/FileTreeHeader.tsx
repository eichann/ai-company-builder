import { useTranslation } from 'react-i18next'
import { ArrowClockwise, Eye, EyeSlash, FilePlus, FolderPlus, LockSimple } from '@phosphor-icons/react'
import { ReadOnlyBadge } from '../../../shared/ui/ReadOnlyBadge'
import { lastSegment, viewersLabel, type MyPrivateFolder } from '../../../../shared/private-folder-ui'

interface FileTreeHeaderProps {
  readOnly: boolean
  showDotFiles: boolean
  onToggleDotFiles: () => void
  isLoading: boolean
  onRefresh: () => void
  /** New items go into the selection's folder: not into a placeholder. */
  parentNotDownloaded: boolean
  onNewFile: () => void
  onNewFolder: () => void
}

const iconButton = 'p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors'

export function FileTreeHeader({
  readOnly, showDotFiles, onToggleDotFiles, isLoading, onRefresh, parentNotDownloaded, onNewFile, onNewFolder,
}: FileTreeHeaderProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-zinc-800/50">
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-xs font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-wider">
          {t('fileTree.title')}
        </span>
        {readOnly && <ReadOnlyBadge compact />}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleDotFiles}
          className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-white/[0.05] transition-colors ${
            showDotFiles ? 'text-accent' : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300'
          }`}
          title={showDotFiles ? t('fileTree.hideHidden') : t('fileTree.showHidden')}
        >
          {showDotFiles ? <Eye size={14} /> : <EyeSlash size={14} />}
        </button>
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className={`${iconButton} disabled:opacity-50`}
          title={t('fileTree.refresh')}
        >
          <ArrowClockwise size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={onNewFile}
          className={`${iconButton} disabled:opacity-40 disabled:pointer-events-none`}
          disabled={parentNotDownloaded}
          title={parentNotDownloaded ? 'ダウンロードしていないフォルダには作成できません' : t('fileTree.newFile')}
        >
          <FilePlus size={14} />
        </button>
        <button
          onClick={onNewFolder}
          className={`${iconButton} disabled:opacity-40 disabled:pointer-events-none`}
          disabled={parentNotDownloaded}
          title={parentNotDownloaded ? 'ダウンロードしていないフォルダには作成できません' : t('fileTree.newFolder')}
        >
          <FolderPlus size={14} />
        </button>
      </div>
    </div>
  )
}

/** 「🔒 非公開：N人だけが見られます」 while the selection (or the department) is inside a private folder. */
export function PrivateFolderBanner({ folder }: { folder: MyPrivateFolder }) {
  return (
    <div
      role="note"
      title={viewersLabel(folder)}
      className="flex items-center gap-1.5 border-b border-indigo-100 bg-indigo-50 px-3 py-1.5 text-[11px] text-indigo-900 dark:border-indigo-400/15 dark:bg-indigo-400/[0.08] dark:text-indigo-100"
    >
      <LockSimple size={12} weight="fill" className="flex-shrink-0 text-indigo-500 dark:text-indigo-400" />
      <span className="truncate">
        <span className="font-medium">非公開：{folder.viewerCount}人だけが見られます</span>
        <span className="text-indigo-900/60 dark:text-indigo-200/60">（{lastSegment(folder.path)}）</span>
      </span>
    </div>
  )
}
