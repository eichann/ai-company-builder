// Milkdown behind the in-place door (inPlaceEditing.ts). Loaded on demand only: client/vite.config.ts
// puts this module and Milkdown in dist/vendor/ (its own budget in scripts/check-bundle-size.mjs).
// Every change goes through SplicedDocument: what it cannot write back faithfully is taken back on
// screen, so the screen never shows what the file does not hold.
import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, remarkCtx, rootCtx, serializerCtx } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey, Selection } from '@milkdown/prose/state'
import type { Node as PMNode } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import { localFileUrl } from '../../../shared/local-file-url'
import { fileVersions } from '../../shared/lib/fileVersions'
import { SplicedDocument, type MarkdownCodec, type SourceBlock } from './markdownSplice'
import { strongKeymap, emphasisKeymap, inlineCodeKeymap, headingKeymap, paragraphKeymap } from '@milkdown/preset-commonmark'
import { strikethroughKeymap } from '@milkdown/preset-gfm'
import { TextSelection } from '@milkdown/prose/state'
import type { InPlaceEngine, InPlaceOptions, InPlaceRefusal } from './inPlaceEditing'
import { selectionOf, setInPlaceLink, setInPlaceSize, toggleInPlaceMark } from './milkdownFormat'
import { droppedFiles, pastedImageFiles, placeImages } from './milkdownImages'
import { fixBelowPlugin, fixedDocument, passageAt, previewFix, selectedPassage, showBelow } from './milkdownAiFix'
import { blockMenuPlugin, blockMenuReport, closeBlockMenu, lineStartRules, REPLACED_LINE_START_RULES, editTable, tableReport, turnIntoBlock } from './milkdownBlocks'

interface MdNode { type: string; value?: unknown; alt?: unknown; children?: MdNode[]; position?: { start: { offset?: number }; end: { offset?: number } } }

function mdText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value
  if ((node.type === 'image' || node.type === 'imageReference') && typeof node.alt === 'string') return node.alt
  return (node.children ?? []).map(mdText).join('')
}

/** Milkdown's own reader and writer, as the splice needs them. */
export function milkdownCodec(ctx: Ctx): MarkdownCodec {
  const remark = ctx.get(remarkCtx)
  const tree = (md: string) => remark.parse(md) as unknown as MdNode
  return {
    blocks: (md: string): SourceBlock[] => (tree(md).children ?? []).map(c => {
      const start = c.position?.start.offset
      const end = c.position?.end.offset
      if (start === undefined || end === undefined) throw new Error('block without a position')
      return { start, end, kind: c.type }
    }),
    parse: (md: string) => ctx.get(parserCtx)(md) as PMNode,
    serialize: (doc: PMNode) => ctx.get(serializerCtx)(doc),
    visibleText: (md: string) => mdText(tree(md)),
    textblocks: (md: string) => {
      const out: Array<{ start: number; end: number }> = []
      const walk = (node: MdNode, parent: string) => {
        const textblock = ['paragraph', 'heading', 'code', 'tableCell'].includes(node.type)
          || (node.type === 'html' && !['paragraph', 'heading', 'tableCell'].includes(parent))
        if (textblock) {
          const start = node.position?.start.offset
          const end = node.position?.end.offset
          if (start === undefined || end === undefined) throw new Error('text block without a position')
          out.push({ start, end })
          return
        }
        for (const c of node.children ?? []) walk(c, node.type)
      }
      walk(tree(md), 'root')
      return out
    },
    rawHtml: (md: string) => {
      const out: string[] = []
      const walk = (node: MdNode) => {
        if (node.type === 'html' && typeof node.value === 'string') out.push(node.value)
        for (const c of node.children ?? []) walk(c)
      }
      walk(tree(md))
      return out
    },
  }
}

/** A Milkdown editor in `host` (also what the splice tests read and write with). */
export async function makeMilkdown(host: HTMLElement, configure?: (ctx: Ctx) => void, plugins: ReturnType<typeof $prose>[] = []) {
  const editor = await Editor.make()
    .config(ctx => { ctx.set(rootCtx, host); ctx.set(defaultValueCtx, ''); configure?.(ctx) })
    .use(commonmark.filter(p => !REPLACED_LINE_START_RULES.includes(p))).use(gfm.filter(p => !REPLACED_LINE_START_RULES.includes(p)))
    .use(history).use([...lineStartRules, blockMenuPlugin].flat()).use(plugins).create()
  return {
    editor,
    codec: editor.action(ctx => milkdownCodec(ctx)),
    view: (): EditorView => editor.action(ctx => ctx.get(editorViewCtx)),
    destroy: () => editor.destroy(),
  }
}

