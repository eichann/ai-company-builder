/**
 * The write part of an opened line (「使ってよい組み合わせ」の書き込み, generalization PR 6, creates since PR 8;
 * `agent-browser.md` "The write words and the first write line", "Creating on the new path"). Internal design memo
 * 「ブラウザ操作の汎用化」 §3-3 (the verbs), §3-4 (one generic check: read → predict → write → read → compare), §4-1 (the
 * harmless prefix, I4), §5 (I2, I3), §6 (the step-template line), §7 (the landing-route line), §15 C1–C7 / C11, §16-4,
 * §17, §18. Pure; nothing in the app or the server writes with it yet (the server still refuses every plan of writes,
 * `BROWSER_LINE_WRITES_NOT_YET`).
 *
 * A line's writes are a list of
 * - `{ read, verb: 'add_child', field, value }`: add the id `value` to the list `field` of the object the read `read`
 *   named (an object that existed before the plan);
 * - `{ read, verb: 'create_from', set, as }`: create a **new** object of the read's thing, a copy of the object `read` read,
 *   with each field of `set` set to a line value (`{ value }`) or to the id an earlier write of this line created
 *   (`{ created }`); `as` names what it created, for later writes and for the judgement.
 * Rules held here (each guarded by `browser-write-words.test.ts`):
 * - **Only what the map lets** (C7): the read's thing lists the verb and the field in its `writes`; the verbs are a closed
 *   list (`BROWSER_WRITE_VERBS`, §17-3: a verb comes with a case that needs it).
 * - **The harmless prefix** (§4-1, I4): a write that changes what existed before (`add_child`) may only be the last;
 *   a create changes nothing that existed and makes what reaches nobody until a person hands it out (the map's
 *   `delivers: none`), so a stop after it leaves an object nobody uses. A create may use only what an **earlier** write
 *   created (C1: only this execution's, never something reached through it).
 * - **Named by the plan's values** (C11): the server derives every lock from the plan alone — a written object's id and
 *   its parent's are `target` values; a copy's original is reached from a value-named read (its lock is that object's).
 * - **What goes in was read** (C5): an id added or set is a value the line reads, by that value, as the thing the map says
 *   goes in that field, under the account (it exists there, it is that kind of thing, and the card shows it).
 * - **Plain values have a source** (§16-4): a value a create sets in a text / date / time field is a `write` value of the
 *   same kind, and every `write` value is used by a write.
 * - **The prediction** (§3-4 step 2, I3): from the states read before, every read's state after the writes — `add_child`
 *   adds the id once more; nothing a create does touches an existing read — and each created object's state: its
 *   original's, with `set` applied and its own new id. After the writes, the reads made again and each created object
 *   read by the id the site gave must equal the prediction **exactly**, under the plan's account (`judgeBrowserWrites`);
 *   anything else is "not as predicted" or "could not be read", never done.
 * - **A copy is never its original** (stage 0 R3, the most common accident): a created object's id is none read before
 *   of its thing, and an id a create sets from a value must not be one its original already holds there (else no plan:
 *   `browserWritesPlanProblem`).
 *
 * The core knows no site, thing or field. Every shape is **provisional** until a second site fits it (§18).
 */
import { BROWSER_ID_VALUE_RE } from './plugin-browser-declaration'
import {
  BROWSER_CREATE_PLAIN_KINDS, BROWSER_MAP_NAME_RE, BROWSER_WRITE_VERBS, browserFieldValueFits, browserFieldValuesEqual,
  browserThingStateProblem, type BrowserMap, type BrowserMapThing, type BrowserThingResult,
} from './browser-map'
import {
  evaluateBrowserReadLine, type BrowserLineIdSource, type BrowserLineRead, type BrowserReadFacts, type BrowserReadLine,
  type BrowserReadStatus,
} from './browser-read-line'
import { browserObjectLockKey } from './browser-plans'

/** What a create sets a field to: a line value, or the id an earlier write of the line created (its `as`). */
export type BrowserWriteSource = { value: string } | { created: string }

/** One write of a line (see the module's comment). */
export type BrowserLineWrite =
  | { read: string; verb: 'add_child'; field: string; value: string }
  | { read: string; verb: 'create_from'; set: Readonly<Record<string, BrowserWriteSource>>; as: string }

export const BROWSER_WRITE_LINE_LIMITS = { writes: 3, set: 20 } as const

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(k => own(v, k))
const isValueSource = (s: BrowserLineIdSource): s is { value: string } => 'value' in s

