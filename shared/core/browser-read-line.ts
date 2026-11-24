/**
 * The read part of an opened line (「開けた1行」の読む部分, generalization PR 2; `agent-browser.md` "The read-side words").
 * Internal design memo 「ブラウザ操作の汎用化」 §3-5, §3-6, §7-3, §15 C6 / C14, §16-4, §17, §18. Pure; nothing in the app or
 * the server calls it yet.
 *
 * A line names the values a plan takes (each with a role and where it may come from), the things it reads (each by an
 * id from a value or from a field of an earlier read) and the checks (確かめの言葉) main computes from what the site's
 * readers read — never from the AI's word. The words are a **closed list** whose arguments are names only (a read, a
 * field of the map, a value, a format from a closed list): no expression, condition or calculation (plugins.md §8-1, §15
 * C14 「型のある小さな表し方」). Adding a word is a change of the core (model, tests, independent review); adding one
 * opens nothing.
 *
 * Rules held here (each guarded by `browser-read-words.test.ts`):
 * - **Strict read**: a plan is made only when every read of the line was read whole (`browser-map.ts`).
 * - **Unreadable is never ✓**: a check whose material was not read whole, or is not the object asked for, is
 *   `unreadable`, and anything but ✓ makes no plan.
 * - **Where a value comes from** (§16-4, owner decision Q14 §18): a value that decides *which* object or *when* (`which`,
 *   what a check compares against) comes only from (a) a record field a business plugin bound, or (b) a person who
 *   confirmed it on the card, one by one — never the AI alone and never the site; a record field the AI wrote last counts
 *   as needing the person (Codex round 2 R5). A target id is (c), a fact read from the site.
 *
 * The core knows no site, thing or field. The shapes are **provisional** until a second site fits them (§18).
 */
import { BROWSER_ID_VALUE_RE, isPlainBrowserText } from './plugin-browser-declaration'
import {
  BROWSER_MAP_NAME_RE, browserFieldValuesEqual, browserThingStateProblem, isBrowserDate,
  type BrowserMap, type BrowserMapThing, type BrowserThingResult,
} from './browser-map'

/** Where a value comes from (§16-4): (a) `record_field`, (b) `person`, (c) `site_fact`, or the AI alone. */
export const BROWSER_VALUE_SOURCES = ['record_field', 'person', 'site_fact', 'ai'] as const
export type BrowserValueSource = typeof BROWSER_VALUE_SOURCES[number]

/** What a value is for: the id of an object to read (`target`), what decides which / when (`which`), or a value to write. */
export const BROWSER_VALUE_ROLES = ['target', 'which', 'write'] as const
export type BrowserValueRole = typeof BROWSER_VALUE_ROLES[number]

/**
 * Where each role's value may come from (§16-4). The one copy of the rule: the line's validator and the plan's values
 * both ask it. `which` never `ai` or `site_fact`; `target` only what the site showed.
 */
export const BROWSER_ROLE_SOURCES: Readonly<Record<BrowserValueRole, readonly BrowserValueSource[]>> = {
  target: ['site_fact'],
  which: ['record_field', 'person'],
  write: ['record_field', 'person', 'site_fact', 'ai'],
}

export const BROWSER_VALUE_KINDS = ['id', 'text', 'date'] as const
export type BrowserValueKind = typeof BROWSER_VALUE_KINDS[number]

export interface BrowserLineValue {
  kind: BrowserValueKind
  role: BrowserValueRole
  /** The sources this line accepts (a subset of what the role allows). */
  from: readonly BrowserValueSource[]
}

/** One thing the line reads: by a value's id, or by an id field of an earlier read. */
export interface BrowserLineRead {
  name: string
  thing: string
  id: { value: string } | { read: string; field: string }
}

/** How a date may be written in a text (closed; a line picks one, §16-2: the business plugin's choice, never the core's). */
export const BROWSER_DATE_FORMATS = ['YYYYMMDD', 'YYYY-MM-DD', 'M/D'] as const
export type BrowserDateFormat = typeof BROWSER_DATE_FORMATS[number]

