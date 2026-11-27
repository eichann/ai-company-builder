/**
 * The run's promise (agent-browser.md "The run's promise"; Codex review points 3 / 4 / 6, owner-approved 2026-11-28): what a
 * write run of 「ブラウザ操作」 may write, fixed on the server before its first permit, so the AI is kept by the mechanism and
 * not by sentences. **The one copy of the rule**: the server asks it at every permit, the app asks it before it asks for one
 * (and asks the person when it says `ask`). Pure (shared-core.md); **knows no site**.
 *
 * What a promise holds (the server keeps only digests — never a value, a label or a page's text):
 * - **values**: the values the person approved, each with where it came from — `person` (their own words, handed by the
 *   consultation AI), `preview` (read by the preview and approved by the person on the plan card; never a value the preview
 *   read for a run nobody approved: a pre-approved Skill has no preview, so none), `asked` (the person's 「書いてよい」 while
 *   the run wrote). A value is `hmac:` + HMAC-SHA256 under a key only the app's main process holds for that run.
 * - **binds**: for a frame whose `browser.yaml` write binds a body field to a label (`bind: { name: 名前 }`), the value that
 *   field must hold.
 * - **decisions**: the person's answer on a stopped card (`proceed`), carried into the new run that continues it.
 * - **the account** is the run's member's own login (the write ledger's `member:<id>`), the **targets** the frames, and **the
 *   fields free to change** a frame's `body`: all the server's own, never sent by the app.
 *
 * At a permit (`browserPromiseVerdict`): a bound field holding another value, or missing → `broken` (never permitted, never
 * asked); a bound field with no promised value, a field outside `body` (when declared), or a placeholder segment of the path
 * (`{n}` / `{x}`) that is neither something this run made nor a promised value → `ask` — the person is asked once on the
 * card, and their 「書いてよい」 adds exactly those to the promise (`BrowserRunPromiseAddition`); the same thing is never asked
 * twice. A run with no promise (an older app) is not checked.
 */
import { browserPromiseFieldName } from './browser-skill'

export type BrowserPromiseSource = 'person' | 'preview' | 'asked'
export const BROWSER_PROMISE_SOURCES: readonly BrowserPromiseSource[] = ['person', 'preview', 'asked']
/** The fixed answers of a stopped card a new run may carry (agent-browser.md "The stopped card's answer"). */
export type BrowserPromiseDecision = 'proceed'
export const BROWSER_PROMISE_DECISIONS: readonly BrowserPromiseDecision[] = ['proceed']

export const BROWSER_PROMISE_LIMITS = Object.freeze({
  values: 32,
  binds: 64,
  /** One addition (the person's one 「書いてよい」): fields, targets, bound values. */
  addFields: 32,
  addTargets: 8,
  addBinds: 8,
  /** Additions a run may take in all. */
  additions: 20,
  /** A permit's check: body field names and the length of one. */
  checkFields: 200,
  checkFieldName: 128,
  /** Path segments (a write path's own limit, `BROWSER_SKILL_LIMITS.segments`, and one more for a trailing `/`). */
  segments: 17,
})
const L = BROWSER_PROMISE_LIMITS

/** A promised value as the server keeps it. */
export const BROWSER_PROMISE_DIGEST_RE = /^hmac:[0-9a-f]{64}$/
const isDigest = (v: unknown): v is string => typeof v === 'string' && BROWSER_PROMISE_DIGEST_RE.test(v)

/** The promise as the app sends it once, before the run's first permit (`POST /browser-frame-runs/:runId/promise`). */
export interface BrowserRunPromiseInput {
  values: Array<{ digest: string; source: Exclude<BrowserPromiseSource, 'asked'> }>
  binds: Array<{ frame: number; field: string; digest: string }>
  decisions: BrowserPromiseDecision[]
}

/** The person's 「書いてよい」 for one held write: exactly what the card showed them (`POST …/promise-add`). */
export interface BrowserRunPromiseAddition {
  frame: number
  fields: string[]
  targets: string[]
  binds: Array<{ field: string; digest: string }>
}

