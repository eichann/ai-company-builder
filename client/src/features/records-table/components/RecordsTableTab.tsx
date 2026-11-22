// 「記録の一覧」: the middle's table of one kind's records (tasks-ui.md "The records table (B4)").
// Over ~300 lines: one screen (heading, narrowing, table, page foot) whose parts share one state.
import { useMemo, useState, type KeyboardEvent } from 'react'
import { ArrowClockwise, CaretDown, CaretUp, Columns, Lock, UsersThree } from '@phosphor-icons/react'
import { Callout, StatusBadge } from '../../../shared/ui/primitives'
import { useAuthStore } from '../../../stores/authStore'
import type { RecordsTableColumn, RecordsTableRow } from '../../../../shared/records-table'
import type { RecordsTableReads } from '../api'
import { filterRows, isOverdue, nextSort, pageNote, shortDate, shortDay, shownColumns, sortRows, todayOf, type SortKey } from '../model'
import { chooseKind, chooseOpenOnly, pickColumns, readMore, reloadTable, setSort, setText, useRecordsTableState } from '../tableState'

interface Props {
  companyId: string
  /** A row opens its record in a tab beside this one (AppShell: the record tab). */
  onOpenRecord: (recordId: string) => void
  /** Tests hand a fake read; the app uses window.electronAPI. */
  reads?: RecordsTableReads
  /** The clock for 期限切れ (tests). */
  now?: () => number
}

const CONTROL = 'inline-flex h-control-sm items-center gap-1 rounded-control border border-border-control bg-bg px-control-sm-x text-small text-text hover:bg-surface-sunken disabled:opacity-disabled'
const CELL = 'border-b border-[color:var(--color-border)] px-table-cell-x py-1.5 text-left align-top'