/**
 * The check words (§3-6, §16-4). `now` words judge a state just read (before a write — or, in later PRs, the predicted
 * state); `after` words compare a read before a write with the read after it and are never ✓ before (`later`, C14).
 * - `unchanged_except` — `read` is the same as `reference` (the same kind of thing) in every field but its id and `except`.
 * - `source_unchanged` — `read` after the writes is exactly what it was before them (after only).
 * - `no_sibling_named` — no other thing in the same parent has the same `field` text, compared by `siblingNameKey`
 *   (the parent's list read whole).
 * - `date_in_text` — the text `field` holds the `date` value written in `format`, and no other date in that format.
 * - `datetime_on_date` — the date `field` (the date part of the site's date and time) is the `date` value.
 */
export type BrowserCheck =
  | { word: 'unchanged_except'; read: string; reference: string; except: readonly string[] }
  | { word: 'source_unchanged'; read: string }
  | { word: 'no_sibling_named'; read: string; field: string }
  | { word: 'date_in_text'; read: string; field: string; date: string; format: BrowserDateFormat }
  | { word: 'datetime_on_date'; read: string; field: string; date: string }
export type BrowserCheckWord = BrowserCheck['word']

export const BROWSER_CHECK_WORDS: Readonly<Record<BrowserCheckWord, { when: 'now' | 'after'; args: readonly string[] }>> = {
  unchanged_except: { when: 'now', args: ['read', 'reference', 'except'] },
  source_unchanged: { when: 'after', args: ['read'] },
  no_sibling_named: { when: 'now', args: ['read', 'field'] },
  date_in_text: { when: 'now', args: ['read', 'field', 'date', 'format'] },
  datetime_on_date: { when: 'now', args: ['read', 'field', 'date'] },
}

/** The read part of an opened line. Provisional (§18): PR 3 puts it in the opened list's format. */
export interface BrowserReadLine {
  site: string
  values: Readonly<Record<string, BrowserLineValue>>
  reads: readonly BrowserLineRead[]
  checks: readonly BrowserCheck[]
}

export const BROWSER_READ_LINE_LIMITS = { values: 10, reads: 10, checks: 20, except: 40 } as const

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(k => own(v, k))
const isName = (v: unknown): v is string => typeof v === 'string' && BROWSER_MAP_NAME_RE.test(v)

/**
 * Why this read part cannot be opened against this map (Japanese, for the reviewer), or null (§17-2 「行の検査」): only
 * things and fields the map has, only the core's words with arguments of the right kind, every value's sources allowed
 * for its role, every value used, reads by ids that are site facts. A line with no write cannot use an `after` word.
 */
