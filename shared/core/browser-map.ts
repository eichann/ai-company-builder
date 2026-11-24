/**
 * The read side of a site's map (「サイトの地図」, generalization PR 2; `agent-browser.md` "The read-side words"). Internal
 * design memo 「ブラウザ操作の汎用化」 §3-2, §16-1, §16-2, §17, §18. Pure; nothing in the app or the server calls it yet.
 *
 * A map names a site's things (もの): each with its id field, its parent, its fields (a kind from a closed list and a
 * Japanese heading) and every key its JSON answer may carry — each `required` (read, always there), `optional` (read,
 * may be absent: a list whose items differ by kind) or `ignored` (読まない欄: read past, never compared). A site's reader (code in its connector folder, never here) turns the answer into the thing's
 * state; the core decides whether the answer was **read whole**:
 *
 * - **Strict read** (§3-2, owner decision §16-1): every key of the answer, at every depth, must be one the map lists;
 *   every `required` key must be there in each object that should hold it. One unknown or missing key ⇒ "not fully read" ⇒
 *   no plan (and, after approval, nothing sent). A site that silently grows a field stops being usable; it never has
 *   an unknown field read past or sent back.
 * - **The state** the reader hands back holds exactly the map's fields, each of its kind; anything else is not read.
 * - **What is told** (§16-1, Codex round 2 R1/R2): the member sees one fixed sentence; the owner / admin notice carries
 *   the site, the map's version, the thing (a map name), the kind of change and a count — **never a key name** (a key
 *   is the page's text: `customer_12345` would pass any filter). Key names stay in the PC's own diagnosis.
 *
 * The core knows no site, thing or field: every name here comes from a map (data in a connector folder), and
 * `browser-read-words.test.ts` fails when a site's name appears in this file. The shapes are **provisional** until a
 * second site fits them (§18): nothing stored or sent uses them yet.
 */
import { BROWSER_ID_VALUE_RE, isPlainBrowserText } from './plugin-browser-declaration'

/**
 * The kinds a field's value may have (closed; §3-2 「番号／番号の一覧／短い文字／日時の文字／数」, only what the known cases
 * need, §17-3). `id` a site's record number or token (`BROWSER_ID_VALUE_RE`); `id_list` ids in order; `id_set` ids in any
 * order, each as often (compared as a multiset); `text` plain text ≤ 5000 (newlines allowed); `date` `YYYY-MM-DD`, a real
 * calendar day, in the site's own day (no time zone: the map says the site's dates are local); `time` `HH:MM` (00–23,
 * 00–59); `number` a finite number; `flag` true / false. A field marked `nullable` may also be null.
 */
export const BROWSER_FIELD_KINDS = ['id', 'id_list', 'id_set', 'text', 'date', 'time', 'number', 'flag'] as const
export type BrowserFieldKindName = typeof BROWSER_FIELD_KINDS[number]

export interface BrowserMapField {
  kind: BrowserFieldKindName
  /** The Japanese heading the card shows for it. */
  label: string
  nullable?: boolean
}

export interface BrowserMapThing {
  /** The Japanese name of the thing, shown on the card and in the admin notice. */
  label: string
  /** Only JSON answers are read strictly by this path (an HTML thing stays on today's checker path until one is needed). */
  answer: 'json'
  /** The field holding the thing's own id (kind `id`). */
  id: string
  /**
   * Where the id comes from (PR 3): `answer` (default) — the reader takes it out of the answer; `address` — the answer
   * does not carry it (a site's `GET /x/{id}` answers the object without its own number), so the core puts the id the
   * address was built with into the state, and the reader must not give one. Which address is the connector's code.
   */
  id_from?: 'answer' | 'address'
  /** What the thing lives in: the parent thing and the field holding the parent's id (kind `id`). */
  parent?: { thing: string; field: string }
  fields: Readonly<Record<string, BrowserMapField>>
  /**
   * Every key path the answer may carry (`inputs[].tag_ids`: keys joined by `.`, `[]` per list level). `required`: the
   * reader uses it and it stands in every object that should hold it; `optional`: the reader uses it, it may be absent;
   * `ignored` (読まない欄, e.g. an update time): never in the state, never compared — reviewed one by one.
   */
  keys: Readonly<Record<string, BrowserMapKeyUse>>
  /**
   * The thing's must-hold facts (memo §15 C5, PR 3): what every line reading it gets whether the line asks or not — a
   * line can neither drop nor loosen them. `account`: read under the outside account the card names (the account read
   * before and after the line's reads, the same, and the expected one when there is one); `parent`: every read of it names
   * its parent and the state's parent field must be that parent; `note`: a sentence the card always shows when it is read.
   */
  must_hold?: BrowserMustHold
}

