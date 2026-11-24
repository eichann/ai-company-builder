// The read runner of an opened read-only line (「開けた1行」, generalization PR 5a; agent-browser.md
// "The read runner of an opened line"). Built and tested; NOTHING calls it yet: the server's opened
// list and the notice route are PR 4, the wiring to the chat and the card PR 5b.
//
// Given an approved line, its map, the map's readers, how each thing is addressed and the line's values,
// it reads ONLY the things the line names, in its order, through the member's open window's page-less
// read session (`BrowserPreviewSurface.read`: GET of exactly the address main built — the shell's
// `exactRead` refuses anything else, so nothing but a GET can leave through it), reads the site's
// account marker right before and right after (the must-hold `account`, §15 C5), turns each JSON
// answer into the thing's state strictly (`readBrowserThing`: a key the map does not list, a required
// key missing → not read), judges the line (`evaluateBrowserReadLine`) and builds the generic card
// (`buildBrowserReadCard`). No Electron, no site: the site's knowledge comes in as data (the map and
// `BrowserThingAddress`) and reviewed reader code handed in by the composition root.
//
// Never kept or logged: a page's HTML or JSON (each answer is dropped once read), a value, a key name.
// What may leave the PC is the notice (`BrowserShapeNotice`: site, map version, thing, kind of change,
// count — the map's own strings), through the reporter port (PR 4's `POST /browser-shape-notices`,
// wired in 5b). The member sees `BROWSER_SHAPE_WORDS.member` when the site's shape changed.
import {
  BROWSER_SHAPE_CHANGES, BROWSER_SHAPE_WORDS, browserMapProblem, readBrowserThing,
  type BrowserMap, type BrowserShapeChange, type BrowserShapeNotice, type BrowserThingNotRead, type BrowserThingReader, type BrowserThingResult,
} from '../../../../shared/core/browser-map'
import {
  browserLineValuesProblem, evaluateBrowserReadLine,
  type BrowserLineRead, type BrowserReadFacts, type BrowserReadLineOutcome, type BrowserSuppliedValue,
} from '../../../../shared/core/browser-read-line'
import { browserOpenedLineProblem, type BrowserOpenedLine, type BrowserOpenedStatus } from '../../../../shared/core/browser-opened'
import { buildBrowserReadCard, type BrowserCard } from '../../../../shared/core/browser-card'
import { BROWSER_ID_VALUE_RE, BROWSER_QUERY_NAME_RE, exploreAddressProblem } from '../../../../shared/core/plugin-browser-declaration'
import { parseStrictJson } from '../../../shared/browser-json'
import type { BrowserPreviewSurface } from '../../../shared/browser-runner'
import { buildAiSwitch, type BrowserAiSwitch } from './ai-switch'

/**
 * How one thing of the map is read (site data, reviewed with the map; the map's `…_MAP_READS`).
 * - `object`: `GET <path>` with its one `{id}` segment filled with the wanted id (a plain id), no query.
 * - `list_entry`: one entry of a paginated folder list, `GET <path>?<folder.param>=<folder>&<pages.param>=<n>`,
 *   where the folder is the `folder.field` of the earlier read the line reads this entry through (the same object,
 *   by that read's own id). Every page is read (≤ `pages.max`), its envelope strictly (`list.keys`, and for each key
 *   in `list.lists` the keys of its items); the entry must stand exactly once in the whole list.
 * No other query is ever built: a path with `?` or another `{…}` is refused before anything is read.
 */
export type BrowserThingAddress =
  | { kind: 'object'; path: string }
  | {
    kind: 'list_entry'
    path: string
    folder: { param: string; field: string }
    pages: { param: string; max: number; perPage: number }
    list: { items: string; current: string; last: string; total: string; keys: readonly string[]; lists?: Readonly<Record<string, readonly string[]>> }
  }

/** The page that carries the site's account marker, and the reviewed code that reads it (null: cannot tell). */
export interface BrowserAccountMarker {
  path: string
  read(html: string): string | null
}

/** Where the notices go (PR 4's route; 5b wires it). Fire and forget: a failure never changes the result. */
export interface BrowserShapeNoticeReporter {
  report(notices: readonly BrowserShapeNotice[]): Promise<unknown>
}