export function browserReadLineProblem(raw: unknown, map: BrowserMap): string | null {
  if (!isMap(raw) || !exactKeys(raw, ['site', 'values', 'reads', 'checks'])) return '行の形が正しくありません'
  if (raw.site !== map.site) return '行のサイトが地図と違います'
  if (!isMap(raw.values) || Object.keys(raw.values).length > BROWSER_READ_LINE_LIMITS.values) return '値の形が正しくありません'
  const values: Record<string, BrowserLineValue> = {}
  for (const [name, v] of Object.entries(raw.values)) {
    if (!isName(name)) return '値の名前が正しくありません'
    if (!isMap(v) || !exactKeys(v, ['kind', 'role', 'from'])) return `値「${name}」の形が正しくありません`
    if (!(BROWSER_VALUE_KINDS as readonly unknown[]).includes(v.kind)) return `値「${name}」の種類が正しくありません`
    if (!(BROWSER_VALUE_ROLES as readonly unknown[]).includes(v.role)) return `値「${name}」の役目が正しくありません`
    const role = v.role as BrowserValueRole
    if (!Array.isArray(v.from) || v.from.length === 0 || new Set(v.from).size !== v.from.length) return `値「${name}」の出どころが正しくありません`
    if (!v.from.every(s => (BROWSER_VALUE_SOURCES as readonly unknown[]).includes(s))) return `値「${name}」の出どころが正しくありません`
    if (!v.from.every(s => BROWSER_ROLE_SOURCES[role].includes(s as BrowserValueSource))) return `値「${name}」は、その役目では使えない出どころから来ます`
    if (role === 'target' && v.kind !== 'id') return `値「${name}」：対象は番号です`
    values[name] = v as unknown as BrowserLineValue
  }
  const used = new Set<string>()
  if (!Array.isArray(raw.reads) || raw.reads.length === 0 || raw.reads.length > BROWSER_READ_LINE_LIMITS.reads) return '読むものの数が正しくありません'
  const reads: Record<string, BrowserMapThing> = {}
  for (const r of raw.reads) {
    if (!isMap(r) || !exactKeys(r, ['name', 'thing', 'id'])) return '読むものの形が正しくありません'
    if (!isName(r.name) || own(reads, r.name)) return '読むものの名前が正しくありません'
    if (typeof r.thing !== 'string' || !own(map.things, r.thing)) return `読むもの「${r.name}」のものが地図にありません`
    const id = r.id
    if (isMap(id) && exactKeys(id, ['value'])) {
      if (typeof id.value !== 'string' || !own(values, id.value)) return `読むもの「${r.name}」の番号の値がありません`
      if (values[id.value].role !== 'target') return `読むもの「${r.name}」の番号は、対象の値でなければなりません`
      used.add(id.value)
    } else if (isMap(id) && exactKeys(id, ['read', 'field'])) {
      if (typeof id.read !== 'string' || !own(reads, id.read)) return `読むもの「${r.name}」の番号は、前に読んだものから取ります`
      const from = reads[id.read]
      if (typeof id.field !== 'string' || !own(from.fields, id.field) || from.fields[id.field].kind !== 'id') return `読むもの「${r.name}」の番号の欄が正しくありません`
      // Its own id would read the same object again: a check against it would compare a thing with itself (review L2).
      if (id.field === from.id) return `読むもの「${r.name}」は、前に読んだものと同じものです`
    } else return `読むもの「${r.name}」の番号の形が正しくありません`
    reads[r.name] = map.things[r.thing]
  }
  if (!Array.isArray(raw.checks) || raw.checks.length > BROWSER_READ_LINE_LIMITS.checks) return '確かめの数が正しくありません'
  const readThing = (n: unknown): BrowserMapThing | null => (typeof n === 'string' && own(reads, n) ? reads[n] : null)
  const textField = (t: BrowserMapThing, f: unknown, kind: string): boolean => typeof f === 'string' && own(t.fields, f) && t.fields[f].kind === kind
  const whichDate = (n: unknown): boolean => typeof n === 'string' && own(values, n) && values[n].kind === 'date' && values[n].role === 'which'
  for (const [i, c] of raw.checks.entries()) {
    const at = `確かめ ${i + 1}`
    if (!isMap(c) || typeof c.word !== 'string' || !own(BROWSER_CHECK_WORDS, c.word)) return `${at}：本体の言葉ではありません`
    const word = BROWSER_CHECK_WORDS[c.word as BrowserCheckWord]
    if (!exactKeys(c, ['word', ...word.args])) return `${at}：引数が正しくありません`
    if (word.when === 'after') return `${at}：書き込みのない行では、書いたあとの確かめは使えません`
    const t = readThing(c.read)
    if (!t) return `${at}：読むものがありません`
    switch (c.word) {
      case 'unchanged_except': {
        const ref = readThing(c.reference)
        if (!ref || c.reference === c.read || ref !== t) return `${at}：比べる相手は、同じ種類の別に読んだものです`
        if (!Array.isArray(c.except) || c.except.length > BROWSER_READ_LINE_LIMITS.except || new Set(c.except).size !== c.except.length) return `${at}：除く欄が正しくありません`
        if (!c.except.every(f => typeof f === 'string' && own(t.fields, f) && f !== t.id)) return `${at}：除く欄が地図にありません`
        break
      }
      case 'no_sibling_named':
        if (!t.parent) return `${at}：親のないものです`
        if (!textField(t, c.field, 'text')) return `${at}：欄は文字の欄です`
        break
      case 'date_in_text':
        if (!textField(t, c.field, 'text')) return `${at}：欄は文字の欄です`
        if (!(BROWSER_DATE_FORMATS as readonly unknown[]).includes(c.format)) return `${at}：日付の書き方が正しくありません`
        if (!whichDate(c.date)) return `${at}：基準の日付は、どれ・いつを決める日付の値です`
        used.add(c.date as string)
        break
      case 'datetime_on_date':
        if (!textField(t, c.field, 'date')) return `${at}：欄は日付の欄です`
        if (!whichDate(c.date)) return `${at}：基準の日付は、どれ・いつを決める日付の値です`
        used.add(c.date as string)
        break
    }
  }
  for (const name of Object.keys(values)) if (!used.has(name)) return `値「${name}」はこの行で使われていません`
  return null
}

