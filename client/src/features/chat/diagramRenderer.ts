// Draws a reply's diagram as a picture (chat-ui-and-history.md "Diagrams in a reply"). The text comes from the AI,
// which may have read anything, so nothing in it may run or reach the network:
//   1. mermaid runs with securityLevel 'strict', no HTML labels, and none of its settings open to the text;
//   2. every SVG (mermaid's and the AI's own) is cut down to drawing elements with local references only;
//   3. the result is shown as <img src="data:image/svg+xml">: a picture never runs script or loads anything.
// mermaid (~2.8 MB) is loaded only when the first mermaid block is drawn (client/vite.config.ts puts it in dist/vendor/).
import mermaidUrl from '@mermaid-js/tiny/dist/mermaid.tiny.js?url'
import { mermaidWithoutConfig, type Diagram } from './diagrams'

export type DiagramState =
  | { status: 'drawing' }
  | { status: 'drawn'; src: string; width?: number; height?: number }
  | { status: 'failed' }

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Drawing elements only (lower case). No script, foreignObject, image, a, animate / set, iframe, feImage. */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'style', 'switch', 'symbol', 'use', 'marker', 'clippath', 'mask', 'pattern',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'lineargradient', 'radialgradient', 'stop',
  'filter', 'fegaussianblur', 'feoffset', 'feblend', 'feflood', 'fecomposite', 'femerge', 'femergenode', 'fedropshadow', 'fecolormatrix',
])

