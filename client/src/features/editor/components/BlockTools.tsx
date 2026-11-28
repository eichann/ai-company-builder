import { BLOCK_CHOICES, type InPlaceBlock } from '../blockChoices'
import type { InPlaceBlockMenu, InPlaceTable, TableEdit } from '../inPlaceEditing'

const BY_BLOCK = new Map(BLOCK_CHOICES.map(c => [c.block, c]))

/**
 * The 「/」 list (owner decision 2026-11-28): the shapes a line can take, found by what is typed
 * after 「/」; ↑ ↓ and Enter are the commands editor.blockMenu*. A press never takes the focus from
 * the document (mouse down is held), so the caret stays on the 「/」 line; the pointer picks only when it moves
 * (a list opening under a resting pointer keeps its first choice).
 */
export function BlockMenu({ menu, index, onHover, onChoose }: {
  menu: InPlaceBlockMenu
  index: number
  onHover: (index: number) => void
  onChoose: (block: InPlaceBlock) => void
}) {
  const height = 36 + menu.choices.length * 32
  const above = menu.box.bottom + 6 + height > window.innerHeight && menu.box.top - 6 - height > 0
  const left = Math.max(8, Math.min(menu.box.left, window.innerWidth - 280))
  return (
    <div
      role="listbox"
      aria-label="形を選ぶ"
      data-block-menu
      className="fixed z-menu w-64 rounded-card border border-[color:var(--color-border)] bg-surface-raised py-1 shadow-pop"
      style={above ? { left, bottom: window.innerHeight - menu.box.top + 6 } : { left, top: menu.box.bottom + 6 }}
      onMouseDown={e => e.preventDefault()}
    >
      <div className="px-3 py-1 text-caption text-text-muted">
        {menu.query ? `「${menu.query}」で絞り込み` : '形を選ぶ（↑↓ で選んで Enter）'}
      </div>
      {menu.choices.map((block, i) => {
        const choice = BY_BLOCK.get(block)!
        return (
          <button
            key={block}
            type="button"
            role="option"
            aria-selected={i === index}
            className="flex w-full items-center justify-between px-3 py-1 text-small text-text aria-selected:bg-selected-bg aria-selected:text-selected-text"
            onMouseMove={() => { if (i !== index) onHover(i) }}
            onClick={() => onChoose(block)}
          >
            <span>{choice.label}</span>
            <span className="text-caption text-text-subtle">{choice.hint}</span>
          </button>
        )
      })}
    </div>
  )
}

const TABLE_EDITS: Array<{ edit: TableEdit; label: string }> = [
  { edit: 'addRow', label: '行を足す' },
  { edit: 'addColumn', label: '列を足す' },
  { edit: 'deleteRow', label: '行を消す' },
  { edit: 'deleteColumn', label: '列を消す' },
]

/** Over the table's top right while the caret is in it: rows and columns, where the caret is. */
export function TableBar({ table, onEdit }: { table: InPlaceTable; onEdit: (edit: TableEdit) => void }) {
  return (
    <div
      role="toolbar"
      aria-label="表の操作"
      data-table-bar
      className="fixed z-menu flex items-center gap-0.5 rounded-control border border-[color:var(--color-border)] bg-surface-raised p-0.5 shadow-pop"
      style={{ right: Math.max(8, window.innerWidth - table.box.right), top: Math.max(8, table.box.top - 38) }}
      onMouseDown={e => e.preventDefault()}
    >
      {TABLE_EDITS.map(({ edit, label }) => (
        <button
          key={edit}
          type="button"
          disabled={!table.can[edit]}
          className="inline-flex h-control-sm items-center rounded-small px-2 text-small text-text hover:bg-surface-sunken disabled:text-text-subtle disabled:hover:bg-transparent"
          onClick={() => onEdit(edit)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
