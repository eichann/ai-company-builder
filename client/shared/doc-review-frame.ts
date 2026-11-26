/**
 * Reviewing an HTML document shown in its own view (doc-frame.md "Review in the document view"):
 * what crosses between the app and the small piece main puts into the view. The piece runs in an
 * isolated world of the view's page (the document's scripts cannot see or replace it); main asks it
 * for the member's selection after a real mouse or key release and has it draw the comments' marks.
 * Nothing the document's own scripts do sends anything: main pulls, and everything that comes back
 * is untrusted (the document can change its own DOM and selection at any time) — checked here.
 *
 * Only quoted text goes into the view (the document's own words), never a comment's body, a name or
 * an id, so a document cannot read the review.
 */

/** What the member selected in the document: the text and a few characters around it (to find the place again). */
export interface DocReviewSelection {
  text: string
  prefix: string
  suffix: string
}

/** One comment's mark: its quoted text, which occurrence of it (0-based), and whether it is resolved. */
export interface DocReviewQuote {
  text: string
  nth: number
  resolved: boolean
}

/** What the view does for the review: report selections (only while reviewing) and draw these marks. */
export interface DocViewReview {
  selecting: boolean
  quotes: DocReviewQuote[]
}

/** `docView:findQuote`: the mark scrolled into sight, there but hidden (a closed tab of the document), or not there now. */
export type DocQuoteFound = 'shown' | 'hidden' | 'missing'

/** A quote keeps at most this many characters (a longer selection is cut: its start still finds the place). */
export const DOC_REVIEW_QUOTE_MAX = 1000
/** The text before and after a selection: this many characters each. */
export const DOC_REVIEW_CONTEXT_MAX = 32
/** What the view may hand back before it is even looked at (the piece cuts to this; more = not ours). */
export const DOC_REVIEW_RAW_MAX = 4 * DOC_REVIEW_QUOTE_MAX
/** At most this many marks per document. */
export const DOC_REVIEW_QUOTES_MAX = 500
const NTH_MAX = 10_000

/** Control characters and the bidi overrides a page could use to make a quote read differently. */
const UNSEEN = /[\p{Cc}‎‏‪-‮⁦-⁩]/gu

/** Whitespace runs as one space, unseen characters dropped, trimmed. */
export function plainQuote(text: string): string {
  return text.replace(/\s+/g, ' ').replace(UNSEEN, '').trim()
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The selection the view handed back, or null: exactly three strings, none past `DOC_REVIEW_RAW_MAX`,
 * a text with something visible in it. The text is cut to `DOC_REVIEW_QUOTE_MAX`, the context to
 * `DOC_REVIEW_CONTEXT_MAX` (the end of the prefix, the start of the suffix).
 */
export function docReviewSelectionOf(value: unknown): DocReviewSelection | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 3 || !['text', 'prefix', 'suffix'].every(k => keys.includes(k))) return null
  const { text, prefix, suffix } = value
  if (typeof text !== 'string' || typeof prefix !== 'string' || typeof suffix !== 'string') return null
  if (text.length > DOC_REVIEW_RAW_MAX || prefix.length > DOC_REVIEW_RAW_MAX || suffix.length > DOC_REVIEW_RAW_MAX) return null
  const quote = plainQuote(text).slice(0, DOC_REVIEW_QUOTE_MAX).trim()
  if (!quote) return null
  // The context keeps one space at the edge next to the quote: "円 です" stays apart from the quote.
  const before = prefix.replace(/\s+/g, ' ').replace(UNSEEN, '')
  const after = suffix.replace(/\s+/g, ' ').replace(UNSEEN, '')
  return {
    text: quote,
    prefix: before.slice(Math.max(0, before.length - DOC_REVIEW_CONTEXT_MAX)),
    suffix: after.slice(0, DOC_REVIEW_CONTEXT_MAX),
  }
}

/**
 * What the window asked the view to do for the review, or null when it is not that shape: `selecting`
 * a boolean, at most `DOC_REVIEW_QUOTES_MAX` quotes of a visible text (cut to `DOC_REVIEW_QUOTE_MAX`),
 * a whole `nth` from 0, a boolean `resolved`.
 */
export function docViewReviewOf(value: unknown): DocViewReview | null {
  if (!isRecord(value) || typeof value.selecting !== 'boolean' || !Array.isArray(value.quotes)) return null
  if (value.quotes.length > DOC_REVIEW_QUOTES_MAX) return null
  const quotes: DocReviewQuote[] = []
  for (const q of value.quotes as unknown[]) {
    if (!isRecord(q) || typeof q.text !== 'string' || typeof q.resolved !== 'boolean') return null
    if (typeof q.nth !== 'number' || !Number.isInteger(q.nth) || q.nth < 0 || q.nth > NTH_MAX) return null
    const text = plainQuote(q.text.slice(0, DOC_REVIEW_RAW_MAX)).slice(0, DOC_REVIEW_QUOTE_MAX)
    if (!text) return null
    quotes.push({ text, nth: q.nth, resolved: q.resolved })
  }
  return { selecting: value.selecting, quotes }
}

/** The piece's answer to "find this mark", or `missing` for anything else. */
export function docQuoteFoundOf(value: unknown): DocQuoteFound {
  return value === 'shown' || value === 'hidden' ? value : 'missing'
}
