// An image pasted or dropped into Milkdown's document (behind inPlaceEditing.ts, loaded with
// milkdownSurface.ts; files-and-editor.md "Images in a document"). The file is kept first (main names
// and places it beside the document); then the image goes in as one line of its own, written back
// like typing (markdownSplice.ts): `![](images/…)` and nothing around it.
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

/**
 * The files a paste brings as images, or none. Only when the clipboard holds no text: Word, Excel and
 * web pages put a picture of the copied words beside them, and pasting words must stay words.
 */
export function pastedImageFiles(data: DataTransfer | null): File[] {
  if (!data || data.getData('text/plain').trim() !== '') return []
  return [...data.files].filter(f => f.type.startsWith('image/'))
}

/** The files a drop from Finder brings (each judged when kept: a non-image is refused with a sentence). */
export function droppedFiles(data: DataTransfer | null): File[] {
  return data ? [...data.files] : []
}

/**
 * Puts the image at `address` in at `pos`: into the empty line holding it, else as a new line right
 * after the top-level block holding it. The caret goes after the image. Answers where a next image goes.
 */
export function insertImage(view: EditorView, address: string, pos: number): number {
  const { state } = view
  const s = state.schema
  const image = s.nodes.image.create({ src: address, alt: '', title: '' })
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)))
  const tr = state.tr
  let after: number
  if ($pos.depth === 1 && $pos.parent.type === s.nodes.paragraph && $pos.parent.content.size === 0) {
    tr.insert($pos.start(), image)
    tr.setSelection(TextSelection.create(tr.doc, $pos.start() + image.nodeSize))
    after = $pos.start() + image.nodeSize + 1
  } else {
    const at = $pos.depth >= 1 ? $pos.after(1) : $pos.pos
    const line = s.nodes.paragraph.create(null, image)
    tr.insert(at, line)
    tr.setSelection(TextSelection.create(tr.doc, at + 1 + image.nodeSize))
    after = at + line.nodeSize
  }
  view.dispatch(tr.scrollIntoView())
  return after
}

/**
 * Keeps each file (`store`, one at a time, in order) and puts each kept image in, one line each,
 * starting at `pos` — or at the caret, when the document changed while a file was being kept.
 */
export async function placeImages(view: EditorView, files: File[], pos: number, store: (file: File) => Promise<string | null>): Promise<void> {
  let at = pos
  let doc = view.state.doc
  for (const file of files) {
    const address = await store(file)
    if (view.isDestroyed) return
    if (!address) continue
    if (view.state.doc !== doc) at = view.state.selection.from
    at = insertImage(view, address, at)
    doc = view.state.doc
  }
}