export interface BrowserMustHold {
  account?: boolean
  parent?: boolean
  /** ≤ 200 characters, plain text: the site's knowledge the person must see (e.g. "this may be shared"). */
  note?: string
}

export const BROWSER_MAP_KEY_USES = ['required', 'optional', 'ignored'] as const
export type BrowserMapKeyUse = typeof BROWSER_MAP_KEY_USES[number]

export interface BrowserMap {
  /** The connector's id (as in `approved.json`). */
  site: string
  /** The map's version (semver). */
  version: string
  things: Readonly<Record<string, BrowserMapThing>>
  /** The outside account's heading on the card (required when a thing must hold `account`). */
  account?: { label: string }
}

export const BROWSER_MAP_LIMITS = { things: 20, fields: 40, keys: 200, depth: 8, label: 40, note: 200, answerPaths: 2000, diagnosisKeys: 50 } as const

/** A thing's, field's or value's name in a map or a line. */
export const BROWSER_MAP_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/
/**
 * One key of a JSON answer as a map may name it. A key of the answer that does not have this shape is always unknown: a
 * key `"a.b"` or `"a[]"` would otherwise spell the path of a nested key and pass for it.
 */
export const BROWSER_ANSWER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/**
 * A key path: keys joined by `.`, a key followed by `[]` once per list level it holds before a key of its items
 * (`inputs[].tag_ids`). Never `[]` at the end: a list is named by its key (`tags`), as the walker sees it.
 */
const KEY_PATH_RE = /^(?:[A-Za-z_][A-Za-z0-9_]{0,63}(?:\[\])*\.)*[A-Za-z_][A-Za-z0-9_]{0,63}$/
const SEMVER_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const onlyKeys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k))

/** Is this `YYYY-MM-DD` a real calendar day? */
export function isBrowserDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  if (y < 1 || m < 1 || m > 12 || d < 1) return false
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  return d <= days
}

const isId = (v: unknown): v is string => typeof v === 'string' && BROWSER_ID_VALUE_RE.test(v)

/** Does the value have the field's kind? */
export function browserFieldValueFits(field: BrowserMapField, v: unknown): boolean {
  if (v === null) return field.nullable === true
  switch (field.kind) {
    case 'id': return isId(v)
    case 'id_list': case 'id_set': return Array.isArray(v) && v.length <= 500 && v.every(isId)
    case 'text': return isPlainBrowserText(v, 5000, true)
    case 'date': return isBrowserDate(v)
    case 'time': return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'flag': return typeof v === 'boolean'
    default: return false
  }
}

/** Are two values of this field the same (an `id_set` in any order, each as often; text compared as NFC; nothing trimmed)? */
export function browserFieldValuesEqual(field: BrowserMapField, a: unknown, b: unknown): boolean {
  if (!browserFieldValueFits(field, a) || !browserFieldValueFits(field, b)) return false
  if (a === null || b === null) return a === b
  if (field.kind === 'id_set') {
    const x = [...(a as string[])].sort(), y = [...(b as string[])].sort()
    return x.length === y.length && x.every((id, i) => id === y[i])
  }
  if (field.kind === 'id_list') {
    const x = a as string[], y = b as string[]
    return x.length === y.length && x.every((id, i) => id === y[i])
  }
  if (field.kind === 'text') return (a as string).normalize('NFC') === (b as string).normalize('NFC')
  return a === b
}

