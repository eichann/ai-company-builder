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
import { SET_WATCH_HUBSPOT_ITEMS, SET_WATCH_UPDATES_MAX, SET_WATCH_UPDATE_TARGETS, SET_WATCH_UPDATES_VERSION, type SetUpdateItem, type SetUpdateValue } from './ai-turn-steps/set-watch'

export const AFTER_MEETING_RESULT_FILE = 'result.json'
export const AFTER_MEETING_RESULT_VERSION = 1
/** The largest result / proposal file read (a few dozen short items). */
export const AFTER_MEETING_FILE_MAX = 64 * 1024
/** A press handed to a consultation is 「反映中」 this long while its result is not written; after it, 「途中で止まりました」. */
export const APPLY_PENDING_MS = 30 * 60_000
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
}

/** One press of the card, handed to one consultation. */
export interface ApplyEntry { id: string; at: string; kind: 'apply' | 'undo'; keys: string[] }

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
  }
  | { success: false; error: string }

export type AfterMeetingChange =
  | { kind: 'apply' | 'undo'; id: string; keys: string[] }
  | { kind: 'undone'; key: string }
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
    })
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
    return [{ id: x.id, at: x.at, kind: x.kind, keys }]
  })
  const undone = Array.isArray(o.undone) ? o.undone.filter((k): k is string => typeof k === 'string' && k.length <= KEY_MAX) : []
  return { v: 1, applies, undone, draftDismissed: o.draftDismissed === true }
}

/** Where one item stands: never pressed, handed on and waiting, stopped half-way, or what the consultation said. */
export type ItemStatus =
  | { kind: 'new' }
  | { kind: 'pending'; entry: ApplyEntry }
  | { kind: 'stopped'; entry: ApplyEntry }
  | { kind: 'result'; result: ResultItem; undone: boolean }

/** The newest result per key (a later press's result written after an earlier one in the file wins by its press). */
function resultFor(key: string, entry: ApplyEntry | null, results: readonly ResultItem[]): ResultItem | null {
  const mine = results.filter(r => itemKey(r) === key)
  if (entry) {
    const answered = mine.filter(r => r.回 === entry.id)
    if (answered.length > 0) return answered[answered.length - 1]
    return null
  }
  return mine.length > 0 ? mine[mine.length - 1] : null
}

export function itemStatus(key: string, mark: AfterMeetingMark, results: readonly ResultItem[], now: number): ItemStatus {
  const entry = [...mark.applies].reverse().find(a => a.keys.includes(key)) ?? null
  const result = resultFor(key, entry, results)
  if (entry && !result) return now - Date.parse(entry.at) < APPLY_PENDING_MS ? { kind: 'pending', entry } : { kind: 'stopped', entry }
  if (result) return { kind: 'result', result, undone: mark.undone.includes(key) }
  return { kind: 'new' }
}

/** May this item be handed to an apply consultation now: never pressed, failed, stopped half-way, or left out by the consultation. */
export function mayApply(s: ItemStatus): boolean {
  if (s.kind === 'new' || s.kind === 'stopped') return true
  return s.kind === 'result' && !s.undone && (s.result.状態 === '失敗' || s.result.状態 === '反映しない')
}

/** May a coefficient sheet item be written back: written by the consultation, with the value before kept, not taken back yet. */
export function mayUndoSheet(s: ItemStatus): boolean {
  return s.kind === 'result' && !s.undone && s.result.書き先 === '係数表' && s.result.状態 === '済み' && s.result.前の値 !== undefined && s.result.書いた値 !== undefined
}

/** A HubSpot item a person may take back through the server's undo (the server decides whether the written value is still there). */
export function mayUndoHubspot(s: ItemStatus): s is { kind: 'result'; result: ResultItem & { 操作: string; プラグイン: string }; undone: boolean } {
  return s.kind === 'result' && !s.undone && s.result.書き先 === 'hubspot' && s.result.状態 === '済み' && !!s.result.操作 && !!s.result.プラグイン
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
