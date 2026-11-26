/**
 * The app's small piece inside a reviewed HTML document (doc-frame.md "Review in the document view"):
 * the code main runs in the view page's isolated world `REVIEW_WORLD` — its own JavaScript globals,
 * so the document's scripts can neither see nor replace it (they share the DOM only). Each call is
 * self-contained (nothing is left behind for a page to find) and answers one value, which main
 * checks (`client/shared/doc-review-frame.ts`): the document can change its DOM and selection at any
 * moment, so what comes back is untrusted.
 *
 * Marks are drawn with the CSS Custom Highlight API: the document's DOM is not changed (a page that
 * re-renders itself is not broken by them), and the colours are a constructed stylesheet the piece
 * adopts while it draws (`REVIEW_HIGHLIGHT_CSS`, kept in the isolated world's own global). Not
 * `webContents.insertCSS`: Chromium paints no `::highlight` from a user sheet (measured, Electron 45),
 * and a view closed while an `insertCSS` was pending made `close()` throw ("Render frame was disposed
 * before the request completed", the real-Electron harness). A page can restyle or remove the marks
 * on itself, which only hides them there. Only quoted text — the
 * document's own words — is ever put in; never a comment's body, a name or an id.
 */
import { DOC_REVIEW_CONTEXT_MAX, DOC_REVIEW_RAW_MAX, type DocReviewQuote } from '../../../shared/doc-review-frame'

/** The isolated world of the review piece (the scroll position uses 1001). */
export const REVIEW_WORLD = 1002

const OPEN = 'acb-review'
const RESOLVED = 'acb-review-resolved'
const FOCUS = 'acb-review-focus'

/** The marks' colours (adopted by the piece when it draws). */
export const REVIEW_HIGHLIGHT_CSS = [
  `::highlight(${OPEN}) { background-color: rgba(251, 191, 36, 0.45) !important; color: inherit !important; }`,
  `::highlight(${RESOLVED}) { background-color: rgba(134, 239, 172, 0.35) !important; color: inherit !important; }`,
  `::highlight(${FOCUS}) { background-color: rgba(245, 158, 11, 0.85) !important; color: #111 !important; }`,
].join('\n')

/**
 * The document's text without whitespace, and where each run of it starts (a text node): the same
 * walk for finding a quote as the app's `htmlReview.ts` does over the file (text of the body; not
 * scripts, styles, templates, `noscript`, text areas), so the n-th occurrence means the same here.
 */
const TEXT_INDEX = `
const ensureStyle = () => {
  let sheet = globalThis.__acbReviewSheet
  if (!sheet) {
    sheet = new CSSStyleSheet()
    sheet.replaceSync(${JSON.stringify(REVIEW_HIGHLIGHT_CSS)})
    globalThis.__acbReviewSheet = sheet
  }
  if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
}
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'TITLE'])
const squash = s => s.replace(/\\s+/g, '')
const textIndex = () => {
  const root = document.body || document.documentElement
  const runs = []
  let text = ''
  if (!root) return { runs, text }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.nodeType === 1 ? (SKIP.has(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT,
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = squash(n.data)
    if (!s) continue
    runs.push({ node: n, start: text.length })
    text += s
  }
  return { runs, text }
}
// The position (node, offset) of the k-th character without whitespace; \`after\`: just past it.
const pointAt = (runs, k, after) => {
  let lo = 0, hi = runs.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (runs[mid].start <= k) lo = mid; else hi = mid - 1 }
  const run = runs[lo]
  let left = k - run.start
  const data = run.node.data
  for (let i = 0; i < data.length; i++) {
    if (/\\s/.test(data[i])) continue
    if (left === 0) return [run.node, after ? i + 1 : i]
    left--
  }
  return [run.node, data.length]
}
// The range of a quote's n-th occurrence (the first when there are fewer), or null.
const rangeOf = (index, quote) => {
  const q = squash(quote.text)
  if (!q) return null
  let at = -1, first = -1
  for (let i = 0, from = 0; ; i++) {
    const found = index.text.indexOf(q, from)
    if (found < 0) break
    if (first < 0) first = found
    if (i === quote.nth) { at = found; break }
    from = found + 1
  }
  if (at < 0) at = first
  if (at < 0) return null
  const range = new Range()
  range.setStart(...pointAt(index.runs, at, false))
  range.setEnd(...pointAt(index.runs, at + q.length - 1, true))
  return range
}
`

/** Draws the marks (`quotes`, already checked by main); answers how many were found. */
export function drawQuotesCode(quotes: readonly DocReviewQuote[]): string {
  return `(() => {
${TEXT_INDEX}
  if (typeof CSS === 'undefined' || !CSS.highlights) return 0
  ensureStyle()
  const quotes = ${JSON.stringify(quotes)}
  const index = textIndex()
  const open = new Highlight(), resolved = new Highlight()
  let found = 0
  for (const quote of quotes) {
    const range = rangeOf(index, quote)
    if (!range) continue
    found++
    ;(quote.resolved ? resolved : open).add(range)
  }
  CSS.highlights.set('${OPEN}', open)
  CSS.highlights.set('${RESOLVED}', resolved)
  return found
})()`
}

/**
 * Finds one mark, scrolls it into the middle of the view and makes it flash: `shown`; there but not
 * drawn now (inside a closed tab or a folded part of the document): `hidden`; not in the page: `missing`.
 */
export function findQuoteCode(quote: DocReviewQuote): string {
  return `(() => {
${TEXT_INDEX}
  const range = rangeOf(textIndex(), ${JSON.stringify(quote)})
  if (!range) return 'missing'
  const holder = range.startContainer.parentElement
  const seen = holder && (typeof holder.checkVisibility !== 'function' || holder.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
  if (!seen || range.getClientRects().length === 0) return 'hidden'
  holder.scrollIntoView({ block: 'center', behavior: 'smooth' })
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    const focus = new Highlight(range)
    CSS.highlights.set('${FOCUS}', focus)
    setTimeout(() => { if (CSS.highlights.get('${FOCUS}') === focus) CSS.highlights.delete('${FOCUS}') }, 1600)
  }
  return 'shown'
})()`
}

/**
 * The member's selection: its text and up to `DOC_REVIEW_CONTEXT_MAX` characters before and after it
 * (each cut here to `DOC_REVIEW_RAW_MAX`, so a whole-page selection is not copied out), or null.
 */
export const READ_SELECTION_CODE = `(() => {
  const sel = getSelection()
  if (!sel || sel.rangeCount < 1 || sel.isCollapsed) return null
  const r = sel.getRangeAt(0)
  const text = sel.toString().slice(0, ${DOC_REVIEW_RAW_MAX})
  const root = document.body || document.documentElement
  const want = ${DOC_REVIEW_CONTEXT_MAX * 2}
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let prefix = ''
  const start = r.startContainer
  if (start.nodeType === 3) { prefix = start.data.slice(0, r.startOffset); walker.currentNode = start }
  else walker.currentNode = start.childNodes[r.startOffset] || start
  while (prefix.length < want) { const n = walker.previousNode(); if (!n) break; prefix = n.data + prefix }
  let suffix = ''
  const end = r.endContainer
  if (end.nodeType === 3) { suffix = end.data.slice(r.endOffset); walker.currentNode = end }
  else {
    const next = end.childNodes[r.endOffset]
    walker.currentNode = next || end
    if (next && next.nodeType === 3) suffix = next.data
  }
  while (suffix.length < want) { const n = walker.nextNode(); if (!n) break; suffix += n.data }
  return { text, prefix: prefix.slice(-want), suffix: suffix.slice(0, want) }
})()`