/** Why this map cannot be used (Japanese, for the reviewer), or null. Checked where a map is loaded. */
export function browserMapProblem(raw: unknown): string | null {
  if (!isMap(raw) || !onlyKeys(raw, ['site', 'version', 'things', 'account'])) return '地図の形が正しくありません'
  if (typeof raw.site !== 'string' || !BROWSER_MAP_NAME_RE.test(raw.site)) return '地図のサイトの名前が正しくありません'
  if (typeof raw.version !== 'string' || !SEMVER_RE.test(raw.version)) return '地図の版が正しくありません'
  if (!isMap(raw.things)) return '地図のものの形が正しくありません'
  const names = Object.keys(raw.things)
  if (names.length === 0 || names.length > BROWSER_MAP_LIMITS.things) return '地図のものの数が正しくありません'
  for (const name of names) {
    if (!BROWSER_MAP_NAME_RE.test(name)) return 'ものの名前が正しくありません'
    const problem = thingProblem(raw.things[name], raw.things)
    if (problem) return `もの「${name}」：${problem}`
  }
  if (own(raw, 'account')) {
    const a = raw.account
    if (!isMap(a) || !onlyKeys(a, ['label']) || !isPlainBrowserText(a.label, BROWSER_MAP_LIMITS.label)) return 'アカウントの見出しが正しくありません'
  }
  const bound = Object.values(raw.things).some(t => isMap(t) && isMap(t.must_hold) && t.must_hold.account === true)
  if (bound && !own(raw, 'account')) return 'アカウントを守るものがあるのに、アカウントの見出しがありません'
  return null
}

function thingProblem(t: unknown, things: Record<string, unknown>): string | null {
  if (!isMap(t) || !onlyKeys(t, ['label', 'answer', 'id', 'id_from', 'parent', 'fields', 'keys', 'must_hold'])) return '形が正しくありません'
  if (!isPlainBrowserText(t.label, BROWSER_MAP_LIMITS.label)) return '見出しが正しくありません'
  if (t.answer !== 'json') return '読み方は json だけです'
  if (!isMap(t.fields)) return '欄の形が正しくありません'
  const fieldNames = Object.keys(t.fields)
  if (fieldNames.length === 0 || fieldNames.length > BROWSER_MAP_LIMITS.fields) return '欄の数が正しくありません'
  for (const f of fieldNames) {
    const field = t.fields[f]
    if (!BROWSER_MAP_NAME_RE.test(f)) return '欄の名前が正しくありません'
    if (!isMap(field) || !onlyKeys(field, ['kind', 'label', 'nullable'])) return `欄「${f}」の形が正しくありません`
    if (!(BROWSER_FIELD_KINDS as readonly unknown[]).includes(field.kind)) return `欄「${f}」の種類が正しくありません`
    if (!isPlainBrowserText(field.label, BROWSER_MAP_LIMITS.label)) return `欄「${f}」の見出しが正しくありません`
    if (own(field, 'nullable') && typeof field.nullable !== 'boolean') return `欄「${f}」の nullable が正しくありません`
  }
  const fields = t.fields as Record<string, BrowserMapField>
  if (typeof t.id !== 'string' || !own(fields, t.id) || fields[t.id].kind !== 'id' || fields[t.id].nullable) return '番号の欄が正しくありません'
  if (own(t, 'id_from') && t.id_from !== 'answer' && t.id_from !== 'address') return '番号の出どころが正しくありません'
  if (own(t, 'must_hold')) {
    const m = t.must_hold
    if (!isMap(m) || !onlyKeys(m, ['account', 'parent', 'note'])) return '必ず守る事実の形が正しくありません'
    if (own(m, 'account') && typeof m.account !== 'boolean') return '必ず守る事実（アカウント）が正しくありません'
    if (own(m, 'parent') && typeof m.parent !== 'boolean') return '必ず守る事実（親）が正しくありません'
    if (m.parent === true && !own(t, 'parent')) return '親を守るのに、親がありません'
    if (own(m, 'note') && !isPlainBrowserText(m.note, BROWSER_MAP_LIMITS.note)) return '必ず出す注意書きが正しくありません'
  }
  if (own(t, 'parent')) {
    const p = t.parent
    if (!isMap(p) || !onlyKeys(p, ['thing', 'field']) || typeof p.thing !== 'string' || typeof p.field !== 'string') return '親の形が正しくありません'
    if (!own(things, p.thing)) return '親のものが地図にありません'
    if (!own(fields, p.field) || fields[p.field].kind !== 'id' || p.field === t.id) return '親の番号の欄が正しくありません'
  }
  if (!isMap(t.keys)) return '鍵の一覧が正しくありません'
  const all = Object.keys(t.keys)
  if (all.length === 0 || all.length > BROWSER_MAP_LIMITS.keys) return '鍵の数が正しくありません'
  for (const k of all) {
    if (!KEY_PATH_RE.test(k) || pathDepth(k) > BROWSER_MAP_LIMITS.depth) return '鍵の書き方が正しくありません'
    if (!(BROWSER_MAP_KEY_USES as readonly unknown[]).includes(t.keys[k])) return '鍵の使い方が正しくありません'
  }
  const uses = t.keys
  if (!all.some(k => uses[k] !== 'ignored')) return '読む鍵がありません'
  // Every key's container must itself be listed (a key of a list's items needs the list): no key the map cannot reach.
  for (const k of all) {
    const parent = containerPath(k)
    if (parent !== null && !all.includes(parent)) return '鍵の入れ物が一覧にありません'
  }
  return null
}

