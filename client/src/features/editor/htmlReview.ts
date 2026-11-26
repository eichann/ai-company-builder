/**
 * Reviewing an HTML document (doc-frame.md "Review in the document view"): the words of its file,
 * read without running anything — where a comment's quote is in the file, which occurrence of it
 * the member meant, whether it is still there (「位置不明」), and the page's text for 「変更を確認」.
 *
 * Words are compared without whitespace: the page shows `<td>前年比</td><td>120%</td>` as
 * 「前年比 120%」 while the file has no space there, and an indented file has many. The walk keeps the
 * text of the page's body as the review piece in the view does (`review-world.ts`: not scripts,
 * styles, templates, `noscript`, text areas, the title), so "the n-th occurrence" means the same
 * on both sides.
 */
import type { DocReviewQuote, DocReviewSelection } from '../../../shared/doc-review-frame'
import type { DocumentReading, QuoteFinder } from '../doc-review/model'

/** Elements whose content is not shown as the page's words. */
const HIDDEN_TEXT = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title'])
/** Elements whose content is raw text (a `<` inside does not start a tag). */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript'])
/** Elements that start a new line of the page's text (for 「変更を確認」). */
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'blockquote', 'pre', 'figure', 'figcaption', 'hr', 'br', 'body', 'details', 'summary'])
const CELLS = new Set(['td', 'th'])

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', yen: '¥', copy: '©', reg: '®', times: '×', divide: '÷',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·', bull: '•', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
}

/** The character an entity at `at` stands for and where it ends, or null (a lone `&`). */
function entityAt(html: string, at: number): { text: string; end: number } | null {
  const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(html.slice(at, at + 40))
  if (!m) return null
  const body = m[1]
  let text: string | undefined
  if (body.startsWith('#')) {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    text = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined
  } else {
    text = NAMED[body]
  }
  return text === undefined ? null : { text, end: at + m[0].length }
}

/** Where the `<template>` whose content starts at `from` ends (its closing tag), counting nested templates. */
function templateEnd(html: string, from: number): number {
  const tags = /<(\/?)template\b/gi
  tags.lastIndex = from
  let depth = 1
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[1] ? -1 : 1
    if (depth === 0) return m.index
  }
  return html.length
}

interface Visitor {
  /** A character of the page's words and where it starts in the file. */
  text(char: string, at: number): void
  /** An element starts or ends (lower-case name). */
  tag?(name: string, closing: boolean): void
}

/**
 * Walks the file's words: tags and comments left out, entities read, the content of `hiddenText`
 * elements skipped (`null`: every element's words, scripts included). Not a full HTML parser:
 * enough for the words a member can select.
 */
function walkHtml(html: string, visit: Visitor, hiddenText: ReadonlySet<string> | null): void {
  let i = 0
  const n = html.length
  while (i < n) {
    const c = html[i]
    if (c === '<') {
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4)
        i = end < 0 ? n : end + 3
        continue
      }
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(i, i + 64))
      if (!m && html[i + 1] !== '!' && html[i + 1] !== '?') {
        visit.text(c, i)
        i++
        continue
      }
      // The tag's end: the next `>` outside a quoted attribute value.
      let j = i + 1
      let quote: string | null = null
      for (; j < n; j++) {
        const d = html[j]
        if (quote) { if (d === quote) quote = null } else if (d === '"' || d === "'") quote = d
        else if (d === '>') break
      }
      i = j + 1
      if (!m) continue
      const name = m[2].toLowerCase()
      const closing = m[1] === '/'
      visit.tag?.(name, closing)
      if (!closing && RAW_TEXT.has(name)) {
        // Its end tag, found from here in any letter case without changing the file (lower-casing it
        // per element was quadratic, and 「İ」 lower-cases to two characters, shifting every index).
        const endTag = new RegExp(`</${name}(?=[\\s/>]|$)`, 'gi')
        endTag.lastIndex = i
        const close = endTag.exec(html)
        const end = close ? close.index : n
        if (!hiddenText?.has(name)) for (let k = i; k < end; k++) visit.text(html[k], k)
        i = end
      } else if (!closing && name === 'template' && hiddenText?.has('template')) {
        // A template's content is not on the page (the view's walk skips it too): to its own end, nested ones included.
        i = templateEnd(html, i)
      }
      continue
    }
    if (c === '&') {
      const entity = entityAt(html, i)
      if (entity) {
        // One file position for each UTF-16 unit (an emoji is two), so the words' indices stay in step.
        for (let k = 0; k < entity.text.length; k++) visit.text(entity.text[k], i)
        i = entity.end
        continue
      }
    }
    visit.text(c, i)
    i++
  }
}

const squash = (text: string) => text.replace(/\s+/g, '')

/** The words of the last file read, per way of reading: every comment, the finder and 位置不明 share one walk. */
const lastWords = new Map<ReadonlySet<string> | null, { html: string; words: { text: string; at: number[] } }>()

