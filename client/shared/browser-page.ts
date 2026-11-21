/**
 * The preview's page reading (agent-browser.md "The operator and the preview", design memo §33 2-3):
 * a page the read session fetched becomes, through a standards-compliant HTML parser in main
 * (electron/features/browser/html.ts, parse5), a neutral tree; this module turns that tree into the
 * only view a site's reader gets (`BrowserPageView`) and cleans what the reader hands back. Pure
 * (no Node, DOM or Electron).
 *
 * The rules every reader gets, whatever its site:
 * - only what a person could see: nothing inside `hidden`, `aria-hidden="true"`, `<template>`,
 *   `<noscript>`, `<script>`, `<style>`, `<meta>`, `<link>`, `<base>`, `<input type="hidden">`,
 *   comments, or an element whose own `style` says `display:none` / `visibility:hidden` — the page's
 *   `<html>` and `<body>` included (a hidden root hides the whole page) (a stylesheet elsewhere is
 *   not known: the remaining limit, the person checks the card);
 * - an element with an attribute written twice (the parser keeps the first) or an id used twice in
 *   the document (hidden copies counted too) is ambiguous: neither it nor anything inside it is shown
 *   to a reader, whatever the query, and the read is incomplete;
 * - the reader never sees the HTML, only elements, their attributes and their visible text, so
 *   references (ids) come from attributes of the declared region and text stays text;
 * - what comes back is cut to the reader's declared fields and extras, ids in
 *   `BROWSER_ID_VALUE_RE`, labels cleaned (NFC, no control / bidirectional / zero-width
 *   characters, 80 characters).
 */
import { BROWSER_ID_VALUE_RE } from '../../shared/core/plugin-browser-declaration'
import type {
  BrowserExploreItem, BrowserExploreReader, BrowserPageElement, BrowserPageQuery, BrowserPageView,
} from './browser-runner'

export interface BrowserHtmlElement {
  kind: 'element'
  /** Lower-case tag name. */
  tag: string
  /** Attributes as the parser kept them (the first of a repeated name). */
  attrs: ReadonlyArray<readonly [string, string]>
  /** The start tag carried an attribute name twice. */
  duplicateAttribute: boolean
  children: BrowserHtmlNode[]
}
export interface BrowserHtmlText {
  kind: 'text'
  text: string
}
export type BrowserHtmlNode = BrowserHtmlElement | BrowserHtmlText

/** The parsed page: the `<body>` element (null when the parser made none). */
export interface BrowserHtmlDocument {
  /** The `<html>` element (its visibility is the whole page's). */
  root?: BrowserHtmlElement | null
  body: BrowserHtmlElement | null
  /** Every element's id across the whole document, hidden ones included, with how often each stands. */
  idCounts: ReadonlyMap<string, number>
}

export const BROWSER_PAGE_LIMITS = { items: 300, label: 80, extra: 200 } as const

const SKIPPED_TAGS = new Set(['template', 'noscript', 'script', 'style', 'meta', 'link', 'base'])

function attrOf(el: BrowserHtmlElement, name: string): string | null {
  const found = el.attrs.find(([n]) => n === name)
  return found ? found[1] : null
}

/** Not shown to a person: the element and everything inside it are skipped. */
export function hiddenElement(el: BrowserHtmlElement): boolean {
  if (SKIPPED_TAGS.has(el.tag)) return true
  if (el.tag === 'input' && (attrOf(el, 'type') ?? '').trim().toLowerCase() === 'hidden') return true
  if (attrOf(el, 'hidden') !== null) return true
  if ((attrOf(el, 'aria-hidden') ?? '').trim().toLowerCase() === 'true') return true
  const style = (attrOf(el, 'style') ?? '').toLowerCase().replace(/\s+/g, '')
  return /(^|;)display:none(!important)?(;|$)/.test(style) || /(^|;)visibility:hidden(!important)?(;|$)/.test(style)
}

/** Every element's id with how often it stands (hidden ones included: a hidden copy makes the visible one ambiguous). */
export function countIds(root: BrowserHtmlElement | null): Map<string, number> {
  const counts = new Map<string, number>()
  const walk = (el: BrowserHtmlElement) => {
    const id = attrOf(el, 'id')
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1)
    for (const child of el.children) if (child.kind === 'element') walk(child)
  }
  if (root) walk(root)
  return counts
}

function visibleText(el: BrowserHtmlElement): string {
  let out = ''
  const walk = (node: BrowserHtmlNode) => {
    if (node.kind === 'text') { out += node.text; return }
    if (hiddenElement(node)) return
    for (const child of node.children) walk(child)
    out += ' '
  }
  for (const child of el.children) walk(child)
  return out.replace(/\s+/g, ' ').trim()
}