/**
 * What a permit carries for the promise (`check`): every body field the held write names — but `_method` and login / CSRF /
 * session fields — with the digest of its value (a repeated field: of all its values together), and per segment of the
 * path the digest of a segment the frame leaves open (`{n}` / `{x}`), else null.
 */
export interface BrowserPermitCheck {
  fields: Record<string, string>
  segments: Array<string | null>
}

/** A frame as the promise reads it: its path pattern, fixed fields and its `body` / `bind` (absent: not declared). */
export interface BrowserPromiseFrame {
  path: string
  fields: Readonly<Record<string, string>>
  body?: readonly string[]
  bind?: Readonly<Record<string, string>>
}

/** The promise in force: the first one and every addition since. */
export interface BrowserPromiseState {
  values: ReadonlySet<string>
  /** `<frame>\0<field>` → the promised value's digest. */
  binds: ReadonlyMap<string, string>
  /** Fields the person allowed per frame (beside the frame's own `body`). */
  fields: ReadonlyMap<number, ReadonlySet<string>>
  /** Targets the person allowed (digests of path segments). */
  targets: ReadonlySet<string>
  decisions: readonly BrowserPromiseDecision[]
}

const bindKey = (frame: number, field: string) => `${frame}\0${field}`
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k))

/** The first promise read strictly against the run's frames (1-based), or null. */
export function readBrowserRunPromise(v: unknown, frames: readonly BrowserPromiseFrame[]): BrowserRunPromiseInput | null {
  if (!isMap(v) || !only(v, ['values', 'binds', 'decisions'])) return null
  if (!Array.isArray(v.values) || v.values.length > L.values || !Array.isArray(v.binds) || v.binds.length > L.binds || !Array.isArray(v.decisions)) return null
  const values: BrowserRunPromiseInput['values'] = []
  for (const x of v.values) {
    if (!isMap(x) || !only(x, ['digest', 'source']) || !isDigest(x.digest) || (x.source !== 'person' && x.source !== 'preview')) return null
    values.push({ digest: x.digest, source: x.source })
  }
  const promised = new Set(values.map(x => x.digest))
  const binds: BrowserRunPromiseInput['binds'] = []
  const seen = new Set<string>()
  for (const x of v.binds) {
    if (!isMap(x) || !only(x, ['frame', 'field', 'digest']) || !Number.isSafeInteger(x.frame) || typeof x.field !== 'string' || !isDigest(x.digest)) return null
    const frame = frames[(x.frame as number) - 1]
    // Only a field the frame binds, once, to a value of this promise.
    if (!frame?.bind || !Object.prototype.hasOwnProperty.call(frame.bind, x.field) || !promised.has(x.digest) || seen.has(bindKey(x.frame as number, x.field))) return null
    seen.add(bindKey(x.frame as number, x.field))
    binds.push({ frame: x.frame as number, field: x.field, digest: x.digest })
  }
  if (v.decisions.length > BROWSER_PROMISE_DECISIONS.length || new Set(v.decisions).size !== v.decisions.length
    || !v.decisions.every(d => (BROWSER_PROMISE_DECISIONS as readonly unknown[]).includes(d))) return null
  return { values, binds, decisions: [...v.decisions] as BrowserPromiseDecision[] }
}

