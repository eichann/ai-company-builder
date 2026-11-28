// A rich reply's HTML (chat-ui-and-history.md "Rich replies"), cut down to an allowlist before the chat draws it in
// its closed frame. The text is the AI's, which may have read a planted instruction: nothing kept may run, load,
// send, or leave the reply's box. Elements and attributes go through the shared walk (markupCleaning.ts); CSS is
// read by the browser's own parser (escapes undone) and only listed properties with safe values are written back.
// A piece still being written (unclosed tags, a cut-off attribute or rule) is cleaned the same way: the HTML and CSS
// parsers close what is open, and a tag cut inside an attribute is not an element at all.
import { HTML_NS, SVG_NS, cleanTree, cssLoadsOrRuns, parseInert, type CleaningRules, type ElementFate } from './markupCleaning'
import { sanitizeSvg } from './svgCleaning'

export interface CleanReplyHtml {
  /** The cleaned markup (a body's inside), for the reply's frame. */
  html: string
  /** The reply's own CSS, cleaned; safe inside a <style> element (it holds no `<`). */
  css: string
}

const NOTHING: CleanReplyHtml = { html: '', css: '' }

// --- elements and attributes ----------------------------------------------------------------------------------

/** Kept (lower case). Anything not here and not in REMOVED_WITH_CONTENT keeps its words only (unwrapped). */
const ALLOWED_ELEMENTS = new Set([
  'div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup', 'code', 'pre', 'kbd', 'q', 'abbr', 'time',
  'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'aside', 'main',
  'details', 'summary', 'img',
  // Owner decision 2026-11-28: tabs and toggles without a script (radio / checkbox + label), and web links.
  'input', 'label', 'a',
])
/** Removed with everything inside: what runs, loads, asks for input, sends, or changes the page. */
const REMOVED_WITH_CONTENT = new Set([
  'script', 'noscript', 'template', 'style', 'link', 'meta', 'base', 'title', 'head', 'xmp', 'noembed', 'noframes',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe',
  'form', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output', 'fieldset', 'selectedcontent',
  'audio', 'video', 'source', 'track', 'picture', 'canvas', 'map', 'area', 'dialog', 'slot',
])
/** Attributes any kept element may have. Everything else (on*, src, srcset, id, tabindex, autofocus, popover, …) goes. */
const GLOBAL_ATTRIBUTES = new Set(['class', 'style', 'title', 'lang', 'dir', 'role', 'aria-label', 'aria-hidden'])
const ELEMENT_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  ol: new Set(['start', 'reversed', 'type']),
  details: new Set(['open']),
  time: new Set(['datetime']),
  input: new Set(['type', 'name', 'id', 'checked', 'value']),
  label: new Set(['for']),
  a: new Set(['href']),
}
/** The only inputs kept: nothing can be typed, sent or loaded with them (type=image loads, text takes words). */
const KEPT_INPUT_TYPES = new Set(['radio', 'checkbox'])
/** A name an input or label uses to find its pair (no spaces, quotes or brackets). */
const PLAIN_NAME = /^[A-Za-z][\w-]{0,63}$/
/** The only picture the AI may write: one inside the reply (no address to load). */
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i