/** The reader's view of a parsed page, and whether the read stayed whole. */
export function createPageView(doc: BrowserHtmlDocument): { view: BrowserPageView; complete(): boolean } {
  let whole = true
  const incomplete = () => { whole = false }
  const ids = doc.idCounts

  /** An element whose id stands more than once, or with an attribute written twice: never shown, nor anything in it. */
  const ambiguous = (el: BrowserHtmlElement): boolean => {
    const id = attrOf(el, 'id')
    return el.duplicateAttribute || (id !== null && (ids.get(id) ?? 0) !== 1)
  }

  const matches = (el: BrowserHtmlElement, q: BrowserPageQuery): boolean => {
    if (q.tag !== undefined && el.tag !== q.tag.toLowerCase()) return false
    if (q.id !== undefined || q.idPattern !== undefined) {
      const raw = attrOf(el, 'id')
      if (raw === null) return false
      if (!(q.id !== undefined ? raw === q.id : (q.idPattern as RegExp).test(raw))) return false
    }
    if (q.hasAttribute !== undefined && attrOf(el, q.hasAttribute.toLowerCase()) === null) return false
    return true
  }

  // Only elements that passed `visible` below are ever wrapped: unambiguous, shown, under a shown root.
  const wrap = (el: BrowserHtmlElement): BrowserPageElement => ({
    tag: el.tag,
    id: attrOf(el, 'id'),
    attr: (name: string) => attrOf(el, name.toLowerCase()),
    text: () => visibleText(el),
    find: q => findIn(el, q),
  })

  function findIn(root: BrowserHtmlElement, q: BrowserPageQuery): BrowserPageElement[] {
    const out: BrowserPageElement[] = []
    const walk = (el: BrowserHtmlElement) => {
      for (const child of el.children) {
        if (child.kind !== 'element' || hiddenElement(child)) continue
        // An ambiguous element is not read, nor what is inside it; the read is not whole.
        if (ambiguous(child)) { incomplete(); continue }
        // Re-test the pattern from the start each time (a global RegExp keeps its position).
        if (q.idPattern) q.idPattern.lastIndex = 0
        if (matches(child, q)) out.push(wrap(child))
        walk(child)
      }
    }
    walk(root)
    return out
  }

  // A hidden or ambiguous `<html>` / `<body>` hides the whole page.
  const body = doc.body && ![doc.root, doc.body].some(el => el && (hiddenElement(el) || ambiguous(el))) ? doc.body : null
  const view: BrowserPageView = {
    find: q => (body ? findIn(body, q) : []),
    one(q) {
      const found = view.find(q)
      if (found.length !== 1) { incomplete(); return null }
      return found[0]
    },
    incomplete,
  }
  if (!body) incomplete()
  return { view, complete: () => whole }
}

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** A label as the operator may get it: NFC, no control / bidirectional / zero-width characters, one line, cut. */
export function cleanLabel(text: string, max: number = BROWSER_PAGE_LIMITS.label): string {
  const one = text.normalize('NFC').replace(UNSAFE_CHARS_RE, ' ').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) : one
}

export interface BrowserExploreResult {
  items: BrowserExploreItem[]
  complete: boolean
}

/**
 * Runs a reviewed reader over a parsed page and keeps only what it may hand on: its declared fields
 * with plain ids, cleaned labels, its declared extras. Anything else — another field or extra, a
 * value that is not an id, more than 300 items, a reader that throws — is left out and the read is
 * incomplete. The view's own rules (hidden, repeated attribute or id) also make it incomplete.
 */
export function runExploreReader(reader: BrowserExploreReader, values: Readonly<Record<string, string>>, doc: BrowserHtmlDocument): BrowserExploreResult {
  const { view, complete } = createPageView(doc)
  let raw: { items: BrowserExploreItem[]; complete: boolean }
  try { raw = reader.read(values, view) } catch { return { items: [], complete: false } }
  let whole = raw?.complete === true && complete()
  const items: BrowserExploreItem[] = []
  for (const item of Array.isArray(raw?.items) ? raw.items : []) {
    if (items.length >= BROWSER_PAGE_LIMITS.items) { whole = false; break }
    if (!item || typeof item.field !== 'string' || !reader.fields.includes(item.field)
      || typeof item.value !== 'string' || !BROWSER_ID_VALUE_RE.test(item.value)) { whole = false; continue }
    const clean: BrowserExploreItem = { field: item.field, value: item.value }
    if (typeof item.label === 'string') {
      const label = cleanLabel(item.label)
      if (label) clean.label = label
    }
    if (item.extra !== undefined) {
      const extra: Record<string, string> = {}
      let fine = typeof item.extra === 'object' && item.extra !== null
      for (const [k, v] of fine ? Object.entries(item.extra) : []) {
        if (!reader.extra.includes(k) || typeof v !== 'string') { fine = false; break }
        extra[k] = cleanLabel(v, BROWSER_PAGE_LIMITS.extra)
      }
      if (!fine) { whole = false; continue }
      if (Object.keys(extra).length > 0) clean.extra = extra
    }
    items.push(clean)
  }
  return { items, complete: whole }
}
