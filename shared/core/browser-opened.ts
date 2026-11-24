/**
 * The opened list's lines (「開けた1行」, generalization PR 3; `agent-browser.md` "The first map and the inspection line").
 * Internal design memo 「ブラウザ操作の汎用化」 §3-5, §7-3, §15 C5 / C7, §16-5, §16-7 R7, §17-2, §18 (Q15). Pure; nothing
 * in the app or the server calls it yet (the server reads `shared/browser-connectors/opened.json` in PR 4).
 *
 * A line is reviewed data: its name and version, the card's title, the read part (`browser-read-line.ts`: values, reads,
 * checks), the card's headings of its reads and which fields the card shows. A line holds **no write** in this PR: it can
 * only be an inspection (読むだけの点検, §7-3).
 *
 * Two hashes per line (§16-5, owner decision Q15 §18), both computed from the line and the map — never taken as written:
 * - **the meaning** (`browserLineMeaning`): what the line reads and judges — the site, its values (kinds, roles, sources),
 *   its reads, checks and shown fields, and, copied from the map, each read thing's id field and where it comes from, its
 *   parent, its fields' kinds and its must-hold facts (a note's presence, not its words). A member's grant (PR 4) is keyed
 *   by it;
 * - **the mechanics** (`browserLineMechanics`): how — the map's version and hash (key lists, labels, notes' words), the
 *   site's reader code's fingerprint, and the line's own words. Whether a mechanics change keeps the grants is a reviewed
 *   decision of "compatible" (Q15), never automatic.
 * The core returns canonical JSON; the hashing (`sha256:`) is the caller's (the core imports no crypto).
 *
 * The core knows no site, thing or field. Every shape here is **provisional** until a second site fits it (§18).
 */
import { isPlainBrowserText } from './plugin-browser-declaration'
import { BROWSER_MAP_LIMITS, BROWSER_MAP_NAME_RE, type BrowserMap } from './browser-map'
import { browserReadLineProblem, type BrowserReadLine } from './browser-read-line'
import { browserLineWritesProblem, type BrowserLineWrite } from './browser-write-line'
import { canonicalJson } from './fixed-content'

/** Fields of one read the card shows (in this order). */
export interface BrowserLineShow { read: string; fields: readonly string[] }

export interface BrowserOpenedLine {
  /** The line's name (`BROWSER_MAP_NAME_RE`). */
  name: string
  /** The line's version (semver): a changed line under the same name and map version needs a new one. */
  version: string
  /** The card's title (Japanese, plain). */
  label: string
  read: BrowserReadLine
  /**
   * The writes (generalization PR 6, `browser-write-line.ts`): absent for an inspection (読むだけの点検). A line with writes
   * is never made a plan by a build that cannot write it (the server refuses it, `BROWSER_LINE_WRITES_NOT_YET`).
   */
  writes?: readonly BrowserLineWrite[]
  /** The card's heading of each read (Japanese, plain): every read has one. */
  readLabels: Readonly<Record<string, string>>
  show: readonly BrowserLineShow[]
}

export const BROWSER_OPENED_LIMITS = { label: 40, show: 10, showFields: 20 } as const

/** A line's state in the opened list (as `approved.json`): written `pending`, approved or retired by a reviewed edit. */
export const BROWSER_OPENED_STATUSES = ['pending', 'approved', 'retired'] as const
export type BrowserOpenedStatus = typeof BROWSER_OPENED_STATUSES[number]

/** One map in the opened list: the map's text and its hashes (`mapHash` of the map's canonical JSON, `readersHash` of the site's reader code). */
export interface BrowserOpenedMapRow { site: string; version: string; mapHash: string; readersHash: string; map: BrowserMap }
/** One line in the opened list. */
export interface BrowserOpenedLineRow {
  name: string
  version: string
  site: string
  mapVersion: string
  status: BrowserOpenedStatus
  meaningHash: string
  mechanicsHash: string
  /**
   * The mechanics hashes of earlier rows of this line with the same meaning whose members' grants this row carries
   * (§16-5, owner decision Q15): written only by a reviewed edit that calls the mechanics change compatible, kept by the
   * script, never computed. Absent = none (a grant given on another mechanics hash does not count here).
   */
  grantsFrom?: string[]
  line: BrowserOpenedLine
}
/** `shared/browser-connectors/opened.json` (format 1, provisional until a second site, §18). */
export interface BrowserOpenedFile { format: 1; provisional: true; maps: BrowserOpenedMapRow[]; lines: BrowserOpenedLineRow[] }

const SEMVER_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(k => own(v, k))

/**
 * Why this line cannot be opened against this map (Japanese, for the reviewer), or null (§17-2 「行の検査」): its own
 * shape, the read part (`browserReadLineProblem`: only the map's things and fields, the core's words, the sources each
 * role allows, the must-hold parent named), a heading for every read and no other, shown fields the read's thing has.
 */
