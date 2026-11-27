/**
 * 「ブラウザ操作」 の記録 (agent-browser.md "Recording"): a person who knows the work does it once in the app's window; the app
 * keeps **what was done, never with what** — page addresses as patterns, the labels of the buttons pressed and the fields
 * filled, the names of the fields sent, each answer's status and JSON key shape — and the person sends it to the company,
 * where its owner / admin (the FDE) reads it to build a company Skill. Pure: the app builds a recording with these rules
 * (client/shared/browser-recorder.ts) and the server checks every recording it is sent with the same rules
 * (`browserRecordingProblem`), so the one copy decides what a stored recording may hold.
 *
 * **Never kept** (whatever the page shows or sends): a value typed or sent (each becomes a symbol, `値3`, only inside its
 * recording: the same value the same symbol — a flow, not an anonymisation), a password field's content (not even read
 * from the page), Cookie / Authorization / any header, the names and values of CSRF / token / session / password fields,
 * a link's text (a link is its address pattern only), page HTML, an answer's values, screenshots. Digit runs and long
 * tokens in addresses and key names become `{n}` / `{x}`, an e-mail-like key `{mail}`; a query keeps its keys only.
 */
import { normalizeBrowserHost } from './browser-operation'

/**
 * The format the app writes. 2 (2026-11-27, agent-browser.md "A Skill's draft from a recording"): every send also says
 * whether its address's query was kept exactly (`bareQuery`). The server still takes format 1 (an app from before).
 */
export const BROWSER_RECORDING_FORMAT = 2
export type BrowserRecordingFormat = 1 | 2
/** A stored recording is deleted this many days after it was sent (owner decision D2). */
export const BROWSER_RECORDING_DAYS = 30

export const BROWSER_RECORDING_LIMITS = Object.freeze({
  steps: 500,
  fieldsPerSend: 60,
  answerKeys: 200,
  hosts: 60,
  label: 60,
  key: 60,
  address: 300,
  queryKeys: 20,
  depth: 8,
  symbols: 9999,
  count: 9999,
  /** The stored JSON's size (UTF-8 bytes). */
  bytes: 512 * 1024,
})

/** A value as a recording keeps it: a symbol of this recording, empty, a password (never read) or a file (never read). */
export type BrowserValueMark = string
const SYMBOL_RE = /^値[1-9][0-9]{0,3}$/
const OTHER_MARKS = ['empty', 'secret', 'file'] as const
export const isBrowserValueMark = (v: unknown): v is BrowserValueMark =>
  typeof v === 'string' && (SYMBOL_RE.test(v) || (OTHER_MARKS as readonly string[]).includes(v))

/** "This value was seen before in that step's answer, at that key" — inferred (`推定`), never certain. */
export interface BrowserRecordedSource { step: number; key: string }

export interface BrowserRecordedPage { id: number; kind: 'page'; address: string }
export interface BrowserRecordedClick {
  id: number
  kind: 'click'
  /** A button, a choice (checkbox, radio, tab, menu item) or a link. */
  target: 'button' | 'choice' | 'link'
  /** The button's or choice's label; a link never has one (its text may name a person). */
  label: string | null
  /** A link's address pattern on the operated host (null: another host, or not a link). */
  address: string | null
}
export interface BrowserRecordedInput {
  id: number
  kind: 'input'
  label: string | null
  /** The field's `name` as a key (masked like any key). */
  name: string | null
  value: BrowserValueMark
  from: BrowserRecordedSource | null
}
export interface BrowserSentField { name: string; value: BrowserValueMark; from: BrowserRecordedSource | null }
export interface BrowserRecordedSend {
  id: number
  kind: 'send'
  method: string
  /** A `_method` the body carried (PUT / PATCH / DELETE), else null. */
  override: string | null
  address: string
  /** The body's field names and value symbols; null when the body could not be read (an upload, a large body). */
  fields: BrowserSentField[] | null
  status: number | null
  /** The answer's JSON key shape (`items[].id`), null when it was not JSON or not read. */
  answerKeys: string[] | null
  /** The person's action this request most likely followed (`推定`), or null. */
  after: number | null
  /** How many times this very read (GET of the same pattern) was seen. */
  count: number
  /**
   * Format 2: the address's query is exactly its kept form — names only, each a plain word, once, in that order (`?return`)
   * — so a Skill's draft may name that very query (`browserQueryKeptExactly`). False with no query, a value (`?a=1`), an
   * encoding, a name masked or seen twice. Absent in format 1 (unknown).
   */
  bareQuery?: boolean
}
export type BrowserRecordingStep = BrowserRecordedPage | BrowserRecordedClick | BrowserRecordedInput | BrowserRecordedSend

