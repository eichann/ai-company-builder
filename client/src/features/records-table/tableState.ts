// 「記録の一覧」's state while the app runs: what the table shows and how the member narrowed it,
// kept when the member opens a record beside it and comes back (memory only — never disk, never
// another member or company: everything is tied to one scope, the member × the company).
// Loads start from the member's presses (open, kind, 済み以外, 読み直す, さらに読む), never from an
// effect; an answer that arrives after a newer question was asked is dropped (switching kinds fast).
import { create } from 'zustand'
import { RECORDS_TABLE_MAX_OFFSET, type RecordsTableColumn, type RecordsTableKind, type RecordsTableRow } from '../../../shared/records-table'
import { useAuthStore } from '../../stores/authStore'
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
  /** How far into the server's list the pages read reach (the next page's offset), apart from the rows shown. */
  consumed: number
  /** Said above the rows (「済み以外」 not asked of the server). */
  notice?: string
  /**
   * Why 「さらに読む」 stops: the list changed between pages (a record came or went ahead: reading on
   * would skip or repeat), the next page is past the query's reach, or the kind is gone.
   */
  stopped?: 'changed' | 'limit' | 'kindGone'
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
  if (!s.scope) return // nobody signed in: nothing is read
  const { kind, openOnly, scope } = s
  if (mode === 'more' && s.page?.stopped) return // the member reads again from the start instead
  const offset = mode === 'more' && s.page ? s.page.consumed : 0
  if (mode === 'more' && s.page && offset > RECORDS_TABLE_MAX_OFFSET) {
    useRecordsTableState.setState({ page: { ...s.page, stopped: 'limit' } })
    return
  }
  const asked = s.asked + 1
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
  const page = { kind: answer.kind, openOnly, available: answer.available, kinds: answer.kinds, columns: answer.columns, total: answer.total, ...(answer.notice ? { notice: answer.notice } : {}) }
  if (mode === 'replace' || !now.page) {
    useRecordsTableState.setState({ loading: null, kind: answer.kind, page: { ...page, rows: answer.rows, consumed: answer.rows.length } })
    return
  }
  // 「さらに読む」: the server fell back to another kind — the rows read stay, and reading stops.
  if (answer.kind !== now.page.kind) {
    useRecordsTableState.setState({ loading: null, page: { ...now.page, stopped: 'kindGone' } })
    return
  }
  // A page after the ones read, each record once. Pages count by the server's offset, not by the rows
  // shown; a total that moved, or a record already read (the list shifted: one came, went or moved
  // ahead, so another may be skipped), means the list changed under the member: reading stops there.
  const seen = new Set(now.page.rows.map(r => r.id))
  const fresh = answer.rows.filter(r => !seen.has(r.id))
  const changed = answer.total !== now.page.total || fresh.length < answer.rows.length
  useRecordsTableState.setState({
    loading: null,
    page: { ...now.page, rows: [...now.page.rows, ...fresh], consumed: now.page.consumed + answer.rows.length, ...(changed ? { stopped: 'changed' as const } : {}) },
  })
}

/** Opening the tab (［表で見る］, ⌘K): a fresh read; another member or company starts from nothing; nobody (null) reads nothing. */
export function openRecordsTable(scope: string | null, companyId: string, kind?: string, reads?: RecordsTableReads): Promise<void> {
  const s = useRecordsTableState.getState()
  if (!scope) { useRecordsTableState.setState({ ...START, asked: s.asked }); return Promise.resolve() }
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

/** Back to nothing shown (sign-out; tests). */
export const resetRecordsTable = () => useRecordsTableState.setState(s => ({ ...START, asked: s.asked + 1 }))

/** The scope of the member signed in now (null: nobody, which never matches a state's scope). */
export const scopeOf = (userId: string | null | undefined, companyId: string): string | null => (userId ? `${userId}:${companyId}` : null)

// Signing out (or another member signing in) forgets what the table showed (its rows were the member's), and drops answers on their way.
useAuthStore.subscribe((now, before) => { if ((before.user?.id ?? null) !== (now.user?.id ?? null)) resetRecordsTable() })
