/**
 * 「会議のあと」 (4b-4 PR6-A, owner memo 「4b-4 挟む部分」 H-9 A / S3 / S11; jobs.md "The set watch (schema 5)" "The 4b-4
 * screens (PR6-A)"): the pure part shared by main (`electron/features/after-meeting/`) and the screen
 * (`src/features/after-meeting/`). Built to be thrown away: nothing outside those places and the listed doors imports it
 * (`client/tests/after-meeting-removable.test.ts`).
 *
 * Three files on this PC, none on the server: the run's `更新案.json` (the job's AI wrote it, PR5), the run's `result.json`
 * (the apply consultation's AI writes it, in the shape its first message gives), and the app's own mark in its data
 * (`<userData>/after-meeting/<company>/<occurrence>.json`: what was handed to a consultation, when, so nothing is applied twice).
 */
import { RECORD_ID_RE } from '../../shared/core/records'
import { SET_WATCH_HUBSPOT_ITEMS, SET_WATCH_UPDATES_MAX, SET_WATCH_UPDATE_TARGETS, SET_WATCH_UPDATES_VERSION, type SetUpdateItem, type SetUpdateValue } from './ai-turn-steps/set-watch'

export const AFTER_MEETING_RESULT_FILE = 'result.json'
export const AFTER_MEETING_RESULT_VERSION = 1
/** The largest result / proposal file read (a few dozen short items). */
export const AFTER_MEETING_FILE_MAX = 64 * 1024
/**
 * A press handed to a consultation is 「反映中」 this long while its result is not written; after it, 「途中で止まりました」 — offered
 * again only with the last check saying the earlier consultation may still be writing (the member looks first).
 */
export const APPLY_PENDING_MS = 2 * 60 * 60_000
/** An unapplied proposal older than this says so on its card (S11 #7: on this PC, when it is opened). */
export const UNAPPLIED_NOTE_AFTER_MS = 3 * 24 * 60 * 60_000

export type UpdateTarget = typeof SET_WATCH_UPDATE_TARGETS[number]
export type { SetUpdateItem, SetUpdateValue }

/** What the consultation's AI says of one item (`result.json`). */
export const RESULT_STATES = ['済み', '失敗', '承認待ち', '担当が違う', '反映しない', '戻した'] as const
export type ResultState = typeof RESULT_STATES[number]

export interface ResultItem {
  /** The press (`ApplyEntry.id`) this result answers. */
  回: string
  書き先: UpdateTarget
  取引: string
  項目: string
  状態: ResultState
  理由?: string
  /** An approval request the plugin's operation made (`approval-…`): opened by its id; its card is the server's. */
  承認?: string
  承認する人?: string
  /** The deal's assignee when it is not the member (状態 担当が違う). */
  担当?: string
  /** The plugin operation that wrote it (a person's 「元に戻す」 goes to the server's undo with it). */
  操作?: string
  プラグイン?: string
  前の値?: SetUpdateValue
  書いた値?: SetUpdateValue
  /** The 案件 the consultation wrote to (its record id), when the card chose one for the item's 取引. */
  案件?: string
}

/**
 * An existing 案件 the card offers for a HubSpot 取引 (owner FB #43): read with the member's session from the records they
 * read — the meeting's own 案件, one the file names, one of the meeting's 相手, one whose name holds the company's.
 */
export interface DealChoice {
  id: string
  title: string
  /** 担当's name (null: none, or not known). */
  assignee: string | null
  /** 確度 as shown (its label). */
  confidence: string | null
  amount: number | null
  why: 'linked' | 'named' | 'customer' | 'name'
}

/** The member's choice for one HubSpot 取引 of the file: an existing 案件 (its id), or null = make a new one. */
export interface DealPick { 取引: string; 案件: string | null }

/** What a press handed on of one item, kept so a card opened again shows what was applied (an added item, an edited value). */
export interface HandedItem { 書き先: UpdateTarget; 取引: string; 項目: string; 値: SetUpdateValue }

/** One press of the card, handed to one consultation (`items`: an apply's values, in the order of `keys`). */
export interface ApplyEntry { id: string; at: string; kind: 'apply' | 'undo'; keys: string[]; items?: HandedItem[]; deals?: DealPick[] }

/** The app's mark of one occurrence on this PC. */
export interface AfterMeetingMark {
  v: 1
  applies: ApplyEntry[]
  /** Items whose HubSpot write the member took back here (the server's undo answered it). */
  undone: string[]
  /** ［いらない］ on the proposal's draft: its buttons fold (nothing recorded on the server). */
  draftDismissed: boolean
}