/** The page's words without whitespace, and where each character starts in the file (read once per file text). */
function wordsOf(html: string, hiddenText: ReadonlySet<string> | null = HIDDEN_TEXT): { text: string; at: number[] } {
  const kept = lastWords.get(hiddenText)
  if (kept && kept.html === html) return kept.words
  const chars: string[] = []
  const at: number[] = []
  walkHtml(html, {
    text(char, from) {
      if (/\s/.test(char)) return
      chars.push(char)
      at.push(from)
    },
  }, hiddenText)
  const words = { text: chars.join(''), at }
  lastWords.set(hiddenText, { html, words })
  return words
}

/** Every start of `quote` in `text`. */
function occurrences(text: string, quote: string): number[] {
  const found: number[] = []
  if (!quote) return found
  for (let from = text.indexOf(quote); from >= 0; from = text.indexOf(quote, from + 1)) found.push(from)
  return found
}

/** How many characters `a`'s end and `b`'s start share (`fromEnd`), or their starts. */
function shared(a: string, b: string, fromEnd: boolean): number {
  let k = 0
  while (k < a.length && k < b.length && (fromEnd ? a[a.length - 1 - k] === b[b.length - 1 - k] : a[k] === b[k])) k++
  return k
}

/** Where the file's source of a character ends (an entity is one character of the page). */
function sourceEnd(html: string, at: number): number {
  if (html[at] === '&') {
    const entity = entityAt(html, at)
    if (entity) return entity.end
  }
  return at + 1
}

/**
 * Where in the file the member's selection is (`startOffset` / `endOffset` of the stored comment,
 * as Markdown keeps where in its file): of the quote's occurrences, the one whose words before and
 * after match the selection's best (the first on a tie), or null when the file does not have it.
 */
export function anchorHtmlQuote(html: string, selection: DocReviewSelection): { start: number; end: number } | null {
  const words = wordsOf(html)
  const quote = squash(selection.text)
  const found = occurrences(words.text, quote)
  if (found.length === 0) return null
  const prefix = squash(selection.prefix)
  const suffix = squash(selection.suffix)
  let best = found[0]
  let bestScore = -1
  for (const at of found) {
    const score = shared(words.text.slice(Math.max(0, at - prefix.length), at), prefix, true)
      + shared(words.text.slice(at + quote.length, at + quote.length + suffix.length), suffix, false)
    if (score > bestScore) { best = at; bestScore = score }
  }
  return { start: words.at[best], end: sourceEnd(html, words.at[best + quote.length - 1]) }
}

/** Which occurrence of the quote a comment is on: the one starting at (or nearest) its `startOffset`; 0 when none. */
export function htmlQuoteNth(html: string, quote: string, startOffset: number): number {
  const words = wordsOf(html)
  const found = occurrences(words.text, squash(quote))
  let nth = 0
  let distance = Infinity
  found.forEach((at, i) => {
    const d = Math.abs(words.at[at] - startOffset)
    if (d < distance) { distance = d; nth = i }
  })
  return nth
}

/**
 * 「位置不明」 for an HTML document: the quote is still among the file's words — scripts' too (a
 * chart's labels are written in its script), not styles.
 */
const STYLES_ONLY: ReadonlySet<string> = new Set(['style'])

export const htmlQuoteFinder: QuoteFinder = html => {
  const { text } = wordsOf(html, STYLES_ONLY)
  return quote => text.includes(squash(quote))
}

/** The page's words a line per block (paragraph, heading, row…), for 「変更を確認」: words to compare, not tags. */
export function htmlReadableText(html: string): string {
  let out = ''
  let skipping: string | null = null
  walkHtml(html, {
    text(char) {
      // A line break in the file is a space on the page: only blocks start a new line.
      if (!skipping) out += /\s/.test(char) ? ' ' : char
    },
    tag(name, closing) {
      if (name === 'head') skipping = closing ? null : 'head'
      if (BLOCKS.has(name)) out += '\n'
      else if (CELLS.has(name) && !closing) out += ' | '
    },
  }, HIDDEN_TEXT)
  return out.split('\n').map(line => line.replace(/\s+/g, ' ').replace(/^ \| /, '').trim()).filter(Boolean).join('\n')
}

/** What the view draws for a review: each shown comment's quote, its occurrence and resolved mark, and the comment ids in that order. */
export function htmlReviewMarks(html: string, comments: ReadonlyArray<{ id: string; selectedText: string; startOffset: number; resolved: boolean; orphaned?: boolean }>): { quotes: DocReviewQuote[]; ids: string[] } {
  const shown = comments.filter(c => !c.orphaned && c.selectedText.trim())
  return {
    quotes: shown.map(c => ({ text: c.selectedText, nth: htmlQuoteNth(html, c.selectedText, c.startOffset), resolved: c.resolved })),
    ids: shown.map(c => c.id),
  }
}

/**
 * How an HTML document is read for its review: quotes found among its page's words, and the snapshot a
 * completed review keeps is its readable text (`htmlReadableText`) — what 「変更を確認」 compares — not
 * the HTML (owner decision 2026-11-26: embedded images would put megabytes into the sidecar).
 */
export const htmlReading: DocumentReading = { findQuote: htmlQuoteFinder, snapshotOf: htmlReadableText }
