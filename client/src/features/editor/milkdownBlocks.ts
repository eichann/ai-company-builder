// The 「/」 list, the line starts and the table bar on Milkdown's document (behind inPlaceEditing.ts,
// loaded with milkdownSurface.ts; files-and-editor.md "The 「/」 list, line starts and the table bar").
// Each is an ordinary editor change, written back like typing (markdownSplice.ts): what the member
// made, and nothing around it — or taken back when it cannot be written faithfully.
import { InputRule } from '@milkdown/prose/inputrules'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/prose/state'
import { addColumnAfter, deleteColumn, deleteRow, selectedRect, TableMap } from '@milkdown/prose/tables'
import { findWrapping } from '@milkdown/prose/transform'
import type { Node as PMNode, NodeType } from '@milkdown/prose/model'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'
import { $inputRule, $prose } from '@milkdown/utils'
import { createCodeBlockInputRule, insertHrInputRule, wrapInBulletListInputRule, wrapInOrderedListInputRule } from '@milkdown/preset-commonmark'
import { wrapInTaskListInputRule } from '@milkdown/preset-gfm'
import { matchBlockChoices, type InPlaceBlock } from './blockChoices'
import type { InPlaceBlockMenu, InPlaceTable, TableEdit } from './inPlaceEditing'

const menuKey = new PluginKey<{ dismissed: string | null }>('acb-block-menu')

/** The line the 「/」 list is about: a top-level paragraph holding only 「/」 and a few letters, the caret at its end. */
function slashLine(state: EditorState): { at: number; text: string; query: string } | null {
  const sel = state.selection
  if (!(sel instanceof TextSelection) || !sel.empty) return null
  const { $from } = sel
  if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph') return null
  const text = $from.parent.textContent
  const m = /^\/([^\s/]{0,16})$/.exec(text)
  if (!m || $from.parentOffset !== text.length || $from.parent.childCount !== 1) return null
  return { at: $from.before(), text, query: m[1] }
}

/** The 「/」 list as it is shown now, or null (no 「/」 line, nothing found, or closed with Esc for this text). */
export function blockMenuOf(state: EditorState): { query: string; choices: InPlaceBlock[] } | null {
  const line = slashLine(state)
  if (!line || menuKey.getState(state)?.dismissed === `${line.at}:${line.text}`) return null
  const choices = matchBlockChoices(line.query)
  return choices.length ? { query: line.query, choices } : null
}

/** Esc: the list closes for this 「/」 text (typing on opens it again); the 「/」 stays as written. */
export function closeBlockMenu(view: EditorView) {
  const line = slashLine(view.state)
  if (line) view.dispatch(view.state.tr.setMeta(menuKey, `${line.at}:${line.text}`).setMeta('addToHistory', false))
}

export function blockMenuReport(view: EditorView): InPlaceBlockMenu | null {
  const menu = view.hasFocus() ? blockMenuOf(view.state) : null
  if (!menu) return null
  const c = view.coordsAtPos(view.state.selection.from)
  return { ...menu, box: { left: c.left, top: c.top, bottom: c.bottom } }
}

const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter'])

/**
 * The list's state, the empty line's hint and the keys the list holds. ↑ ↓ Enter are the app's
 * commands while the list shows (editor.blockMenu*): the editor only leaves them alone then (no caret
 * move, no new line). Esc is never held here: closing is the command's, and with no list it is another's.
 */
export const blockMenuPlugin = $prose(() => new Plugin<{ dismissed: string | null }>({
  key: menuKey,
  state: {
    init: () => ({ dismissed: null }),
    apply: (tr, v) => {
      const meta = tr.getMeta(menuKey) as string | undefined
      return meta !== undefined ? { dismissed: meta } : v
    },
  },
  props: {
    handleKeyDown: (view, e) => {
      if (view.composing || e.isComposing || e.keyCode === 229) return false
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !MENU_KEYS.has(e.key)) return false
      return blockMenuOf(view.state) !== null
    },
    decorations: state => {
      const { $from, empty } = state.selection
      if (!empty || $from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parent.content.size !== 0) return null
      // Shown only while the document has the focus (the stylesheet's `.ProseMirror-focused`).
      return DecorationSet.create(state.doc, [Decoration.node($from.before(), $from.after(), { class: 'acb-empty-line', 'data-hint': '「/」で形を選べます' })])
    },
  },
}))

/**
 * Lists as the file's reader makes them: a tight list (`spread: false`, else the list reads back
 * differently and is not written) whose items know their kind; a checklist item is unchecked.
 */