/**
 * The read a copy's original is reached from (C11): follow ids taken from earlier reads back to the read named by a plan
 * value. Null when that read's parent is not named by a value too (the server could not derive its lock).
 */
function rootRead(read: BrowserReadLine, map: BrowserMap, name: string): BrowserLineRead | null {
  let r = read.reads.find(x => x.name === name)
  for (let hops = 0; r && hops <= read.reads.length; hops++) {
    if (isValueSource(r.id)) {
      const thing = map.things[r.thing]
      return !thing.parent || (r.parent && isValueSource(r.parent)) ? r : null
    }
    const from: string = r.id.read
    r = read.reads.find(x => x.name === from)
  }
  return null
}

/**
 * Why this write part cannot be opened with this read part against this map (Japanese, for the reviewer), or null. The
 * read part must already pass `browserReadLineProblem` (the caller asks it first).
 */
export function browserLineWritesProblem(raw: unknown, read: BrowserReadLine, map: BrowserMap): string | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BROWSER_WRITE_LINE_LIMITS.writes) return '書き込みの数が正しくありません'
  const created: Record<string, string> = {}
  const usedValues = new Set<string>()
  for (const [i, w] of raw.entries()) {
    const at = `書き込み ${i + 1}`
    if (!isMap(w) || !(BROWSER_WRITE_VERBS as readonly unknown[]).includes(w.verb)) return `${at}：本体の動詞ではありません`
    const shape = w.verb === 'add_child' ? ['read', 'verb', 'field', 'value'] : ['read', 'verb', 'set', 'as']
    if (!exactKeys(w, shape)) return `${at}：形が正しくありません`
    const r = read.reads.find(x => x.name === w.read)
    if (!r) return `${at}：書くものは、この行が読むものです`
    const thing = map.things[r.thing]
    // C5: an id that goes in is read by the line, by that value, as the thing the map names, under the account.
    const readAs = (value: unknown, child: string): boolean => typeof value === 'string' && read.reads.some(x =>
      isValueSource(x.id) && x.id.value === value && x.thing === child) && map.things[child].must_hold?.account === true
    if (w.verb === 'add_child') {
      const allowed = thing.writes?.add_child
      if (!allowed || typeof w.field !== 'string' || !own(allowed, w.field)) return `${at}：地図が、このもののこの欄への書き込みを許していません`
      // §4-1 (I4): it changes what existed before the plan, so it may only be the last write.
      if (i !== raw.length - 1) return `${at}：前からあるものに書けるのは、最後の1回だけです`
      // C11: the server takes the lock from the plan's values alone (the object's id and its parent's).
      if (!isValueSource(r.id) || (thing.parent && !(r.parent && isValueSource(r.parent)))) return `${at}：書くものは、計画の値で名指しします（印のため）`
      if (!readAs(w.value, allowed[w.field])) return `${at}：足すものは、この行が同じアカウントで読むものです`
      continue
    }
    // create_from
    const allowed = thing.writes?.create_from
    if (!allowed) return `${at}：地図が、このものを作ることを許していません`
    if (typeof w.as !== 'string' || !BROWSER_MAP_NAME_RE.test(w.as) || own(created, w.as) || read.reads.some(x => x.name === w.as)) return `${at}：作ったものの名前が正しくありません`
    if (!rootRead(read, map, r.name)) return `${at}：作る元は、計画の値からたどれるものです（印のため）`
    const set = w.set
    if (!isMap(set) || Object.keys(set).length === 0 || Object.keys(set).length > BROWSER_WRITE_LINE_LIMITS.set) return `${at}：変える欄が正しくありません`
    for (const [f, src] of Object.entries(set)) {
      if (!own(allowed, f)) return `${at}：地図が、作るときにこの欄（${f}）を変えることを許していません`
      const field = thing.fields[f]
      const child = allowed[f]
      if (isMap(src) && exactKeys(src, ['created'])) {
        // Only what an earlier write of this execution created (C1), and only into a single-id field for that thing (the
        // second check alone would refuse an unknown name too; the first says why).
        if (typeof src.created !== 'string' || !own(created, src.created)) return `${at}：作ったものは、前の書き込みが作ったものです`
        if (field.kind !== 'id' || child !== created[src.created]) return `${at}：欄（${f}）に入るものの種類が違います`
      } else if (isMap(src) && exactKeys(src, ['value'])) {
        if (typeof src.value !== 'string' || !own(read.values, src.value)) return `${at}：欄（${f}）の値がありません`
        const v = read.values[src.value]
        if (field.kind === 'id' || field.kind === 'id_set') {
          if (typeof child !== 'string' || !readAs(src.value, child)) return `${at}：欄（${f}）に入れるものは、この行が同じアカウントで読むものです`
        } else {
          // A plain value: a `write` value of the field's own kind (its source is the line's, §16-4).
          if (!(BROWSER_CREATE_PLAIN_KINDS as readonly string[]).includes(field.kind) || v.role !== 'write' || v.kind !== field.kind) return `${at}：欄（${f}）の値は、同じ種類の書く値です`
          usedValues.add(src.value)
        }
      } else return `${at}：欄（${f}）の形が正しくありません`
    }
    created[w.as] = r.thing
  }
  for (const [name, v] of Object.entries(read.values)) if (v.role === 'write' && !usedValues.has(name)) return `値「${name}」はこの行で使われていません`
  return null
}

