import { useState, type ReactNode } from 'react'
import { PushPin, X } from '@phosphor-icons/react'
import { ContextMenu } from '../../../shared/ui/ContextMenu'
import { FILE_PATHS_DRAG_TYPE, LINK_EFFECT_ALLOWED, startRecordDrag } from '../../../shared/lib/dragTypes'
import { getFileIcon } from '../../../shared/ui/fileIcon'
import { RecordIcon } from '../../../shared/ui/ThingIcon'
import { thingName } from '../../../../shared/thing-words'
import { recordIdOfTab, type RecordTabLook } from '../editorTabs'
import { fileNameOf } from '../fileKinds'
import type { OpenFile } from '../hooks/useOpenFiles'

interface Props {
  openFiles: string[]
  fileContents: Map<string, OpenFile>
  activeFilePath: string | null
  previewFilePath?: string | null
  /** Department label for tabs whose file is outside the selected department. */
  tabLabels?: Record<string, string>
  /** Record tabs' titles and kinds (by record id); a record not read yet shows 「読み込んでいます」. */
  recordLooks?: Readonly<Record<string, RecordTabLook>>
  onSelect: (path: string) => void
  onPin?: (path: string) => void
  onClose: (e: React.MouseEvent, path: string) => void
  /** Pinned (固定) tabs: 「タブを片づける」 leaves them open. */
  pinnedTabs?: ReadonlySet<string>
  onTogglePinned?: (key: string) => void
  /** At the right end, outside the scrolling strip (the tabs' 「…」 menu). */
  end?: ReactNode
}

/**
 * One tab per open file or record: a preview tab in italics, a dot while unsaved, the department of
 * a file from elsewhere; a record by its kind's icon and its title (plan A, no 「ファイルではありません」 line).
 */
export function EditorTabBar({ openFiles, fileContents, activeFilePath, previewFilePath, tabLabels, recordLooks, onSelect, onPin, onClose, pinnedTabs, onTogglePinned, end }: Props) {
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  return (
    <div className="flex-shrink-0 flex items-center border-b border-gray-200 dark:border-zinc-800/50 bg-gray-100 dark:bg-zinc-900/50">
      {menu && onTogglePinned && (
        <ContextMenu position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)}
          items={[{ label: pinnedTabs?.has(menu.key) ? '固定をやめる' : '固定する（片づけても残す）', icon: <PushPin size={14} />, onClick: () => { onTogglePinned(menu.key); setMenu(null) } }]} />
      )}
      <div className="flex min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="開いているもの">
        {openFiles.map((filePath) => {
          const recordId = recordIdOfTab(filePath)
          const look = recordId ? recordLooks?.[recordId] : undefined
          const fileName = recordId ? (look?.title ?? '読み込んでいます') : fileNameOf(filePath)
          const file = fileContents.get(filePath)
          const isActive = filePath === activeFilePath
          const isModified = file && file.content !== file.originalContent
          const isPreview = filePath === previewFilePath
          const FileIcon = getFileIcon(fileName, false)
          const icon = recordId
            ? (look ? <RecordIcon record={look} size={14} /> : null)
            : <FileIcon size={14} className="flex-shrink-0" />
          const deptLabel = tabLabels?.[filePath]
          const pinned = !!pinnedTabs?.has(filePath)

          return (
            <div
              key={filePath}
              role="tab"
              aria-selected={isActive}
              data-tab={recordId ? `record:${recordId}` : 'file'}
              data-pinned={pinned || undefined}
              onClick={() => onSelect(filePath)}
              onContextMenu={onTogglePinned ? e => { e.preventDefault(); setMenu({ key: filePath, x: e.clientX, y: e.clientY }) } : undefined}
              // A tab dragged onto a record's 「つながっているもの」 links what it shows (owner decision 2026-11-03).
              draggable
              onDragStart={e => {
                if (recordId) startRecordDrag(e.dataTransfer, { id: recordId, title: look?.title ?? '', ...(look ? { word: thingName(look) } : {}) })
                else {
                  e.dataTransfer.setData(FILE_PATHS_DRAG_TYPE, JSON.stringify([filePath]))
                  e.dataTransfer.effectAllowed = LINK_EFFECT_ALLOWED
                }
              }}
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
              {icon}
              {deptLabel && (
                <span data-tab-dept className="text-[11px] text-gray-400 dark:text-zinc-500 truncate max-w-[96px] flex-shrink-[2]" title={`${deptLabel} のファイル`}>
                  {deptLabel} /
                </span>
              )}
              <span className={`text-xs truncate ${isPreview ? 'italic' : ''} ${deptLabel ? '-ml-1' : ''}`} title={recordId ? (look ? `${thingName(look)}：${look.title}` : undefined) : filePath}>{fileName}</span>
              {pinned && (
                <button type="button" aria-label="固定をやめる" title="固定しています（片づけても残ります）。押すと固定をやめます"
                  onClick={e => { e.stopPropagation(); onTogglePinned?.(filePath) }}
                  className="flex-shrink-0 rounded p-0.5 text-indigo-500 hover:bg-gray-200 dark:hover:bg-zinc-700">
                  <PushPin size={11} weight="fill" />
                </button>
              )}
              {isModified && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
              )}
              <button
                type="button"
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
      {end && <div className="flex flex-shrink-0 items-center px-1">{end}</div>}
    </div>
  )
}
