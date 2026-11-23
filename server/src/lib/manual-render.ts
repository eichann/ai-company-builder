/**
 * One page of the user manual (取説) or of the administrator guide (管理者・FDE の手引き):
 * Markdown → a whole, static HTML page (`src/cli/build-manual.ts` runs it when the server
 * image is built; `.claude/rules/server.md` "The user manual", "The administrator guide").
 *
 * What the page can carry is decided here, not by who wrote the Markdown:
 * - raw HTML in the Markdown is dropped (remark-rehype without
 *   `allowDangerousHtml`), and the result goes through rehype-sanitize's
 *   GitHub schema: no script, style, iframe, form, event attribute or
 *   `javascript:` link survives;
 * - a link is another page (`other.md`, `./other.md#見出し` → `other.html…`;
 *   it must exist), an anchor of this page, or an `http(s)://` / `mailto:`
 *   address; anything else stops the build;
 * - a picture is `../images/<name>.png|jpg|jpeg|webp` (the agreed source
 *   layout), written as `images/<name>` in the flat site; any other picture
 *   (a web address included) stops the build.
 * Headings get ids (rehype-slug) so the app can open a page at a heading.
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSlug from 'rehype-slug'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { isManualFilePath, isManualPageId, manualPageFile } from '../../shared/core/manual'

/** A hast node, as far as this file looks at it. */
interface HNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HNode[]
}

export interface RenderedManualPage {
  title: string
  html: string
  /** The pictures it shows (`images/<name>`), for the build to copy. */
  images: string[]
}

export class ManualBuildError extends Error {}


// GitHub's schema, except heading ids are kept as written (no `user-content-` prefix): the app
// opens a page at a heading by that id.
const SCHEMA = { ...defaultSchema, clobber: [] as string[] }

function walk(node: HNode, visit: (n: HNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function textOf(node: HNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

const PAGE_LINK = /^(?:\.\/)?([a-z0-9][a-z0-9-]*)\.md(#.*)?$/
const IMAGE_SOURCE = /^\.\.\/images\/([^/]+)$/

/** `../images/x.png` → `images/x.png`, links to pages → `.html`; anything else is a build error. */
function rewriteReferences(pageId: string, knownPages: ReadonlySet<string>, images: Set<string>) {
  return () => (tree: HNode) => {
    walk(tree, node => {
      if (node.type !== 'element') return
      if (node.tagName === 'a') {
        const href = String(node.properties?.href ?? '')
        if (href.startsWith('#') || /^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return
        const page = PAGE_LINK.exec(href)
        if (!page || !knownPages.has(page[1])) throw new ManualBuildError(`${pageId}.md: a link that is not a page of this site: ${href}`)
        node.properties!.href = manualPageFile(page[1]) + (page[2] ?? '')
      }
      if (node.tagName === 'img') {
        const src = String(node.properties?.src ?? '')
        const image = IMAGE_SOURCE.exec(src)
        const target = image ? `images/${image[1]}` : null
        if (!target || !isManualFilePath(target)) throw new ManualBuildError(`${pageId}.md: a picture outside ../images/ (or of another type): ${src}`)
        node.properties!.src = target
        node.properties!.loading = 'lazy'
        images.add(target)
      }
    })
  }
}

const el = (tagName: string, properties: Record<string, unknown>, children: HNode[] = []): HNode =>
  ({ type: 'element', tagName, properties, children })
const text = (value: string): HNode => ({ type: 'text', value })

/**
 * Renders `markdown` (the page `pageId`) into a whole HTML document. `siteTitle` is the site's
 * name in each page's `<title>` (the members' manual or the administrator guide: `manual-build.ts`
 * `MANUAL_SITES`).
 */
export function renderManualPage(pageId: string, markdown: string, knownPages: ReadonlySet<string>, siteTitle: string): RenderedManualPage {
  if (!isManualPageId(pageId)) throw new ManualBuildError(`not a page name (a-z, 0-9, -): ${pageId}`)
  const images = new Set<string>()
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rewriteReferences(pageId, knownPages, images))
    // Last: whatever came before, only the schema's elements, attributes and protocols are written.
    .use(rehypeSanitize, SCHEMA)
    .use(rehypeStringify)
  const body = processor.runSync(processor.parse(markdown)) as unknown as HNode
  let title = ''
  walk(body, node => { if (!title && node.type === 'element' && node.tagName === 'h1') title = textOf(node).trim() })
  title ||= pageId
  const nav = pageId === 'index' ? [] : [el('nav', {}, [el('a', { href: manualPageFile('index') }, [text('← 目次')])])]
  const page: HNode = {
    type: 'root',
    children: [
      { type: 'doctype' },
      el('html', { lang: 'ja' }, [
        el('head', {}, [
          el('meta', { charSet: 'utf-8' }),
          el('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
          el('meta', { name: 'referrer', content: 'no-referrer' }),
          el('title', {}, [text(title === siteTitle ? title : `${title} — ${siteTitle}`)]),
          el('link', { rel: ['stylesheet'], href: 'manual.css' }),
        ]),
        el('body', {}, [...nav, el('main', {}, body.children ?? [])]),
      ]),
    ],
  }
  const html = unified().use(rehypeStringify).stringify(page as never)
  return { title, html, images: [...images].sort() }
}
