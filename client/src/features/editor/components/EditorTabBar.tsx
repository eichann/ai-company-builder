import { useRef, useState, type ReactNode } from 'react'
import { Broom, CaretDown, CaretRight, FolderPlus, Minus, PencilSimple, PushPin, X } from '@phosphor-icons/react'
import { ContextMenu, type ContextMenuItem } from '../../../shared/ui/ContextMenu'
import { FILE_PATHS_DRAG_TYPE, isTabDrag, LINK_EFFECT_ALLOWED, startRecordDrag, TAB_DRAG_TYPE } from '../../../shared/lib/dragTypes'
import { runCommand } from '../../../shared/commands/commands'
import { getFileIcon } from '../../../shared/ui/fileIcon'
import { RecordIcon } from '../../../shared/ui/ThingIcon'
import { thingName } from '../../../../shared/thing-words'
import { recordIdOfTab, type RecordTabLook } from '../editorTabs'
import { fileNameOf } from '../fileKinds'
import { GROUP_COLOR_CLASSES, tabGroupName, type TabSection } from '../tabArrangement'
import type { OpenFile } from '../hooks/useOpenFiles'
import type { TabArrangement } from '../hooks/useTabArrangement'
import { TabGroupChip, TabGroupDialog } from './TabGroupParts'

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
  /** How the tabs stand (order by drag, named groups, by kind); without it, one run in `openFiles` order. */
  arrangement?: TabArrangement
  /** At the right end, outside the scrolling strip (the tabs' 「…」 menu). */
  end?: ReactNode
}

type DropAt = { key: string; place: 'before' | 'after' } | { group: string }
type Menu = { x: number; y: number; items: ContextMenuItem[] }

/**
 * One tab per open file or record: a preview tab in italics, a dot while unsaved, the department of
 * a file from elsewhere; a record by its kind's icon and its title (plan A, no 「ファイルではありません」 line).
 * A tab dragged inside the bar moves (an insertion line shows where); dropped anywhere else it links.
 */