/** A link's address when it is an http(s) page (written back as the browser reads it), else null. */
function webLink(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

const HTML_RULES: CleaningRules = {
  element(element): ElementFate {
    const name = element.localName.toLowerCase()
    // A picture in the reply: cut by the diagrams' own cleaner and shown as an image (it never runs or loads).
    if (element.namespaceURI === SVG_NS && name === 'svg') return svgAsImage(element)
    if (element.namespaceURI !== HTML_NS || REMOVED_WITH_CONTENT.has(name)) return 'remove'
    if (name === 'input') return KEPT_INPUT_TYPES.has((element.getAttribute('type') ?? '').trim().toLowerCase()) ? 'keep' : 'remove'
    if (name === 'img') return keptImage(element) ? 'keep' : 'remove'
    // A link to anything but a web page (javascript:, data:, a file) keeps its words, not itself.
    if (name === 'a') return webLink(element.getAttribute('href') ?? '') ? 'keep' : 'unwrap'
    return ALLOWED_ELEMENTS.has(name) ? 'keep' : 'unwrap'
  },
  attribute(element, name, value) {
    const tag = element.localName.toLowerCase()
    if (!GLOBAL_ATTRIBUTES.has(name) && !ELEMENT_ATTRIBUTES[tag]?.has(name)) return null
    if (name === 'style') return cleanDeclarations((element as HTMLElement).style) || null
    if (tag === 'a' && name === 'href') return webLink(value)
    if (name === 'id' || name === 'for' || name === 'name') return PLAIN_NAME.test(value) ? value : null
    if (name === 'type' && tag === 'input') return value.trim().toLowerCase()
    if (name === 'colspan' || name === 'rowspan' || name === 'span' || name === 'start') return /^\d{1,4}$/.test(value.trim()) ? value.trim() : null
    return value
  },
}

/**
 * A picture cut by the diagrams' cleaner, as an image address in one spelling (so a reply cleaned twice reads the
 * same); null when nothing is left, or when what is left is not well-formed (an attribute name XML cannot hold).
 */
function pictureOf(markup: string): { src: string; width?: number; height?: number } | null {
  const picture = sanitizeSvg(markup)
  if (!picture || new DOMParser().parseFromString(picture.svg, 'image/svg+xml').getElementsByTagName('parsererror').length) return null
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(picture.svg)}`, width: picture.width, height: picture.height }
}

/**
 * Whether an <img> the AI wrote stays: a picture written into the reply (a raster one base64, an SVG one cleaned).
 */
function keptImage(image: Element): boolean {
  const src = image.getAttribute('src') ?? ''
  if (INLINE_IMAGE.test(src)) return true
  const svg = /^data:image\/svg\+xml(?:;charset=utf-8)?,/i.exec(src)
  if (!svg) return false
  let markup: string
  try {
    markup = decodeURIComponent(src.slice(svg[0].length))
  } catch {
    return false
  }
  const picture = pictureOf(markup)
  if (!picture) return false
  image.setAttribute('src', picture.src)
  return true
}

function svgAsImage(svg: Element): ElementFate {
  const picture = pictureOf(svg.outerHTML)
  if (!picture) return 'remove'
  const image = svg.ownerDocument.createElementNS(HTML_NS, 'img') as HTMLImageElement
  image.setAttribute('src', picture.src)
  image.setAttribute('alt', (svg.getAttribute('aria-label') ?? svg.querySelector('title')?.textContent ?? '').trim())
  if (picture.width) image.setAttribute('width', String(picture.width))
  if (picture.height) image.setAttribute('height', String(picture.height))
  const className = svg.getAttribute('class')
  if (className) image.setAttribute('class', className)
  const style = svg.getAttribute('style')
  if (style) {
    image.setAttribute('style', style)
    const kept = cleanDeclarations(image.style)
    if (kept) image.setAttribute('style', kept)
    else image.removeAttribute('style')
  }
  return { replace: image, clean: false }
}

// --- CSS ------------------------------------------------------------------------------------------------------

/** Properties kept: the name itself or a longhand of it (`border` keeps `border-top-width`). Layout, colour, type, motion. */
const CSS_PROPERTIES = [
  'color', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat',
  'background-clip', 'background-origin', 'opacity', 'border', 'outline', 'box-shadow', 'box-sizing',
  'margin', 'padding', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio',
  'display', 'flex', 'grid', 'gap', 'row-gap', 'column-gap', 'align', 'justify', 'place', 'order',
  'position', 'top', 'right', 'bottom', 'left', 'z-index', 'overflow', 'transform', 'vertical-align', 'float', 'clear',
  'object-fit', 'object-position',
  'font-size', 'font-weight', 'font-style', 'font-family', 'font-variant', 'font-feature-settings',
  'line-height', 'letter-spacing', 'word-spacing', 'text', 'white-space', 'word-break', 'overflow-wrap', 'hyphens',
  'list-style-type', 'list-style-position', 'counter-reset', 'counter-increment', 'content',
  'caption-side', 'table-layout', 'empty-cells', 'color-scheme', 'accent-color', 'fill', 'stroke', 'stroke-width',
  // Owner decision 2026-11-28: light motion (never endless: see cleanDeclarations).
  'animation', 'transition',
]
const allowedProperty = (name: string) =>
  name.startsWith('--') || CSS_PROPERTIES.some(base => name === base || name.startsWith(`${base}-`))

/**
 * A value that loads, runs or breaks out of the <style> it goes into, read after the browser's parser (custom
 * properties keep their escapes as written, which cssLoadsOrRuns refuses). In a live document no url() is kept, not
 * even `url(#id)`.
 */
const LIVE_UNSAFE_VALUE = /url\s*\(|cross-fade|element\s*\(|paint\s*\(|src\s*\(|attr\s*\(|</i
const unsafeValue = (value: string) => cssLoadsOrRuns(value) || LIVE_UNSAFE_VALUE.test(value)
/** The screen's size (vh, vw, dvh, …): a reply has no screen of its own. */
const VIEWPORT_UNIT = /\d(?:[dsl]?v(?:h|w|min|max|i|b))\b/i
/** fixed / sticky would leave the reply's box (cover the app). */
const KEPT_POSITION = /^(?:static|relative|absolute)$/i
/** Selectors that reach outside the reply's own markup, or a `<` that could end the <style>. */
const OUTSIDE_SELECTOR = /:host|::slotted|::part|:root|\bhtml\b|\bbody\b|::backdrop|:fullscreen|::view-transition|</i
/** Motion stops: at most this many runs, each at most this long (owner decision: no endless motion). */
const MAX_RUNS = 10
const MAX_SECONDS = 10

const listOf = (value: string) => value.split(',').map(part => part.trim())
const fewRuns = (value: string) => listOf(value).every(run => /^\d+(?:\.\d+)?$/.test(run) && Number(run) <= MAX_RUNS)
const shortTimes = (value: string) => listOf(value).every(time => {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/i.exec(time)
  return !!match && Number(match[1]) / (match[2].toLowerCase() === 'ms' ? 1000 : 1) <= MAX_SECONDS
})

function keptDeclaration(name: string, value: string): boolean {
  if (!value || !allowedProperty(name) || unsafeValue(value) || VIEWPORT_UNIT.test(value)) return false
  if (name === 'position') return KEPT_POSITION.test(value)
  if (name === 'animation-iteration-count') return fewRuns(value)
  if (name === 'animation-duration' || name === 'transition-duration') return shortTimes(value)
  if (name === 'content') return /^(?:none|normal|"[^"\\]*"|'[^'\\]*')$/.test(value)
  return true
}

function cleanDeclarations(style: CSSStyleDeclaration): string {
  const kept: string[] = []
  for (let i = 0; i < style.length; i++) {
    const name = style[i]
    const value = style.getPropertyValue(name).trim()
    if (keptDeclaration(name, value)) kept.push(`${name}: ${value}${style.getPropertyPriority(name) ? ' !important' : ''}`)
  }
  return kept.join('; ')
}

/** Style rules, @media / @supports around them and @keyframes; every other at-rule (@import, @font-face, …) goes. */
function cleanRules(rules: CSSRuleList): string {
  let out = ''
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      // Nested rules inside a style rule are not written back: only its own declarations.
      if (OUTSIDE_SELECTOR.test(rule.selectorText)) continue
      const body = cleanDeclarations(rule.style)
      if (body) out += `${rule.selectorText} { ${body} }\n`
    } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
      const inner = cleanRules(rule.cssRules)
      if (inner && !unsafeValue(rule.conditionText)) out += `${rule instanceof CSSMediaRule ? '@media' : '@supports'} ${rule.conditionText} {\n${inner}}\n`
    } else if (rule instanceof CSSKeyframesRule) {
      let frames = ''
      for (const frame of Array.from(rule.cssRules) as CSSKeyframeRule[]) {
        const body = cleanDeclarations(frame.style)
        if (body) frames += `${frame.keyText} { ${body} }\n`
      }
      if (frames && /^[A-Za-z_][\w-]*$/.test(rule.name)) out += `@keyframes ${rule.name} {\n${frames}}\n`
    }
  }
  return out
}

/** A <style> element's text through the browser's CSS parser (a constructed sheet loads nothing, @import included). */
function cleanStyleSheet(css: string): string {
  const sheet = new CSSStyleSheet()
  try {
    sheet.replaceSync(css.replace(/@import/gi, '@x-import'))
  } catch {
    return ''
  }
  return cleanRules(sheet.cssRules)
}

// --- the whole piece ------------------------------------------------------------------------------------------

/**
 * The AI's HTML with only allowlisted elements, attributes and CSS; parsed inert (nothing loads or runs while it is
 * cut). Anything that goes wrong gives nothing rather than something half cleaned.
 */
export function sanitizeReplyHtml(markup: string): CleanReplyHtml {
  try {
    const doc = parseInert(markup)
    const body = doc.body
    // `<frameset>` first takes the body's place: such a piece has nothing to show.
    if (!body || body.localName !== 'body') return NOTHING
    // The reply's own <style>s, wherever the parser put them (the head too); not a picture's own (svgCleaning keeps those).
    const css = [...doc.getElementsByTagNameNS(HTML_NS, 'style')]
      .filter(style => !style.closest('svg, math'))
      .map(style => cleanStyleSheet(style.textContent ?? ''))
      .join('')
    cleanTree(body, HTML_RULES)
    return { html: body.innerHTML, css }
  } catch {
    return NOTHING
  }
}
