import { useState } from 'react'
import { CaretDown, CaretRight, DotsThreeVertical } from '@phosphor-icons/react'
import { InputDialog } from '../../../shared/ui/InputDialog'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { GROUP_COLOR_CLASSES, GROUP_COLOR_NAMES, GROUP_COLORS, type GroupColor, type TabSection } from '../tabArrangement'
import type { GroupDialog } from '../hooks/useTabArrangement'

interface ChipProps {
  section: TabSection
  name: string
  /** A bundle group's first label (its picture). */
  typeLabel?: string | null
  collapsed: boolean
  /** The active tab is in this folded group (the chip is marked; the tab stays shown). */
  holdsActive: boolean
  dropping: boolean
  onToggle: () => void
  onMenu: (x: number, y: number) => void
  dropHandlers?: Pick<React.HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDrop'>
}

/** A group's start in the tabs: its colour or kind icon, name and count; pressing it folds the group. */
export function TabGroupChip({ section, name, typeLabel, collapsed, holdsActive, dropping, onToggle, onMenu, dropHandlers }: ChipProps) {
  const color = section.group ? GROUP_COLOR_CLASSES[section.group.color] : null
  const Caret = collapsed ? CaretRight : CaretDown
  return (
    <div data-tab-group={name} data-collapsed={collapsed || undefined} {...dropHandlers}
      className={`flex flex-shrink-0 items-center gap-0.5 pl-1.5 pr-0.5 border-r border-gray-200 dark:border-zinc-800/50 ${dropping ? 'bg-indigo-100 dark:bg-indigo-900/40' : ''}`}>
      <button type="button" aria-expanded={!collapsed} title={collapsed ? `「${name}」を開く` : `「${name}」をたたむ`}
        onClick={onToggle} onContextMenu={e => { e.preventDefault(); onMenu(e.clientX, e.clientY) }}
        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${color ? color.chip : 'bg-gray-200/70 text-gray-700 dark:bg-zinc-800 dark:text-zinc-300'} ${holdsActive ? 'ring-1 ring-indigo-400' : ''}`}>
        {section.kind ? <ThingIcon kind={section.kind} typeLabel={typeLabel} size={12} label={name} /> : null}
        <span className="max-w-[120px] truncate">{name}</span>
        <span className="tabular-nums opacity-70" aria-label={`${section.keys.length}件`}>{section.keys.length}</span>
        <Caret size={9} weight="bold" className="opacity-60" />
      </button>
      <button type="button" aria-label={`${name}の操作`} title={`${name}の操作`}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom + 2) }}
        className="rounded p-0.5 text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-700">
        <DotsThreeVertical size={12} weight="bold" />
      </button>
    </div>
  )
}

/** The name and colour of a named group: a new one for a tab, or an existing one's. */
export function TabGroupDialog({ dialog, onSave, onCancel }: { dialog: GroupDialog; onSave: (name: string, color: GroupColor) => void; onCancel: () => void }) {
  const [color, setColor] = useState<GroupColor>(dialog.kind === 'new' ? dialog.color : dialog.group.color)
  return (
    <InputDialog isOpen title={dialog.kind === 'new' ? '新しいまとまり' : 'まとまりの名前と色'} placeholder="まとまりの名前（例：提案の準備）"
      defaultValue={dialog.kind === 'new' ? dialog.name : dialog.group.name} confirmText={dialog.kind === 'new' ? '作る' : '変える'}
      error={dialog.error} onConfirm={name => onSave(name, color)} onCancel={onCancel}>
      <div role="radiogroup" aria-label="まとまりの色" className="mt-3 flex items-center gap-2">
        <span className="text-xs text-text-secondary">色</span>
        {GROUP_COLORS.map(c => (
          <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={GROUP_COLOR_NAMES[c]} title={GROUP_COLOR_NAMES[c]}
            onClick={() => setColor(c)}
            className={`h-5 w-5 rounded-full ${GROUP_COLOR_CLASSES[c].swatch} ${c === color ? 'ring-2 ring-offset-2 ring-gray-500 dark:ring-offset-zinc-900' : ''}`} />
        ))}
      </div>
    </InputDialog>
  )
}