/** A company image (a relative address) is the file in the document's folder; other addresses stay as written. */
function companyImagePath(src: string, folder: string): string | null {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null
  return `${folder}/${src.replace(/^\.\//, '')}`
}

/** An image of the document: a company file follows its version (the AI may replace it), as the reading view's. */
function imageView(node: PMNode, folder: string) {
  const img = document.createElement('img')
  img.alt = String(node.attrs.alt ?? '')
  if (node.attrs.title) img.title = String(node.attrs.title)
  const src = String(node.attrs.src ?? '')
  const path = companyImagePath(src, folder)
  if (!path) { img.src = src; return { dom: img } }
  const show = () => { img.src = localFileUrl(path, fileVersions.get(path)) }
  show()
  return { dom: img, destroy: fileVersions.subscribe(show) }
}

const trackerKey = new PluginKey('acb-in-place-writer')

export const milkdownEngine: InPlaceEngine = {
  async open(host, text, options: InPlaceOptions) {
    // The splice is created after the editor (it reads with the editor's own reader); until then,
    // and while the shown document is being put back, changes are not written.
    let spliced: SplicedDocument | null = null
    let shownDoc: PMNode | null = null
    let lastText = text
    let destroyed = false
    // The selection as last shown: a box for a link's address takes the focus, the change still applies to it.
    let lastRange: { from: number; to: number } | null = null
    // An adopted AI fix: the write chosen for exactly that document (the AI's own Markdown or the smallest edit).
    let adopted: { doc: PMNode; write: NonNullable<ReturnType<SplicedDocument['write']>> } | null = null
    const reported = { selection: '', menu: '', table: '' }
    const report = <T>(kind: keyof typeof reported, value: T, tell: (v: T) => void) => {
      const key = JSON.stringify(value)
      if (key === reported[kind]) return
      reported[kind] = key
      tell(value)
    }
    const reportSelection = (view: EditorView) => {
      const shown = view.hasFocus() ? selectionOf(view) : null
      if (shown) lastRange = { from: view.state.selection.from, to: view.state.selection.to }
      report('selection', shown, options.onSelection)
      report('menu', blockMenuReport(view), options.onBlockMenu)
      report('table', tableReport(view), options.onTable)
    }
    const tracker = $prose(() => new Plugin({
      key: trackerKey,
      view: () => ({
        update(view) {
          if (spliced) reportSelection(view)
          const doc = view.state.doc
          if (!spliced || !shownDoc || doc === shownDoc) return
          // A write that throws (the editor's writer meeting a shape it cannot write) is not writable either.
          let write: ReturnType<SplicedDocument['write']> = null
          const chosen = adopted && adopted.doc === doc ? adopted.write : null
          adopted = null
          try { write = chosen ?? spliced.write(doc) } catch { write = null }
          if (write) {
            write.commit()
            shownDoc = doc
            if (write.text !== lastText) { lastText = write.text; options.onChange(write.text) }
            return
          }
          // Not writable faithfully: show the last written state again (outside this update), the caret
          // kept where it was. Not in the middle of a word being composed (Japanese input): its next
          // step tries again.
          if (view.composing) return
          const back = shownDoc
          queueMicrotask(() => {
            if (destroyed || view.isDestroyed || view.state.doc === back) return
            const at = view.state.selection.from
            const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, back.content).setMeta('addToHistory', false)
            tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size))))
            view.dispatch(tr)
            options.onChangeTakenBack()
          })
        },
      }),
    }))
    let made: Awaited<ReturnType<typeof makeMilkdown>>
    try {
      made = await makeMilkdown(host, ctx => {
        // The bubble's keys are the app's commands (shortcuts in the command catalog): Milkdown's own
        // for the same operations are off, or a key would act twice.
        ctx.set(strongKeymap.key, { ToggleBold: { shortcuts: [] } })
        ctx.set(emphasisKeymap.key, { ToggleEmphasis: { shortcuts: [] } })
        ctx.set(inlineCodeKeymap.key, { ToggleInlineCode: { shortcuts: [] } })
        ctx.set(strikethroughKeymap.key, { ToggleStrikethrough: { shortcuts: [] } })
        ctx.set(paragraphKeymap.key, { TurnIntoText: { shortcuts: [] } })
        ctx.update(headingKeymap.key, prev => ({ ...prev, TurnIntoH1: { shortcuts: [] }, TurnIntoH2: { shortcuts: [] }, TurnIntoH3: { shortcuts: [] } }))
        ctx.update(editorViewOptionsCtx, prev => ({
          ...prev,
          attributes: { class: 'markdown-body acb-in-place', spellcheck: 'false' },
          nodeViews: {
            image: (node: PMNode) => imageView(node, options.folder),
          },
          // An image pasted (⌘V) or a file dropped from Finder: kept beside the document first, then put in.
          handlePaste: (v: EditorView, e: ClipboardEvent) => {
            const files = pastedImageFiles(e.clipboardData)
            if (!spliced || files.length === 0) return false
            e.preventDefault()
            void placeImages(v, files, v.state.selection.from, options.storeImage)
            return true
          },
          handleDrop: (v: EditorView, e: DragEvent) => {
            const files = droppedFiles(e.dataTransfer)
            if (!spliced || files.length === 0) return false
            e.preventDefault()
            const at = v.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? v.state.selection.from
            void placeImages(v, files, at, options.storeImage)
            return true
          },
          handleDOMEvents: {
            focus: (v: EditorView) => { if (spliced) reportSelection(v); return false },
            blur: (v: EditorView) => { if (spliced) queueMicrotask(() => { if (!v.isDestroyed) reportSelection(v) }); return false },
            // ⌘-click opens a web link in the browser (a plain click places the caret).
            click: (_view: EditorView, e: MouseEvent) => {
              if (!(e.metaKey || e.ctrlKey)) return false
              const href = (e.target as Element | null)?.closest?.('a[href]')?.getAttribute('href') ?? ''
              if (!/^(https?:|mailto:)/i.test(href)) return false
              e.preventDefault()
              window.open(href, '_blank', 'noopener')
              return true
            },
          },
        }))
      }, [tracker, fixBelowPlugin])
    } catch {
      host.replaceChildren()
      return { ok: false, reason: 'unavailable' }
    }
    const refuse = (reason: InPlaceRefusal) => {
      destroyed = true
      void made.destroy()
      host.replaceChildren()
      return { ok: false as const, reason }
    }
    const loaded = SplicedDocument.load(text, made.codec)
    if (!loaded.ok) return refuse(loaded.reason)
    const view = made.view()
    const start = loaded.doc.doc
    if (start.childCount > 0) view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, start.content).setMeta('addToHistory', false))
    // The editor may tidy the document once as it shows it; if that changed it, do not edit here.
    if (!loaded.doc.rebase(view.state.doc)) return refuse('unreadable')
    const unchanged = loaded.doc.write(view.state.doc)
    if (!unchanged || unchanged.text !== text) return refuse('unreadable')
    spliced = loaded.doc
    shownDoc = view.state.doc
    return {
      ok: true,
      surface: {
        destroy: () => { destroyed = true; void made.destroy() },
        focus: () => { if (!view.isDestroyed) view.focus() },
        hasFocus: () => !view.isDestroyed && view.hasFocus(),
        toggleMark: mark => { if (!view.isDestroyed) toggleInPlaceMark(view, mark) },
        setLink: href => {
          if (view.isDestroyed) return
          if (!view.hasFocus() && lastRange && lastRange.to <= view.state.doc.content.size) {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, lastRange.from, lastRange.to)))
          }
          setInPlaceLink(view, href)
        },
        setSize: size => { if (!view.isDestroyed) setInPlaceSize(view, size) },
        turnInto: block => { if (!view.isDestroyed) turnIntoBlock(view, block) },
        closeBlockMenu: () => { if (!view.isDestroyed) closeBlockMenu(view) },
        editTable: edit => { if (!view.isDestroyed) editTable(view, edit) },
        // 「AI に直してもらう」 (milkdownAiFix.ts): only against what is written (a change still taken back has no passage).
        selectedPassage: () => (spliced && !view.isDestroyed && view.state.doc === shownDoc ? selectedPassage(view, spliced, lastRange) : null),
        passageAt: (start, end) => (spliced && !view.isDestroyed && view.state.doc === shownDoc ? passageAt(spliced, start, end) : null),
        showBelow: (passage, element) => showBelow(view, passage, element),
        previewFix: (passage, markdown) => (spliced && !view.isDestroyed ? previewFix(view, spliced, shownDoc, passage, markdown) : { ok: false, reason: 'changed' }),
        adoptFix: (passage, markdown) => {
          if (!spliced || view.isDestroyed) return { ok: false, reason: 'changed' }
          const preview = previewFix(view, spliced, shownDoc, passage, markdown)
          const fixed = fixedDocument(view, spliced, shownDoc, passage, markdown)
          if (!preview.ok || !fixed.ok) return preview.ok ? { ok: false, reason: 'unwritable' } : preview
          // Written by the tracker like typing, with the write chosen for exactly this document.
          adopted = { doc: fixed.tr.doc, write: fixed.write }
          view.dispatch(fixed.tr)
          adopted = null
          return view.state.doc === shownDoc ? preview : { ok: false, reason: 'unwritable' }
        },
      },
    }
  },
}
