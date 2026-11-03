/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the task list (features/tasks): the real panel and hooks over a fake main
// process that keeps the list like the server would (a new task is added, 引き受ける moves it).
// Dates are relative to now. What was opened shows as the card stub; actions sent in `#acted`.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TaskListPanel } from '../src/features/tasks/components/TaskListPanel'
import { useTaskList } from '../src/features/tasks/hooks/useTaskList'
import { addDays, companyNow } from '../src/features/tasks/model'
import type { TaskListData, TaskListItem } from '../shared/tasks'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'

const now = companyNow(Date.now())
const day = (n: number) => addDays(now.date, n)
const base = { type: 'task', typeLabel: 'タスク', version: 2, tags: [] as string[], waitingFor: null, personal: false, own: false, actingFor: null, bundle: null, finishedAt: null, stateLabel: null }
const it = (over: Partial<TaskListItem> & Pick<TaskListItem, 'id' | 'title' | 'turn'>): TaskListItem => ({ ...base, state: 'todo', due: null, ...over })
let data: TaskListData = {
  available: true, listDepartmentIds: null, me: 'u-me',
  // 営業部 (the department on screen) makes 案件: the meeting question says 「案件」, never 「まとまり」.
  bundleKinds: { core: { type: 'project', name: 'プロジェクト', source: 'core' }, departments: [{ departmentId: 'd-sales', folder: '営業部', kind: { type: 'deal', name: '案件', source: 'plugin' } }], kinds: [] }, members: [{ id: 'u-me', name: '佐藤' }, { id: 'u-tanaka', name: '田中' }, { id: 'u-abe', name: '阿部' }],
  items: [
    it({ id: 'task-acc001', title: 'セキュリティのチェックシート', turn: 'acceptance', state: 'awaiting_acceptance', due: day(5) }),
    it({ id: 'task-mine01', title: 'お礼メールを確かめて送る', turn: 'mine', due: `${day(0)}T23:59`, tags: ['営業'], bundle: { id: 'deal-a00001', title: 'A社 問い合わせ対応', typeLabel: '案件' } }),
    it({ id: 'task-mine02', title: '見積書を作り直す', turn: 'mine', due: day(1), tags: ['営業', '見積'], own: true, personal: true, check: { action: 'complete' } }),
    // Asked with 確かめてから: the ☑ shows it to the checker instead of completing.
    it({ id: 'task-chk001', title: '提案書の数字を直す', turn: 'mine', state: 'in_progress', check: { action: 'request_review', reviewer: 'u-abe' } }),
    it({ id: 'task-far001', title: '来期の研修メニューを見直す', turn: 'mine', due: day(40), tags: ['社内'] }),
    it({ id: 'task-ai0001', title: '日程の候補を探す', turn: 'ai', state: 'preparing' }),
    it({ id: 'task-oth001', title: '金額の変更の承認', turn: 'others', waitingFor: '阿部さんの番' }),
    // Asked of someone else: no box, the 「人に頼んだもの」 mark.
    it({ id: 'task-ask001', title: 'セキュリティ資料を送る', turn: 'others', state: 'awaiting_acceptance', waitingFor: '田中さんに頼んだ・引き受け待ち', askedOfOthers: true }),
    it({ id: 'task-done01', title: '経費の申請', turn: 'done', state: 'done', finishedAt: new Date().toISOString() }),
    it({ id: 'meeting-00aa11', type: 'meeting', typeLabel: '会議', title: 'C社 打ち合わせ', turn: 'mine', state: 'read', waitingFor: 'どの案件・プロジェクトの会議か選んでください', needsBundle: true, bundleGroup: { key: 'g-c', label: 'C社 打ち合わせ' } }),
    // The server suggests the 相手's one open まとまり: 「『…』の会議ですか？」.
    it({ id: 'meeting-00cc31', type: 'meeting', typeLabel: '会議', title: 'E社 打ち合わせ', turn: 'mine', state: 'read', waitingFor: '『E社 研修導入』の会議ですか？', needsBundle: true, bundleGroup: { key: 'g-e', label: 'E社' }, suggestedBundle: { id: 'deal-e00001', title: 'E社 研修導入' } }),
    // Two meetings of one series (the server's group): one row 「まとまりを選ぶ会議 2件」.
    it({ id: 'meeting-00bb21', type: 'meeting', typeLabel: '会議', title: 'D社 定例 第1回', turn: 'mine', state: 'read', waitingFor: 'どの案件・プロジェクトの会議か選んでください', needsBundle: true, bundleGroup: { key: 'g-d', label: 'D社 定例' } }),
    it({ id: 'meeting-00bb22', type: 'meeting', typeLabel: '会議', title: 'D社 定例 第2回', turn: 'mine', state: 'read', waitingFor: 'どの案件・プロジェクトの会議か選んでください', needsBundle: true, bundleGroup: { key: 'g-d', label: 'D社 定例' } }),
  ],
}
const changed = emitter<{ companyId: string }>()
const acted: string[] = []