export const EMPTY_MARK: AfterMeetingMark = { v: 1, applies: [], undone: [], draftDismissed: false }

/** What the card is told of the run, from its record on this PC (`job-set-runs`). */
export interface AfterMeetingRun {
  /** Company-relative run folder (`<place>/.personal/<folder>/<day>_<company>`). */
  folder: string
  decision: string | null
  confidence: number | null
  minutesDocVersion: string | null
  /** When the record was written (the proposal's age). */
  at: string
}

export type AfterMeetingRead =
  | { success: true; run: null }
  | {
    success: true
    run: AfterMeetingRun
    meetingId: string | null
    proposals: SetUpdateItem[]
    /** Why the proposals could not be shown: none written, another version, not the shape. */
    problem: 'none' | 'version' | 'shape' | null
    results: ResultItem[]
    mark: AfterMeetingMark
    /** 確度's choices, from the business plugin's type the server answers (null: not found → typed). */
    stages: string[] | null
    /** The 案件 the card offers for the HubSpot items (null: not read — offline, no 案件 type, no HubSpot item → no choice). */
    deals: DealChoice[] | null
    /** The 案件 the meeting is linked to now (null: none, or not one the member reads). */
    meetingBundle: string | null
  }
  | { success: false; error: string }

export type AfterMeetingChange =
  | { kind: 'apply'; id: string; keys: string[]; items: HandedItem[]; deals?: DealPick[] }
  | { kind: 'undo'; id: string; keys: string[] }
  | { kind: 'undone'; key: string }
  /** The consultation of a press did not start: its press is taken back (only while nothing answered it). */
  | { kind: 'cancel'; id: string }
  | { kind: 'draft-dismissed' }

export type AfterMeetingNoteResult = { success: true; mark: AfterMeetingMark } | { success: false; code: 'ALREADY' | 'BAD_REQUEST' | 'NOT_HERE'; error: string }

/** An item is told apart by its target, deal and item (with the meeting: the file holds one meeting). */
export function itemKey(i: { 書き先: string; 取引: string; 項目: string }): string {
  return `${i.書き先}\n${i.取引.normalize('NFC')}\n${i.項目.normalize('NFC')}`
}

export const APPLY_ID_RE = /^[au]-[0-9a-f]{16}$/
const KEY_MAX = 200
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
// eslint-disable-next-line no-control-regex
const ONE_LINE = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v)

export function isUpdateValue(v: unknown): v is SetUpdateValue {
  if (typeof v === 'string') return v.length <= 2000
  if (typeof v === 'number') return Number.isFinite(v)
  return Array.isArray(v) && v.length > 0 && v.length <= 24 && v.every(x => typeof x === 'object' && x !== null && !Array.isArray(x)
    && Object.keys(x).length === 2 && typeof (x as Record<string, unknown>).月 === 'string' && MONTH_RE.test((x as Record<string, string>).月)
    && typeof (x as Record<string, unknown>).金額 === 'number' && Number.isFinite((x as Record<string, number>).金額))
}

/** An item's 項目 for its target: HubSpot's fixed list, a coefficient sheet's one short line. */
export function itemFits(target: unknown, item: unknown): boolean {
  if (target === 'hubspot') return (SET_WATCH_HUBSPOT_ITEMS as readonly unknown[]).includes(item)
  return target === '係数表' && ONE_LINE(item, 40)
}

function parseJson(text: string): Record<string, unknown> | null {
  if (text.length > AFTER_MEETING_FILE_MAX) return null
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}

/**
 * `更新案.json` as the card reads it (PR5 checked it before the run was counted; read again here, since the file is on disk):
 * the version, at most 20 items of the fixed shape, each key once. Another version → `version` (「このアプリでは表示できない形
 * です」); anything else → `shape`. The quotes are kept as written (PR5 found them in the minutes when the run reported).
 */
