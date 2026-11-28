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
  const block = oneTextblock(state)
  const size: TextSize | null = !block ? null
    : block.type.name === 'paragraph' ? 0
      : block.type.name === 'heading' && Number(block.attrs.level) <= 3 ? Number(block.attrs.level) as TextSize : null
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
    const tr = state.tr.removeMark(from, to, type)
    if (href) tr.addMark(from, to, type.create({ href }))
    dispatch?.(tr)
    return true
  })
}

/**
 * The text size of the selected line: 0 = body text, 1–3 = heading 1–3. A paragraph written over
 * several lines has only the selected line(s) changed (a heading is one line).
 */
export function setInPlaceSize(view: EditorView, size: TextSize): boolean {
  const { schema } = view.state
  const block = oneTextblock(view.state)
  if (!block || !['paragraph', 'heading'].includes(block.type.name)) return false
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