export interface BrowserRecordingContent {
  format: BrowserRecordingFormat
  /** The operated host the recording was made on. */
  domain: string
  steps: BrowserRecordingStep[]
  /** Other hosts the window's pages asked for (FDE: the parts and login helpers a site needs); `loaded` = at least one answered. */
  hosts: Array<{ host: string; loaded: boolean }>
}

// ── Patterns ────────────────────────────────────────────────────────────────

/** Names whose fields are dropped whole (name and value): passwords, tokens, sessions, keys. Safe side: a wide net. */
const SENSITIVE_RE = /pass|pwd|secret|token|csrf|xsrf|session|sess_?id|auth|api[-_]?key|otp|cookie|credential|signature|nonce|captcha/i
const PW_RE = /(^|[^a-z])pw([^a-z]|$)/i
export const isSensitiveFieldName = (name: string): boolean => SENSITIVE_RE.test(name) || PW_RE.test(name)

/**
 * A word a recording keeps as written (a path segment, a query key, one part of a key): lowercase ASCII letters joined by
 * `-` or `_` (a leading `_` too: `_method`), at most 24. Anything else — a digit, a capital, a dot, `@`, `%`, a character
 * not ASCII, longer — is not kept: it may be a name, an e-mail or a token (independent review of #846). A lowercase name
 * such as `tanaka` still passes: the person hides it on the review screen (`browserRecordingHide`).
 */
const WORD_RE = /^_?[a-z]+(?:[-_][a-z]+)*$/
const WORD_MAX = 24
const isWord = (s: string) => s.length <= WORD_MAX && WORD_RE.test(s)
/** `{n}` a number, `{x}` anything not kept (or hidden by the person), `{k}` keys that are data (many of one shape). */
const PLACEHOLDERS = ['{n}', '{x}', '{k}'] as const
const isPlaceholder = (s: string) => (PLACEHOLDERS as readonly string[]).includes(s)

/** One word as kept: all digits → `{n}`, a plain word as it is, anything else → `{x}` (whole, never digit by digit). */
function wordPattern(s: string): string {
  if (/^[0-9]+$/.test(s)) return '{n}'
  return isWord(s) ? s : '{x}'
}

/**
 * A key as a recording keeps it. `json`: one JSON key (a key path's part). Otherwise a form field's name or a query key,
 * `name[part][part]` with each part a word (`items[0][name]` → `items[{n}][name]`, `user[Tanaka]` → `user[{x}]`).
 */
export function browserKeyPattern(key: string, json = false): string {
  if (json) return wordPattern(key)
  const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key)
  if (!m || key.length > 120) return '{x}'
  const parts = [...m[2].matchAll(/\[([^[\]]*)\]/g)].map(p => (p[1] === '' ? '[]' : `[${wordPattern(p[1])}]`))
  return `${wordPattern(m[1])}${parts.join('')}`
}

/**
 * An address of the operated host as a pattern (`/orders/{n}/edit?page&q`), or null for another host, another scheme or
 * something that is not an address. Never its query values, fragment, user or port.
 */
export function browserAddressPattern(url: string, domain: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:' || u.hostname !== domain) return null
  const path = u.pathname.split('/').map(seg => (seg === '' ? '' : wordPattern(seg))).join('/') || '/'
  const keys: string[] = []
  for (const k of u.searchParams.keys()) {
    const p = wordPattern(k)
    if (!keys.includes(p) && keys.length < BROWSER_RECORDING_LIMITS.queryKeys) keys.push(p)
  }
  const pattern = keys.length > 0 ? `${path}?${keys.join('&')}` : path
  return pattern.length <= BROWSER_RECORDING_LIMITS.address ? pattern : '/{x}'
}

