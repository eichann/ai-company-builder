import { X } from '@phosphor-icons/react'
import { getFileIcon } from '../../../shared/ui/fileIcon'
import { fileNameOf } from '../fileKinds'
import type { OpenFile } from '../hooks/useOpenFiles'

interface Props {
  openFiles: string[]
  fileContents: Map<string, OpenFile>
  activeFilePath: string | null
  previewFilePath?: string | null
  /** Department label for tabs whose file is outside the selected department. */
  tabLabels?: Record<string, string>
  onSelect: (path: string) => void
  onPin?: (path: string) => void
  onClose: (e: React.MouseEvent, path: string) => void
}

/** One tab per open file: a preview tab in italics, a dot while unsaved, the department of a file from elsewhere. */
export function EditorTabBar({ openFiles, fileContents, activeFilePath, previewFilePath, tabLabels, onSelect, onPin, onClose }: Props) {
  return (
    <div className="flex-shrink-0 flex items-center border-b border-gray-200 dark:border-zinc-800/50 bg-gray-100 dark:bg-zinc-900/50 overflow-x-auto">
      <div className="flex">
        {openFiles.map((filePath) => {
          const fileName = fileNameOf(filePath)
          const file = fileContents.get(filePath)
          const isActive = filePath === activeFilePath
          const isModified = file && file.content !== file.originalContent
          const isPreview = filePath === previewFilePath
          const FileIcon = getFileIcon(fileName, false)
          const deptLabel = tabLabels?.[filePath]

          return (
            <div
              key={filePath}
              onClick={() => onSelect(filePath)}
              onDoubleClick={() => { if (isPreview && onPin) onPin(filePath) }}
              className={`
                group flex items-center gap-2 px-3 py-2 cursor-pointer
                border-r border-gray-200 dark:border-zinc-800/50 min-w-0 ${deptLabel ? 'max-w-[260px]' : 'max-w-[200px]'}
                ${isActive
                  ? 'bg-white dark:bg-zinc-900/80 text-gray-800 dark:text-zinc-200'
                  : 'bg-gray-50 dark:bg-zinc-900/30 text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-900/50'
                }
              `}
            >
              <FileIcon size={14} className="flex-shrink-0" />
              {deptLabel && (
                <span data-tab-dept className="text-[11px] text-gray-400 dark:text-zinc-500 truncate max-w-[96px] flex-shrink-[2]" title={`${deptLabel} のファイル`}>
                  {deptLabel} /
                </span>
              )}
              <span className={`text-xs truncate ${isPreview ? 'italic' : ''} ${deptLabel ? '-ml-1' : ''}`} title={filePath}>{fileName}</span>
              {isModified && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
              )}
              <button
                onClick={(e) => onClose(e, filePath)}
                className={`
                  p-0.5 rounded hover:bg-white/10 flex-shrink-0
                  ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
                `}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>

    </div>
  )
}
