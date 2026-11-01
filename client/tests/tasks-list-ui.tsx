/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the task list (features/tasks): the real panel and hooks over a fake main
// process that keeps the list like the server would (a new task is added, 引き受ける moves it).
// Dates are relative to now. What was opened shows as the card stub; actions sent in `#acted`.
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
  available: true, listDepartmentIds: null,
  items: [
    it({ id: 'task-acc001', title: 'セキュリティのチェックシート', turn: 'acceptance', state: 'awaiting_acceptance', due: day(5) }),
    it({ id: 'task-mine01', title: 'お礼メールを確かめて送る', turn: 'mine', due: `${day(0)}T23:59`, tags: ['営業'], bundle: { id: 'deal-a00001', title: 'A社 問い合わせ対応' } }),
    it({ id: 'task-mine02', title: '見積書を作り直す', turn: 'mine', due: day(1), tags: ['営業', '見積'], own: true, personal: true }),
    it({ id: 'task-far001', title: '来期の研修メニューを見直す', turn: 'mine', due: day(40), tags: ['社内'] }),
    it({ id: 'task-ai0001', title: '日程の候補を探す', turn: 'ai', state: 'preparing' }),
    it({ id: 'task-oth001', title: '金額の変更の承認', turn: 'others', waitingFor: '阿部さんの番' }),
    it({ id: 'task-done01', title: '経費の申請', turn: 'done', state: 'done', finishedAt: new Date().toISOString() }),
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
    data = { ...data, items: [it({ id: 'task-new001', title: input.title, turn: 'mine', due: input.due ?? null, tags: input.tags ?? [], own: true, personal: true }), ...data.items] }
    return { success: true, recordId: 'task-new001' }
  },
  linkFileToTask: async (_companyId, recordId, companyPath, version) => {
    acted.push(`${recordId}:link ${companyPath}@${version}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    return { success: true, recordId }
  },
  actOnTask: async (_companyId, recordId, input) => {
    acted.push(`${recordId}:${input.action}@${input.expectedVersion}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    if (input.action === 'accept') data = { ...data, items: data.items.map(i => (i.id === recordId ? { ...i, turn: 'mine' as const, state: 'todo' } : i)) }
    if (input.action === 'complete') data = { ...data, items: data.items.map(i => (i.id === recordId ? { ...i, turn: 'done' as const, state: 'done', finishedAt: new Date().toISOString() } : i)) }
    return { success: true, recordId }
  },
})

function Preview() {
  const list = useTaskList('co-preview')
  return (
    <main className="flex h-screen flex-col bg-white text-gray-900">
      <pre id="acted" className="text-[10px]" />
      <div className="flex min-h-0 flex-1">
        <TaskListPanel companyId="co-preview" rootPath="/Users/me/company" list={list} aiTurns={null} renderCard={id => <div data-testid="card">カード：{id}</div>} />
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