/**
 * True when the address's raw query is exactly what `browserAddressPattern` keeps of it (names only, plain words, once, in
 * order: `?return`, `?a&b`), so the kept form says the very query that was sent. False with no query, an empty one, any value
 * (`?a=1`, `?a=`), an encoding, a masked or repeated name, or another host.
 */
export function browserQueryKeptExactly(url: string, domain: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  const pattern = browserAddressPattern(url, domain)
  if (pattern === null) return false
  const at = pattern.indexOf('?')
  const raw = u.search.slice(1)
  return at !== -1 && raw !== '' && raw === pattern.slice(at + 1)
}

/** A host of another address (for the hosts list), or null. */
export function browserOtherHost(url: string, domain: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'wss:' && u.protocol !== 'http:' && u.protocol !== 'ws:') return null
  const host = normalizeBrowserHost(u.hostname)
  return host && host !== domain ? host : null
}

/**
 * A button's or field's label as kept: NFKC, whitespace collapsed, e-mail-like text → `{mail}`, an address → `{url}`,
 * **every digit run** → `{n}` (an amount, a phone number, an id, a date), at most 60 characters. Applying it twice
 * changes nothing (the server checks a stored label is already in this form). Empty → null.
 */
export function browserLabel(text: unknown): string | null {
  if (typeof text !== 'string') return null
  let s = text.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
  s = s.replace(/\S+@\S+/g, '{mail}').replace(/(https?|wss?):\/\/\S*/gi, '{url}').replace(/[0-9]+/g, '{n}')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > BROWSER_RECORDING_LIMITS.label) s = `${s.slice(0, BROWSER_RECORDING_LIMITS.label - 3).trimEnd()}...`
  return s === '' ? null : s
}

// ── Values and answers ──────────────────────────────────────────────────────

/**
 * The symbols of one recording: the same value always the same `値N`, numbered in the order first seen. `digest` is the
 * recording's own keyed hash (the app makes a new random key per recording), so this holds no value and two recordings'
 * symbols have nothing to do with each other.
 */
export function createBrowserValueSymbols(digest: (value: string) => string) {
  const symbols = new Map<string, number>()
  return {
    symbol(value: string): BrowserValueMark {
      if (value === '') return 'empty'
      const d = digest(value)
      let n = symbols.get(d)
      if (n === undefined) {
        if (symbols.size >= BROWSER_RECORDING_LIMITS.symbols) return 'empty'
        n = symbols.size + 1
        symbols.set(d, n)
      }
      return `値${n}`
    },
    digest,
  }
}
export type BrowserValueSymbols = ReturnType<typeof createBrowserValueSymbols>

/** More keys than this sharing one value shape in an object are data (customers by name), kept as `{k}`. */
const DATA_KEYS_AFTER = 5
const shapeOf = (v: unknown): string =>
  Array.isArray(v) ? 'a' : v && typeof v === 'object' ? `o:${Object.keys(v as object).sort().join(',')}` : typeof v

/** The JSON key shape of an answer (`items[].id`, keys masked) and its scalar leaves (for "seen before"; never kept). */
export function browserJsonShape(value: unknown): { keys: string[]; leaves: Array<{ key: string; value: string }> } {
  const keys: string[] = []
  const leaves: Array<{ key: string; value: string }> = []
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > BROWSER_RECORDING_LIMITS.depth || keys.length >= BROWSER_RECORDING_LIMITS.answerKeys) return
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 200)) walk(item, `${path}[]`, depth + 1)
      return
    }
    if (v && typeof v === 'object') {
      // A password / token / session key goes whole, with everything under it.
      const entries = Object.entries(v as Record<string, unknown>).filter(([k]) => !isSensitiveFieldName(k))
      const shapes = new Map<string, number>()
      for (const [, child] of entries) shapes.set(shapeOf(child), (shapes.get(shapeOf(child)) ?? 0) + 1)
      for (const [k, child] of entries.slice(0, 200)) {
        const part = (shapes.get(shapeOf(child)) ?? 0) > DATA_KEYS_AFTER ? '{k}' : browserKeyPattern(k, true)
        const p = path === '' ? part : `${path}.${part}`
        if (!keys.includes(p) && keys.length < BROWSER_RECORDING_LIMITS.answerKeys) keys.push(p)
        walk(child, p, depth + 1)
      }
      return
    }
    if (path !== '' && (typeof v === 'string' || typeof v === 'number') && leaves.length < 2000) leaves.push({ key: path, value: String(v) })
  }
  walk(value, '', 0)
  return { keys, leaves }
}

