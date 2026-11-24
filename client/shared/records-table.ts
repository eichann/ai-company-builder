// 「記録の一覧」 (the middle's table of records by kind; tasks-ui.md "The records table (B4)"):
// what main answers the renderer for one page. Main builds it from the server's
// `POST /records/query` answer — the server already left out every record the member may not
// read (owner-only, members-only, private folders) — and from the kinds' definitions; nothing
// here decides who sees what. Pure: types and wording. Built to be removed easily (the owner is
// not sure of this view): only `features/records-table` (main and renderer) uses this file.
import type { FieldDef, FieldKind, TypeDefinition } from '../../shared/core/record-types'
import type { RecordFieldValue, RecordSummary } from '../../shared/types/records'
import { fieldText, stateLabel } from './record-views'
import { thingName } from './thing-words'

/** One page per call: the server's largest page. 「さらに読む」 asks for the next one. */
export const RECORDS_TABLE_PAGE = 200
/** The query's largest offset (`RecordQuery.offset` 0–10000): past it the table says to narrow instead. */
export const RECORDS_TABLE_MAX_OFFSET = 10_000
/** The query's longest state list (`POST /records/query`: 1–20 names). */
const MAX_QUERY_STATES = 20

/** A kind the member can choose above the table. */
export interface RecordsTableKind { name: string; label: string }

/** A column from the kind's declared fields (server fields only: the query answers only those). */
export interface RecordsTableColumn {
  field: string
  label: string
  kind: FieldKind
  /** Shown before the member picks columns (the first few by `columnsOf`'s order). */
  shown: boolean
}

/** A cell as the member reads it, and the value it sorts by (dates as stored, people by name). */
export interface RecordsTableCell { text: string | null; sort: string | number | null }

export interface RecordsTableRow {
  id: string
  title: string
  /** The state in the member's words (null: the kind has no states). */
  stateLabel: string | null
  /** In a final state of its kind (done, cancelled…). */
  finished: boolean
  updatedAt: string
  /** 「あなただけ」 / 「この人たちだけ」, as the server marked it (never decided here). */
  personal?: true
  membersOnly?: true
  cells: Record<string, RecordsTableCell>
}

export interface RecordsTableQuery {
  /** The kind (type name). */
  kind: string
  /** Only records not in a final state (「済み以外」); asked of the server, not filtered here. */
  openOnly: boolean
  offset: number
}

export type RecordsTablePage =
  | {
    success: true
    /** false: records are turned off for the company (or an older server). */
    available: boolean
    kinds: RecordsTableKind[]
    kind: string
    columns: RecordsTableColumn[]
    /** Every match the member may read, not only this page. */
    total: number
    offset: number
    rows: RecordsTableRow[]
    /** Said above the rows when 「済み以外」 could not be asked of the server (every row is shown). */
    notice?: string
  }
  | { success: false; offline: boolean; error: string }

const COLUMN_KINDS: ReadonlySet<FieldKind> = new Set(['person', 'date', 'datetime', 'choice', 'number', 'tags', 'boolean', 'text'])
// The fields people look for first in a list (担当, 期限, 責任者…); then the rest in declared order.
const FIRST_FIELDS = ['assignee', 'owner', 'decided_by', 'due', 'meeting_at', 'requested_by', 'tags', 'important']
const SHOWN_AT_FIRST = 5

/** The kind's columns: its server fields a cell can show in a line (no long text, no record ids). */
export function columnsOf(def: TypeDefinition): RecordsTableColumn[] {
  const declared = Object.entries(def.fields)
    .filter(([name, f]) => f.source === 'server' && COLUMN_KINDS.has(f.kind) && name !== 'title')
  const rank = (name: string) => { const i = FIRST_FIELDS.indexOf(name); return i < 0 ? FIRST_FIELDS.length : i }
  return declared
    .map(([field, f], i) => ({ field, f, i }))
    .sort((a, b) => rank(a.field) - rank(b.field) || a.i - b.i)
    .map(({ field, f }, n) => ({ field, label: f.label, kind: f.kind, shown: n < SHOWN_AT_FIRST }))
}

/** The kinds in the order people meet them: やること, the 案件・プロジェクト kinds, 会議, 決めたこと, then the rest. */
export function kindsOf(defs: readonly TypeDefinition[]): RecordsTableKind[] {
  const rank = (d: TypeDefinition) => d.name === 'task' ? 0 : d.implements.includes('bundle') ? 1 : d.name === 'meeting' ? 2 : d.name === 'decision' ? 3 : 4
  return [...defs]
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, 'ja'))
    .map(d => ({ name: d.name, label: thingName({ type: d.name, typeLabel: d.label, implements: d.implements, state: null }) }))
}

/** 「済み以外」 could not be asked for this kind: every record is shown, and the member is told why. */
export const OPEN_ONLY_TOO_MANY_STATES = 'この種類は状態が多いため「済み以外」で絞れません。すべてを出しています。'

/**
 * What 「済み以外」 asks the server for (`state`: 1–20 names, the server's rule): the kind's non-final
 * states; `all` when nothing is final (no filter needed); `none` when every state is final (nothing
 * to ask: no row is open); `tooMany` past the query's limit (no filter, said in words).
 */
export function openStatesOf(def: TypeDefinition): { states: string[] } | { all: true } | { none: true } | { tooMany: true } {
  if (def.final.length === 0) return { all: true }
  const states = def.states.filter(s => !def.final.includes(s))
  if (states.length === 0) return { none: true }
  if (states.length > MAX_QUERY_STATES) return { tooMany: true }
  return { states }
}

function sortValue(f: FieldDef, value: RecordFieldValue, text: string | null): string | number | null {
  if (value === null || value === '') return null
  if (f.kind === 'number') return typeof value === 'number' ? value : Number(value)
  if (f.kind === 'date' || f.kind === 'datetime') return String(value)
  return text
}

/** One row from the server's summary (people by name: `people` = member id → name). */
export function rowOf(r: RecordSummary, def: TypeDefinition, columns: readonly RecordsTableColumn[], people: Record<string, string>): RecordsTableRow {
  const cells: Record<string, RecordsTableCell> = {}
  for (const c of columns) {
    const f = def.fields[c.field]
    const value = r.fields[c.field] ?? null
    const text = fieldText(f, value, people)
    cells[c.field] = { text, sort: sortValue(f, value, text) }
  }
  return {
    id: r.id, title: r.title || '（名前なし）', stateLabel: stateLabel(r.state, r.type, def),
    finished: r.state !== null && def.final.includes(r.state), updatedAt: r.updatedAt,
    ...(r.personal ? { personal: true as const } : {}),
    ...(r.membersOnly ? { membersOnly: true as const } : {}),
    cells,
  }
}