/** How a supplied value came to be (the app fills it from where it really came; the server re-checks later PRs' parts). */
export type BrowserValueOrigin =
  | { kind: 'record_field'; aiWroteLast: boolean }
  | { kind: 'person'; confirmed: boolean }
  | { kind: 'site_fact' }
  | { kind: 'ai' }

export interface BrowserSuppliedValue { value: string; from: BrowserValueOrigin }

/** Why the supplied values do not make a plan: a fixed word and the line's value name (never the value), or null. */
export type BrowserValueProblem = { problem: 'missing' | 'extra' | 'shape' | 'source' | 'unconfirmed'; value: string }

/**
 * The plan's values against the line (§16-4, Q14): each declared value present, of its kind, from a source the line and
 * the role allow. A `which` value from a record field the AI wrote last, or a person's value not yet confirmed, is
 * `unconfirmed` (the card asks the person, one value at a time). Never accepted for `which`: the AI alone, the site.
 */
export function browserLineValuesProblem(line: BrowserReadLine, supplied: unknown): BrowserValueProblem | null {
  if (!isMap(supplied)) return { problem: 'missing', value: '' }
  for (const name of Object.keys(supplied)) if (!own(line.values, name)) return { problem: 'extra', value: '' }
  for (const [name, decl] of Object.entries(line.values)) {
    const v = own(supplied, name) ? supplied[name] : undefined
    if (!isMap(v) || !exactKeys(v, ['value', 'from']) || !isMap(v.from)) return { problem: 'missing', value: name }
    if (!valueFits(decl.kind, v.value)) return { problem: 'shape', value: name }
    const from = v.from as Record<string, unknown>
    const kind = from.kind
    if (!(BROWSER_VALUE_SOURCES as readonly unknown[]).includes(kind)) return { problem: 'source', value: name }
    const source = kind as BrowserValueSource
    const allowed = BROWSER_ROLE_SOURCES[decl.role]
    if (!allowed.includes(source) || !decl.from.includes(source)) return { problem: 'source', value: name }
    if (source === 'record_field') {
      if (!exactKeys(from, ['kind', 'aiWroteLast']) || typeof from.aiWroteLast !== 'boolean') return { problem: 'source', value: name }
      // Codex round 2 R5: a field the AI wrote last is the AI's value; only a person's confirmation makes it usable.
      if (from.aiWroteLast && !allowed.includes('ai')) return { problem: 'unconfirmed', value: name }
    } else if (source === 'person') {
      if (!exactKeys(from, ['kind', 'confirmed']) || typeof from.confirmed !== 'boolean') return { problem: 'source', value: name }
      if (!from.confirmed) return { problem: 'unconfirmed', value: name }
    } else if (!exactKeys(from, ['kind'])) return { problem: 'source', value: name }
  }
  return null
}

function valueFits(kind: BrowserValueKind, v: unknown): v is string {
  if (kind === 'id') return typeof v === 'string' && BROWSER_ID_VALUE_RE.test(v)
  if (kind === 'date') return isBrowserDate(v)
  return isPlainBrowserText(v, 200)
}

/** A parent's children as the site's list read them: whole, or not. A list not read whole is never "no other". */
export type BrowserSiblingsRead = { status: 'read'; items: readonly unknown[] } | { status: 'not_read' }

