/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the record screens (features/records RecordCard): the real card over a fake main
// process whose card is built by the real `summaryView` / `recordDetailOf`. `?record=meeting` (the
// default) is a meeting with its decisions, homework and many links; `?record=slack` a 来た連絡
// from Slack with the thread slot filled; `?record=bundle` a 案件 with everyone's やること, an approval
// request and what the AI last did (`?ai=working`: while it works). Links opened outside show in `#opened`.
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { RecordCard } from '../src/features/records/components/RecordCard'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { RecordSummary } from '../../shared/types/records'
import { bundleDetailOf, recordDetailOf } from '../shared/record-details'
import { summaryView, type RecordCardLink } from '../shared/record-views'
import { installElectronAPI } from './ui/fixtures/electron-api'

const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
const people = { 'u-sato': '佐藤', 'u-abe': '阿部' }
const params = new URLSearchParams(location.search)
const kind = params.get('record') ?? 'meeting'
const rec = (id: string, type: string, title: string, state: string | null, fields: RecordSummary['fields'] = {}, summary = ''): RecordSummary =>
  ({ id, type, typeVersion: 1, title, summary, path: null, state, fields, version: 3, updatedAt: '2026-11-05T06:00:00.000Z' })
const view = (r: RecordSummary) => summaryView(r, defs.get(r.type))

const meeting = rec('meeting-0000aa', 'meeting', 'A社 研修導入のお打ち合わせ', 'read', {
  meeting_at: '2026-11-05T14:30', assignee: 'u-sato', attendees: '["u-sato","u-abe"]', external_count: 2,
  summary_text: '窓口を2つから3つに増やす方向で合意。金額は150万円の見込み。',
  source_ref: JSON.stringify({ conference: 'c1', event: 'e1', docs: [{ kind: 'notes', id: 'notesDoc12345' }, { kind: 'transcript', id: 'transcriptDoc123' }] }),
})
const slack = rec('interaction-0000bb', 'interaction', '資料送付のお願い', 'received', {
  channel: 'slack', occurred_at: '2026-11-05T17:30:00Z', counterpart_text: '山田 様（C社）', needs_reply: true, source_ref: 'slack:C0123ABCD:1730800000.123456',
}, '先日の打ち合わせ資料を送ってほしいとのこと。')

const task = (n: number, state = 'todo') => ({ label: 'もとの会議', record: view(rec(`task-00000${n}`, 'task', `宿題 ${n}`, state)) })
const links: RecordCardLink[] = kind === 'slack' ? [] : [
  task(1), task(2), task(3), task(4, 'done'),
  { label: '会議', record: view(rec('decision-000001', 'decision', '窓口は3つにする', 'unconfirmed')) },
]
const tasks = [
  rec('task-0000b1', 'task', '見積書を作り直す', 'todo', { assignee: 'u-sato', due: '2026-11-07T17:00' }),
  rec('task-0000b2', 'task', 'スケジュール案を出す', 'in_progress', { assignee: 'u-abe' }),
  rec('task-0000b3', 'task', 'お礼メールを送る', 'done', { assignee: 'u-sato' }),
]
const deal = rec('deal-0000cc', 'deal', 'A社 研修導入', 'open', { owner: 'u-abe', purpose: '新人研修の窓口を3つにする' })
const approval = rec('approval-0000dd', 'approval', '金額を 1,500,000円 に改める', 'pending')
const bundleLinks: RecordCardLink[] = [...tasks, approval].map(r => ({ label: 'まとまり', record: view(r) }))
const record = kind === 'slack' ? slack : kind === 'bundle' ? deal : meeting
const opened: string[] = []
const card = kind === 'bundle'
  ? {
    record: { ...view(deal), typeLabel: '案件', thing: 'bundle' as const },
    detail: bundleDetailOf(deal, [...tasks, approval], 'u-sato', people),
    fields: [], history: [], links: bundleLinks,
    ai: params.get('ai') === 'working' ? { working: true, done: null } : { working: false, done: { at: '2026-11-05T06:38:00.000Z', text: '承認のお願い 1件を作りました' } },
  }
  : { record: view(record), detail: recordDetailOf(record, people) ?? undefined, fields: [], history: [], links }

installElectronAPI({
  getRecordCard: async () => ({ success: true, card }),
  openExternal: async url => { opened.push(url); document.getElementById('opened')!.textContent = opened.join('\n'); return { success: true } },
})

function Preview() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <pre id="opened" className="text-[10px]" />
      <RecordCard companyId="co-preview" rootPath="/Users/me/company" recordId={record.id}
        renderSource={r => (r.type === 'interaction' ? <div data-testid="thread">スレッドの前後と返事の下書き：{r.title}</div> : null)}
        renderApproval={id => <div data-testid="approval">承認のお願いのカード：{id}</div>} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