/**
 * The fields a request body carries: each name as a key pattern (a JSON body's as key paths) and its raw value (a file
 * part: `file: true`, no value). A password / token / session field is left out whole (judged on its raw name). Null: a
 * body this cannot read.
 */
export function browserBodyFields(contentType: string | undefined, body: string): Array<{ name: string; value: string; file?: boolean }> | null {
  const type = (contentType ?? '').toLowerCase()
  const out: Array<{ name: string; value: string; file?: boolean }> = []
  if (type.includes('application/json') || (!type && /^\s*[{[]/.test(body))) {
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { return null }
    const { keys, leaves } = browserJsonShape(parsed)
    const leafKeys = new Set(leaves.map(l => l.key))
    for (const l of leaves) out.push({ name: l.key, value: l.value })
    // Containers and nulls / booleans: their names with no value.
    for (const k of keys) if (!leafKeys.has(k)) out.push({ name: k, value: '' })
    return out
  }
  if (type.includes('multipart/form-data')) {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '')
    const b = boundary?.[1] ?? boundary?.[2]
    if (!b) return null
    for (const part of body.split(`--${b}`)) {
      const head = /^\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(part)
      if (!head) continue
      const name = /(?:^|[;\s])name="([^"]*)"/i.exec(head[1])?.[1]
      if (name === undefined || isSensitiveFieldName(name)) continue
      const file = /filename="/i.test(head[1])
      out.push({ name: browserKeyPattern(name), value: file ? '' : head[2].replace(/\r?\n$/, ''), ...(file ? { file: true } : {}) })
    }
    return out
  }
  if (type.includes('application/x-www-form-urlencoded') || (!type && /^[^=&\s]+=/.test(body))) {
    for (const [name, value] of new URLSearchParams(body)) if (!isSensitiveFieldName(name)) out.push({ name: browserKeyPattern(name), value })
    return out
  }
  return null
}

// ── Checking a stored recording (the server's rule) ─────────────────────────

const SEND_KEYS = ['id', 'kind', 'method', 'override', 'address', 'fields', 'status', 'answerKeys', 'after', 'count'] as const
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const
const OVERRIDES = ['PUT', 'PATCH', 'DELETE'] as const

/** A word as `wordPattern` writes it (or a placeholder). */
const isKeptWord = (s: string) => isPlaceholder(s) || isWord(s)

export function isBrowserAddressPattern(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > BROWSER_RECORDING_LIMITS.address || !s.startsWith('/')) return false
  const [path, query, ...rest] = s.split('?')
  if (rest.length > 0 || path.split('/').some(seg => seg !== '' && !isKeptWord(seg))) return false
  if (query !== undefined) {
    const keys = query.split('&')
    if (keys.length > BROWSER_RECORDING_LIMITS.queryKeys || new Set(keys).size !== keys.length) return false
    if (keys.some(k => !isKeptWord(k))) return false
  }
  return true
}

/** A form field's name as `browserKeyPattern` writes it. */
function isFormName(k: string): boolean {
  const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(k)
  if (!m || !isKeptWord(m[1])) return false
  return [...m[2].matchAll(/\[([^[\]]*)\]/g)].every(p => p[1] === '' || isKeptWord(p[1]))
}

/** An answer key path (`items[].id`) or a body field's name (a JSON body's are paths too). */
function isKeyPath(p: unknown, allowFormName: boolean): p is string {
  if (typeof p !== 'string' || p === '' || p.length > 300) return false
  if (allowFormName && isFormName(p)) return true
  // A root array's items are `[]` / `[].id` (browserJsonShape): only the first segment may be bare brackets.
  return p.split('.').every((seg, i) => {
    const base = seg.replace(/(\[\])+$/, '')
    return base === '' ? i === 0 && seg !== '' : isKeptWord(base)
  })
}

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k))
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isLabel = (v: unknown) => v === null || (typeof v === 'string' && browserLabel(v) === v)
const posInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max

/**
 * Null when `content` is a recording of `domain` exactly as the rules above write it, else what is wrong (a fixed English
 * phrase for the log and the refusal; never a piece of the content). Every object holds exactly its keys; every string is
 * already in its kept form (a label, an address pattern, a key), so a value or a token cannot ride in one of them unmasked.
 */