/** A read state as the core holds it (exactly the map's fields). */
export type BrowserState = Readonly<Record<string, unknown>>

/** The plan values as plain strings, by name. */
type PlainValues = Readonly<Record<string, string>>

/**
 * The states every read of the line — and every object it creates, by its `as` — must have after the writes (§3-4 step
 * 2). `created` gives each create's new id (the one the site answered and the app identified, C3). Null when a read's
 * state is missing or not one of its thing, a value or an id is not plain or not of its field, a created id is one read
 * before of its thing (a copy is never its original) or given twice, or a state would not be one of its thing.
 */
export function predictBrowserWrites(
  read: BrowserReadLine, writes: readonly BrowserLineWrite[], map: BrowserMap,
  before: Readonly<Record<string, BrowserState>>, values: PlainValues, created: PlainValues = {},
): Record<string, BrowserState> | null {
  const after: Record<string, Record<string, unknown>> = {}
  for (const r of read.reads) {
    const s = own(before, r.name) ? before[r.name] : undefined
    if (!s || browserThingStateProblem(map.things[r.thing], s)) return null
    after[r.name] = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))
  }
  const plainId = (v: unknown): v is string => typeof v === 'string' && BROWSER_ID_VALUE_RE.test(v)
  const madeIds = new Set<string>()
  for (const w of writes) {
    if (w.verb === 'add_child') {
      const value = own(values, w.value) ? values[w.value] : undefined
      if (!plainId(value)) return null
      const state = after[w.read]
      const list = state?.[w.field]
      if (!Array.isArray(list)) return null
      state[w.field] = [...list, value]
      continue
    }
    const r = read.reads.find(x => x.name === w.read)
    if (!r) return null
    const thing = map.things[r.thing]
    const id = own(created, w.as) ? created[w.as] : undefined
    // A new id: plain, never one read before of its thing (the original, or any object the line read), never given twice.
    if (!plainId(id) || madeIds.has(`${r.thing}\n${id}`) || read.reads.some(x => x.thing === r.thing && before[x.name]?.[map.things[x.thing].id] === id)) return null
    madeIds.add(`${r.thing}\n${id}`)
    const original = before[w.read]
    const copy: Record<string, unknown> = Object.fromEntries(Object.entries(original).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))
    copy[thing.id] = id
    for (const [f, src] of Object.entries(w.set)) {
      const field = thing.fields[f]
      if ('created' in src) {
        const made = own(created, src.created) ? created[src.created] : undefined
        if (!plainId(made)) return null
        copy[f] = made
        continue
      }
      const value = own(values, src.value) ? values[src.value] : undefined
      if (typeof value !== 'string') return null
      // A value not of the field's kind fails the state check below.
      copy[f] = field.kind === 'id_set' ? [value] : value
    }
    after[w.as] = copy
  }
  for (const r of read.reads) if (browserThingStateProblem(map.things[r.thing], after[r.name])) return null
  for (const w of writes) if (w.verb === 'create_from' && browserThingStateProblem(map.things[(read.reads.find(x => x.name === w.read) as BrowserLineRead).thing], after[w.as])) return null
  return after
}

/** Why the writes make no plan, from what was read before (a fixed word), or null. */
export type BrowserWritesPlanProblem = 'reads' | 'values' | 'same-as-original'