export function readProposalFile(text: string): { meetingId: string; items: SetUpdateItem[] } | { problem: 'version' | 'shape' } {
  const o = parseJson(text)
  if (!o) return { problem: 'shape' }
  if (o.版 !== SET_WATCH_UPDATES_VERSION) return { problem: typeof o.版 === 'number' ? 'version' : 'shape' }
  if (typeof o.会議 !== 'string' || !/^[a-z][a-z0-9_]{0,39}-[0-9a-z]{6,32}$/.test(o.会議)) return { problem: 'shape' }
  if (!Array.isArray(o.更新案) || o.更新案.length > SET_WATCH_UPDATES_MAX) return { problem: 'shape' }
  const items: SetUpdateItem[] = []
  const seen = new Set<string>()
  for (const raw of o.更新案 as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { problem: 'shape' }
    const x = raw as Record<string, unknown>
    if (!(SET_WATCH_UPDATE_TARGETS as readonly unknown[]).includes(x.書き先) || !ONE_LINE(x.取引, 100) || !itemFits(x.書き先, x.項目) || !isUpdateValue(x.値)) return { problem: 'shape' }
    if (x.根拠 !== undefined && (typeof x.根拠 !== 'string' || x.根拠.length > 2000)) return { problem: 'shape' }
    if (x.理由 !== undefined && (typeof x.理由 !== 'string' || x.理由.length > 300)) return { problem: 'shape' }
    const item: SetUpdateItem = { 書き先: x.書き先 as UpdateTarget, 取引: x.取引 as string, 項目: x.項目 as string, 値: x.値 as SetUpdateValue, ...(typeof x.根拠 === 'string' ? { 根拠: x.根拠 } : {}), ...(typeof x.理由 === 'string' ? { 理由: x.理由 } : {}) }
    const key = itemKey(item)
    if (seen.has(key)) return { problem: 'shape' }
    seen.add(key)
    items.push(item)
  }
  return { meetingId: o.会議, items }
}

const PLUGIN_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/
const APPROVAL_ID_RE = /^approval-[0-9a-z]{6,32}$/

/**
 * `result.json` as the card reads it. The consultation's AI writes it, so each entry is taken on its own: one not of the shape
 * is left out (never the others), an approval / operation id only in its plain shape, names one short line. Read as words to
 * show, never as a decision: the server answers every undo and approval itself.
 */
export function readResultFile(text: string): ResultItem[] {
  const o = parseJson(text)
  if (!o || o.版 !== AFTER_MEETING_RESULT_VERSION || !Array.isArray(o.結果)) return []
  const out: ResultItem[] = []
  for (const raw of (o.結果 as unknown[]).slice(0, 100)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const x = raw as Record<string, unknown>
    if (typeof x.回 !== 'string' || !APPLY_ID_RE.test(x.回)) continue
    if (!(SET_WATCH_UPDATE_TARGETS as readonly unknown[]).includes(x.書き先) || !ONE_LINE(x.取引, 100) || !itemFits(x.書き先, x.項目)) continue
    if (!(RESULT_STATES as readonly unknown[]).includes(x.状態)) continue
    out.push({
      回: x.回, 書き先: x.書き先 as UpdateTarget, 取引: x.取引 as string, 項目: x.項目 as string, 状態: x.状態 as ResultState,
      ...(ONE_LINE(x.理由, 300) ? { 理由: x.理由 } : {}),
      ...(typeof x.承認 === 'string' && APPROVAL_ID_RE.test(x.承認) ? { 承認: x.承認 } : {}),
      ...(ONE_LINE(x.承認する人, 40) ? { 承認する人: x.承認する人 } : {}),
      ...(ONE_LINE(x.担当, 40) ? { 担当: x.担当 } : {}),
      ...(typeof x.操作 === 'string' && OPERATION_ID_RE.test(x.操作) && typeof x.プラグイン === 'string' && PLUGIN_ID_RE.test(x.プラグイン) ? { 操作: x.操作, プラグイン: x.プラグイン } : {}),
      ...(isUpdateValue(x.前の値) ? { 前の値: x.前の値 } : {}),
      ...(isUpdateValue(x.書いた値) ? { 書いた値: x.書いた値 } : {}),
      ...(typeof x.案件 === 'string' && RECORD_ID_RE.test(x.案件) ? { 案件: x.案件 } : {}),
    })
  }
  return out
}

/** An apply's handed items, only when each is of the file's shape and they are exactly `keys`, in order; else null. */
export function handedItems(v: unknown, keys: readonly string[]): HandedItem[] | null {
  if (!Array.isArray(v) || v.length !== keys.length) return null
  const out: HandedItem[] = []
  for (const [i, raw] of v.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const x = raw as Record<string, unknown>
    if (!(SET_WATCH_UPDATE_TARGETS as readonly unknown[]).includes(x.書き先) || !ONE_LINE(x.取引, 100) || !itemFits(x.書き先, x.項目) || !isUpdateValue(x.値)) return null
    const item: HandedItem = { 書き先: x.書き先 as UpdateTarget, 取引: x.取引 as string, 項目: x.項目 as string, 値: x.値 as SetUpdateValue }
    if (itemKey(item) !== keys[i]) return null
    out.push(item)
  }
  return out
}