/** A url() that is not a reference inside the picture (`url(#id)`). */
const OUTSIDE_URL = /url\s*\(\s*(?!['"]?#)/i
/** CSS that could load or hide something: imports, fonts, escapes, other image functions. */
const UNSAFE_CSS = /@import|@font-face|image-set|image\s*\(|expression\s*\(|javascript:|\\/i

const unsafeCss = (css: string) => OUTSIDE_URL.test(css) || UNSAFE_CSS.test(css)

/**
 * The one `<svg>` of `markup` with only drawing elements and local references, serialised as XML;
 * null when there is no such picture. Parsed as HTML in a DOMParser document: inert (nothing runs or loads)
 * and forgiving of mermaid's HTML-serialised output.
 */
export function sanitizeSvg(markup: string): { svg: string; width?: number; height?: number } | null {
  const doc = new DOMParser().parseFromString(markup, 'text/html')
  const root = doc.body.firstElementChild
  if (!root || doc.body.children.length !== 1 || root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null
  clean(root)
  const size = intrinsicSize(root)
  if (size) {
    root.setAttribute('width', String(size.width))
    root.setAttribute('height', String(size.height))
  }
  return { svg: new XMLSerializer().serializeToString(root), ...size }
}

function clean(element: Element): void {
  for (const original of [...element.children]) {
    // A link (mermaid's `click … href`) keeps what it draws, as a plain group: a picture links nowhere.
    const child = original.namespaceURI === SVG_NS && original.localName === 'a' ? unwrapLink(original) : original
    if (child.namespaceURI !== SVG_NS || !ALLOWED_ELEMENTS.has(child.localName.toLowerCase())) child.remove()
    else clean(child)
  }
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    const value = attribute.value
    const isReference = name === 'href' || name.endsWith(':href') || name === 'src'
    if (name.startsWith('on') || (isReference && !/^#[\w:.-]*$/.test(value.trim())) ||
        OUTSIDE_URL.test(value) || (name === 'style' && unsafeCss(value))) {
      element.removeAttribute(attribute.name)
    }
  }
  if (element.localName === 'style' && unsafeCss(element.textContent ?? '')) element.remove()
}

function unwrapLink(link: Element): Element {
  const group = link.ownerDocument.createElementNS(SVG_NS, 'g')
  group.append(...link.childNodes)
  link.replaceWith(group)
  return group
}

/** The picture's own size from its viewBox (mermaid writes width="100%"), so the <img> has one. */
function intrinsicSize(root: Element): { width: number; height: number } | undefined {
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (box.length === 4 && box[2] > 0 && box[3] > 0 && box.every(Number.isFinite)) return { width: Math.ceil(box[2]), height: Math.ceil(box[3]) }
  const width = Number(root.getAttribute('width'))
  const height = Number(root.getAttribute('height'))
  return width > 0 && height > 0 ? { width, height } : undefined
}

// --- mermaid, loaded once and only when needed -------------------------------------------------------------

interface Mermaid {
  initialize(config: Record<string, unknown>): void
  render(id: string, text: string): Promise<{ svg: string }>
}

let mermaidLoad: Promise<Mermaid> | null = null
function loadMermaid(): Promise<Mermaid> {
  mermaidLoad ??= new Promise<Mermaid>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = mermaidUrl
    script.async = true
    script.onload = () => {
      const mermaid = (globalThis as { mermaid?: Mermaid }).mermaid
      if (mermaid) resolve(mermaid)
      else reject(new Error('mermaid did not load'))
    }
    script.onerror = () => { mermaidLoad = null; reject(new Error('mermaid did not load')) }
    document.head.appendChild(script)
  })
  return mermaidLoad
}

/** Settings a diagram's own text may not change (mermaid's `secure`), on top of the directives being removed. */
const SECURE_KEYS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering',
  'htmlLabels', 'flowchart', 'themeCSS', 'themeVariables', 'fontFamily', 'theme', 'darkMode', 'dompurifyConfig']

let renderCount = 0
// mermaid draws one diagram at a time (it measures text in the page).
let mermaidQueue: Promise<unknown> = Promise.resolve()

async function renderMermaid(source: string, dark: boolean): Promise<string> {
  const mermaid = await loadMermaid()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif',
    secure: SECURE_KEYS,
  })
  const id = `acb-diagram-${++renderCount}`
  try {
    return (await mermaid.render(id, mermaidWithoutConfig(source))).svg
  } finally {
    // A failed render may leave its measuring element behind.
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

async function draw(diagram: Diagram, dark: boolean): Promise<DiagramState> {
  try {
    const markup = diagram.kind === 'svg'
      ? diagram.source
      : await (mermaidQueue = mermaidQueue.catch(() => {}).then(() => renderMermaid(diagram.source, dark))) as string
    const clean = sanitizeSvg(markup)
    if (!clean) return { status: 'failed' }
    return { status: 'drawn', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean.svg)}`, width: clean.width, height: clean.height }
  } catch {
    return { status: 'failed' }
  }
}

// --- a small store for useSyncExternalStore: each diagram is drawn once and kept -------------------------------

const DRAWING: DiagramState = { status: 'drawing' }
/** Kept pictures; the oldest unwatched go past this many (a long conversation scrolls through its window). */
const KEEP = 100
const states = new Map<string, DiagramState>()
const watchers = new Map<string, Set<() => void>>()

export const diagramKey = (diagram: Diagram, dark: boolean) => `${diagram.kind}:${dark ? 'dark' : 'light'}:${diagram.source}`

export function diagramState(key: string): DiagramState {
  return states.get(key) ?? DRAWING
}

/** Watches one diagram; the first watcher starts its drawing. */
export function watchDiagram(diagram: Diagram, dark: boolean, onChange: () => void): () => void {
  const key = diagramKey(diagram, dark)
  const set = watchers.get(key) ?? new Set()
  set.add(onChange)
  watchers.set(key, set)
  if (!states.has(key)) {
    states.set(key, DRAWING)
    void draw(diagram, dark).then(state => {
      states.set(key, state)
      forgetOldest()
      for (const listener of watchers.get(key) ?? []) listener()
    })
  }
  return () => {
    set.delete(onChange)
    if (set.size === 0) watchers.delete(key)
  }
}

function forgetOldest(): void {
  for (const key of states.keys()) {
    if (states.size <= KEEP) return
    if (!watchers.has(key) && states.get(key)?.status !== 'drawing') states.delete(key)
  }
}
