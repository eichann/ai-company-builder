// 「記録の一覧」's state while the app runs: what the table shows and how the member narrowed it,
// kept when the member opens a record beside it and comes back (memory only — never disk, never
// another member or company: everything is tied to one scope, the member × the company).
// Loads start from the member's presses (open, kind, 済み以外, 読み直す, さらに読む), never from an
// effect; an answer that arrives after a newer question was asked is dropped (switching kinds fast).
import { create } from 'zustand'
import type { RecordsTableColumn, RecordsTableKind, RecordsTableRow } from '../../../shared/records-table'
import { readRecordsTablePage, type RecordsTableReads } from './api'
import type { Sort } from './model'

/** What one answer put on screen, and for which question. */
export interface ShownPage {
  kind: string
  openOnly: boolean
  available: boolean
  kinds: RecordsTableKind[]
  columns: RecordsTableColumn[]
  total: number
  rows: RecordsTableRow[]
}

export interface TableState {
  /** `<member id>:<company id>` the state belongs to; anything else on screen starts empty. */
  scope: string | null
  kind: string
  openOnly: boolean
  text: string
  sort: Sort
  /** Columns the member picked, per kind, while the app runs. */
  picked: Record<string, string[]>
  loading: 'replace' | 'more' | null
  page: ShownPage | null
  error: { text: string; offline: boolean } | null
  /** The latest question asked: an answer to an older one is dropped. */
  asked: number
}

const START: TableState = { scope: null, kind: 'task', openOnly: true, text: '', sort: null, picked: {}, loading: null, page: null, error: null, asked: 0 }

export const useRecordsTableState = create<TableState>(() => ({ ...START }))

const DEFAULT_ERROR = '表示できませんでした。'

/** Reads page 1 (`replace`) or the next page (`more`) of the question the state holds now. */
async function load(companyId: string, mode: 'replace' | 'more', reads?: RecordsTableReads): Promise<void> {
  const s = useRecordsTableState.getState()
  const asked = s.asked + 1
  const { kind, openOnly, scope } = s
  const offset = mode === 'more' && s.page ? s.page.rows.length : 0
  useRecordsTableState.setState({ asked, loading: mode, error: null })
  const answer = await readRecordsTablePage(companyId, { kind, openOnly, offset }, reads)
    .catch(() => ({ success: false as const, offline: true, error: DEFAULT_ERROR }))
  const now = useRecordsTableState.getState()
  if (now.asked !== asked || now.scope !== scope) return
  if (!answer.success) {
    // Rows of another question are never left under this one's heading.
    const same = now.page && now.page.kind === kind && now.page.openOnly === openOnly
    useRecordsTableState.setState({ loading: null, error: { text: answer.error || DEFAULT_ERROR, offline: answer.offline }, page: same ? now.page : null })
    return
  }
  // Rows are exactly the server's answer (a page appended after the ones read, each record once).
  const before = mode === 'more' && now.page?.kind === answer.kind ? now.page.rows : []
  const seen = new Set(before.map(r => r.id))
  const rows = [...before, ...answer.rows.filter(r => !seen.has(r.id))]
  useRecordsTableState.setState({
    loading: null, kind: answer.kind,
    page: { kind: answer.kind, openOnly, available: answer.available, kinds: answer.kinds, columns: answer.columns, total: answer.total, rows },
  })
}

/** Opening the tab (［表で見る］, ⌘K): a fresh read; another member or company starts from nothing. */
export function openRecordsTable(scope: string, companyId: string, kind?: string, reads?: RecordsTableReads): Promise<void> {
  const s = useRecordsTableState.getState()
  const base = s.scope === scope ? s : { ...START, asked: s.asked }
  useRecordsTableState.setState({ ...base, scope, ...(kind ? { kind, text: '', sort: null } : {}) })
  return load(companyId, 'replace', reads)
}

export function chooseKind(companyId: string, kind: string, reads?: RecordsTableReads): Promise<void> {
  useRecordsTableState.setState({ kind, text: '', sort: null })
  return load(companyId, 'replace', reads)
}

export function chooseOpenOnly(companyId: string, openOnly: boolean, reads?: RecordsTableReads): Promise<void> {
  useRecordsTableState.setState({ openOnly })
  return load(companyId, 'replace', reads)
}

export const reloadTable = (companyId: string, reads?: RecordsTableReads) => load(companyId, 'replace', reads)
export const readMore = (companyId: string, reads?: RecordsTableReads) => load(companyId, 'more', reads)

export const setText = (text: string) => useRecordsTableState.setState({ text })
export const setSort = (sort: Sort) => useRecordsTableState.setState({ sort })
export const pickColumns = (kind: string, fields: string[]) =>
  useRecordsTableState.setState(s => ({ picked: { ...s.picked, [kind]: fields } }))

/** Tests only: back to nothing shown. */
export const resetRecordsTable = () => useRecordsTableState.setState({ ...START })