/** The app's mark read back (another shape → the empty mark: nothing was handed on from this PC as far as it can tell). */
export function readMark(text: string | null): AfterMeetingMark {
  const o = text === null ? null : parseJson(text)
  if (!o || o.v !== 1 || !Array.isArray(o.applies)) return { ...EMPTY_MARK, applies: [], undone: [] }
  const applies = (o.applies as unknown[]).flatMap((a): ApplyEntry[] => {
    if (typeof a !== 'object' || a === null) return []
    const x = a as Record<string, unknown>
    if (typeof x.id !== 'string' || !APPLY_ID_RE.test(x.id) || typeof x.at !== 'string' || Number.isNaN(Date.parse(x.at))) return []
    if ((x.kind !== 'apply' && x.kind !== 'undo') || !Array.isArray(x.keys)) return []
    const keys = x.keys.filter((k): k is string => typeof k === 'string' && k.length <= KEY_MAX)
    const items = handedItems(x.items, keys)
    const deals = items ? dealPicks(x.deals, items) : null
    return [{ id: x.id, at: x.at, kind: x.kind, keys, ...(x.kind === 'apply' && items ? { items } : {}), ...(x.kind === 'apply' && deals && deals.length > 0 ? { deals } : {}) }]
  })
  const undone = Array.isArray(o.undone) ? o.undone.filter((k): k is string => typeof k === 'string' && k.length <= KEY_MAX) : []
  return { v: 1, applies, undone, draftDismissed: o.draftDismissed === true }
}

/**
 * Where one item stands: never pressed, handed on and waiting, stopped half-way, or what the consultation said. `entry` is the
 * newest press holding it (an apply or an undo); `written` the result of the newest apply press when it wrote the item (済み), so
 * an undo that failed or stopped never makes a written item look unwritten.
 */
export type ItemStatus =
  | { kind: 'new' }
  | { kind: 'pending'; entry: ApplyEntry; written: ResultItem | null }
  | { kind: 'stopped'; entry: ApplyEntry; written: ResultItem | null }
  | { kind: 'result'; result: ResultItem; undone: boolean; via: 'apply' | 'undo' | null; written: ResultItem | null }

/** The result answering one press for a key (the last one the file holds for it). */
function answerOf(key: string, entry: ApplyEntry, results: readonly ResultItem[]): ResultItem | null {
  const answered = results.filter(r => itemKey(r) === key && r.回 === entry.id)
  return answered.length > 0 ? answered[answered.length - 1] : null
}

export function itemStatus(key: string, mark: AfterMeetingMark, results: readonly ResultItem[], now: number): ItemStatus {
  const holding = mark.applies.filter(a => a.keys.includes(key))
  const entry = holding.length > 0 ? holding[holding.length - 1] : null
  const lastApply = [...holding].reverse().find(a => a.kind === 'apply') ?? null
  const applied = lastApply ? answerOf(key, lastApply, results) : null
  const written = applied && applied.状態 === '済み' ? applied : null
  if (entry) {
    const result = answerOf(key, entry, results)
    if (!result) return now - Date.parse(entry.at) < APPLY_PENDING_MS ? { kind: 'pending', entry, written } : { kind: 'stopped', entry, written }
    return { kind: 'result', result, undone: mark.undone.includes(key), via: entry.kind, written }
  }
  // No press of this PC (a lost or trimmed mark): the file's last result for the item, if any.
  const mine = results.filter(r => itemKey(r) === key)
  if (mine.length > 0) return { kind: 'result', result: mine[mine.length - 1], undone: mark.undone.includes(key), via: null, written: null }
  return { kind: 'new' }
}

/**
 * May this item be handed to an apply consultation now: never pressed, an apply that failed, stopped half-way or was left out by
 * the consultation — never one an apply wrote (also when an undo of it failed or stopped).
 */
export function mayApply(s: ItemStatus): boolean {
  if (s.kind === 'new') return true
  if (s.written) return false
  if (s.kind === 'stopped') return s.entry.kind === 'apply'
  return s.kind === 'result' && s.via !== 'undo' && !s.undone && (s.result.状態 === '失敗' || s.result.状態 === '反映しない')
}

/**
 * The apply result a coefficient sheet undo writes back from: the item an apply wrote with the value before kept, not taken back
 * (a 戻した result) and its undo not waiting. Null when it may not be undone now.
 */
export function sheetWritten(s: ItemStatus): ResultItem | null {
  if (s.kind === 'new' || s.kind === 'pending' || !s.written) return null
  if (s.kind === 'result' && (s.undone || s.result.状態 === '戻した')) return null
  const w = s.written
  return w.書き先 === '係数表' && w.前の値 !== undefined && w.書いた値 !== undefined ? w : null
}