export function browserRecordingProblem(content: unknown, domain: string): string | null {
  if (normalizeBrowserHost(domain) !== domain) return 'domain'
  if (!isObj(content) || !exactKeys(content, ['format', 'domain', 'steps', 'hosts'])) return 'shape'
  if (content.format !== 1 && content.format !== 2) return 'format'
  const sendKeys = content.format === 1 ? SEND_KEYS : [...SEND_KEYS, 'bareQuery']
  if (content.domain !== domain) return 'domain'
  const { steps, hosts } = content
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > BROWSER_RECORDING_LIMITS.steps) return 'steps'
  if (!Array.isArray(hosts) || hosts.length > BROWSER_RECORDING_LIMITS.hosts) return 'hosts'
  const seenHosts = new Set<string>()
  for (const h of hosts) {
    if (!isObj(h) || !exactKeys(h, ['host', 'loaded']) || typeof h.loaded !== 'boolean') return 'hosts'
    if (typeof h.host !== 'string' || normalizeBrowserHost(h.host) !== h.host || h.host === domain || seenHosts.has(h.host)) return 'hosts'
    seenHosts.add(h.host)
  }
  const kinds = new Map<number, { kind: string; answer: boolean }>()
  let last = 0
  const source = (v: unknown, before: number): boolean => {
    if (v === null) return true
    if (!isObj(v) || !exactKeys(v, ['step', 'key']) || !posInt(v.step) || v.step >= before) return false
    const s = kinds.get(v.step)
    return !!s && s.kind === 'send' && s.answer && isKeyPath(v.key, false)
  }
  for (const s of steps) {
    if (!isObj(s) || !posInt(s.id) || s.id <= last) return 'step id'
    last = s.id
    switch (s.kind) {
      case 'page':
        if (!exactKeys(s, ['id', 'kind', 'address']) || !isBrowserAddressPattern(s.address)) return 'page'
        break
      case 'click':
        if (!exactKeys(s, ['id', 'kind', 'target', 'label', 'address'])) return 'click'
        if (s.target === 'link') {
          if (s.label !== null || !(s.address === null || isBrowserAddressPattern(s.address))) return 'click'
        } else if (s.target === 'button' || s.target === 'choice') {
          if (!isLabel(s.label) || s.address !== null) return 'click'
        } else return 'click'
        break
      case 'input':
        if (!exactKeys(s, ['id', 'kind', 'label', 'name', 'value', 'from'])) return 'input'
        if (!isLabel(s.label) || !(s.name === null || isFormName(s.name as string)) || !isBrowserValueMark(s.value)) return 'input'
        if (typeof s.name === 'string' && isSensitiveFieldName(s.name) && s.value !== 'secret') return 'input'
        if (!source(s.from, s.id)) return 'input'
        break
      case 'send': {
        if (!exactKeys(s, sendKeys)) return 'send'
        if (!(METHODS as readonly unknown[]).includes(s.method) || !(s.override === null || (OVERRIDES as readonly unknown[]).includes(s.override))) return 'send'
        if (!isBrowserAddressPattern(s.address)) return 'send'
        // Format 2 says for every send whether its query was kept exactly; "exactly" needs a query (the address is a string
        // by now: Codex review).
        if (content.format === 2 && (typeof s.bareQuery !== 'boolean' || (s.bareQuery && !s.address.includes('?')))) return 'send'
        if (!(s.status === null || (typeof s.status === 'number' && Number.isInteger(s.status) && s.status >= 100 && s.status <= 599))) return 'send'
        if (!posInt(s.count, BROWSER_RECORDING_LIMITS.count)) return 'send'
        if (s.after !== null) {
          const a = posInt(s.after) && s.after < s.id ? kinds.get(s.after) : undefined
          if (!a || (a.kind !== 'click' && a.kind !== 'input')) return 'send'
        }
        if (s.fields !== null) {
          if (!Array.isArray(s.fields) || s.fields.length > BROWSER_RECORDING_LIMITS.fieldsPerSend) return 'send'
          for (const f of s.fields) {
            if (!isObj(f) || !exactKeys(f, ['name', 'value', 'from']) || !isKeyPath(f.name, true) || !isBrowserValueMark(f.value)) return 'send'
            if (isSensitiveFieldName(f.name as string) || f.value === 'secret' || !source(f.from, s.id)) return 'send'
          }
        }
        if (s.answerKeys !== null) {
          if (!Array.isArray(s.answerKeys) || s.answerKeys.length > BROWSER_RECORDING_LIMITS.answerKeys) return 'send'
          if (s.answerKeys.some(k => !isKeyPath(k, false)) || new Set(s.answerKeys).size !== s.answerKeys.length) return 'send'
        }
        kinds.set(s.id, { kind: 'send', answer: s.answerKeys !== null })
        continue
      }
      default:
        return 'step kind'
    }
    kinds.set(s.id, { kind: s.kind, answer: false })
  }
  if (new TextEncoder().encode(JSON.stringify(content)).length > BROWSER_RECORDING_LIMITS.bytes) return 'size'
  return null
}

