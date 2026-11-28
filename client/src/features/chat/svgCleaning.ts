// A reply's picture (chat-ui-and-history.md "Diagrams in a reply"): the one <svg> cut down to drawing elements with
// local references only, by the shared walk (markupCleaning.ts). Its callers show it as <img src="data:image/svg+xml">.
import { SVG_NS, cleanTree, cssLoadsOrRuns, isLocalReference, OUTSIDE_URL, parseInert, type CleaningRules } from './markupCleaning'

/** Drawing elements only (lower case). No script, foreignObject, image, a, animate / set, iframe, feImage. */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'style', 'switch', 'symbol', 'use', 'marker', 'clippath', 'mask', 'pattern',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'lineargradient', 'radialgradient', 'stop',
  'filter', 'fegaussianblur', 'feoffset', 'feblend', 'feflood', 'fecomposite', 'femerge', 'femergenode', 'fedropshadow', 'fecolormatrix',
])
/** More `<use>` than this is not drawn: copies of copies can make one small picture cost the renderer seconds. */
const MAX_USES = 200

const SVG_RULES: CleaningRules = {
  element(child) {
    // A link (mermaid's `click … href`) keeps what it draws, as a plain group: a picture links nowhere.
    if (child.namespaceURI === SVG_NS && child.localName === 'a') {
      const group = child.ownerDocument.createElementNS(SVG_NS, 'g')
      group.append(...child.childNodes)
      return { replace: group, clean: true }
    }
    return child.namespaceURI === SVG_NS && ALLOWED_ELEMENTS.has(child.localName.toLowerCase()) ? 'keep' : 'remove'
  },
  attribute(_element, name, value) {
    const isReference = name === 'href' || name.endsWith(':href') || name === 'src'
    if ((isReference && !isLocalReference(value)) || OUTSIDE_URL.test(value) || (name === 'style' && cssLoadsOrRuns(value))) return null
    return value
  },
  finish: element => !(element.localName === 'style' && cssLoadsOrRuns(element.textContent ?? '')),
}

/**
 * The one `<svg>` of `markup` with only drawing elements and local references, serialised as XML;
 * null when there is no such picture. Parsed as HTML in a DOMParser document: inert (nothing runs or loads)
 * and forgiving of mermaid's HTML-serialised output.
 */
export function sanitizeSvg(markup: string): { svg: string; width?: number; height?: number } | null {
  const doc = parseInert(markup)
  const root = doc.body.firstElementChild
  if (!root || doc.body.children.length !== 1 || root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null
  cleanTree(root, SVG_RULES)
  if (root.getElementsByTagNameNS(SVG_NS, 'use').length > MAX_USES) return null
  const size = intrinsicSize(root)
  if (size) {
    root.setAttribute('width', String(size.width))
    root.setAttribute('height', String(size.height))
  }
  return { svg: new XMLSerializer().serializeToString(root), ...size }
}

/** The picture's own size from its viewBox (mermaid writes width="100%"), so the <img> has one. */
function intrinsicSize(root: Element): { width: number; height: number } | undefined {
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (box.length === 4 && box[2] > 0 && box[3] > 0 && box.every(Number.isFinite)) return { width: Math.ceil(box[2]), height: Math.ceil(box[3]) }
  const width = Number(root.getAttribute('width'))
  const height = Number(root.getAttribute('height'))
  return width > 0 && height > 0 ? { width, height } : undefined
}