/** What main read for a line (never the AI's word): each read's strict result, the parents' lists, the values. */
export interface BrowserReadFacts {
  reads: Readonly<Record<string, BrowserThingResult>>
  /** For `no_sibling_named`: the read's parent's children, read whole. */
  siblings?: Readonly<Record<string, BrowserSiblingsRead>>
  /** For `after` words: the same reads made before the write. */
  earlier?: Readonly<Record<string, BrowserThingResult>>
  values: Readonly<Record<string, BrowserSuppliedValue>>
}

/** ✓ / ✗ / could not be read / judged only after the write. Only `ok` is ✓; nothing turns `unreadable` into `ok`. */
export type BrowserCheckStatus = 'ok' | 'ng' | 'unreadable' | 'later'

export interface BrowserCheckResult {
  word: BrowserCheckWord
  status: BrowserCheckStatus
  /** `unchanged_except` / `source_unchanged` ✗: the map's names of the fields that differ (for the card's headings). */
  differs?: readonly string[]
}

/** Why a line's reads make no plan: a fixed word (never page text). */
export type BrowserReadPlanProblem = 'line' | 'values' | 'not-read' | 'wrong-object' | 'check-ng' | 'check-unreadable'

export interface BrowserReadLineOutcome {
  /** null only when every read was read whole, is the object asked for, the values pass and every `now` check is ✓. */
  problem: BrowserReadPlanProblem | null
  values: BrowserValueProblem | null
  checks: readonly BrowserCheckResult[]
}

/**
 * Judge a line's reads (`phase` `now`: before any write; `after`: after the writes, with `earlier`). The strict-read
 * rule: a read not read whole, or whose id is not the one asked for, makes no plan even when no check uses it.
 */
export function evaluateBrowserReadLine(line: BrowserReadLine, map: BrowserMap, facts: BrowserReadFacts, phase: 'now' | 'after' = 'now'): BrowserReadLineOutcome {
  if (browserReadLineProblem(line, map)) return { problem: 'line', values: null, checks: [] }
  // The values copied once (plain data), then checked and used: what was checked is what is used (review L3).
  let values: Record<string, BrowserSuppliedValue>
  try { values = JSON.parse(JSON.stringify(facts.values ?? null)) as Record<string, BrowserSuppliedValue> } catch { return { problem: 'values', values: { problem: 'missing', value: '' }, checks: [] } }
  facts = { ...facts, values }
  const valueProblem = browserLineValuesProblem(line, facts.values)
  // Each read's state, only when read whole and the object asked for; otherwise null (and why).
  const states: Record<string, Readonly<Record<string, unknown>> | null> = {}
  let readProblem: BrowserReadPlanProblem | null = null
  for (const r of line.reads) {
    const thing = map.things[r.thing]
    const got = own(facts.reads, r.name) ? facts.reads[r.name] : undefined
    const state = got && got.status === 'read' && !browserThingStateProblem(thing, got.state) ? got.state : null
    const wanted = 'value' in r.id
      ? (!valueProblem && own(facts.values, r.id.value) ? facts.values[r.id.value].value : null)
      : (states[r.id.read]?.[r.id.field] ?? null)
    if (!state) { states[r.name] = null; readProblem ??= 'not-read'; continue }
    if (typeof wanted !== 'string' || state[thing.id] !== wanted) { states[r.name] = null; readProblem ??= 'wrong-object'; continue }
    states[r.name] = state
  }
  const checks = line.checks.map(c => judge(c, line, map, facts, states, phase, valueProblem === null))
  const problem: BrowserReadPlanProblem | null = valueProblem ? 'values'
    : readProblem
      ?? (checks.some(c => c.status === 'ng') ? 'check-ng'
        : checks.some(c => c.status === 'unreadable' || (phase === 'after' && c.status === 'later')) ? 'check-unreadable' : null)
  return { problem, values: valueProblem, checks }
}

