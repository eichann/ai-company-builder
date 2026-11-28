// 「AI に直してもらう」 behind the in-place door (files-and-editor.md "Asking the AI to fix a passage"):
// the passage the AI is handed (the top-level blocks holding the selection, from the write-back's own
// source offsets), the place under it where the fix is shown (a widget: never part of the text), and
// the fix put in as the editor's own change — so the write-back writes only the changed lines and
// refuses what it cannot write faithfully.
import { Plugin, PluginKey, Selection } from '@milkdown/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'
import type { Node as PMNode } from '@milkdown/prose/model'
import { $prose } from '@milkdown/utils'
import type { SplicedDocument } from './markdownSplice'
import type { InPlaceFixPreview, InPlacePassage } from './inPlaceEditing'
import { changedLines, contextAround } from '../../../shared/inline-fix'
import { splitFront } from './markdownSplice'

const belowKey = new PluginKey<DecorationSet>('acb-ai-fix-below')

/** The place under a passage where its fix is shown (moved along with edits around it). */
export const fixBelowPlugin = $prose(() => new Plugin<DecorationSet>({
  key: belowKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(belowKey) as { pos: number; element: HTMLElement | null } | undefined
      if (meta) {
        return meta.element
          ? DecorationSet.create(tr.doc, [Decoration.widget(meta.pos, meta.element, { side: -1, ignoreSelection: true, stopEvent: () => true, key: 'acb-ai-fix' })])
          : DecorationSet.empty
      }
      return set.map(tr.mapping, tr.doc)
    },
  },
  props: { decorations: state => belowKey.getState(state) },
}))

/** Where the first text of top-level node `index` can stand (inside a list or quote, deeper than its start). */
function firstTextPos(doc: PMNode, index: number): number {
  const start = nodeStart(doc, index)
  try { return start + 1 + Selection.atStart(doc.child(index)).from } catch { return start + 1 }
}

/** Addresses of the images on the internet in `nodes` (http, https, or `//host`); an image beside the document is not one. */
function remoteImages(nodes: readonly PMNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    n.descendants(d => {
      const src = d.type.name === 'image' ? String(d.attrs.src ?? '').trim() : ''
      if (/^(https?:)?\/\//i.test(src)) out.push(src)
      return true
    })
  }
  return out
}

/** Where top-level node `index` starts in `doc`. */
function nodeStart(doc: PMNode, index: number): number {
  let pos = 0
  for (let i = 0; i < index && i < doc.childCount; i++) pos += doc.child(i).nodeSize
  return pos
}

function passageOf(spliced: SplicedDocument, first: number, last: number): InPlacePassage | null {
  const found = spliced.passage(first, last)
  if (!found) return null
  const text = spliced.text
  const { before, after } = contextAround(text, found.start, found.end, splitFront(text).front.length)
  return { markdown: text.slice(found.start, found.end), before, after, at: { nodeFrom: found.nodeFrom, nodeTo: found.nodeTo, text } }
}

/** The passage holding `from`..`to` of the editor's document. */
export function selectedPassage(view: EditorView, spliced: SplicedDocument, range: { from: number; to: number } | null): InPlacePassage | null {
  if (!range || range.to > view.state.doc.content.size) return null
  const doc = view.state.doc
  const first = doc.resolve(range.from).index(0)
  let last = doc.resolve(range.to).index(0)
  // A selection ending at the very start of a block does not take that block.
  if (last > first && range.to <= firstTextPos(doc, last)) last--
  return passageOf(spliced, first, Math.min(last, doc.childCount - 1))
}

/** The passage holding file offsets `start`..`end`. */
export function passageAt(spliced: SplicedDocument, start: number, end: number): InPlacePassage | null {
  const nodes = spliced.nodesAt(start, end)
  return nodes && passageOf(spliced, nodes.first, nodes.last)
}

export function showBelow(view: EditorView, passage: InPlacePassage, element: HTMLElement | null) {
  if (view.isDestroyed) return
  const pos = Math.min(nodeStart(view.state.doc, passage.at.nodeTo), view.state.doc.content.size)
  view.dispatch(view.state.tr.setMeta(belowKey, { pos, element }).setMeta('addToHistory', false))
}

/**
 * The document with `markdown` in place of the passage, and what the write-back would write; refused
 * when the file changed since the passage was taken or the fix cannot be written faithfully.
 */
export function fixedDocument(view: EditorView, spliced: SplicedDocument, shown: PMNode | null, passage: InPlacePassage, markdown: string) {
  if (spliced.text !== passage.at.text || view.state.doc !== shown) return { ok: false as const, reason: 'changed' as const }
  // Raw HTML the passage did not have is not taken from the AI (the preview never shows it: tracking images, links).
  // Judged by the reader, not a pattern: a tag broken over lines or in capitals is HTML all the same.
  const ownHtml = new Set(spliced.rawHtml(passage.markdown))
  if (spliced.rawHtml(markdown).some(part => !ownHtml.has(part))) return { ok: false as const, reason: 'html' as const }
  // A fix that takes the passage away entirely is not a fix the card offers.
  const nodes = markdown.trim() ? spliced.read(markdown) : null
  if (!nodes || nodes.length === 0) return { ok: false as const, reason: 'unwritable' as const }
  // Nor an image on the internet the passage did not have (a planted instruction's tracking image: the document is
  // opened elsewhere too). Read as the reader reads it, so a reference-style image counts.
  const ownImages = new Set(remoteImages(spliced.read(passage.markdown) ?? []))
  if (remoteImages(nodes).some(src => !ownImages.has(src))) return { ok: false as const, reason: 'remoteImage' as const }
  const doc = view.state.doc
  const from = nodeStart(doc, passage.at.nodeFrom)
  const to = nodeStart(doc, passage.at.nodeTo)
  const tr = view.state.tr.replaceWith(from, to, nodes)
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from + nodes.reduce((n, node) => n + node.nodeSize, 0), tr.doc.content.size)), -1))
  // Two faithful ways: the AI's own Markdown over the passage, or the write-back's smallest edit (a fix
  // that rewrites a list in another bullet changes only the lines whose words changed). Fewer lines wins; a tie, the AI's.
  const own = spliced.writeSource(tr.doc, passage.at.nodeFrom, passage.at.nodeTo, markdown)
  const smallest = spliced.write(tr.doc)
  const size = (w: { text: string }) => { const c = changedLines(spliced.text, w.text); return c.removed.length + c.added.length }
  const write = own && (!smallest || size(own) <= size(smallest)) ? own : smallest
  if (!write) return { ok: false as const, reason: 'unwritable' as const }
  return { ok: true as const, tr, write }
}

export function previewFix(view: EditorView, spliced: SplicedDocument, shown: PMNode | null, passage: InPlacePassage, markdown: string): InPlaceFixPreview {
  const fixed = fixedDocument(view, spliced, shown, passage, markdown)
  if (!fixed.ok) return fixed
  const { removed, added } = changedLines(spliced.text, fixed.write.text)
  return { ok: true, removed, added }
}