installElectronAPI({
  getTaskList: async () => ({ success: true, data }),
  onNotificationsChanged: changed.subscribe,
  getCalendarToday: async () => ({
    success: true,
    data: {
      date: now.date, timeZone: 'Asia/Tokyo', reason: null, events: [
        { id: 'ev-later', title: 'B社 見積のオンライン確認', start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 5400_000).toISOString(), allDay: false, online: true, attendeeCount: 3, hasExternalAttendees: true },
        { id: 'ev-over', title: '営業部 週次定例', start: new Date(Date.now() - 7200_000).toISOString(), end: new Date(Date.now() - 5400_000).toISOString(), allDay: false, online: false, attendeeCount: 5, hasExternalAttendees: false },
      ],
    },
  }),
  createTask: async (_companyId, input) => {
    acted.push(`create ${JSON.stringify(input)}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    data = { ...data, items: [it({ id: 'task-new001', title: input.title, turn: 'mine', due: input.due ?? null, tags: input.tags ?? [], own: true, personal: true }), ...data.items] }
    return { success: true, recordId: 'task-new001' }
  },
  // Tag suggestions as main would answer them: a reading variant caught (えいぎょう → 営業).
  suggestTaskTags: async (_companyId, title, inUse) => ({ source: 'ai', tags: title.includes('えいぎょう') && inUse.includes('営業') ? ['営業'] : [] }),
  getBundleChoices: async () => ({ success: true, bundles: [{ id: 'deal-c00001', title: 'C社 研修導入', typeLabel: '案件' }, { id: 'deal-c00002', title: 'C社 追加', typeLabel: '案件' }] }),
  linkMinutesBundle: async (_companyId, meetingId, bundleId) => {
    acted.push(`${meetingId}:bundle ${bundleId}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    data = { ...data, items: data.items.filter(i => i.id !== meetingId) }
    return { success: true }
  },
  declineMinutesBundle: async (_companyId, meetingId) => {
    acted.push(`${meetingId}:no bundle`)
    document.getElementById('acted')!.textContent = acted.join(',')
    data = { ...data, items: data.items.filter(i => i.id !== meetingId) }
    return { success: true }
  },
  linkFileToTask: async (_companyId, recordId, companyPath, version) => {
    acted.push(`${recordId}:link ${companyPath}@${version}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    return { success: true, recordId }
  },
  actOnTask: async (_companyId, recordId, input) => {
    acted.push(`${recordId}:${input.action}@${input.expectedVersion}${input.args?.reviewer ? `>${input.args.reviewer}` : ''}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    if (input.action === 'accept') data = { ...data, items: data.items.map(i => (i.id === recordId ? { ...i, turn: 'mine' as const, state: 'todo' } : i)) }
    if (input.action === 'request_review') data = { ...data, items: data.items.map(i => (i.id === recordId ? { ...i, turn: 'others' as const, state: 'review', waitingFor: '阿部さんの番', check: undefined } : i)) }
    if (input.action === 'complete') data = { ...data, items: data.items.map(i => (i.id === recordId ? { ...i, turn: 'done' as const, state: 'done', finishedAt: new Date().toISOString(), check: { action: 'reopen' as const } } : i)) }
    return { success: true, recordId }
  },
})

function Preview() {
  const list = useTaskList('co-preview')
  const [opened, setOpened] = useState<string | null>(null)
  return (
    <main className="flex h-screen flex-col bg-white text-gray-900">
      <pre id="acted" className="text-[10px]" />
      <div className="flex min-h-0 flex-1">
        <TaskListPanel companyId="co-preview" rootPath="/Users/me/company" askFolder="営業部" list={list} aiTurns={null} activeRecordId={opened} onOpen={setOpened}
          onConsult={t => { acted.push(`consult ${t.id}`); document.getElementById('acted')!.textContent = acted.join(',') }} />
        {opened && <div data-testid="card">カード：{opened}</div>}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