function judge(
  c: BrowserCheck, line: BrowserReadLine, map: BrowserMap, facts: BrowserReadFacts,
  states: Record<string, Readonly<Record<string, unknown>> | null>, phase: 'now' | 'after', valuesOk: boolean,
): BrowserCheckResult {
  const word = c.word
  const unreadable: BrowserCheckResult = { word, status: 'unreadable' }
  const thing = map.things[(line.reads.find(r => r.name === c.read) as BrowserLineRead).thing]
  const state = states[c.read]
  switch (c.word) {
    case 'source_unchanged': {
      if (phase !== 'after') return { word, status: 'later' }
      const before = facts.earlier && own(facts.earlier, c.read) ? facts.earlier[c.read] : undefined
      return state ? sourceUnchanged(thing, before, facts.reads[c.read]) : unreadable
    }
    case 'unchanged_except': {
      const ref = states[c.reference]
      if (!state || !ref) return unreadable
      const differs = Object.entries(thing.fields)
        .filter(([f]) => f !== thing.id && !c.except.includes(f))
        .filter(([f, field]) => !browserFieldValuesEqual(field, ref[f], state[f])).map(([f]) => f)
      return differs.length ? { word, status: 'ng', differs } : { word, status: 'ok' }
    }
    case 'no_sibling_named': {
      const list = facts.siblings && own(facts.siblings, c.read) ? facts.siblings[c.read] : undefined
      const parentField = thing.parent?.field
      if (!state || !list || list.status !== 'read' || !parentField || typeof state[c.field] !== 'string') return unreadable
      if (list.items.some(item => browserThingStateProblem(thing, item))) return unreadable
      const items = list.items as readonly Readonly<Record<string, unknown>>[]
      // The list must be this thing's parent's, holding the thing itself exactly once: else it is not the list asked for.
      if (items.some(item => item[parentField] !== state[parentField])) return unreadable
      if (items.filter(item => item[thing.id] === state[thing.id]).length !== 1) return unreadable
      const name = siblingNameKey(state[c.field] as string)
      const same = items.some(item => item[thing.id] !== state[thing.id] && typeof item[c.field] === 'string' && siblingNameKey(item[c.field] as string) === name)
      return { word, status: same ? 'ng' : 'ok' }
    }
    case 'date_in_text': {
      if (!state || !valuesOk) return unreadable
      const text = state[c.field]
      if (text === null) return { word, status: 'ng' }
      if (typeof text !== 'string') return unreadable
      return { word, status: dateInText(text, facts.values[c.date].value, c.format) ? 'ok' : 'ng' }
    }
    case 'datetime_on_date': {
      if (!state || !valuesOk) return unreadable
      const day = state[c.field]
      if (day === null) return { word, status: 'ng' }
      return { word, status: day === facts.values[c.date].value ? 'ok' : 'ng' }
    }
  }
}

/**
 * The key `no_sibling_named` compares names by (owner decision 2026-11-24: refuse more, the safe side): NFC, full-width
 * ASCII and the ideographic space folded to half-width (for this purpose only, not a general NFKC), whitespace runs
 * collapsed to one space and trimmed, A–Z case-folded. So 「参加者_20261203 」, 「参加者＿２０２６１２０３」 and a name differing
 * only in ASCII case count as the same name. Knows no site.
 */
export function siblingNameKey(text: string): string {
  return text.normalize('NFC')
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, ' ') // every whitespace run, the ideographic space U+3000 included
    .trim()
    .replace(/[A-Z]/g, ch => ch.toLowerCase())
}

/**
 * `source_unchanged` on one thing: the read before the writes and the read after them, both whole, the same in every
 * field (its id included). Anything not read whole is `unreadable`. Exported for the write path (PR 5), whose lines are
 * the only ones that may hold it.
 */
export function sourceUnchanged(thing: BrowserMapThing, before: BrowserThingResult | undefined, after: BrowserThingResult | undefined): BrowserCheckResult {
  const word = 'source_unchanged'
  if (!before || !after || before.status !== 'read' || after.status !== 'read') return { word, status: 'unreadable' }
  if (browserThingStateProblem(thing, before.state) || browserThingStateProblem(thing, after.state)) return { word, status: 'unreadable' }
  const differs = Object.entries(thing.fields).filter(([f, field]) => !browserFieldValuesEqual(field, before.state[f], after.state[f])).map(([f]) => f)
  return differs.length ? { word, status: 'ng', differs } : { word, status: 'ok' }
}

