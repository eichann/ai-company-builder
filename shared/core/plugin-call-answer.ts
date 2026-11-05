/**
 * What is kept of a call's answer (plugins.md "Contract 3"): `returns` is an
 * allow-list, so anything it does not name is dropped and counted, never handed
 * on. A named field is one plain value; a list named with `each` is entries with
 * those fixed fields. Every string but a plain id is text the service sent, whatever
 * its class: it is wrapped here, on the server, with the header and footer and the
 * instruction-like flag, bounded, and its 【 】 are changed, so it cannot close the
 * wrapper itself.
 */
import { OUTSIDE_TEXT_FOOTER, OUTSIDE_TEXT_HEADER, outsideTextFlags, wrapOutsideText } from './outside-text'
import { EXTERNAL_ID_RE, type PluginDataField, type PluginReturn } from './plugin-declaration'

/** The header the AI sees above outside text (data, not instructions). */
export const CALL_OUTSIDE_HEADER = OUTSIDE_TEXT_HEADER
export const CALL_OUTSIDE_FOOTER = OUTSIDE_TEXT_FOOTER

/**
 * A list's cursor, either way (what the service gave as `next`, what a caller hands
 * back): an opaque token. No space, `@` or non-ASCII letter, so it carries neither a
 * sentence nor an address, and it is bounded. It reaches a GET's URL and the AI as is.
 */
export const CALL_CURSOR_RE = /^[A-Za-z0-9._~+/=:-]{1,500}$/
/** The longest link a page may cite, as handed on. */
const CITE_MAX = 2000
/** The longest text of one field handed on; the rest is cut, and said so inside the wrapper. */
export const CALL_TEXT_MAX = 20_000
const CUT_NOTE = '…（長いため、ここで切りました）'
/** The most ids of one answer's entries the access log keeps; the rest are counted. */
export const LOGGED_POINTERS_MAX = 200

export type KeptPlain = string | number | boolean | null
/** Outside text, wrapped. `instructionLike` flags it (a flag, never a filter). */
export type KeptOutside = { outsideText: string; instructionLike: string[] }
export type KeptValue = KeptPlain | KeptOutside | KeptEntry[]
export interface KeptEntry { [field: string]: KeptValue }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPlain = (v: unknown): v is KeptPlain => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/** The wrapper (`outside-text.ts`, the one standard): `【` `】` inside become `〔` `〕`, so no spelling of the footer (or a second header) survives. */
function wrapOutside(value: string): KeptOutside {
  const bounded = value.length > CALL_TEXT_MAX ? `${value.slice(0, CALL_TEXT_MAX)}${CUT_NOTE}` : value
  return { outsideText: wrapOutsideText(bounded), instructionLike: outsideTextFlags(bounded) }
}

/**
 * Only a plain id stays plain (and not where `outside: true` says otherwise): it has no
 * room for a sentence, and it is what the next call takes as its input. Every other
 * string is wrapped, `class: normal` too: a title or a page's text is the service's
 * writing, and a declaration cannot turn that off.
 */
const staysPlain = (value: string, field: PluginDataField): boolean => !field.outside && EXTERNAL_ID_RE.test(value)

function keepPlain(value: unknown, field: PluginDataField): KeptPlain | KeptOutside | undefined {
  if (!isPlain(value)) return undefined
  return typeof value !== 'string' || staysPlain(value, field) ? value : wrapOutside(value)
}

/** One object of an answer: only the named fields; each other field, and each value of the wrong shape, counts as dropped. */
function keepEntry(from: Record<string, unknown>, returns: Record<string, PluginReturn | PluginDataField>): { entry: KeptEntry; dropped: number } {
  const entry: KeptEntry = {}
  let dropped = 0
  for (const [name, value] of Object.entries(from)) {
    const rule = Object.prototype.hasOwnProperty.call(returns, name) ? returns[name] : undefined
    if (!rule) { dropped++; continue }
    if ('each' in rule) {
      if (!Array.isArray(value)) { dropped++; continue }
      const list: KeptEntry[] = []
      for (const item of value) {
        if (!isObject(item)) { dropped++; continue }
        const kept = keepEntry(item, rule.each)
        list.push(kept.entry)
        dropped += kept.dropped
      }
      entry[name] = list
      continue
    }
    const kept = keepPlain(value, rule)
    if (kept === undefined) dropped++
    else entry[name] = kept
  }
  return { entry, dropped }
}

/**
 * The answer as the allow-list keeps it. `items`: the field holding the entries
 * of a list or a search (null: the answer itself, an object or a list).
 */
export function keepDeclared(answer: unknown, returns: Record<string, PluginReturn>, items: string | null): { data: KeptEntry | null; items: KeptEntry[] | null; dropped: number } {
  const source = items !== null ? (isObject(answer) ? answer[items] : undefined) : answer
  if (Array.isArray(source)) {
    let dropped = 0
    const list: KeptEntry[] = []
    for (const item of source) {
      if (!isObject(item)) { dropped++; continue }
      const kept = keepEntry(item, returns)
      list.push(kept.entry)
      dropped += kept.dropped
    }
    return { data: null, items: list, dropped }
  }
  if (items === null && isObject(source)) {
    const { entry, dropped } = keepEntry(source, returns)
    return { data: entry, items: null, dropped }
  }
  return { data: null, items: null, dropped: 1 }
}

/**
 * The ids of the entries handed on, for the access log (who was read): each `keep:
 * pointer` field, sensitive ones aside, and only a plain id, so a pointer holding
 * text or an address never reaches the log. Unique, at most `LOGGED_POINTERS_MAX`;
 * `more` counts the ones left out.
 */
export function pointersOf(entries: readonly KeptEntry[], returns: Record<string, PluginReturn | PluginDataField>): { ids: string[]; more: number } {
  const ids = new Set<string>()
  const visit = (entry: KeptEntry, rules: Record<string, PluginReturn | PluginDataField>) => {
    for (const [name, rule] of Object.entries(rules)) {
      const value = Object.prototype.hasOwnProperty.call(entry, name) ? entry[name] : undefined
      if ('each' in rule) { if (Array.isArray(value)) for (const item of value) visit(item, rule.each); continue }
      if (rule.keep === 'pointer' && rule.dataClass !== 'sensitive' && typeof value === 'string' && EXTERNAL_ID_RE.test(value)) ids.add(value)
    }
  }
  for (const entry of entries) visit(entry, returns)
  return { ids: [...ids].slice(0, LOGGED_POINTERS_MAX), more: Math.max(0, ids.size - LOGGED_POINTERS_MAX) }
}

/** The link to cite: only https on the declared host (a value cannot send a reader elsewhere), and bounded. */
export function citeLink(value: unknown, host: string): string | null {
  if (typeof value !== 'string' || value.length > CITE_MAX) return null
  try {
    const url = new URL(value)
    const link = url.toString()
    // The default port only: another port on the same name is another service.
    return url.protocol === 'https:' && url.hostname === host && url.port === '' && !url.username && !url.password && link.length <= CITE_MAX ? link : null
  } catch {
    return null
  }
}