export interface BrowserReadRunnerDeps {
  /** The AI's browser operation's switch (default: the build's, off): off = refused at once, nothing read. */
  aiSwitch?: BrowserAiSwitch
  /** The emergency stop for the company's AI (`browserAiStopped`). */
  stopped(companyId: string): boolean
  /** The member's open window of the site, as main reads through it (controller `previewWindow`); null: not open. */
  window(companyId: string, host: string): BrowserPreviewSurface | null
  /** Captures the context now (sign-in, company, setting generation); the answer says whether it still holds. */
  context(): () => boolean
  notices?: BrowserShapeNoticeReporter
  /** The wall clock (epoch ms), for the run's time limit. */
  now?(): number
  /** Tighter limits than `BROWSER_READ_RUN_LIMITS` (tests); never looser. */
  limits?: Partial<typeof BROWSER_READ_RUN_LIMITS>
}

/** What the caller hands the runner: an approved line of the opened list with its map and the site's code. */
export interface BrowserReadRunInput {
  companyId: string
  host: string
  line: BrowserOpenedLine
  /** The line's row status in the opened list: only `approved` runs. */
  lineStatus: BrowserOpenedStatus
  map: BrowserMap
  readers: Readonly<Record<string, BrowserThingReader>>
  addresses: Readonly<Record<string, BrowserThingAddress>>
  account: BrowserAccountMarker
  values: Readonly<Record<string, BrowserSuppliedValue>>
  /** The account a plan is bound to (later PRs); absent for a read made only to show the card. */
  expectedAccount?: string
}

/** Why nothing was judged (a fixed word): what was read so far is dropped. */
export const BROWSER_READ_RUN_REFUSALS = [
  'off', 'input', 'not-approved', 'map', 'line', 'addresses', 'values', 'stopped', 'window', 'busy', 'context', 'too-many-reads', 'timeout',
] as const
export type BrowserReadRunRefusal = typeof BROWSER_READ_RUN_REFUSALS[number]

export type BrowserReadRunResult =
  | { status: 'refused'; reason: BrowserReadRunRefusal }
  | {
    status: 'judged'
    /** Every read counted and every check ✓ (`outcome.problem === null`). */
    ok: boolean
    outcome: BrowserReadLineOutcome
    card: BrowserCard
    /** The member's one sentence when the site's shape changed (§16-1); null otherwise (the card speaks). */
    member: string | null
    /** What may go to the owner / admin: no key name, value or page text. */
    notices: readonly BrowserShapeNotice[]
  }

export const BROWSER_READ_RUN_LIMITS = { reads: 30, ms: 60_000 } as const

const OK = 200
const ID_SEGMENT = '{id}'

