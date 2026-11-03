/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the left 「探す」 tab (features/search SearchPanel): the real panel over a fake main
// process holding a made-up 営業部 (相手, 案件, やること, 会議, files) and a 開発部, plus this PC's
// consultations. `?dept=` picks the department on screen ('' = 全社, default 営業部); `?theme=dark`.
// Records, consultations and files opened show in `#opened`; the words each search sent, in `#calls`.
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { SearchPanel } from '../src/features/search/components/SearchPanel'
import { useCommandHandler } from '../src/shared/commands/commands'
import type { FindHitView, RecordViewSummary } from '../shared/record-views'
import type { RecordFindHub } from '../../shared/types/records'
import type { ConsultationTopic } from '../shared/consultation-topics'
import { foldAsciiCase } from '../../shared/core/paths'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const dept = params.get('dept') ?? '営業部'
const ROOT = '/company'
const fold = (s: string) => foldAsciiCase(s.normalize('NFC'))

/** A time `days` from now, at `hour` (local), as ISO. */
const ago = (days: number, hour = 10) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(hour, 0, 0, 0); return d.toISOString() }
/** A meeting's own time (local, no zone), `days` from today. */
const local = (days: number, hm: string) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${hm}` }

interface Rec { r: RecordViewSummary; department: string | null; mine: boolean; bundle?: { id: string; title: string }; meetingAt?: string }
const rec = (id: string, thing: RecordViewSummary['thing'], typeLabel: string, title: string, summary: string, updatedAt: string, department: string | null, mine: boolean, more: Partial<Rec> & { finished?: true } = {}): Rec => ({
  r: { id, type: id.split('-')[0], typeLabel, kind: 'other', title, summary, stateLabel: null, updatedAt, thing, ...(more.finished ? { finished: true } : {}) },
  department, mine, ...(more.bundle ? { bundle: more.bundle } : {}), ...(more.meetingAt ? { meetingAt: more.meetingAt } : {}),
})
const DEAL = { id: 'deal-sample01', title: '株式会社サンプル 研修導入' }
const RECORDS: Rec[] = [
  rec('company-sample01', 'counterpart', '相手', '株式会社サンプル', '人事部長 山田様、研修担当 佐藤様。社員300名。', ago(0), '営業部', true),
  rec(DEAL.id, 'bundle', '案件', DEAL.title, '来年4月の新人研修（30名・5日間）を受注したい。予算上限は300万円（税別）。', ago(0), '営業部', true),
  rec('deal-sample02', 'bundle', '案件', '株式会社サンプル 来期の追加研修', '管理職向けの追加研修。', ago(6), '営業部', false),
  rec('task-quote001', 'task', 'やること', '見積書を直す（講師を3日に）', '講師の日数を5日から3日に。予算上限に収める。', ago(0), '営業部', true, { bundle: DEAL }),
  rec('task-thanks01', 'task', 'やること', 'サンプル社へお礼のメール', '', ago(9), '営業部', true, { finished: true, bundle: DEAL }),
  rec('task-hire0001', 'task', 'やること', '講師の候補を3人あげる', 'サンプル社向けに、研修講師の候補を出す。', ago(2), '営業部', false, { bundle: DEAL }),
  rec('task-memo0001', 'task', 'やること', '自分用：サンプルの宿題メモ', '', ago(1), null, true),
  rec('meeting-000002', 'meeting', '会議の記録', '研修導入のご相談 2回目', 'サンプル社と日程と予算を話した。予算上限は300万円。', ago(1), '営業部', true, { bundle: DEAL, meetingAt: local(-1, '14:00') }),
  rec('decision-0001', 'decision', '決めたこと', '講師は3日にする', 'サンプル社の予算に合わせて講師の日数を減らす。', ago(1), '営業部', false, { bundle: DEAL }),
  rec('meeting-000003', 'meeting', '会議の記録', '研修導入のご相談 3回目', '', ago(0), '営業部', true, { bundle: DEAL, meetingAt: local(3, '15:00') }),
  rec('task-devapp01', 'task', 'やること', 'サンプルアプリの改修', '', ago(3), '開発部', false),
  rec('project-dev01', 'bundle', 'プロジェクト', '社内サンプル集の整理', '', ago(20), '開発部', false),
]
const HUBS: RecordFindHub[] = [
  { id: 'company-sample01', counts: { bundles: 2, openTasks: 3, meetings: 2, decisions: 1, files: 4 }, nextMeetingAt: local(3, '15:00'), lastMovedAt: ago(0), memberIds: [DEAL.id, 'deal-sample02', 'task-quote001', 'task-hire0001'] },
  { id: DEAL.id, counts: { bundles: 0, openTasks: 2, meetings: 2, decisions: 1, files: 4 }, nextMeetingAt: local(3, '15:00'), lastMovedAt: ago(0), memberIds: ['task-quote001', 'task-hire0001', 'task-thanks01'] },
  { id: 'deal-sample02', counts: { bundles: 0, openTasks: 0, meetings: 0, decisions: 0, files: 0 }, nextMeetingAt: null, lastMovedAt: ago(6), memberIds: [] },
]
const FILES: Record<string, string> = {
  '営業部/顧客/株式会社サンプル/見積書_株式会社サンプル.md': '# 見積書\n株式会社サンプル様 御中\n講師 3日間 合計 280万円（税別）',
  '営業部/顧客/株式会社サンプル/研修カリキュラム案_株式会社サンプル.md': '# カリキュラム案\n1日目 ビジネスマナー\n2日目 報連相',
  '営業部/顧客/株式会社サンプル/研修導入_提案書_株式会社サンプル.md': '# 提案書\n新人研修のご提案\n予算上限は300万円と伺っています。',
  '営業部/顧客/株式会社サンプル/議事メモ_株式会社サンプル.md': '# 議事メモ\n日程と予算の確認。',
  '営業部/研修事例/事例_製造業.md': '# 事例\nサンプル企業の導入事例。講師は社内から2名。',
  '営業部/研修事例/事例_小売.md': '# 事例\n小売業の新人研修。',
  '営業部/提案テンプレート.md': '# 提案テンプレート\n会社名：（サンプル）\n予算：',
  '開発部/サンプルコード/README.md': '# サンプルコード\n社内用のサンプル。',
}
const CONSULTATIONS = [
  { id: 'c-quote', title: '株式会社サンプルの見積を一緒に考える', updatedAt: ago(0, 9), topicRecordId: DEAL.id },
  { id: 'c-teach', title: '講師の日程の相談', updatedAt: ago(1, 16), topicRecordId: 'task-quote001' },
  { id: 'c-curr', title: '研修カリキュラムの構成案', updatedAt: ago(2, 16) },
  { id: 'c-prep', title: '今週の商談の準備', updatedAt: ago(1, 8) },
]

const DEAL_LOOK = { id: DEAL.id, title: DEAL.title, thing: 'bundle' as const, typeLabel: '案件', kindName: '案件' }
const TOPICS = new Map<string, ConsultationTopic | null>([
  [DEAL.id, { own: null, bundle: DEAL_LOOK }],
  ['task-quote001', { own: { id: 'task-quote001', title: '見積書を直す（講師を3日に）', thing: 'task', typeLabel: null, kindName: 'やること' }, bundle: DEAL_LOOK }],
])

const log = (id: string, line: string) => { const el = document.getElementById(id)!; el.textContent = `${el.textContent}${line}\n` }
const hitOf = (x: Rec): FindHitView => ({ record: x.r, department: x.department, mine: x.mine, ...(x.bundle ? { bundle: x.bundle } : {}), ...(x.meetingAt ? { meetingAt: x.meetingAt } : {}) })

installElectronAPI({
  findRecords: async (_c, text) => {
    log('calls', `records ${text}`)
    const w = fold(text)
    const found = RECORDS.filter(x => fold(x.r.title).includes(w) || fold(x.r.summary).includes(w))
    return { success: true, available: true, total: found.length, hits: found.map(hitOf), hubs: HUBS.filter(h => found.some(x => x.r.id === h.id && fold(x.r.title).includes(w))) }
  },
  findRecordsHome: async () => ({
    success: true, available: true,
    bundles: RECORDS.filter(x => x.r.thing === 'bundle' && x.mine).map(x => ({ ...hitOf(x), hub: HUBS.find(h => h.id === x.r.id)! })),
    meetings: RECORDS.filter(x => x.r.type === 'meeting' && x.mine).map(hitOf),
  }),
  gitListFiles: async (_root, folder) => ({ success: true, files: Object.keys(FILES).filter(p => !folder || p.startsWith(`${folder}/`)) }),
  gitGrep: async (_root, query, folder) => {
    log('calls', `grep ${query} in ${folder || '全社'}`)
    const w = fold(query)
    const results = Object.entries(FILES).filter(([p]) => !folder || p.startsWith(`${folder}/`))
      .flatMap(([file, body]) => body.split('\n').flatMap((text, i) => (fold(text).includes(w) ? [{ file, line: i + 1, text }] : [])))
    return { success: true, results }
  },
  getStats: async path => ({ success: true, data: { isDirectory: false, isFile: true, size: 1, mtime: path.includes('事例_製造業') ? ago(40) : ago(1), ctime: ago(60) } }),
})

function Preview() {
  useCommandHandler('record.open', ({ recordId }) => log('opened', `record ${recordId}`))
  return (
    <main className="h-screen flex bg-gray-100 dark:bg-zinc-950 text-gray-900 dark:text-zinc-100">
      <aside style={{ width: 320 }} className="shrink-0 overflow-hidden border-r border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <SearchPanel
          rootPath={ROOT} companyId="demo" departmentFolder={dept}
          departmentNames={{ 営業部: '営業部', 開発部: '開発部' }}
          bundleWord="案件"
          recent={[
            { key: `${ROOT}/営業部/顧客/株式会社サンプル/見積書_株式会社サンプル.md`, path: '営業部/顧客/株式会社サンプル/見積書_株式会社サンプル.md' },
            { key: 'acb-record:task-quote001', recordId: 'task-quote001', record: { type: 'task', title: '見積書を直す（講師を3日に）' } },
          ]}
          loadConsultations={async () => CONSULTATIONS}
          consultationTopics={TOPICS}
          onOpenConsultation={id => log('opened', `consultation ${id}`)}
          onOpenFile={(path, line) => log('opened', `file ${path}${line ? `:${line}` : ''}`)}
          notDownloaded={params.get('excluded') ? [params.get('excluded')!] : undefined}
        />
      </aside>
      <section className="flex-1 p-4 text-xs text-gray-500 space-y-3">
        <div><b>開いたもの</b><pre id="opened" className="whitespace-pre-wrap" /></div>
        <div><b>探した言葉</b><pre id="calls" className="whitespace-pre-wrap" /></div>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
