/**
 * The preview's JSON answers (agent-browser.md "The operator and the preview"; design memo §35: a
 * site's lists — Lステップ's reminder folders, reminders, templates — come as JSON its own pages read).
 * Pure (no Node, DOM or Electron).
 *
 * An answer is parsed strictly before any reader sees it: standard JSON only, at most 2 000 000
 * characters and 32 levels deep, and **a key written twice in one object refuses the whole answer**
 * (`JSON.parse` would keep the last copy silently: an id or a name the page shows could differ from
 * the one read). Objects come without a prototype, so a key such as `__proto__` or `constructor` is a
 * plain key. A reader gets the parsed value only, never the text; what it hands back is cleaned like
 * an HTML reader's (`keepReaderItems`).
 */
import { keepReaderItems, type BrowserExploreResult } from './browser-page'
import type { BrowserJsonExploreReader, BrowserJsonValue, BrowserListPage } from './browser-runner'

export const BROWSER_JSON_LIMITS = { chars: 2_000_000, depth: 32 } as const

class Refused extends Error {}

/** `text` as strict JSON (`{ value }`), or null: too long, too deep, a repeated key, anything JSON does not allow. */
export function parseStrictJson(text: string): { value: BrowserJsonValue } | null {
  if (typeof text !== 'string' || text.length > BROWSER_JSON_LIMITS.chars) return null
  let i = 0
  const fail = (): never => { throw new Refused() }
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++ }
  const string = (): string => {
    if (text[i] !== '"') fail()
    i++
    let out = ''
    for (;;) {
      if (i >= text.length) fail()
      const c = text[i++]
      if (c === '"') return out
      if (c < ' ') fail()
      if (c !== '\\') { out += c; continue }
      const e = text[i++]
      if (e === '"' || e === '\\' || e === '/') out += e
      else if (e === 'b') out += '\b'
      else if (e === 'f') out += '\f'
      else if (e === 'n') out += '\n'
      else if (e === 'r') out += '\r'
      else if (e === 't') out += '\t'
      else if (e === 'u') {
        const hex = text.slice(i, i + 4)
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail()
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else fail()
    }
  }
  const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
  const value = (depth: number): BrowserJsonValue => {
    if (depth > BROWSER_JSON_LIMITS.depth) fail()
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      const obj = Object.create(null) as Record<string, BrowserJsonValue>
      const keys = new Set<string>()
      ws()
      if (text[i] === '}') { i++; return obj }
      for (;;) {
        ws()
        const key = string()
        if (keys.has(key)) fail()
        keys.add(key)
        ws()
        if (text[i++] !== ':') fail()
        obj[key] = value(depth + 1)
        ws()
        const next = text[i++]
        if (next === '}') return obj
        if (next !== ',') fail()
      }
    }
    if (c === '[') {
      i++
      const list: BrowserJsonValue[] = []
      ws()
      if (text[i] === ']') { i++; return list }
      for (;;) {
        list.push(value(depth + 1))
        ws()
        const next = text[i++]
        if (next === ']') return list
        if (next !== ',') fail()
      }
    }
    if (c === '"') return string()
    if (text.startsWith('true', i)) { i += 4; return true }
    if (text.startsWith('false', i)) { i += 5; return false }
    if (text.startsWith('null', i)) { i += 4; return null }
    NUMBER_RE.lastIndex = i
    const m = NUMBER_RE.exec(text)
    if (!m) fail()
    i += (m as RegExpExecArray)[0].length
    const n = Number((m as RegExpExecArray)[0])
    if (!Number.isFinite(n)) fail()
    return n
  }
  try {
    const out = value(0)
    ws()
    return i === text.length ? { value: out } : null
  } catch (e) {
    if (e instanceof Refused || e instanceof RangeError) return null
    throw e
  }
}

/** A page report as the app may use it: whole numbers, `current` and `last` from 1, `current` ≤ `last`, `total` from 0. */
function keptPage(page: unknown): BrowserListPage | null {
  if (!page || typeof page !== 'object') return null
  const { current, last, total } = page as Record<string, unknown>
  const whole = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min
  return whole(current, 1) && whole(last, 1) && whole(total, 0) && current <= last ? { current, last, total } : null
}

/**
 * Runs a reviewed JSON reader over an answer's text: parsed strictly first (an answer that does not
 * parse is no items, incomplete), then what the reader hands back is kept as any reader's is. A page
 * report (`page`) is passed on only when it is whole numbers that fit together; a malformed one is
 * dropped and the read is incomplete.
 */
export function runJsonExploreReader(reader: BrowserJsonExploreReader, values: Readonly<Record<string, string>>, text: string): BrowserJsonExploreResult {
  const json = parseStrictJson(text)
  if (!json) return { items: [], complete: false }
  let raw: ReturnType<BrowserJsonExploreReader['read']>
  try { raw = reader.read(values, json.value) } catch { return { items: [], complete: false } }
  const page = raw?.page === undefined ? undefined : keptPage(raw.page)
  const kept = keepReaderItems(reader, raw, page !== null)
  return page ? { ...kept, page } : kept
}

export interface BrowserJsonExploreResult extends BrowserExploreResult {
  /** Where this answer stands in a paginated list, as its reader reported it (checked numbers). */
  page?: BrowserListPage
}
