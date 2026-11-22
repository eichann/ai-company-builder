// 「記録の一覧」's only door (tasks-ui.md "The records table (B4)"): what the screen skeleton needs
// to put the table in a middle tab and open it from ［表で見る］ and ⌘K. Nothing else of this
// folder is imported from outside it (client/tests/records-table-removable.test.ts), so removing
// the folder plus the lines the rule lists removes the feature.
import { Table } from '@phosphor-icons/react'
import { useAuthStore } from '../../stores/authStore'
import { RecordsTableTab } from './components/RecordsTableTab'
import { openRecordsTable, scopeOf } from './tableState'

/** The middle tab's name (the editor's screen tab `viewTabKey(RECORDS_TABLE_VIEW)`). */
export const RECORDS_TABLE_VIEW = 'records-table'

/** How the tab reads in the tab bar. */
export const RECORDS_TABLE_TAB_LOOK = { title: '記録の一覧', icon: <Table size={14} className="flex-shrink-0" aria-hidden /> }

/** ⌘K finds it by these words (「記録の一覧」 typed, or 表, 一覧…). */
export const RECORDS_TABLE_PALETTE_ACTION = { id: 'recordsTable', title: '記録の一覧', words: ['記録', '一覧', '表で見る', 'テーブル', 'table'] } as const

/** Starts a fresh read of `kind` (or the kind shown last); the caller then opens the tab. */
export function startRecordsTable(companyId: string, kind?: string): void {
  void openRecordsTable(scopeOf(useAuthStore.getState().user?.id, companyId), companyId, kind)
}

/** The tab's page; a row opens its record in a tab beside it. */
export function renderRecordsTable(companyId: string, onOpenRecord: (recordId: string) => void) {
  return <RecordsTableTab key={companyId} companyId={companyId} onOpenRecord={onOpenRecord} />
}