/** The recording without the steps the person deleted: every reference to a deleted step is cleared (nothing dangles). */
export function browserRecordingWithout(content: BrowserRecordingContent, ids: readonly number[]): BrowserRecordingContent {
  const gone = new Set(ids)
  const keep = (from: BrowserRecordedSource | null) => (from && !gone.has(from.step) ? from : null)
  const steps = content.steps.filter(s => !gone.has(s.id)).map((s): BrowserRecordingStep => {
    if (s.kind === 'input') return { ...s, from: keep(s.from) }
    if (s.kind === 'send') {
      return {
        ...s,
        after: s.after !== null && !gone.has(s.after) ? s.after : null,
        fields: s.fields ? s.fields.map(f => ({ ...f, from: keep(f.from) })) : null,
      }
    }
    return s
  })
  return { ...content, steps }
}

/** The recording without one of the other hosts (the person removed it before sending). */
export function browserRecordingWithoutHost(content: BrowserRecordingContent, host: string): BrowserRecordingContent {
  return { ...content, hosts: content.hosts.filter(h => h.host !== host) }
}

// ── Hiding a word everywhere (the person, before sending) ──────────────────

/** Every word of an address (its segments and query keys). */
const addressWords = (a: string) => {
  const [path, query] = a.split('?')
  return [...path.split('/'), ...(query ? query.split('&') : [])]
}
/** Every word of a key path or a form name (`items[].id`, `user[name]`). */
const keyWords = (k: string) => k.split(/[.[\]]+/)
const hideInAddress = (a: string, word: string) => {
  const [path, query] = a.split('?')
  const p = path.split('/').map(seg => (seg === word ? '{x}' : seg)).join('/')
  if (query === undefined) return p
  const keys = [...new Set(query.split('&').map(k => (k === word ? '{x}' : k)))]
  return `${p}?${keys.join('&')}`
}
const hideInKey = (k: string, word: string) => k.replace(/[^.[\]]+/g, part => (part === word ? '{x}' : part))

/**
 * The words of a recording a person may hide (`browserRecordingHide`): every label and every word of an address, a field
 * name or an answer key that is not already a placeholder — each once, with how often it appears.
 */