/**
 * Before anything is sent (§3-4 step 1, with the plan's account): the reads make a plan (`evaluateBrowserReadLine`: read
 * whole, the objects asked for, every must-hold fact, every check ✓), every value a write uses fits its field, and an id
 * a create sets from a value is not one its original already holds in that field — a copy re-pointed at what its original already points at is
 * the copy-still-on-the-original accident (stage 0 R3); a text, date or time set to the original's own is allowed (the
 * same end time every week).
 */
export function browserWritesPlanProblem(
  read: BrowserReadLine, writes: readonly BrowserLineWrite[], map: BrowserMap, before: BrowserReadFacts, planAccount: string,
): BrowserWritesPlanProblem | null {
  const was = evaluateBrowserReadLine(read, map, { ...before, expectedAccount: planAccount }, 'now')
  if (was.problem !== null) return 'reads'
  const values = plainValues(before)
  for (const w of writes) {
    if (w.verb !== 'create_from') continue
    const r = read.reads.find(x => x.name === w.read) as BrowserLineRead
    const thing = map.things[r.thing]
    const got = before.reads[w.read]
    if (!got || got.status !== 'read') return 'reads'
    for (const [f, src] of Object.entries(w.set)) {
      if (!('value' in src)) continue
      const field = thing.fields[f]
      const value = values[src.value]
      const next = field.kind === 'id_set' ? [value] : value
      if (typeof value !== 'string' || !browserFieldValueFits(field, next)) return 'values'
      // The id must not be one the original already holds (independent review L4: an id set `[old, x]` with `old` set).
      const held = got.state[f]
      if ((field.kind === 'id' && held === value) || (field.kind === 'id_set' && Array.isArray(held) && held.includes(value))) return 'same-as-original'
    }
  }
  return null
}

const plainValues = (facts: BrowserReadFacts): Record<string, string> =>
  Object.fromEntries(Object.entries(facts.values).map(([k, v]) => [k, v.value]))

/** What main read of one created object after the writes: the id the site gave (identified, C3) and its strict read. */
export interface BrowserCreatedRead { id: string; read: BrowserThingResult }

/** How the writes came out, judged from what main read before and after (never the AI's word, never the site's answer). */
export type BrowserWritesJudgement =
  /** Every read after — and every created object — equals the prediction exactly: what was written landed, nothing else changed. */
  | { status: 'as_predicted' }
  /** Read whole, the same objects and account, but not the prediction: `differs` names each read's (or created object's) differing fields. */
  | { status: 'not_as_predicted'; differs: Readonly<Record<string, readonly string[]>> }
  /** Something before or after was not read whole, not the object, not under the account: nothing can be said. */
  | { status: 'unreadable'; reads: Readonly<Record<string, BrowserReadStatus>> }

/**
 * Judge the writes (§3-4 steps 4–5, I3): the reads before must have made a plan (`browserWritesPlanProblem`, under the
 * plan's account) and the reads after are judged by the same rules; each created object (`created`, by its `as`) must be
 * read whole as the object of the id the site gave, under the plan's account (both sides of the marker); then every
 * state after must equal the prediction field by field. A read after that differs anywhere, an extra or a missing id,
 * a created object that is not exactly its original with the set fields, an original that changed, the account moving:
 * never `as_predicted`. **Scope** (independent review): "nothing else changed" holds for what the line reads and what it
 * created, field by field of the map — a change the site made elsewhere, or in a key the map lists as `ignored`, is not
 * seen, as on the old path. That a created id is really new (not an existing object with the same content, e.g. one left
 * by an earlier stopped run) and that the created reads sit between the account markers are the caller's to make sure
 * (the app's identification, C3: the answer's id, the parent's list, nothing else referencing it).
 */
