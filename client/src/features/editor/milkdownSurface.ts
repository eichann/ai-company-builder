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
import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { Node as PMNode } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import { localFileUrl } from '../../../shared/local-file-url'
import { SplicedDocument, type MarkdownCodec, type SourceBlock } from './markdownSplice'
import type { InPlaceEngine, InPlaceOptions, InPlaceRefusal } from './inPlaceEditing'

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
  }
}

/** A Milkdown editor in `host` (also what the splice tests read and write with). */
export async function makeMilkdown(host: HTMLElement, configure?: (ctx: Ctx) => void, plugins: ReturnType<typeof $prose>[] = []) {
  const editor = await Editor.make()
    .config(ctx => { ctx.set(rootCtx, host); ctx.set(defaultValueCtx, ''); configure?.(ctx) })
    .use(commonmark).use(gfm).use(history).use(plugins).create()
  return {
    editor,
    codec: editor.action(ctx => milkdownCodec(ctx)),
    view: (): EditorView => editor.action(ctx => ctx.get(editorViewCtx)),
    destroy: () => editor.destroy(),
  }
}

/** A company image (a relative address) is read from the document's folder; nothing else is fetched. */
function imageSource(src: string, folder: string): string {
  if (!src || /^(data:|local-file:)/i.test(src)) return src
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return src
  return localFileUrl(`${folder}/${src.replace(/^\.\//, '')}`)
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
    const tracker = $prose(() => new Plugin({
      key: trackerKey,
      view: () => ({
        update(view) {
          const doc = view.state.doc
          if (!spliced || !shownDoc || doc === shownDoc) return
          const write = spliced.write(doc)
          if (write) {
            write.commit()
            shownDoc = doc
            if (write.text !== lastText) { lastText = write.text; options.onChange(write.text) }
            return
          }
          // Not writable faithfully: show the last written state again (outside this update).
          const back = shownDoc
          queueMicrotask(() => {
            if (destroyed || view.isDestroyed) return
            view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, back.content).setMeta('addToHistory', false))
            options.onChangeTakenBack()
          })
        },
      }),
    }))
    let made: Awaited<ReturnType<typeof makeMilkdown>>
    try {
      made = await makeMilkdown(host, ctx => {
        ctx.update(editorViewOptionsCtx, prev => ({
          ...prev,
          attributes: { class: 'markdown-body acb-in-place', spellcheck: 'false' },
          nodeViews: {
            image: (node: PMNode) => {
              const img = document.createElement('img')
              img.src = imageSource(String(node.attrs.src ?? ''), options.folder)
              img.alt = String(node.attrs.alt ?? '')
              if (node.attrs.title) img.title = String(node.attrs.title)
              return { dom: img }
            },
          },
          handleDOMEvents: {
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
      }, [tracker])
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
      },
    }
  },
}