export function mayUndoSheet(s: ItemStatus): boolean {
  return sheetWritten(s) !== null
}

/** A HubSpot item a person may take back through the server's undo (the server decides whether the written value is still there). */
export function mayUndoHubspot(s: ItemStatus): s is { kind: 'result'; result: ResultItem & { 操作: string; プラグイン: string }; undone: boolean; via: 'apply'; written: ResultItem } {
  return s.kind === 'result' && s.via === 'apply' && !s.undone && s.result.書き先 === 'hubspot' && s.result.状態 === '済み' && !!s.result.操作 && !!s.result.プラグイン
}

/**
 * main's check before it records a press (one place for "never twice"): every key once, and each one the press may take now —
 * an apply only `mayApply`, an undo only `mayUndoSheet`. Answers the keys that may not, none = it may.
 */
export function refusedKeys(change: { kind: 'apply' | 'undo'; keys: readonly string[] }, mark: AfterMeetingMark, results: readonly ResultItem[], now: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const key of change.keys) {
    const s = itemStatus(key, mark, results, now)
    if (seen.has(key) || !(change.kind === 'apply' ? mayApply(s) : mayUndoSheet(s))) out.push(key)
    seen.add(key)
  }
  return out
}

/**
 * A press's 案件 choices, only of the shape the card sends: each a HubSpot 取引 the press hands on, once, with a record id or
 * null (make a new one). Absent → none (an older card); anything else → null (refused).
 */
export function dealPicks(v: unknown, items: readonly HandedItem[]): DealPick[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > SET_WATCH_UPDATES_MAX) return null
  const deals = new Set(items.filter(i => i.書き先 === 'hubspot').map(i => i.取引.normalize('NFC')))
  const seen = new Set<string>()
  const out: DealPick[] = []
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const x = raw as Record<string, unknown>
    if (Object.keys(x).length !== 2 || typeof x.取引 !== 'string' || !deals.has(x.取引.normalize('NFC')) || seen.has(x.取引.normalize('NFC'))) return null
    if (x.案件 !== null && !(typeof x.案件 === 'string' && RECORD_ID_RE.test(x.案件))) return null
    seen.add(x.取引.normalize('NFC'))
    out.push({ 取引: x.取引, 案件: x.案件 as string | null })
  }
  return out
}

/** The 案件 the newest press chose for a 取引 (undefined: none chose; null: 「新しく作る」). */
export function pickedBefore(deal: string, mark: AfterMeetingMark): string | null | undefined {
  for (const a of [...mark.applies].reverse()) {
    const p = a.deals?.find(x => x.取引.normalize('NFC') === deal.normalize('NFC'))
    if (p) return p.案件
  }
  return undefined
}

/**
 * The 取引's 案件 can no longer be changed: an earlier press chose one and an item of that 取引 is written, waiting for an
 * approval, on its way or stopped half-way (the earlier consultation may still be writing) — a later press then writes to the
 * same 案件, never to another one.
 */
export function dealLocked(deal: string, mark: AfterMeetingMark, results: readonly ResultItem[], now: number): string | null | undefined {
  const before = pickedBefore(deal, mark)
  if (before === undefined) return undefined
  const prefix = `hubspot\n${deal.normalize('NFC')}\n`
  const keys = new Set(mark.applies.flatMap(a => a.keys).filter(k => k.startsWith(prefix)))
  for (const key of keys) {
    const s = itemStatus(key, mark, results, now)
    const open = s.kind === 'new' || (s.kind === 'result' && !s.written && (s.result.状態 === '失敗' || s.result.状態 === '反映しない'))
    if (!open) return before
  }
  return undefined
}

/**
 * main's check beside `refusedKeys`: the HubSpot 取引 of a press whose 案件 an earlier press began writing to, and which this
 * press would send elsewhere — another 案件, 「新しく作る」, or no choice at all (the consultation would search again).
 */
export function movedDeals(picks: readonly DealPick[], handed: readonly HandedItem[], mark: AfterMeetingMark, results: readonly ResultItem[], now: number): string[] {
  const deals = [...new Set(handed.filter(i => i.書き先 === 'hubspot').map(i => i.取引))]
  return deals.filter(deal => {
    const locked = dealLocked(deal, mark, results, now)
    const pick = picks.find(p => p.取引.normalize('NFC') === deal.normalize('NFC'))
    return locked !== undefined && (!pick || pick.案件 !== locked)
  })
}