/** An addition read strictly against the run's frames, or null (nothing in it, or anything off). */
export function readBrowserRunPromiseAddition(v: unknown, frames: readonly BrowserPromiseFrame[]): BrowserRunPromiseAddition | null {
  if (!isMap(v) || !only(v, ['frame', 'fields', 'targets', 'binds']) || !Number.isSafeInteger(v.frame)) return null
  const frame = frames[(v.frame as number) - 1]
  if (!frame || !Array.isArray(v.fields) || !Array.isArray(v.targets) || !Array.isArray(v.binds)) return null
  if (v.fields.length > L.addFields || v.targets.length > L.addTargets || v.binds.length > L.addBinds) return null
  if (v.fields.length + v.targets.length + v.binds.length === 0) return null
  if (!v.fields.every(browserPromiseFieldName) || new Set(v.fields).size !== v.fields.length) return null
  if (!v.targets.every(isDigest) || new Set(v.targets).size !== v.targets.length) return null
  const binds: BrowserRunPromiseAddition['binds'] = []
  for (const x of v.binds) {
    if (!isMap(x) || !only(x, ['field', 'digest']) || typeof x.field !== 'string' || !isDigest(x.digest)) return null
    if (!frame.bind || !Object.prototype.hasOwnProperty.call(frame.bind, x.field) || binds.some(b => b.field === x.field)) return null
    binds.push({ field: x.field, digest: x.digest })
  }
  return { frame: v.frame as number, fields: [...v.fields] as string[], targets: [...v.targets] as string[], binds }
}

/** A permit's check read strictly (its field names any clean string, its segments as many as the path's), or null. */
export function readBrowserPermitCheck(v: unknown, segments: number): BrowserPermitCheck | null {
  if (!isMap(v) || !only(v, ['fields', 'segments']) || !isMap(v.fields) || !Array.isArray(v.segments)) return null
  const names = Object.keys(v.fields)
  if (names.length > L.checkFields || v.segments.length !== segments || segments > L.segments) return null
  const fields: Record<string, string> = {}
  for (const k of names) {
    // eslint-disable-next-line no-control-regex
    if (k.length === 0 || k.length > L.checkFieldName || /[\u0000-\u001f\u007f]/.test(k) || !isDigest(v.fields[k])) return null
    fields[k] = v.fields[k] as string
  }
  if (!v.segments.every(s => s === null || isDigest(s))) return null
  return { fields, segments: [...v.segments] as Array<string | null> }
}

/** The promise in force from the first one and its additions (in order). */
export function browserPromiseState(first: BrowserRunPromiseInput, additions: readonly BrowserRunPromiseAddition[]): BrowserPromiseState {
  const values = new Set(first.values.map(v => v.digest))
  const binds = new Map(first.binds.map(b => [bindKey(b.frame, b.field), b.digest]))
  const fields = new Map<number, Set<string>>()
  const targets = new Set<string>()
  for (const a of additions) {
    for (const f of a.fields) fields.set(a.frame, (fields.get(a.frame) ?? new Set()).add(f))
    for (const t of a.targets) targets.add(t)
    // A field already bound keeps its value: an addition never changes a promised value (it only fills an empty one).
    for (const b of a.binds) if (!binds.has(bindKey(a.frame, b.field))) { binds.set(bindKey(a.frame, b.field), b.digest); values.add(b.digest) }
  }
  return { values, binds, fields, targets, decisions: [...first.decisions] }
}

/** Why a write is outside the promise: fixed words, never a value. */
export type BrowserPromiseBroken = 'value' | 'missing'
export type BrowserPromiseVerdict =
  | { kind: 'kept' }
  | { kind: 'broken'; reason: BrowserPromiseBroken; field: string }
  /** Not in the promise yet: the person is asked once (`fields`: names outside `body`; `targets`: segment places, 0-based; `values`: bound fields with no promised value). */
  | { kind: 'ask'; fields: string[]; targets: number[]; values: string[] }

/** The path's segments after the leading `/` (the pattern's and the request's line up: the frame already fits). */
export const browserPathSegments = (path: string): string[] => path.split('/').slice(1)
const OPEN_SEGMENTS = new Set(['{n}', '{x}'])
/** The places (0-based, after the leading `/`) a frame's path leaves open to any segment of its kind. */
export const browserOpenSegments = (pattern: string): number[] =>
  browserPathSegments(pattern).flatMap((seg, i) => (OPEN_SEGMENTS.has(seg) ? [i] : []))

