// The selection bubble's operations on Milkdown's document (behind inPlaceEditing.ts, loaded with
// milkdownSurface.ts). Each is an ordinary editor change: it is written back like typing — only the
// changed line — or taken back when it cannot be (markdownSplice.ts).
import { toggleMark } from '@milkdown/prose/commands'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/prose/state'
import type { MarkType, Node as PMNode } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import type { InPlaceMark, InPlaceSelection, TextSize } from './inPlaceEditing'

const MARK_NAMES: Record<InPlaceMark, string> = {
  strong: 'strong',
  emphasis: 'emphasis',
  strike: 'strike_through',
  code: 'inlineCode',
}

function markType(state: EditorState, name: string): MarkType | undefined {
  return state.schema.marks[name]
}

/** Every character of the selection carries the mark (what a pressed button shows). */
function allMarked(state: EditorState, type: MarkType): boolean {
  const { from, to } = state.selection
  let any = false
  let all = true
  state.doc.nodesBetween(from, to, node => {
    if (!node.isText) return true
    any = true
    if (!type.isInSet(node.marks)) all = false
    return false
  })
  return any && all
}

/** The text block holding the whole selection, or null across blocks. */
function oneTextblock(state: EditorState): PMNode | null {
  const { $from, $to } = state.selection
  return $from.sameParent($to) && $from.parent.isTextblock ? $from.parent : null
}

/**
 * The selected line's size, offered only where a heading can stand (a top-level paragraph or heading,
 * not a list item or a table cell) and for one line (a heading is one line).
 */
function sizeOf(state: EditorState): TextSize | null {
  const block = oneTextblock(state)
  if (!block || state.selection.$from.depth !== 1) return null
  const { from, to } = state.selection
  let lines = false
  state.doc.nodesBetween(from, to, node => { if (node.type.name === 'hardbreak' || (node.isText && node.text!.includes('\n'))) lines = true })
  if (lines) return null
  if (block.type.name === 'paragraph') return 0
  return block.type.name === 'heading' && Number(block.attrs.level) <= 3 ? Number(block.attrs.level) as TextSize : null
}

/** What the bubble shows for the current selection; null when there is nothing to format. */
export function selectionOf(view: EditorView): InPlaceSelection | null {
  const { state } = view
  const sel = state.selection
  if (!(sel instanceof TextSelection) || sel.empty) return null
  if (sel.$from.parent.type.name === 'code_block') return null
  const text = state.doc.textBetween(sel.from, sel.to, '\n')
  if (!text.trim()) return null
  const start = view.coordsAtPos(sel.from)
  const end = view.coordsAtPos(sel.to)
  const marks = Object.fromEntries((Object.keys(MARK_NAMES) as InPlaceMark[]).map(m => {
    const type = markType(state, MARK_NAMES[m])
    return [m, !!type && allMarked(state, type)]
  })) as Record<InPlaceMark, boolean>
  const linkType = markType(state, 'link')
  const link = linkType ? linkType.isInSet(sel.$from.marks()) ?? linkType.isInSet(sel.$from.nodeAfter?.marks ?? []) : undefined
  const size = sizeOf(state)
  return {
    text,
    box: { left: Math.min(start.left, end.left), top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) },
    marks,
    link: link ? String(link.attrs.href ?? '') : null,
    size,
  }
}

function run(view: EditorView, command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean): boolean {
  const done = command(view.state, tr => view.dispatch(tr))
  view.focus()
  return done
}

export function toggleInPlaceMark(view: EditorView, mark: InPlaceMark): boolean {
  const type = markType(view.state, MARK_NAMES[mark])
  return !!type && run(view, toggleMark(type))
}

/** A link on the selection (`href`), or none (`null`): the words stay, only the link changes. */
export function setInPlaceLink(view: EditorView, href: string | null): boolean {
  const type = markType(view.state, 'link')
  if (!type) return false
  return run(view, (state, dispatch) => {
    const { from, to, empty } = state.selection
    if (empty) return false
    const tr = state.tr
    if (href) tr.removeMark(from, to, type).addMark(from, to, type.create({ href }))
    else {
      // The whole link goes, not a piece of it (half a link would not read back as written).
      const [a, z] = linkRange(state, type, from, to)
      tr.removeMark(a, z, type)
    }
    dispatch?.(tr)
    return true
  })
}

/** From the first to the last character of the link(s) the selection touches. */
function linkRange(state: EditorState, type: MarkType, from: number, to: number): [number, number] {
  const $from = state.doc.resolve(from)
  const parent = $from.parent
  const start = $from.start()
  let a = from
  let z = to
  parent.forEach((child, offset) => {
    const at = start + offset
    const end = at + child.nodeSize
    if (!type.isInSet(child.marks)) return
    if (end >= a && at <= z) { a = Math.min(a, at); z = Math.max(z, end) }
  })
  return [a, z]
}

/**
 * The text size of the selected line: 0 = body text, 1–3 = heading 1–3. A paragraph written over
 * several lines has only the selected line(s) changed (a heading is one line).
 */
export function setInPlaceSize(view: EditorView, size: TextSize): boolean {
  const { schema } = view.state
  const block = oneTextblock(view.state)
  // Already that size, or not a place for a heading: nothing to change (the file stays as it is).
  if (!block || sizeOf(view.state) === null || sizeOf(view.state) === size) return false
  const type = size === 0 ? schema.nodes.paragraph : schema.nodes.heading
  if (!type) return false
  return run(view, (state, dispatch) => {
    const { $from, $to } = state.selection
    const start = $from.start()
    // A line break the file holds (a soft or hard break) is one position, as is any other inline leaf.
    const text = block.textBetween(0, block.content.size, '\n', leaf => (leaf.type.name === 'hardbreak' ? '\n' : '\ufffc'))
    const lineStart = text.lastIndexOf('\n', $from.parentOffset - 1) + 1
    const lineEndAt = text.indexOf('\n', $to.parentOffset)
    const lineEnd = lineEndAt < 0 ? text.length : lineEndAt
    let tr = state.tr
    // The later line break first, so the earlier position stays where it is.
    if (lineEndAt >= 0) tr = tr.delete(start + lineEnd, start + lineEnd + 1).split(start + lineEnd)
    if (lineStart > 0) tr = tr.delete(start + lineStart - 1, start + lineStart).split(start + lineStart - 1)
    const from = tr.mapping.map(state.selection.from)
    const to = tr.mapping.map(state.selection.to, -1)
    tr.setBlockType(from, Math.max(from, to), type, size === 0 ? null : { level: size })
    tr.setSelection(TextSelection.create(tr.doc, from, Math.max(from, to)))
    dispatch?.(tr)
    return true
  })
}
