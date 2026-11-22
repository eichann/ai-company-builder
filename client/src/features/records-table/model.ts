// 「記録の一覧」's pure rules (tasks-ui.md "The records table (B4)"): sorting and the text filter
// work on the rows already read (one page or more), never asking the server to widen anything.
import { dayWindow, DEFAULT_COMPANY_TIME_ZONE } from '../../../../shared/core/calendar'
import type { RecordsTableCell, RecordsTableColumn, RecordsTableRow } from '../../../shared/records-table'

/** A column the member can sort by: the three every kind has, or one of the kind's fields. */
export type SortKey = 'title' | 'state' | 'updated' | `field:${string}`
export type Sort = { key: SortKey; dir: 'asc' | 'desc' } | null

const sortValueOf = (row: RecordsTableRow, key: SortKey): string | number | null => {
  if (key === 'title') return row.title
  if (key === 'state') return row.stateLabel
  if (key === 'updated') return row.updatedAt
  return row.cells[key.slice('field:'.length)]?.sort ?? null
}

/** Rows sorted by one column; empty values always last, ties keep the server's order (newest change first). */
export function sortRows(rows: readonly RecordsTableRow[], sort: Sort): RecordsTableRow[] {
  if (!sort) return [...rows]
  const sign = sort.dir === 'asc' ? 1 : -1
  return rows
    .map((row, i) => ({ row, i, v: sortValueOf(row, sort.key) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), 'ja')
      return c !== 0 ? sign * c : a.i - b.i
    })
    .map(x => x.row)
}

/** A header press: ascending, then descending, then back to the server's order. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (!current || current.key !== key) return { key, dir: 'asc' }
  return current.dir === 'asc' ? { key, dir: 'desc' } : null
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase()

/** Rows whose title, state or any shown cell holds every word typed (full-width and case folded). */
export function filterRows(rows: readonly RecordsTableRow[], text: string, columns: readonly RecordsTableColumn[]): RecordsTableRow[] {
  const words = fold(text).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter(row => {
    const hay = fold([row.title, row.stateLabel ?? '', ...columns.map(c => row.cells[c.field]?.text ?? '')].join('\n'))
    return words.every(w => hay.includes(w))
  })
}

/** The company's today (Japan time, like 今日のフォルダ). */
export const todayOf = (nowMs: number): string => dayWindow(nowMs, DEFAULT_COMPANY_TIME_ZONE).date

/** 期限 passed on a record not finished: drawn red (the field `due` only; other dates are just dates). */
export function isOverdue(row: RecordsTableRow, field: string, cell: RecordsTableCell | undefined, today: string): boolean {
  return field === 'due' && !row.finished && typeof cell?.sort === 'string' && cell.sort.slice(0, 10) < today
}

/** The columns on screen: the member's pick for this kind while the tab lives, else the kind's first few. */
export function shownColumns(columns: readonly RecordsTableColumn[], picked: readonly string[] | undefined): RecordsTableColumn[] {
  return picked ? columns.filter(c => picked.includes(c.field)) : columns.filter(c => c.shown)
}

/** 「全 N 件のうち M 件」, and whether 「さらに読む」 has more to read. */
export function pageNote(loaded: number, total: number): { text: string; more: boolean } {
  if (total <= loaded) return { text: `${total} 件`, more: false }
  return { text: `全 ${total} 件のうち ${loaded} 件を読み込みました（並べ替え・絞り込みは読み込んだ分の中で行います）`, more: true }
}

/** A stored date (2026-11-19) as the list shows it: 11/19 this year, else with the year. */
export function shortDate(value: string, today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return value
  return m[1] === today.slice(0, 4) ? `${Number(m[2])}/${Number(m[3])}` : `${m[1]}/${Number(m[2])}/${Number(m[3])}`
}

/** The day of `updatedAt` (company time) as the list shows it. */
export const shortDay = (iso: string, today: string): string => shortDate(dayWindow(Date.parse(iso), DEFAULT_COMPANY_TIME_ZONE).date, today)