/**
 * Does a held write that fits `frame` (the core's frame rule already said so) keep the promise? `path`: the request's path
 * without its query; `made`: every id this run's own done writes returned (plain, as the server recorded them).
 */
export function browserPromiseVerdict(input: {
  frameIdx: number
  frame: BrowserPromiseFrame
  path: string
  check: BrowserPermitCheck
  promise: BrowserPromiseState
  made: ReadonlySet<string>
}): BrowserPromiseVerdict {
  const { frame, frameIdx, check, promise } = input
  const has = (k: string) => Object.prototype.hasOwnProperty.call(check.fields, k)
  const unbound: string[] = []
  for (const field of Object.keys(frame.bind ?? {})) {
    if (!has(field)) return { kind: 'broken', reason: 'missing', field }
    const promised = promise.binds.get(bindKey(frameIdx, field))
    if (promised === undefined) unbound.push(field)
    else if (check.fields[field] !== promised) return { kind: 'broken', reason: 'value', field }
  }
  const outside: string[] = []
  if (frame.body) {
    const allowed = new Set([...frame.body, ...Object.keys(frame.fields), ...Object.keys(frame.bind ?? {}), ...(promise.fields.get(frameIdx) ?? [])])
    for (const name of Object.keys(check.fields)) if (!allowed.has(name)) outside.push(name)
  }
  const segments = browserPathSegments(input.path)
  const targets: number[] = []
  for (const i of browserOpenSegments(frame.path)) {
    if (input.made.has(segments[i] ?? '')) continue
    const d = check.segments[i]
    if (d !== null && d !== undefined && (promise.values.has(d) || promise.targets.has(d))) continue
    targets.push(i)
  }
  if (unbound.length + outside.length + targets.length === 0) return { kind: 'kept' }
  return { kind: 'ask', fields: outside.sort(), targets, values: unbound.sort() }
}

/** How a label is compared when the app binds the person's values to a frame's `bind` (NFKC, spaces folded, A–Z folded). */
export const browserPromiseLabelKey = (label: string): string => label.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/[A-Z]/g, c => c.toLowerCase())

/**
 * The first promise the app sends, from what the person approved: their own values first, then the preview's values the
 * person approved on the plan card (`preview`: null when there was no card), and a stopped card's answer it continues.
 * Each frame's bound field gets the value whose label matches its `bind` label (the person's before the preview's); a
 * bound field with no such value is left out (asked at its write). `digest` is the app's keyed hash.
 */
export function buildBrowserRunPromise(input: {
  frames: readonly BrowserPromiseFrame[]
  person: ReadonlyArray<{ label: string; value: string }>
  preview: ReadonlyArray<{ label: string; value: string }> | null
  decisions: readonly BrowserPromiseDecision[]
  digest: (value: string) => string
}): { promise: BrowserRunPromiseInput; plain: Map<string, string> } {
  const plain = new Map<string, string>()
  const values: BrowserRunPromiseInput['values'] = []
  const byLabel = new Map<string, string>()
  const add = (v: { label: string; value: string }, source: 'person' | 'preview') => {
    const d = input.digest(v.value)
    plain.set(d, v.value)
    if (!values.some(x => x.digest === d) && values.length < L.values) values.push({ digest: d, source })
    const key = browserPromiseLabelKey(v.label)
    if (!byLabel.has(key)) byLabel.set(key, d)
  }
  for (const v of input.person) add(v, 'person')
  for (const v of input.preview ?? []) add(v, 'preview')
  const binds: BrowserRunPromiseInput['binds'] = []
  input.frames.forEach((f, i) => {
    for (const [field, label] of Object.entries(f.bind ?? {})) {
      const d = byLabel.get(browserPromiseLabelKey(label))
      if (d !== undefined && values.some(x => x.digest === d)) binds.push({ frame: i + 1, field, digest: d })
    }
  })
  return { promise: { values, binds, decisions: [...input.decisions] }, plain }
}