const pathDepth = (p: string): number => p.split('.').length
/** The path of the key's container (`inputs[].type` → `inputs[]` written as the list key `inputs`), or null at the top. */
function containerPath(p: string): string | null {
  const i = p.lastIndexOf('.')
  if (i < 0) return null
  return p.slice(0, i).replace(/(?:\[\])+$/, '')
}

/** The kinds of "not read whole" told to the owner / admin (§16-1): never which key. */
export const BROWSER_SHAPE_CHANGES = ['unknown_keys', 'missing_keys', 'unreadable'] as const
export type BrowserShapeChange = typeof BROWSER_SHAPE_CHANGES[number]

/**
 * What the owner / admin is told when a thing was not read whole (§16-1 as revised by Codex round 2 R1): the site and
 * the map's version (the map's own words), the thing (a name the map has), the kind of change and how many. No key name,
 * no value, no page text: every string here comes from the map, never from the answer.
 */
export interface BrowserShapeNotice {
  site: string
  mapVersion: string
  thing: string
  change: BrowserShapeChange
  count: number
}

/** The member's sentence when a site's shape changed (§16-1): the same wherever it stops. No key, JSON or version word. */
export const BROWSER_SHAPE_WORDS = {
  member: 'サイトの形が変わったので確認中です。今回は手でお願いします。',
  /** Added when it stopped after the person approved (the re-read before sending). */
  notSent: '送っていません。',
} as const

/** A thing read whole: its state (exactly the map's fields). */
export interface BrowserThingRead { status: 'read'; state: Readonly<Record<string, unknown>> }
/**
 * A thing not read whole. `notices` may leave the PC (the admin notice); `diagnosis` holds the page's own key names and
 * **never leaves this PC** (§16-1: the FDE reads it there). `diagnosis` is capped and its keys are only those of the
 * answer's shape `BROWSER_ANSWER_KEY_RE` (others are counted, not named).
 */