export function EditorTabBar({ openFiles, fileContents, activeFilePath, previewFilePath, tabLabels, recordLooks, onSelect, onPin, onClose, pinnedTabs, onTogglePinned, arrangement, end }: Props) {
  const [menu, setMenu] = useState<Menu | null>(null)
  // The tab being dragged from this bar (a ref: changing the dragged element during dragstart can cancel the drag).
  const dragKey = useRef<string | null>(null)
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const looks = recordLooks ?? {}
  const sections: TabSection[] = arrangement?.sections ?? [{ id: 'all', keys: openFiles }]

  const tabMenu = (key: string): ContextMenuItem[] => {
    const items: ContextMenuItem[] = []
    if (onTogglePinned) items.push({ label: pinnedTabs?.has(key) ? '固定をやめる' : '固定する（片づけても残す）', icon: <PushPin size={14} />, onClick: () => onTogglePinned(key) })
    if (arrangement && !pinnedTabs?.has(key)) {
      const current = arrangement.groupOf(key)
      items.push({ label: '新しいまとまりに入れる…', icon: <FolderPlus size={14} />, onClick: () => arrangement.askNewGroup(key) })
      for (const g of arrangement.grouping.groups) {
        if (g.id !== current?.id) items.push({ label: `「${g.name}」に入れる`, icon: <span className={`block h-2.5 w-2.5 rounded-full ${GROUP_COLOR_CLASSES[g.color].swatch}`} />, onClick: () => arrangement.addToGroup(key, g.id) })
      }
      if (current) items.push({ label: 'まとまりから外す', icon: <Minus size={14} />, onClick: () => arrangement.removeFromGroup(key) })
    }
    return items
  }

  const chipMenu = (section: TabSection, name: string): ContextMenuItem[] => {
    if (!arrangement) return []
    const collapsed = arrangement.isCollapsed(section)
    const fold = { label: collapsed ? 'ひらく' : 'たたむ', icon: collapsed ? <CaretRight size={14} /> : <CaretDown size={14} />, onClick: () => arrangement.toggleCollapsed(section.id) }
    const group = section.group
    if (group) return [
      fold,
      { label: '名前と色を変える…', icon: <PencilSimple size={14} />, onClick: () => arrangement.askEditGroup(group) },
      { label: 'このまとまりを片づける', icon: <Broom size={14} />, onClick: () => { void runCommand('tabs.tidy', { group: group.id }) } },
      { label: 'まとまりを解く', icon: <Minus size={14} />, onClick: () => arrangement.ungroup(group.id) },
    ]
    const kind = section.kind
    return kind ? [fold, { label: `この種類（${name}）を片づける`, icon: <Broom size={14} />, onClick: () => { void runCommand('tabs.tidy', { kind }) } }] : [fold]
  }

  const endDrag = () => { dragKey.current = null; setDropAt(null) }

  const renderTab = (filePath: string, section: TabSection) => {
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
    const line = dropAt && 'key' in dropAt && dropAt.key === filePath ? dropAt.place : null

    return (
      <div
        key={filePath}
        role="tab"
        aria-selected={isActive}
        data-tab={recordId ? `record:${recordId}` : 'file'}
        data-pinned={pinned || undefined}
        data-drop-line={line ?? undefined}
        onClick={() => onSelect(filePath)}
        onContextMenu={e => {
          const items = tabMenu(filePath)
          if (items.length === 0) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, items })
        }}
        // A tab dragged onto a record's 「つながっているもの」 links what it shows (owner decision 2026-11-03);
        // dropped on the bar itself it moves (the drop target decides; owner 2026-11-04).
        draggable
        onDragStart={e => {
          if (recordId) startRecordDrag(e.dataTransfer, { id: recordId, title: look?.title ?? '', ...(look ? { word: thingName(look) } : {}) })
          else {
            e.dataTransfer.setData(FILE_PATHS_DRAG_TYPE, JSON.stringify([filePath]))
            e.dataTransfer.effectAllowed = LINK_EFFECT_ALLOWED
          }
          if (arrangement) { e.dataTransfer.setData(TAB_DRAG_TYPE, ''); dragKey.current = filePath }
        }}
        onDragEnd={endDrag}
        onDragOver={e => {
          const from = dragKey.current
          if (!arrangement || !from || !isTabDrag(e.dataTransfer) || !arrangement.canDrop(from, filePath)) return
          e.preventDefault()
          // The drag allows `link` only (a tab never moves a file in the tree); the bar takes that.
          e.dataTransfer.dropEffect = 'link'
          const r = e.currentTarget.getBoundingClientRect()
          const place = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
          if (line !== place) setDropAt({ key: filePath, place })
        }}
        onDrop={e => {
          const from = dragKey.current
          if (!arrangement || !from || !isTabDrag(e.dataTransfer)) return
          e.preventDefault()
          if (line) arrangement.reorder(from, filePath, line)
          endDrag()
        }}
        onDoubleClick={() => { if (isPreview && onPin) onPin(filePath) }}
        className={`
          relative group flex items-center gap-2 px-3 py-2 cursor-pointer
          border-r border-gray-200 dark:border-zinc-800/50 min-w-[96px] ${deptLabel ? 'max-w-[260px]' : 'max-w-[200px]'}
          ${section.group ? `border-b-2 ${GROUP_COLOR_CLASSES[section.group.color].line}` : ''}
          ${isActive
            ? 'bg-white dark:bg-zinc-900/80 text-gray-800 dark:text-zinc-200'
            : 'bg-gray-50 dark:bg-zinc-900/30 text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-900/50'
          }
        `}
      >
        {line && <span aria-hidden className={`pointer-events-none absolute inset-y-1 w-0.5 rounded bg-indigo-500 ${line === 'before' ? '-left-px' : '-right-px'}`} />}
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
          <span role="img" aria-label="保存していない変更があります" title="保存していない変更があります（1秒ほどで自動で保存します）" className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
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
  }

  return (
    <div className="flex-shrink-0 flex items-center border-b border-gray-200 dark:border-zinc-800/50 bg-gray-100 dark:bg-zinc-900/50">
      {menu && <ContextMenu position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} items={menu.items} />}
      {arrangement?.dialog && <TabGroupDialog key={JSON.stringify(arrangement.dialog)} dialog={arrangement.dialog} onSave={arrangement.saveDialog} onCancel={arrangement.closeDialog} />}
      <div className="flex min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="開いているもの"
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null) }}>
        {sections.map(section => {
          const chip = !!arrangement && (section.group || section.kind)
          const collapsed = !!chip && arrangement.isCollapsed(section)
          // A folded group still shows the tab that is open: the member always sees where they are.
          const shown = collapsed ? section.keys.filter(k => k === activeFilePath) : section.keys
          const name = section.group ? section.group.name : section.kind ? tabGroupName(section.kind, section.keys, looks) : ''
          const group = section.group
          return (
            <div key={section.id} className="contents" data-tab-section={section.id}>
              {chip && (
                <TabGroupChip section={section} name={name} collapsed={collapsed} holdsActive={collapsed && shown.length > 0}
                  typeLabel={section.kind === 'bundle' ? looks[recordIdOfTab(section.keys[0]) ?? '']?.typeLabel : undefined}
                  dropping={!!group && !!dropAt && 'group' in dropAt && dropAt.group === group.id}
                  onToggle={() => arrangement.toggleCollapsed(section.id)}
                  onMenu={(x, y) => setMenu({ x, y, items: chipMenu(section, name) })}
                  dropHandlers={group ? {
                    // A tab dropped on a named group's chip joins it (a pinned one stays with the pinned).
                    onDragOver: e => {
                      const from = dragKey.current
                      if (!from || !isTabDrag(e.dataTransfer) || pinnedTabs?.has(from)) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'link'
                      if (!dropAt || !('group' in dropAt) || dropAt.group !== group.id) setDropAt({ group: group.id })
                    },
                    onDrop: e => {
                      const from = dragKey.current
                      if (!from || !isTabDrag(e.dataTransfer)) return
                      e.preventDefault()
                      arrangement.addToGroup(from, group.id)
                      endDrag()
                    },
                  } : undefined} />
              )}
              {shown.map(key => renderTab(key, section))}
            </div>
          )
        })}
      </div>
      {end && <div className="flex flex-shrink-0 items-center px-1">{end}</div>}
    </div>
  )
}