function wrapAsList(tr: Transaction, inside: number, kind: 'bullet' | 'ordered' | 'task', order = 1): boolean {
  const s = tr.doc.type.schema
  const range = tr.doc.resolve(inside).blockRange()
  const listType = kind === 'ordered' ? s.nodes.ordered_list : s.nodes.bullet_list
  const wrapping = range && findWrapping(range, listType, kind === 'ordered' ? { order, spread: false } : { spread: false })
  if (!range || !wrapping) return false
  tr.wrap(range, wrapping)
  const item = range.start + 1
  tr.setNodeMarkup(item, undefined, {
    ...tr.doc.nodeAt(item)!.attrs,
    spread: false,
    listType: kind === 'ordered' ? 'ordered' : 'bullet',
    label: kind === 'ordered' ? `${order}.` : '•',
    checked: kind === 'task' ? false : null,
  })
  return true
}

function wrapIn(tr: Transaction, inside: number, type: NodeType | undefined): boolean {
  const range = tr.doc.resolve(inside).blockRange()
  const wrapping = range && type && findWrapping(range, type)
  if (!range || !wrapping) return false
  tr.wrap(range, wrapping)
  return true
}

/** The paragraph holding `start` has nothing but the line start typed so far (no words after the caret). */
function onlyLineStart(state: EditorState, start: number, end: number): boolean {
  const $s = state.doc.resolve(start)
  return $s.parent.type.name === 'paragraph' && $s.parent.content.size === end - start
}

/** A divider in place of the paragraph at `at`, and an empty line after it for the caret (not written while empty). */
function divider(tr: Transaction, at: number, size: number) {
  const s = tr.doc.type.schema
  tr.replaceWith(at, at + size, [s.nodes.hr.create(), s.nodes.paragraph.create()])
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)))
}

/**
 * The line starts (owner decision 2026-11-28): 「- 」「1. 」「[] 」「```」「---」 here, 「# 」「> 」 the
 * editor's own. These replace the editor's rules for the same starts (`REPLACED_LINE_START_RULES`):
 * its lists were not tight (never written), its 「---」 put the caret into the next paragraph, its
 * code needed a space, its checklist worked only inside a list and only for 「[ ] 」.
 */