export function judgeBrowserWrites(
  read: BrowserReadLine, writes: readonly BrowserLineWrite[], map: BrowserMap, before: BrowserReadFacts, after: BrowserReadFacts,
  planAccount: string, created: Readonly<Record<string, BrowserCreatedRead>> = {},
): BrowserWritesJudgement {
  // Both sides under the plan's account (the one the person approved), never only "the same before and after".
  const was = evaluateBrowserReadLine(read, map, { ...before, expectedAccount: planAccount }, 'now')
  if (was.problem !== null || browserWritesPlanProblem(read, writes, map, before, planAccount) !== null) return { status: 'unreadable', reads: was.reads }
  const now = evaluateBrowserReadLine(read, map, { ...after, values: before.values, earlier: before.reads, expectedAccount: planAccount }, 'after')
  if (Object.values(now.reads).some(s => s !== 'ok') || Object.keys(now.reads).length !== read.reads.length) return { status: 'unreadable', reads: now.reads }
  // Each created object: read whole, the object of the id the site gave, under the plan's account.
  const accountOk = after.account?.before === planAccount && after.account?.after === planAccount
  const createdStates: Record<string, BrowserState> = {}
  const createdIds: Record<string, string> = {}
  const createdStatus: Record<string, BrowserReadStatus> = { ...now.reads }
  for (const w of writes) {
    if (w.verb !== 'create_from') continue
    const thing = map.things[(read.reads.find(x => x.name === w.read) as BrowserLineRead).thing]
    const got = own(created, w.as) ? created[w.as] : undefined
    const state = got && got.read.status === 'read' && !browserThingStateProblem(thing, got.read.state) ? got.read.state : null
    if (!got || !state) { createdStatus[w.as] = 'not-read'; return { status: 'unreadable', reads: createdStatus } }
    if (typeof got.id !== 'string' || state[thing.id] !== got.id) { createdStatus[w.as] = 'wrong-object'; return { status: 'unreadable', reads: createdStatus } }
    // Kept on purpose (a second layer): the original is a read of the same thing, so `now` above already holds the account.
    if (thing.must_hold?.account && !accountOk) { createdStatus[w.as] = 'account-mismatch'; return { status: 'unreadable', reads: createdStatus } }
    createdStates[w.as] = state
    createdIds[w.as] = got.id
  }
  const states = (facts: BrowserReadFacts): Record<string, BrowserState> =>
    Object.fromEntries(read.reads.map(r => { const g = facts.reads[r.name]; return [r.name, g.status === 'read' ? g.state : {}] }))
  const beforeStates = states(before)
  // A "created" object whose id is one read before of its thing (the original itself), or given for two creates: it is
  // not new, so nothing was made for sure — never done, named by the created object's id field.
  const seenIds = new Set<string>()
  for (const w of writes) {
    if (w.verb !== 'create_from') continue
    const thingName = (read.reads.find(x => x.name === w.read) as BrowserLineRead).thing
    const key = `${thingName}\n${createdIds[w.as]}`
    const old = read.reads.some(x => x.thing === thingName && beforeStates[x.name][map.things[thingName].id] === createdIds[w.as])
    if (old || seenIds.has(key)) return { status: 'not_as_predicted', differs: { [w.as]: [map.things[thingName].id] } }
    seenIds.add(key)
  }
  const predicted = predictBrowserWrites(read, writes, map, beforeStates, plainValues(before), createdIds)
  if (!predicted) return { status: 'unreadable', reads: was.reads }
  const seen: Record<string, BrowserState> = { ...states(after), ...createdStates }
  const differs: Record<string, string[]> = {}
  const compare = (name: string, thing: BrowserMapThing): void => {
    const fields = Object.entries(thing.fields).filter(([f, field]) => !browserFieldValuesEqual(field, predicted[name][f], seen[name][f])).map(([f]) => f)
    if (fields.length) differs[name] = fields
  }
  for (const r of read.reads) compare(r.name, map.things[r.thing])
  for (const w of writes) if (w.verb === 'create_from') compare(w.as, map.things[(read.reads.find(x => x.name === w.read) as BrowserLineRead).thing])
  if (Object.keys(differs).length) return { status: 'not_as_predicted', differs }
  if (now.problem !== null) return { status: 'unreadable', reads: now.reads }
  return { status: 'as_predicted' }
}

/**
 * The lock keys a line's writes take at the claim (C11), from the plan's values: `browserObjectLockKey` with the written
 * thing's id field and its parent's — for `add_child` the written object (byte-equal to the old path's `browserLockKey`
 * for the same object); for `create_from` the object its original is reached from (a copy of one original is made by one
 * execution at a time; the created object's own key is taken when the server records it). Null when a value it needs is
 * missing (the line validator makes every lock value-named, so a valid plan always has them).
 */
export function browserLineWriteLocks(
  read: BrowserReadLine, writes: readonly BrowserLineWrite[], map: BrowserMap, values: Readonly<Record<string, string>>,
  where: { company: string; host: string; account: string },
): string[] | null {
  const keys = new Set<string>()
  for (const w of writes) {
    const r = w.verb === 'add_child' ? read.reads.find(x => x.name === w.read) : rootRead(read, map, w.read)
    if (!r || !isValueSource(r.id)) return null
    const thing = map.things[r.thing]
    const id = own(values, r.id.value) ? values[r.id.value] : undefined
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