export function browserRecordingHideable(content: BrowserRecordingContent): Array<{ word: string; count: number }> {
  const counts = new Map<string, number>()
  const add = (w: string | null | undefined) => {
    if (!w || isPlaceholder(w) || w === '[]') return
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  for (const s of content.steps) {
    if (s.kind === 'page') addressWords(s.address).forEach(add)
    if (s.kind === 'click') { add(s.label); if (s.address) addressWords(s.address).forEach(add) }
    if (s.kind === 'input') { add(s.label); if (s.name) keyWords(s.name).forEach(add); if (s.from) keyWords(s.from.key).forEach(add) }
    if (s.kind === 'send') {
      addressWords(s.address).forEach(add)
      for (const f of s.fields ?? []) { keyWords(f.name).forEach(add); if (f.from) keyWords(f.from.key).forEach(add) }
      for (const k of s.answerKeys ?? []) keyWords(k).forEach(add)
    }
  }
  return [...counts].map(([word, count]) => ({ word, count })).sort((a, b) => a.word.localeCompare(b.word))
}

/**
 * The recording with `word` replaced by `{x}` everywhere it stands whole: a label equal to it, an address's segment or
 * query key, a part of a field name, an answer key or a value's source. What remains still passes the server's check.
 */
export function browserRecordingHide(content: BrowserRecordingContent, word: string): BrowserRecordingContent {
  if (!word || isPlaceholder(word)) return content
  const label = (l: string | null) => (l === word ? '{x}' : l)
  const from = (f: BrowserRecordedSource | null) => (f ? { ...f, key: hideInKey(f.key, word) } : null)
  const steps = content.steps.map((s): BrowserRecordingStep => {
    switch (s.kind) {
      case 'page': return { ...s, address: hideInAddress(s.address, word) }
      case 'click': return { ...s, label: label(s.label), address: s.address ? hideInAddress(s.address, word) : null }
      case 'input': return { ...s, label: label(s.label), name: s.name ? hideInKey(s.name, word) : null, from: from(s.from) }
      case 'send': return {
        ...s,
        address: hideInAddress(s.address, word),
        fields: s.fields ? s.fields.map(f => ({ ...f, name: hideInKey(f.name, word), from: from(f.from) })) : null,
        answerKeys: s.answerKeys ? [...new Set(s.answerKeys.map(k => hideInKey(k, word)))] : null,
      }
    }
  })
  return { ...content, steps }
}

// ── Words (the app's list before sending, the admin console's view) ─────────

export const BROWSER_RECORDING_WORDS = Object.freeze({
  page: 'ページ',
  click: '押した',
  input: '入力した',
  send: '送った',
  link: 'リンク',
  choice: '（選んだ）',
  noLabel: '（見出しなし）',
  otherHost: '（ほかのサイト）',
  secret: '（伏せた）',
  empty: '（空）',
  file: '（ファイル）',
  notRead: '（中身は読めませんでした）',
  estimated: '推定',
  fromAnswer: (step: number, key: string) => `手順${step}の答えの ${key} と同じ値`,
  after: (step: number) => `手順${step}のあと`,
  times: (n: number) => `×${n}`,
  answerKeys: '答えの形',
})

const mark = (v: BrowserValueMark) =>
  v === 'secret' ? BROWSER_RECORDING_WORDS.secret : v === 'empty' ? BROWSER_RECORDING_WORDS.empty : v === 'file' ? BROWSER_RECORDING_WORDS.file : v

/** One step as a line for a person: its kind word and the text (only what the recording holds). */
export function browserRecordingLine(step: BrowserRecordingStep): { kind: string; text: string; estimated: string | null } {
  const W = BROWSER_RECORDING_WORDS
  const fromText = (f: BrowserRecordedSource | null) => (f ? W.fromAnswer(f.step, f.key) : null)
  switch (step.kind) {
    case 'page':
      return { kind: W.page, text: step.address, estimated: null }
    case 'click':
      if (step.target === 'link') return { kind: W.click, text: `${W.link} → ${step.address ?? W.otherHost}`, estimated: null }
      return { kind: W.click, text: `「${step.label ?? W.noLabel}」${step.target === 'choice' ? W.choice : ''}`, estimated: null }
    case 'input':
      return { kind: W.input, text: `「${step.label ?? W.noLabel}」${step.name ? ` (${step.name})` : ''} ＝ ${mark(step.value)}`, estimated: fromText(step.from) }
    case 'send': {
      const fields = step.fields === null ? W.notRead : step.fields.map(f => (f.value === 'empty' ? f.name : `${f.name}=${mark(f.value)}`)).join(', ')
      const parts = [`${step.override ? `${step.method}(${step.override})` : step.method} ${step.address}`]
      if (step.fields === null || step.fields.length > 0) parts.push(`［${fields}］`)
      if (step.status !== null) parts.push(`→ ${step.status}`)
      if (step.count > 1) parts.push(W.times(step.count))
      if (step.answerKeys && step.answerKeys.length > 0) parts.push(`｜${W.answerKeys}：${step.answerKeys.join(', ')}`)
      const estimated = [step.after !== null ? W.after(step.after) : null, ...(step.fields ?? []).map(f => (f.from ? `${f.name}：${fromText(f.from)}` : null))]
        .filter((x): x is string => x !== null)
      return { kind: W.send, text: parts.join(' '), estimated: estimated.length > 0 ? estimated.join('／') : null }
    }
  }
}
