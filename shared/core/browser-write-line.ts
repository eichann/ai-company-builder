/**
 * The write part of an opened line (「使ってよい組み合わせ」の書き込み, generalization PR 6; `agent-browser.md` "The write
 * words and the first write line"). Internal design memo 「ブラウザ操作の汎用化」 §3-3 (the verbs), §3-4 (one generic check:
 * read → predict → write → read → compare), §4-1 (the harmless prefix, I4), §5 (I2, I3), §6 (the step-template line),
 * §15 C4 / C5 / C7 / C11, §17, §18. Pure; nothing in the app or the server writes with it yet (the server still refuses
 * every plan of writes, `BROWSER_LINE_WRITES_NOT_YET`).
 *
 * A line's writes are a list of `{ read, verb, field, value }`: write `value` with `verb` into `field` of the object the
 * line's read `read` named. Rules held here (each guarded by `browser-write-words.test.ts`):
 * - **Only what the map lets** (C7): the read's thing lists the verb and the field in its `writes`; the verbs are a closed
 *   list (`BROWSER_WRITE_VERBS`: `add_child` only — §17-3, a verb comes with a case that needs it).
 * - **The harmless prefix** (§4-1, I4): before its last write a line writes only to what its own execution created. No
 *   verb creates anything yet, so every object a line names existed before it and **only one write may stand** (the last).
 * - **Named by the plan's values** (C11): a written object's id and its parent's are `target` values (what the site
 *   showed), so the server derives the lock key from the plan alone, byte-equal to the old path's key for the same object
 *   (`browserLineWriteLocks`).
 * - **What is added was read** (C5): an `add_child` value is a value the line reads as an object of the same account.
 * - **The prediction** (§3-4 step 2, I3): from the states read before, the core computes every read's state after the
 *   writes — the written field with exactly the added id, every other field and every other read unchanged (what the
 *   line reads: a change elsewhere on the site is not seen, as on the old path). After the
 *   write, the line's reads made again must equal that prediction **exactly**, under the same account and with every
 *   must-hold fact held (`judgeBrowserWrites`); anything else is "not as predicted" or "could not be read", never done.
 *
 * The core knows no site, thing or field. Every shape is **provisional** until a second site fits it (§18).
 */
import { BROWSER_ID_VALUE_RE } from './plugin-browser-declaration'
import {
  BROWSER_WRITE_VERBS, browserFieldValuesEqual, browserThingStateProblem,
  type BrowserMap, type BrowserMapThing, type BrowserWriteVerb,
} from './browser-map'
import {
  evaluateBrowserReadLine, type BrowserLineIdSource, type BrowserReadFacts, type BrowserReadLine, type BrowserReadStatus,
} from './browser-read-line'
import { browserObjectLockKey } from './browser-plans'

/** One write of a line: `verb` `value` into `field` of the object the line's read `read` named. */
export interface BrowserLineWrite {
  read: string
  verb: BrowserWriteVerb
  field: string
  value: string
}

export const BROWSER_WRITE_LINE_LIMITS = { writes: 3 } as const

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(k => own(v, k))
const isValueSource = (s: BrowserLineIdSource): s is { value: string } => 'value' in s

/**
 * Why this write part cannot be opened with this read part against this map (Japanese, for the reviewer), or null. The
 * read part must already pass `browserReadLineProblem` (the caller asks it first).
 */
export function browserLineWritesProblem(raw: unknown, read: BrowserReadLine, map: BrowserMap): string | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BROWSER_WRITE_LINE_LIMITS.writes) return '書き込みの数が正しくありません'
  for (const [i, w] of raw.entries()) {
    const at = `書き込み ${i + 1}`
    if (!isMap(w) || !exactKeys(w, ['read', 'verb', 'field', 'value'])) return `${at}：形が正しくありません`
    if (!(BROWSER_WRITE_VERBS as readonly unknown[]).includes(w.verb)) return `${at}：本体の動詞ではありません`
    const r = read.reads.find(x => x.name === w.read)
    if (!r) return `${at}：書くものは、この行が読むものです`
    const thing = map.things[r.thing]
    const allowed = thing.writes?.[w.verb as BrowserWriteVerb]
    if (!allowed || typeof w.field !== 'string' || !own(allowed, w.field)) return `${at}：地図が、このもののこの欄への書き込みを許していません`
    // §4-1 (I4): every object a line names existed before it (no verb creates one yet), so only the last write may change it.
    if (i !== raw.length - 1) return `${at}：前からあるものに書けるのは、最後の1回だけです`
    // C11: the server takes the lock from the plan's values alone (the object's id and its parent's).
    if (!isValueSource(r.id) || (thing.parent && !(r.parent && isValueSource(r.parent)))) return `${at}：書くものは、計画の値で名指しします（印のため）`
    if (w.verb === 'add_child') {
      // C5: what is added is read by the line, by that value, as an object of the same account (it exists there, and the
      // card shows it) — so it is a `target` id the site showed.
      // And it is the thing the map says goes in that field (not just any id of the account).
      const added = read.reads.find(x => isValueSource(x.id) && x.id.value === w.value)
      if (!added || added.thing !== allowed[w.field] || map.things[added.thing].must_hold?.account !== true) return `${at}：足すものは、この行が同じアカウントで読むものです`
    }
  }
  return null
}

/** A read state as the core holds it (exactly the map's fields). */
export type BrowserState = Readonly<Record<string, unknown>>