export interface BrowserThingNotRead {
  status: 'not_read'
  notices: readonly BrowserShapeNotice[]
  diagnosis: { unknownKeys: readonly string[]; missingKeys: readonly string[] }
}
export type BrowserThingResult = BrowserThingRead | BrowserThingNotRead

/**
 * The connector's reader for one thing: the parsed answer (strict JSON) → the thing's state. Site code, in the connector's
 * folder. It may throw or hand back anything: the core checks what it gives.
 */
export type BrowserThingReader = (answer: unknown) => unknown

/**
 * Read one thing strictly (§3-2, §16-1): the answer's keys against the map's, then the reader's state against the map's
 * fields. Anything short of whole is `not_read` — never a partial state. The state's id is not checked against a planned
 * id here: the line's evaluation does that (`browser-read-line.ts`).
 */
export function readBrowserThing(map: BrowserMap, thingName: string, answer: unknown, reader: BrowserThingReader, address?: string): BrowserThingResult {
  const thing = own(map.things, thingName) ? map.things[thingName] : undefined
  const notRead = (change: BrowserShapeChange, count: number, unknownKeys: string[] = [], missingKeys: string[] = []): BrowserThingNotRead => ({
    status: 'not_read',
    notices: [{ site: map.site, mapVersion: map.version, thing: thingName, change, count }],
    diagnosis: { unknownKeys: unknownKeys.slice(0, BROWSER_MAP_LIMITS.diagnosisKeys), missingKeys: missingKeys.slice(0, BROWSER_MAP_LIMITS.diagnosisKeys) },
  })
  // A name the map does not have is never put in a notice (every string of a notice is the map's own).
  if (!thing) return { status: 'not_read', notices: [], diagnosis: { unknownKeys: [], missingKeys: [] } }
  const keys = browserAnswerKeysProblem(thing, answer)
  if (keys === 'unreadable') return notRead('unreadable', 1)
  if (keys.unknownCount > 0 || keys.missing.length > 0) {
    const notices: BrowserShapeNotice[] = []
    if (keys.unknownCount > 0) notices.push({ site: map.site, mapVersion: map.version, thing: thingName, change: 'unknown_keys', count: keys.unknownCount })
    if (keys.missing.length > 0) notices.push({ site: map.site, mapVersion: map.version, thing: thingName, change: 'missing_keys', count: keys.missing.length })
    return {
      status: 'not_read', notices,
      diagnosis: { unknownKeys: keys.unknownNamed.slice(0, BROWSER_MAP_LIMITS.diagnosisKeys), missingKeys: keys.missing.slice(0, BROWSER_MAP_LIMITS.diagnosisKeys) },
    }
  }
  let state: unknown
  try { state = reader(answer) } catch { return notRead('unreadable', 1) }
  // Copied once, then checked and handed on: what was checked is what is used (review L3).
  const copy = isMap(state) ? Object.fromEntries(Object.entries(state).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])) : state
  if (thing.id_from === 'address') {
    // The answer does not carry its id: the address's id stands in, and a reader that made one up is not trusted.
    if (typeof address !== 'string' || !BROWSER_ID_VALUE_RE.test(address) || !isMap(copy) || own(copy, thing.id)) return notRead('unreadable', 1)
    const withId = copy as Record<string, unknown>
    withId[thing.id] = address
  }
  if (browserThingStateProblem(thing, copy)) return notRead('unreadable', 1)
  return { status: 'read', state: copy as Record<string, unknown> }
}

/** Why a state is not one of this thing (a field missing, an extra one, a value not of its kind), or null. */
export function browserThingStateProblem(thing: BrowserMapThing, state: unknown): string | null {
  if (!isMap(state)) return 'not-an-object'
  for (const k of Object.keys(state)) if (!own(thing.fields, k)) return 'extra-field'
  for (const [name, field] of Object.entries(thing.fields)) {
    if (!own(state, name)) return 'missing-field'
    if (!browserFieldValueFits(field, state[name])) return 'bad-value'
  }
  return null
}