export function RecordsTableTab({ companyId, onOpenRecord, reads, now = Date.now }: Props) {
  const userId = useAuthStore(s => s.user?.id ?? '')
  const scope = `${userId}:${companyId}`
  const s = useRecordsTableState()
  // Another member or company than the state's: nothing of it is shown.
  const mine = s.scope === scope
  const page = mine ? s.page : null
  const [columnsOpen, setColumnsOpen] = useState(false)
  const today = todayOf(now())

  const columns = useMemo(() => page ? shownColumns(page.columns, s.picked[page.kind]) : [], [page, s.picked])
  const rows = useMemo(() => page ? sortRows(filterRows(page.rows, s.text, columns), s.sort) : [], [page, s.text, s.sort, columns])
  const kindLabel = page?.kinds.find(k => k.name === page.kind)?.label ?? ''
  const note = page ? pageNote(page.rows.length, page.total) : null

  const header = (key: SortKey, label: string) => {
    const dir = s.sort?.key === key ? s.sort.dir : null
    return (
      <th key={key} scope="col" aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'} className="sticky top-0 border-b border-[color:var(--color-border)] bg-surface-raised p-0 font-normal">
        <button type="button" onClick={() => setSort(nextSort(s.sort, key))}
          className="flex w-full items-center gap-0.5 whitespace-nowrap px-table-cell-x py-1.5 text-left text-small text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring">
          {label}{dir === 'asc' ? <CaretUp size={11} aria-hidden /> : dir === 'desc' ? <CaretDown size={11} aria-hidden /> : null}
        </button>
      </th>
    )
  }

  // ↑ ↓ Home End move between rows; Enter (or Space) opens the row's record.
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: RecordsTableRow) => {
    const tr = e.currentTarget
    const go = (target: Element | null | undefined) => { if (target instanceof HTMLElement) { e.preventDefault(); target.focus() } }
    if (e.key === 'ArrowDown') go(tr.nextElementSibling)
    else if (e.key === 'ArrowUp') go(tr.previousElementSibling)
    else if (e.key === 'Home') go(tr.parentElement?.firstElementChild)
    else if (e.key === 'End') go(tr.parentElement?.lastElementChild)
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenRecord(row.id) }
  }

  const cell = (row: RecordsTableRow, c: RecordsTableColumn) => {
    const v = row.cells[c.field]
    const late = isOverdue(row, c.field, v, today)
    return (
      <td key={c.field} className={`${CELL} whitespace-nowrap ${late ? 'text-danger-text' : ''}`}>
        {v?.text ? (c.kind === 'date' ? shortDate(v.text, today) : v.text) : <span className="text-text-subtle">—</span>}{late && <span className="ml-1 text-caption">（過ぎています）</span>}
      </td>
    )
  }

  // A tab shown again without its question (opened from ← →, or after another member signed in): ask anew.
  const reloadAfterScope = () => {
    useRecordsTableState.setState(st => st.scope === scope ? {} : { scope, page: null, error: null, text: '', sort: null, picked: {} })
    return reloadTable(companyId, reads)
  }

  const body = () => {
    const loadButton = (onClick: () => void) => <div className="px-4 py-6"><button type="button" className={CONTROL} onClick={onClick}>一覧を読み込む</button></div>
    if (!mine) return loadButton(() => { void reloadAfterScope() })
    if (!page && s.loading) return <p className="px-4 py-6 text-body text-text-muted">読み込んでいます</p>
    if (!page && s.error) return <div className="p-4"><Callout tone={s.error.offline ? 'offline' : 'danger'} action={<button type="button" className={CONTROL} onClick={() => { void reloadTable(companyId, reads) }}>もう一度</button>}>{s.error.text}</Callout></div>
    if (!page) return loadButton(() => { void reloadTable(companyId, reads) })
    if (!page.available) return <div className="p-4"><Callout tone="info">この会社では、やることや決めたことなどの記録を使っていません。</Callout></div>
    if (page.rows.length === 0) return <p className="px-4 py-6 text-body text-text-muted">{page.openOnly ? `済んでいない${kindLabel}はありません。` : `${kindLabel}はまだありません。`}</p>
    return (
      <table className="w-full border-separate border-spacing-0 text-body">
        <thead>
          <tr>
            {header('state', '状態')}
            {header('title', '題名')}
            {columns.map(c => header(`field:${c.field}`, c.label))}
            {header('updated', '更新日')}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} tabIndex={0} data-record-row={row.id} aria-label={row.title}
              onClick={() => onOpenRecord(row.id)} onKeyDown={e => onRowKey(e, row)}
              className={`cursor-pointer hover:bg-surface-sunken focus-visible:bg-selected-bg focus-visible:outline-none ${row.finished ? 'text-text-muted' : ''}`}>
              <td className={`${CELL} whitespace-nowrap`}>{row.stateLabel ? <StatusBadge variant={row.finished ? 'neutral' : 'info'} icon={null}>{row.stateLabel}</StatusBadge> : null}</td>
              <td className={`${CELL} min-w-[var(--size-menu)]`}>
                <span className="mr-1">{row.title}</span>
                {row.personal && <StatusBadge icon={Lock}>あなただけ</StatusBadge>}
                {row.membersOnly && <StatusBadge icon={UsersThree}>この人たちだけ</StatusBadge>}
              </td>
              {columns.map(c => cell(row, c))}
              <td className={`${CELL} whitespace-nowrap text-text-muted`}>{shortDay(row.updatedAt, today)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <section aria-label="記録の一覧" className="flex h-full min-h-0 flex-col bg-bg text-text">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2">
        <h2 className="text-title font-strong">記録の一覧</h2>
        {page && page.kinds.length > 0 && (
          <div role="group" aria-label="種類" className="flex flex-wrap gap-1">
            {page.kinds.map(k => (
              <button key={k.name} type="button" aria-pressed={k.name === page.kind} onClick={() => { void chooseKind(companyId, k.name, reads) }}
                className={`h-control-sm rounded-control border px-control-sm-x text-small ${k.name === page.kind ? 'border-selected-border bg-selected-bg text-selected-text' : 'border-border-control bg-bg text-text-muted hover:bg-surface-sunken hover:text-text'}`}>
                {k.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {page?.available && (
        <div className="relative flex flex-shrink-0 flex-wrap items-center gap-2 px-4 py-2">
          <label className="inline-flex items-center gap-1 text-small text-text-muted">
            状態
            <select value={s.openOnly ? 'open' : 'all'} onChange={e => { void chooseOpenOnly(companyId, e.target.value === 'open', reads) }} className={CONTROL}>
              <option value="open">済み以外</option>
              <option value="all">すべて</option>
            </select>
          </label>
          <input type="search" value={s.text} onChange={e => setText(e.target.value)} placeholder="文字で絞り込む" aria-label="文字で絞り込む"
            className="h-control-sm w-48 rounded-control border border-border-control bg-bg px-input-x text-small text-text placeholder:text-text-subtle focus:border-focus-border focus:outline-none" />
          <span className="text-small text-text-muted" data-testid="records-table-count">{s.text ? `${rows.length} 件（読み込んだ ${page.rows.length} 件から）` : `${page.total} 件`}</span>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" className={CONTROL} aria-expanded={columnsOpen} onClick={() => setColumnsOpen(o => !o)}><Columns size={13} aria-hidden />列</button>
            <button type="button" className={CONTROL} disabled={!!s.loading} onClick={() => { void reloadTable(companyId, reads) }}><ArrowClockwise size={13} aria-hidden />読み直す</button>
          </div>
          {columnsOpen && (
            <div role="group" aria-label="出す列" onKeyDown={e => { if (e.key === 'Escape') setColumnsOpen(false) }}
              className="absolute right-4 top-full z-menu max-h-72 w-56 overflow-y-auto rounded-control border border-border-control bg-surface-raised p-menu shadow-pop">
              {page.columns.map(c => {
                const on = columns.some(x => x.field === c.field)
                return (
                  <label key={c.field} className="flex items-center gap-2 px-menu-item-x py-1 text-small">
                    <input type="checkbox" checked={on} onChange={() => pickColumns(page.kind, page.columns.filter(x => x.field === c.field ? !on : columns.some(y => y.field === x.field)).map(x => x.field))} />
                    {c.label}
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}
      {s.error && page && <div className="px-4 pb-2"><Callout tone={s.error.offline ? 'offline' : 'danger'}>{s.error.text}</Callout></div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {body()}
        {page?.available && page.rows.length > 0 && rows.length === 0 && (
          <p className="px-4 py-4 text-body text-text-muted">「{s.text}」に合う行はありません（読み込んだ {page.rows.length} 件の中で探しています）。</p>
        )}
      </div>
      {note?.more && page && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-[color:var(--color-border)] px-4 py-1.5 text-caption text-text-muted">
          <span data-testid="records-table-page-note">{note.text}</span>
          <button type="button" className={CONTROL} disabled={!!s.loading} onClick={() => { void readMore(companyId, reads) }}>{s.loading === 'more' ? '読み込んでいます' : 'さらに読む'}</button>
        </div>
      )}
    </section>
  )
}