/**
 * The states every read of the line must have after the writes (§3-4 step 2): the states read before, with each write
 * applied — `add_child` adds the value once more to the field (a list kept in any order: each as often, so adding is
 * always visible). Null when a read's state is missing or not one of its thing, a value is not a plain id, or the list
 * would pass its limit (it cannot come true).
 */
export function predictBrowserWrites(
  read: BrowserReadLine, writes: readonly BrowserLineWrite[], map: BrowserMap,
  before: Readonly<Record<string, BrowserState>>, values: Readonly<Record<string, string>>,
): Record<string, BrowserState> | null {
  const after: Record<string, Record<string, unknown>> = {}
  for (const r of read.reads) {
    const s = own(before, r.name) ? before[r.name] : undefined
    if (!s || browserThingStateProblem(map.things[r.thing], s)) return null
    after[r.name] = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))
  }
  for (const w of writes) {
    const value = own(values, w.value) ? values[w.value] : undefined
    if (typeof value !== 'string' || !BROWSER_ID_VALUE_RE.test(value)) return null
    const state = after[w.read]
    const list = state?.[w.field]
    if (!Array.isArray(list)) return null
    state[w.field] = [...list, value]
  }
  for (const r of read.reads) if (browserThingStateProblem(map.things[r.thing], after[r.name])) return null
  return after
}

/** How the writes came out, judged from what main read before and after (never the AI's word, never the site's answer). */
export type BrowserWritesJudgement =
  /** Every read after equals the prediction exactly: what was written landed, and nothing else changed. */
  | { status: 'as_predicted' }
  /** Read whole, the same objects and account, but not the prediction: `differs` names each read's differing fields. */
  | { status: 'not_as_predicted'; differs: Readonly<Record<string, readonly string[]>> }
  /** Something before or after was not read whole, not the object, not under the account: nothing can be said. */
  | { status: 'unreadable'; reads: Readonly<Record<string, BrowserReadStatus>> }

/**
 * Judge the writes (§3-4 steps 4–5, I3): the reads before must have made a plan (`evaluateBrowserReadLine` with no
 * problem) and the reads after are judged by the same function — strict read, the objects asked for, every must-hold
 * fact (account, parent) — both under the plan's account; then every read's state after must equal the prediction field
 * by field. A read after that differs anywhere, an extra or a missing id, the account moving: never `as_predicted`.
 * **Scope** (independent review): "nothing else changed" holds for what the line reads — a change the site made
 * elsewhere (another step, another object) is not seen, as on the old path.
 */
export function judgeBrowserWrites(
  read: BrowserReadLine, writes: readonly BrowserLineWrite[], map: BrowserMap, before: BrowserReadFacts, after: BrowserReadFacts,
  planAccount: string,
): BrowserWritesJudgement {
  // Both sides under the plan's account (the one the person approved), never only "the same before and after".
  const was = evaluateBrowserReadLine(read, map, { ...before, expectedAccount: planAccount }, 'now')
  if (was.problem !== null) return { status: 'unreadable', reads: was.reads }
  const now = evaluateBrowserReadLine(read, map, { ...after, values: before.values, earlier: before.reads, expectedAccount: planAccount }, 'after')
  if (Object.values(now.reads).some(s => s !== 'ok') || Object.keys(now.reads).length !== read.reads.length) return { status: 'unreadable', reads: now.reads }
  const states = (facts: BrowserReadFacts): Record<string, BrowserState> =>
    Object.fromEntries(read.reads.map(r => { const g = facts.reads[r.name]; return [r.name, g.status === 'read' ? g.state : {}] }))
  const values = Object.fromEntries(Object.entries(before.values).map(([k, v]) => [k, v.value]))
  const predicted = predictBrowserWrites(read, writes, map, states(before), values)
  if (!predicted) return { status: 'unreadable', reads: was.reads }
  const seen = states(after)
  const differs: Record<string, string[]> = {}
  for (const r of read.reads) {
    const thing: BrowserMapThing = map.things[r.thing]
    const fields = Object.entries(thing.fields).filter(([f, field]) => !browserFieldValuesEqual(field, predicted[r.name][f], seen[r.name][f])).map(([f]) => f)
    if (fields.length) differs[r.name] = fields
  }
  if (Object.keys(differs).length) return { status: 'not_as_predicted', differs }
  if (now.problem !== null) return { status: 'unreadable', reads: now.reads }
  return { status: 'as_predicted' }
}

/**
 * The lock keys of the objects a line writes (C11), from the plan's values: `browserObjectLockKey` with the written thing's
 * id field and its parent's — byte-equal to the old path's `browserLockKey` for the same object. Null when a value it
 * needs is missing (the line validator makes every written object value-named, so a valid plan always has them).
 */
export function browserLineWriteLocks(
  read: BrowserReadLine, writes: readonly BrowserLineWrite[], map: BrowserMap, values: Readonly<Record<string, string>>,
  where: { company: string; host: string; account: string },
): string[] | null {
  const keys = new Set<string>()
  for (const w of writes) {
    const r = read.reads.find(x => x.name === w.read)
    if (!r || !isValueSource(r.id)) return null
    const thing = map.things[r.thing]
    const id = values[r.id.value]
    if (typeof id !== 'string') return null
    let parent: { field: string; value: string } | undefined
    if (thing.parent) {
      if (!r.parent || !isValueSource(r.parent) || typeof values[r.parent.value] !== 'string') return null
      parent = { field: thing.parent.field, value: values[r.parent.value] }
    }
    keys.add(browserObjectLockKey({ ...where, site: map.site, thing: r.thing, id: { field: thing.id, value: id }, parent }))
  }
  return [...keys]
}