/**
 * The answer's keys against the map's (§3-2): every key at every depth must be listed, every `required` key present in
 * each object at its place, every container the map describes of its shape (an object where it lists keys, a list of the
 * listed depth where it lists items; null only when not required). `unknownCount` counts distinct unknown key paths (a
 * key not of `BROWSER_ANSWER_KEY_RE` counts and is never named); `missing` the required keys absent somewhere and the
 * places of the wrong shape (map paths). 'unreadable' when the
 * answer is not an object, too deep or too large to walk.
 */
export function browserAnswerKeysProblem(thing: BrowserMapThing, answer: unknown):
  { unknownCount: number; unknownNamed: string[]; missing: string[] } | 'unreadable' {
  if (!isMap(answer)) return 'unreadable'
  const allKeys = Object.keys(thing.keys)
  const known = new Set(allKeys)
  const required = Object.keys(thing.keys).filter(k => thing.keys[k] === 'required')
  const unknown = new Set<string>()
  const unknownNamed = new Set<string>()
  const missing = new Set<string>()
  let paths = 0
  let tooBig = false
  // Walks one object found at `at` (its key path, '' at the top; a list's items are at the list's path + `[]`).
  const walkObject = (obj: Record<string, unknown>, at: string, depth: number): void => {
    if (tooBig) return
    if (depth > BROWSER_MAP_LIMITS.depth) { tooBig = true; return }
    for (const r of required) if (objectPathOf(r) === at && !own(obj, lastKey(r))) missing.add(r)
    for (const key of Object.keys(obj)) {
      if (++paths > BROWSER_MAP_LIMITS.answerPaths) { tooBig = true; return }
      if (!BROWSER_ANSWER_KEY_RE.test(key)) { unknown.add(`\u0000${at}\u0000${key}`); continue }
      const path = at === '' ? key : `${at}.${key}`
      if (!known.has(path)) { unknown.add(path); unknownNamed.add(path); continue }
      walkValue(obj[key], path, depth + 1, thing.keys[path] !== 'required')
    }
  }
  // What the map holds below a place: keys of an object (`P.x`), items of a list (`P[]…`), or nothing (a leaf).
  const holds = (at: string): 'object' | 'list' | null =>
    allKeys.some(k => k.startsWith(`${at}.`)) ? 'object' : allKeys.some(k => k.startsWith(`${at}[]`)) ? 'list' : null
  // A container the map describes must have that shape (review M1: else its required keys would never be asked):
  // an object where it lists keys, a list (of the listed depth) where it lists items; null only for a key not required.
  const walkValue = (v: unknown, path: string, depth: number, nullable: boolean): void => {
    if (tooBig) return
    if (depth > BROWSER_MAP_LIMITS.depth) { tooBig = true; return }
    const shape = holds(path)
    if (shape !== null && v === null) { if (!nullable) missing.add(path); return }
    if (shape === 'object' && !isMap(v)) { missing.add(path); return }
    if (shape === 'list' && !Array.isArray(v)) { missing.add(path); return }
    if (Array.isArray(v)) {
      if (v.length > BROWSER_MAP_LIMITS.answerPaths) { tooBig = true; return }
      for (const item of v) walkValue(item, `${path}[]`, depth + 1, false)
      return
    }
    if (isMap(v)) walkObject(v, path, depth)
    else if (v !== null && typeof v === 'object') tooBig = true
  }
  walkObject(answer, '', 0)
  if (tooBig) return 'unreadable'
  return { unknownCount: unknown.size, unknownNamed: [...unknownNamed], missing: [...missing] }
}

const lastKey = (p: string): string => p.slice(p.lastIndexOf('.') + 1).replace(/(?:\[\])+$/, '')
/** The key path of the object a key stands in ('' at the top): `inputs[].type` → `inputs[]`. */
const objectPathOf = (p: string): string => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(0, i) }
