// Preview of 「記録の一覧」 in the middle's tabs, composed as AppShell does (entry only): a file
// tab, ［表で見る］ and ⌘K open the table; a row opens its record in a tab beside it. The preload
// API is faked: `getRecordsTablePage` answers from the rows below (as the server would, already
// filtered), and window.__acbAsked lists every question asked.
// /tests/records-table-ui.html?theme=light|dark (&off=1: records turned off; &offline=1: the
// server unreachable; &many=1: 450 やること, read 200 at a time; &slow=task: やること answers late)
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TabbedEditorPanel } from '../src/features/editor/components/TabbedEditorPanel'
import { recordIdOfTab, recordTabKey, viewTabKey } from '../src/features/editor/editorTabs'
import { FindPalette } from '../src/features/search/components/FindPalette'
import { RECORDS_TABLE_PALETTE_ACTION, RECORDS_TABLE_TAB_LOOK, RECORDS_TABLE_VIEW, renderRecordsTable, startRecordsTable } from '../src/features/records-table/entry'
import { useAppStore } from '../src/stores/appStore'
import { useKeybindings } from '../src/shared/commands/commands'
import type { RecordsTablePage, RecordsTableQuery, RecordsTableRow } from '../shared/records-table'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const ROOT = '/Users/demo/会社'
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

const cell = (text: string | null) => ({ text, sort: text })
const task = (id: string, title: string, state: string, assignee: string | null, due: string | null, extra: Partial<RecordsTableRow> = {}): RecordsTableRow => ({
  id, title, stateLabel: state, finished: state === '完了', updatedAt: `${day(-1)}T09:00:00Z`,
  cells: { assignee: cell(assignee), due: cell(due), requested_by: cell('阿部') }, ...extra,
})
const TASKS: RecordsTableRow[] = params.get('many')
  ? Array.from({ length: 450 }, (_, i) => task(`task-${String(i).padStart(3, '0')}`, `やること ${i + 1}`, 'まだ', i % 2 ? '佐藤' : '田中', day(i % 30)))
  : [
    task('task-kitayama', '北山工業に事例集を送る', '進めている', '高橋', day(-3)),
    task('task-morita', '森田さまへのお礼メールを確かめる', '待ち', '佐藤', day(0)),
    task('task-sakura', 'さくら不動産の契約書を法務に回す', 'まだ', '田中', day(4)),
    task('task-mitsumori', '見積もりを作って送る', '進めている', '佐藤', day(6), { personal: true }),
    task('task-kenshu', '研修の日程案を出す', 'まだ', null, null),
    task('task-done', '先週の議事録を共有する', '完了', '高橋', day(-8)),
  ]
const DECISIONS: RecordsTableRow[] = [
  { id: 'decision-1', title: '見積もりは税込で出す', stateLabel: '決まり', finished: false, updatedAt: `${day(-2)}T09:00:00Z`, cells: { decided_by: cell('阿部') } },
]
const COLUMNS = {
  task: [
    { field: 'assignee', label: '担当', kind: 'person' as const, shown: true },
    { field: 'due', label: '期限', kind: 'date' as const, shown: true },
    { field: 'requested_by', label: '依頼した人', kind: 'person' as const, shown: false },
  ],
  decision: [{ field: 'decided_by', label: '決めた人', kind: 'person' as const, shown: true }],
}
const asked: RecordsTableQuery[] = []
const kinds = [{ name: 'task', label: 'やること' }, { name: 'decision', label: '決めたこと' }]
let reads = 0

async function page(_companyId: string, q: RecordsTableQuery): Promise<RecordsTablePage> {
  asked.push(q)
  reads += 1
  // The first read of やること answers late (a kind switched to meanwhile must win).
  if (params.get('slow') === q.kind && reads === 1) await new Promise(r => setTimeout(r, 800))
  if (params.get('offline')) return { success: false, offline: true, error: 'サーバーにつながらないため、表示できません。つながってから開き直してください。' }
  if (params.get('off')) return { success: true, available: false, kinds: [], kind: q.kind, columns: [], total: 0, offset: 0, rows: [] }
  const kind = q.kind === 'decision' ? 'decision' : 'task'
  const all = (kind === 'task' ? TASKS : DECISIONS).filter(r => !q.openOnly || !r.finished)
  return { success: true, available: true, kinds, kind, columns: COLUMNS[kind], total: all.length, offset: q.offset, rows: all.slice(q.offset, q.offset + 200) }
}

installElectronAPI({
  getRecordsTablePage: page,
  readFile: async () => '# 議事録\n\n定例のメモです。',
  searchRecords: async () => ({ success: true, available: true, total: 0, records: [] }),
  gitListFiles: async () => ({ success: true, files: [] }),
})
Object.assign(window, { __acbAsked: asked })
useAppStore.setState({ currentCompany: { id: 'demo', name: '株式会社デモ', rootPath: ROOT, departments: [], createdAt: new Date() } })

const TABLE = viewTabKey(RECORDS_TABLE_VIEW)
const FILE = `${ROOT}/営業部/議事録.md`

export function Preview() {
  useKeybindings()
  const [tabs, setTabs] = useState<string[]>([FILE])
  const [active, setActive] = useState<string>(FILE)
  const [palette, setPalette] = useState(false)
  const open = (key: string) => { setTabs(t => (t.includes(key) ? t : [...t, key])); setActive(key) }
  // As AppShell's showRecordsTable.
  const showTable = (kind?: string) => { startRecordsTable('demo', kind); open(TABLE) }
  const close = (key: string) => {
    const rest = tabs.filter(t => t !== key)
    setTabs(rest)
    if (active === key) setActive(rest[rest.length - 1] ?? '')
  }
  return (
    <main className="flex h-screen flex-col bg-bg text-text">
      <div className="flex gap-2 px-3 py-2">
        <button type="button" onClick={() => showTable('task')}>表で見る（やること）</button>
        <button type="button" onClick={() => setPalette(true)}>⌘K を開く</button>
      </div>
      <div className="min-h-0 flex-1">
        <TabbedEditorPanel openFiles={tabs} activeFilePath={active} onSelectFile={setActive} onCloseFile={close}
          recordLooks={{}}
          renderRecord={id => <p className="p-4" data-testid="record-page">記録のページ：{id}</p>}
          viewLooks={{ [RECORDS_TABLE_VIEW]: RECORDS_TABLE_TAB_LOOK }}
          renderView={name => name === RECORDS_TABLE_VIEW ? renderRecordsTable('demo', id => open(recordTabKey(id))) : null} />
      </div>
      {palette && (
        <FindPalette onClose={() => setPalette(false)} rootPath={ROOT} companyId="demo" departmentFolder="" recent={[]}
          onSelectFile={open} onOpenRecord={id => open(recordTabKey(id))}
          actions={[RECORDS_TABLE_PALETTE_ACTION]} onAction={id => { if (id === RECORDS_TABLE_PALETTE_ACTION.id) showTable() }} />
      )}
      <output data-testid="active-tab" hidden>{recordIdOfTab(active) ?? active}</output>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