export const lineStartRules = [
  $inputRule(() => new InputRule(/^\s*([-+*])\s$/, (state, _m, start, end) => {
    const tr = state.tr.delete(start, end)
    return wrapAsList(tr, start, 'bullet') ? tr : null
  })),
  $inputRule(() => new InputRule(/^(\d{1,9})\.\s$/, (state, m, start, end) => {
    const tr = state.tr.delete(start, end)
    return wrapAsList(tr, start, 'ordered', Number(m[1])) ? tr : null
  })),
  // 「[] 」 or 「[ ] 」: in a list, that item becomes a checklist item; anywhere else, a new checklist.
  $inputRule(() => new InputRule(/^\[ ?\] $/, (state, _m, start, end) => {
    const s = state.schema
    const $s = state.doc.resolve(start)
    if ($s.parent.type !== s.nodes.paragraph) return null
    const item = $s.depth >= 2 ? $s.node(-1) : null
    const tr = state.tr.delete(start, end)
    if (item && item.type === s.nodes.list_item) {
      if (item.attrs.checked != null || $s.index(-1) !== 0) return null
      return tr.setNodeMarkup($s.before(-1), undefined, { ...item.attrs, checked: false })
    }
    return wrapAsList(tr, start, 'task') ? tr : null
  })),
  // 「```」 on an empty line: code at once (the language can be added in the source).
  $inputRule(() => new InputRule(/^```$/, (state, _m, start, end) => {
    if (!onlyLineStart(state, start, end)) return null
    const $s = state.doc.resolve(start)
    return state.tr.delete(start, end).setNodeMarkup($s.before(), state.schema.nodes.code_block, { language: '' })
  })),
  // 「---」 on an empty line: a divider, the caret on the line after it.
  $inputRule(() => new InputRule(/^---$/, (state, _m, start, end) => {
    if (!onlyLineStart(state, start, end)) return null
    const $s = state.doc.resolve(start)
    const tr = state.tr.delete(start, end)
    divider(tr, $s.before(), 2)
    return tr
  })),
]

/** The editor's own rules these replace (one rule per line start). */
export const REPLACED_LINE_START_RULES: readonly unknown[] = [
  wrapInBulletListInputRule, wrapInOrderedListInputRule, createCodeBlockInputRule, insertHrInputRule, wrapInTaskListInputRule,
].flat()

/** A new table: a header row and two rows of three empty cells, no alignment (written `| --- |`). */
function newTable(state: EditorState): PMNode {
  const s = state.schema
  const cell = (type: string) => s.nodes[type].create({ alignment: null }, s.nodes.paragraph.create())
  const row = (type: string, cellType: string) => s.nodes[type].create(null, [cell(cellType), cell(cellType), cell(cellType)])
  return s.nodes.table.create(null, [row('table_header_row', 'table_header'), row('table_row', 'table_cell'), row('table_row', 'table_cell')])
}

/** The 「/」 list's choice: the 「/…」 line becomes that block (its letters gone), the caret inside it. */
export function turnIntoBlock(view: EditorView, block: InPlaceBlock): boolean {
  const { state } = view
  if (!slashLine(state)) return false
  const s = state.schema
  const { $from } = state.selection
  const at = $from.before()
  const tr = state.tr.delete($from.start(), $from.end())
  const inside = at + 1
  let done = true
  switch (block) {
    case 'heading1': case 'heading2': case 'heading3':
      tr.setNodeMarkup(at, s.nodes.heading, { level: Number(block.slice(-1)) })
      break
    case 'code': tr.setNodeMarkup(at, s.nodes.code_block, { language: '' }); break
    case 'bullet': case 'ordered': case 'task': done = wrapAsList(tr, inside, block); break
    case 'quote': done = wrapIn(tr, inside, s.nodes.blockquote); break
    case 'divider': divider(tr, at, 2); break
    case 'table': {
      const table = newTable(state)
      const last = at + 2 >= tr.doc.content.size
      tr.replaceWith(at, at + 2, last ? [table, s.nodes.paragraph.create()] : [table])
      tr.setSelection(TextSelection.near(tr.doc.resolve(at + 4)))
      break
    }
  }
  if (!done) return false
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

/** The table holding the caret: its position and node, or null. */
function tableAround(state: EditorState): { pos: number; node: PMNode; inHeader: boolean } | null {
  const { $from } = state.selection
  let inHeader = false
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d)
    if (n.type.name === 'table_header_row') inHeader = true
    if (n.type.name === 'table') return { pos: $from.before(d), node: n, inHeader }
  }
  return null
}

/** A row after the caret's row (after the header when the caret is there), each cell its column's alignment. */
function addRow(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const around = tableAround(state)
  if (!around) return false
  if (!dispatch) return true
  const s = state.schema
  const rect = selectedRect(state)
  const header = around.node.firstChild!
  let rowPos = rect.tableStart
  for (let r = 0; r < rect.bottom; r++) rowPos += around.node.child(r).nodeSize
  const cells: PMNode[] = []
  header.forEach(h => { cells.push(s.nodes.table_cell.createAndFill({ alignment: h.attrs.alignment })!) })
  const tr = state.tr.insert(rowPos, s.nodes.table_row.create(null, cells))
  // The caret goes into the new row, in its column: what is typed next fills it.
  let at = rowPos + 1
  for (let c = 0; c < rect.left && c < cells.length; c++) at += cells[c].nodeSize
  dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1))))
  return true
}

/** A column after the caret's column, without alignment (its `---` like a new table's). */
function addColumn(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  if (!tableAround(state)) return false
  if (!dispatch) return addColumnAfter(state)
  const col = selectedRect(state).right
  return addColumnAfter(state, tr => {
    const $cell = tr.doc.resolve(tr.mapping.map(state.selection.from))
    let d = $cell.depth
    while (d > 0 && $cell.node(d).type.name !== 'table') d--
    const table = $cell.node(d)
    const start = $cell.start(d)
    const map = TableMap.get(table)
    for (let r = 0; r < map.height; r++) {
      const pos = start + map.map[r * map.width + col]
      const cell = tr.doc.nodeAt(pos)
      if (cell && cell.attrs.alignment !== null) tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment: null })
    }
    // The caret goes into the new column, in its row.
    const row = map.findCell($cell.before(d + 2) - start).top
    tr.setSelection(TextSelection.near(tr.doc.resolve(start + map.map[row * map.width + col] + 1)))
    dispatch(tr)
  })
}

const TABLE_EDITS: Record<TableEdit, (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean> = {
  addRow,
  addColumn,
  // The header row stays: a Markdown table cannot be without it.
  deleteRow: (state, dispatch) => !tableAround(state)?.inHeader && deleteRow(state, dispatch),
  deleteColumn,
}

export function tableReport(view: EditorView): InPlaceTable | null {
  if (!view.hasFocus()) return null
  const around = tableAround(view.state)
  if (!around) return null
  const dom = view.nodeDOM(around.pos) as HTMLElement | null
  const r = dom?.getBoundingClientRect?.()
  if (!r) return null
  const can = Object.fromEntries((Object.keys(TABLE_EDITS) as TableEdit[]).map(e => [e, TABLE_EDITS[e](view.state)])) as Record<TableEdit, boolean>
  return { box: { top: r.top, right: r.right }, can }
}

export function editTable(view: EditorView, edit: TableEdit): boolean {
  const done = TABLE_EDITS[edit](view.state, tr => view.dispatch(tr.scrollIntoView()))
  view.focus()
  return done
}