export function browserOpenedLineProblem(raw: unknown, map: BrowserMap): string | null {
  const shape = ['name', 'version', 'label', 'read', 'readLabels', 'show']
  if (!isMap(raw) || !(exactKeys(raw, shape) || exactKeys(raw, [...shape, 'writes']))) return '行の形が正しくありません'
  if (typeof raw.name !== 'string' || !BROWSER_MAP_NAME_RE.test(raw.name)) return '行の名前が正しくありません'
  if (typeof raw.version !== 'string' || !SEMVER_RE.test(raw.version)) return '行の版が正しくありません'
  if (!isPlainBrowserText(raw.label, BROWSER_OPENED_LIMITS.label)) return '行の見出しが正しくありません'
  const readProblem = browserReadLineProblem(raw.read, map)
  if (readProblem) return readProblem
  const line = raw.read as BrowserReadLine
  if (own(raw, 'writes')) {
    const writesProblem = browserLineWritesProblem(raw.writes, line, map)
    if (writesProblem) return writesProblem
  }
  const readNames = line.reads.map(r => r.name)
  const labels = raw.readLabels
  if (!isMap(labels) || !exactKeys(labels, readNames)) return '読むものの見出しは、読むものごとに1つです'
  if (!readNames.every(n => isPlainBrowserText(labels[n], BROWSER_MAP_LIMITS.label))) return '読むものの見出しが正しくありません'
  if (!Array.isArray(raw.show) || raw.show.length > BROWSER_OPENED_LIMITS.show) return 'カードに出す欄が正しくありません'
  const shown = new Set<string>()
  for (const s of raw.show) {
    if (!isMap(s) || !exactKeys(s, ['read', 'fields']) || typeof s.read !== 'string' || !readNames.includes(s.read) || shown.has(s.read)) return 'カードに出す欄の形が正しくありません'
    shown.add(s.read)
    const thing = map.things[(line.reads.find(r => r.name === s.read) as BrowserReadLine['reads'][number]).thing]
    if (!Array.isArray(s.fields) || s.fields.length === 0 || s.fields.length > BROWSER_OPENED_LIMITS.showFields || new Set(s.fields).size !== s.fields.length) return `カードに出す欄（${s.read}）が正しくありません`
    if (!s.fields.every(f => typeof f === 'string' && own(thing.fields, f))) return `カードに出す欄（${s.read}）が地図にありません`
  }
  return null
}

/**
 * The line's meaning as canonical JSON (§16-5): the line's names, values, reads, checks and shown fields, with each read
 * thing's meaning copied from the map (id field and its source, parent, fields' kinds, must-hold facts — a note's
 * presence only). Labels, key lists, the readers' code and the notes' words are mechanics. Throws on a line the map does
 * not open (call `browserOpenedLineProblem` first).
 */
export function browserLineMeaning(line: BrowserOpenedLine, map: BrowserMap): string {
  if (browserOpenedLineProblem(line, map)) throw new Error('browserLineMeaning: the line does not open against the map')
  const things = [...new Set(line.read.reads.map(r => r.thing))].sort()
  // A line's writes and a thing's write facts are part of what it means (memo §16-5: what it changes and who that
  // reaches); added only where present, so an inspection's meaning (and its members' grants) stays what it was.
  const writes = line.writes ? { writes: line.writes } : {}
  const written = new Set((line.writes ?? []).map(w => (line.read.reads.find(r => r.name === w.read) as BrowserReadLine['reads'][number]).thing))
  return canonicalJson({
    ...writes,
    site: line.read.site,
    name: line.name,
    values: line.read.values,
    reads: line.read.reads,
    checks: line.read.checks,
    show: line.show,
    account: map.account !== undefined,
    things: Object.fromEntries(things.map(name => {
      const t = map.things[name]
      return [name, {
        id: t.id,
        idFrom: t.id_from ?? 'answer',
        parent: t.parent ?? null,
        fields: Object.fromEntries(Object.entries(t.fields).map(([f, field]) => [f, { kind: field.kind, nullable: field.nullable === true }])),
        mustHold: { account: t.must_hold?.account === true, parent: t.must_hold?.parent === true, note: t.must_hold?.note !== undefined },
        ...(written.has(name) ? { writes: t.writes ?? null, delivers: t.delivers ?? null } : {}),
      }]
    })),
  })
}

/**
 * The line's mechanics as canonical JSON (§16-5): the map's version and hash, the site's readers' fingerprint and the
 * line's own words (title, read headings, version). Both hashes are the caller's `sha256:` strings.
 */
export function browserLineMechanics(line: BrowserOpenedLine, map: BrowserMap, hashes: { mapHash: string; readersHash: string }): string {
  return canonicalJson({
    mapVersion: map.version,
    mapHash: hashes.mapHash,
    readersHash: hashes.readersHash,
    version: line.version,
    label: line.label,
    readLabels: line.readLabels,
  })
}