class Refusal extends Error {
  constructor(readonly reason: BrowserReadRunRefusal) { super(reason) }
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** A thing not read, telling nothing (an address that cannot be built, a failed request: not the site's shape). */
const notReadQuietly = (): BrowserThingNotRead => ({ status: 'not_read', notices: [], diagnosis: { unknownKeys: [], missingKeys: [] } })

/** A fixed path of a declared shape: starts with `/`, no query, no fragment, braces only as the one `{id}` segment of an object. */
export function browserThingAddressProblem(a: unknown): string | null {
  if (!isObject(a) || typeof a.path !== 'string' || !a.path.startsWith('/') || /[?#%]/.test(a.path)) return 'path'
  if (a.kind === 'object') {
    const segments = a.path.split('/')
    if (segments.filter(s => s === ID_SEGMENT).length !== 1 || segments.some(s => s !== ID_SEGMENT && /[{}]/.test(s))) return 'path'
    if (exploreAddressProblem(a.path.replace(ID_SEGMENT, '1')) !== null) return 'path'
    return null
  }
  if (a.kind !== 'list_entry') return 'kind'
  if (/[{}]/.test(a.path) || exploreAddressProblem(a.path) !== null) return 'path'
  const folder = a.folder as Record<string, unknown> | undefined
  const pages = a.pages as Record<string, unknown> | undefined
  const list = a.list as Record<string, unknown> | undefined
  if (!isObject(folder) || typeof folder.param !== 'string' || !BROWSER_QUERY_NAME_RE.test(folder.param) || typeof folder.field !== 'string') return 'folder'
  if (!isObject(pages) || typeof pages.param !== 'string' || !BROWSER_QUERY_NAME_RE.test(pages.param) || pages.param.toLowerCase() === folder.param.toLowerCase()) return 'pages'
  if (!Number.isInteger(pages.max) || (pages.max as number) < 1 || (pages.max as number) > 10) return 'pages'
  if (!Number.isInteger(pages.perPage) || (pages.perPage as number) < 1 || (pages.perPage as number) > 100) return 'pages'
  if (!isObject(list) || !Array.isArray(list.keys) || !list.keys.every(k => typeof k === 'string')) return 'list'
  const keys = list.keys as string[]
  for (const k of ['items', 'current', 'last', 'total']) if (typeof list[k] !== 'string' || !keys.includes(list[k] as string)) return 'list'
  if (list.lists !== undefined) {
    if (!isObject(list.lists)) return 'list'
    for (const [k, v] of Object.entries(list.lists)) if (!keys.includes(k) || k === list.items || !Array.isArray(v) || !v.every(x => typeof x === 'string')) return 'list'
  }
  return null
}

/** The account marker's page: a fixed path, no query, no `{…}`. */
function accountPathProblem(path: unknown): boolean {
  return typeof path !== 'string' || !path.startsWith('/') || /[?#%{}]/.test(path) || exploreAddressProblem(path) !== null
}

/** One notice per thing × kind of change (the largest count), rebuilt from exactly its fields: nothing else can ride along. */
function cleanNotices(map: BrowserMap, raw: readonly BrowserShapeNotice[]): BrowserShapeNotice[] {
  const kept = new Map<string, BrowserShapeNotice>()
  for (const n of raw) {
    if (!isObject(n) || typeof n.thing !== 'string' || !own(map.things, n.thing)) continue
    if (!(BROWSER_SHAPE_CHANGES as readonly unknown[]).includes(n.change)) continue
    if (!Number.isSafeInteger(n.count) || n.count < 1) continue
    const key = `${n.thing}\u0000${n.change}`
    const before = kept.get(key)
    if (!before || before.count < n.count) kept.set(key, { site: map.site, mapVersion: map.version, thing: n.thing, change: n.change as BrowserShapeChange, count: n.count })
  }
  return [...kept.values()]
}

export function createBrowserReadRunner(deps: BrowserReadRunnerDeps) {
  const now = deps.now ?? Date.now
  const limits = {
    reads: Math.min(deps.limits?.reads ?? BROWSER_READ_RUN_LIMITS.reads, BROWSER_READ_RUN_LIMITS.reads),
    ms: Math.min(deps.limits?.ms ?? BROWSER_READ_RUN_LIMITS.ms, BROWSER_READ_RUN_LIMITS.ms),
  }
  const busy = new WeakSet<BrowserPreviewSurface>()

  async function run(input: BrowserReadRunInput): Promise<BrowserReadRunResult> {
    const refused = (reason: BrowserReadRunRefusal): BrowserReadRunResult => ({ status: 'refused', reason })
    // The switch first: off = nothing checked, read or sent.
    if (!(deps.aiSwitch ?? buildAiSwitch)()) return refused('off')
    if (!isObject(input) || typeof input.companyId !== 'string' || input.companyId.length === 0 || typeof input.host !== 'string' || input.host.length === 0) return refused('input')
    const { companyId, host, line, map, readers, addresses, account, values } = input
    // Only an approved line of this map, every read thing with its address and reader, the values as the line allows.
    if (input.lineStatus !== 'approved') return refused('not-approved')
    if (browserMapProblem(map)) return refused('map')
    if (browserOpenedLineProblem(line, map) || line.read.site !== map.site) return refused('line')
    if (!isObject(account) || accountPathProblem(account.path) || typeof account.read !== 'function') return refused('addresses')
    for (const r of line.read.reads) {
      const a = own(addresses, r.thing) ? addresses[r.thing] : undefined
      if (!a || browserThingAddressProblem(a) || !own(readers, r.thing) || typeof readers[r.thing] !== 'function') return refused('addresses')
      if (a.kind === 'list_entry') {
        // A list entry is read through the earlier read of the same object: its own id, and that read's folder field.
        const via = 'read' in r.id ? line.read.reads.find(x => x.name === (r.id as { read: string }).read) : undefined
        const viaThing = via ? map.things[via.thing] : undefined
        if (!via || !viaThing || (r.id as { field: string }).field !== viaThing.id || !own(viaThing.fields, a.folder.field)) return refused('addresses')
        // An entry carries its own id (the list is searched by it); an id taken from the address would be no entry's.
        if (map.things[r.thing].id_from === 'address') return refused('addresses')
      }
    }
    if (browserLineValuesProblem(line.read, values)) return refused('values')
    if (input.expectedAccount !== undefined && (typeof input.expectedAccount !== 'string' || !BROWSER_ID_VALUE_RE.test(input.expectedAccount))) return refused('input')
    if (deps.stopped(companyId)) return refused('stopped')
    const surface = deps.window(companyId, host)
    if (!surface || surface.closed()) return refused('window')
    if (busy.has(surface)) return refused('busy')
    const stillCurrent = deps.context()
    busy.add(surface)
    const abort = new AbortController()
    const deadline = now() + limits.ms
    const timer = setTimeout(() => abort.abort(), limits.ms)
    let made = 0
    // Every check that may stop the run: the switch, the stop, the context, the same window still open, the time.
    const check = (): void => {
      if (!(deps.aiSwitch ?? buildAiSwitch)()) throw new Refusal('off')
      if (deps.stopped(companyId)) throw new Refusal('stopped')
      if (!stillCurrent()) throw new Refusal('context')
      if (surface.closed() || deps.window(companyId, host) !== surface) throw new Refusal('window')
      if (now() >= deadline || abort.signal.aborted) throw new Refusal('timeout')
    }
    // One GET of exactly this address through the window's read session; the answer's text is handed back and not kept.
    const get = async (address: string): Promise<{ status: number; body: string } | null> => {
      check()
      if (exploreAddressProblem(address) !== null) return null
      if (++made > limits.reads) throw new Refusal('too-many-reads')
      let answer: { status: number; body: string } | null
      try { answer = await surface.read(address, abort.signal) } catch { answer = null }
      return answer && typeof answer.status === 'number' && typeof answer.body === 'string' ? answer : null
    }
    const readAccount = async (): Promise<string | null> => {
      const page = await get(account.path)
      if (!page || page.status !== OK) return null
      let id: string | null = null
      try { id = account.read(page.body) } catch { id = null }
      return typeof id === 'string' && BROWSER_ID_VALUE_RE.test(id) ? id : null
    }
    const json = (body: string): { value: unknown } | null => parseStrictJson(body)
    const notRead = (thing: string, change: BrowserShapeChange, count: number): BrowserThingNotRead =>
      ({ status: 'not_read', notices: [{ site: map.site, mapVersion: map.version, thing, change, count }], diagnosis: { unknownKeys: [], missingKeys: [] } })

    const readObject = async (thing: string, a: Extract<BrowserThingAddress, { kind: 'object' }>, id: string): Promise<BrowserThingResult> => {
      const answer = await get(a.path.replace(ID_SEGMENT, id))
      if (!answer || answer.status !== OK) return notReadQuietly()
      const parsed = json(answer.body)
      if (!parsed) return notRead(thing, 'unreadable', 1)
      return readBrowserThing(map, thing, parsed.value, readers[thing], map.things[thing].id_from === 'address' ? id : undefined)
    }

    const readEntry = async (thing: string, a: Extract<BrowserThingAddress, { kind: 'list_entry' }>, folder: string, id: string): Promise<BrowserThingResult> => {
      const idField = map.things[thing].id
      const list = a.list
      const matches: unknown[] = []
      let first: { last: number; total: number } | null = null
      let seen = 0
      for (let page = 1; page <= (first?.last ?? 1); page++) {
        const answer = await get(`${a.path}?${a.folder.param}=${folder}&${a.pages.param}=${page}`)
        if (!answer || answer.status !== OK) return notReadQuietly()
        const parsed = json(answer.body)
        if (!parsed || !isObject(parsed.value)) return notRead(thing, 'unreadable', 1)
        const envelope = parsed.value
        // The envelope strictly, like a thing's keys: every key known, the ones the reading uses present.
        let unknown = Object.keys(envelope).filter(k => !list.keys.includes(k)).length
        for (const [k, itemKeys] of Object.entries(list.lists ?? {})) {
          const v = own(envelope, k) ? envelope[k] : undefined
          if (v === undefined) continue
          if (!Array.isArray(v) || !v.every(isObject)) return notRead(thing, 'unreadable', 1)
          for (const item of v as Record<string, unknown>[]) unknown += Object.keys(item).filter(x => !itemKeys.includes(x)).length
        }
        const missing = [list.items, list.current, list.last, list.total].filter(k => !own(envelope, k)).length
        if (unknown > 0 || missing > 0) {
          const notices: BrowserShapeNotice[] = []
          if (unknown > 0) notices.push({ site: map.site, mapVersion: map.version, thing, change: 'unknown_keys', count: unknown })
          if (missing > 0) notices.push({ site: map.site, mapVersion: map.version, thing, change: 'missing_keys', count: missing })
          return { status: 'not_read', notices, diagnosis: { unknownKeys: [], missingKeys: [] } }
        }
        const current = envelope[list.current]
        const last = envelope[list.last]
        const total = envelope[list.total]
        const items = envelope[list.items]
        if (!Number.isSafeInteger(current) || !Number.isSafeInteger(last) || !Number.isSafeInteger(total) || !Array.isArray(items)) return notRead(thing, 'unreadable', 1)
        // Where it stands: the page asked, the same last page and total as page 1, within what may be read whole.
        if (current !== page || (last as number) < 1 || (total as number) < 0) return notRead(thing, 'unreadable', 1)
        if (!first) {
          if ((last as number) > a.pages.max || (total as number) > a.pages.max * a.pages.perPage) return notReadQuietly()
          first = { last: last as number, total: total as number }
        } else if (last !== first.last || total !== first.total) return notReadQuietly()
        if (items.length > a.pages.perPage) return notRead(thing, 'unreadable', 1)
        seen += items.length
        for (const item of items) {
          const itemId = isObject(item) ? item[idField] : undefined
          if (String(itemId) === id && (typeof itemId === 'number' || typeof itemId === 'string')) matches.push(item)
        }
      }
      // The whole list read, and the entry in it exactly once; else it is not the entry asked for.
      if (!first || seen !== first.total || matches.length !== 1) return notReadQuietly()
      return readBrowserThing(map, thing, matches[0], readers[thing])
    }

    try {
      check()
      const before = await readAccount()
      const reads: Record<string, BrowserThingResult> = {}
      const states: Record<string, Readonly<Record<string, unknown>>> = {}
      const wantedId = (r: BrowserLineRead): string | null => {
        const v = 'value' in r.id ? values[r.id.value]?.value : states[r.id.read]?.[r.id.field]
        return typeof v === 'string' && BROWSER_ID_VALUE_RE.test(v) ? v : null
      }
      for (const r of line.read.reads) {
        const a = addresses[r.thing]
        const id = wantedId(r)
        let got: BrowserThingResult
        if (id === null) got = notReadQuietly()
        else if (a.kind === 'object') got = await readObject(r.thing, a, id)
        else {
          const folder = states[(r.id as { read: string }).read]?.[a.folder.field]
          got = typeof folder === 'string' && BROWSER_ID_VALUE_RE.test(folder) ? await readEntry(r.thing, a, folder, id) : notReadQuietly()
        }
        reads[r.name] = got
        if (got.status === 'read') states[r.name] = got.state
      }
      const after = await readAccount()
      check()
      const facts: BrowserReadFacts = {
        reads, values, account: { before, after },
        ...(input.expectedAccount !== undefined ? { expectedAccount: input.expectedAccount } : {}),
      }
      const outcome = evaluateBrowserReadLine(line.read, map, facts)
      const card = buildBrowserReadCard(line, map, facts, outcome)
      const notices = cleanNotices(map, Object.values(reads).flatMap(r => (r.status === 'not_read' ? r.notices : [])))
      if (notices.length > 0 && deps.notices) {
        // Fire and forget: the card never waits on it, and a failure changes nothing.
        try { void Promise.resolve(deps.notices.report(notices)).catch(() => {}) } catch { /* the reporter threw: nothing to do */ }
      }
      return { status: 'judged', ok: outcome.problem === null, outcome, card, member: notices.length > 0 ? BROWSER_SHAPE_WORDS.member : null, notices }
    } catch (error) {
      return refused(error instanceof Refusal ? error.reason : 'context')
    } finally {
      clearTimeout(timer)
      abort.abort()
      busy.delete(surface)
    }
  }

  return { run }
}