/**
 * Does the text hold this date in the format, and no other day in any date-like spelling? The date must stand in the
 * chosen format (a real day: an 8-digit number that is no date is not one) (ASCII digits, nothing but a separator-free edge next to it: `20261203` is not in `202612031`, `12/3` not
 * in `12/31`, `2026/12/3` or `112/3`), and every one found so is the date. Then the whole text, NFKC-folded (full-width
 * digits count), is scanned for every date-like spelling — `YYYYMMDD`, `YYYY-M-D` / `YYYY/M/D` / `YYYY.M.D`,
 * `YYYY年M月D日`, `M/D`, `M月D日` — and one naming another day (a year-less one: another month or day) is ✗ (§15 C6
 * 「部分一致しない」, review M2: `20261203（変更: 2026/12/04）` ✗). A number that only looks like a date is ✗ too: the safe
 * side. `M/D` has no year: the line chose it, the year is not checked.
 */
export function dateInText(text: string, date: string, format: BrowserDateFormat): boolean {
  if (!isBrowserDate(date)) return false
  const [y, m, d] = date.split('-')
  const wanted = format === 'YYYYMMDD' ? `${y}${m}${d}` : format === 'YYYY-MM-DD' ? date : `${Number(m)}/${Number(d)}`
  const pattern = format === 'YYYYMMDD' ? /(?<![\d])(\d{8})(?![\d])/g
    : format === 'YYYY-MM-DD' ? /(?<![\d\-/.])(\d{4}-\d{2}-\d{2})(?![\d\-/.])/g
      : /(?<![\d\-/.])(\d{1,2}\/\d{1,2})(?![\d\-/.])/g
  // Only spellings that are real days count (a phone number's 8 digits are no date); another real day is ✗ below.
  const real = (t: string): boolean => format === 'YYYYMMDD' ? isBrowserDate(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`)
    : format === 'YYYY-MM-DD' ? isBrowserDate(t)
      : t.split('/').every((n, i) => Number(n) >= 1 && Number(n) <= (i === 0 ? 12 : 31))
  const inFormat = [...text.matchAll(pattern)].map(x => x[1]).filter(real)
  if (!inFormat.includes(wanted) || inFormat.some(s => s !== wanted)) return false
  const { full, monthDay } = datesIn(text.normalize('NFKC'))
  return full.every(f => f === date) && monthDay.every(md => md === `${Number(m)}/${Number(d)}`)
}

/** Every date-like spelling in a (NFKC-folded) text: whole dates as `YYYY-MM-DD`, year-less ones as `M/D`. Not a real day = kept as is (never equal). */
function datesIn(text: string): { full: string[]; monthDay: string[] } {
  const full: string[] = []
  const monthDay: string[] = []
  const day = (yy: string, mm: string, dd: string): string => {
    const iso = `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
    return isBrowserDate(iso) ? iso : `?${yy}${mm}${dd}`
  }
  for (const x of text.matchAll(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g)) {
    const iso = day(x[1], x[2], x[3])
    if (!iso.startsWith('?')) full.push(iso)
  }
  for (const x of text.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) full.push(day(x[1], x[2], x[3]))
  for (const x of text.matchAll(/(?<!\d)(\d{4})年(\d{1,2})月(\d{1,2})日/g)) full.push(day(x[1], x[2], x[3]))
  for (const x of text.matchAll(/(?<![\d\-/.])(\d{1,2})\/(\d{1,2})(?![\d\-/.])/g)) monthDay.push(`${Number(x[1])}/${Number(x[2])}`)
  for (const x of text.matchAll(/(?<!\d)(\d{1,2})月(\d{1,2})日/g)) monthDay.push(`${Number(x[1])}/${Number(x[2])}`)
  return { full, monthDay }
}
