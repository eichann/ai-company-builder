/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the title bar's 「あなたの番 N」 and bell (features/notifications): the real hook
// and component over a fake main process that keeps the read state like the server does (the
// read answer comes back through `notifications:changed`). What was opened shows in `#opened`,
// the ids marked read in `#read`. `?meetings=1`: a department without the task list, whose meetings
// (a まとまり to choose, received minutes) the title bar carries; their buttons write `#opened`.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TitleBarNotices, type MeetingTurnRow } from '../src/features/notifications/components/TitleBarNotices'
import { useNotices } from '../src/features/notifications/hooks/useNotices'
import type { NoticesState } from '../shared/notifications-app'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'

const changed = emitter<{ companyId: string }>()
let state: NoticesState = {
  available: true,
  myTurn: {
    total: 2,
    items: [
      { id: 'approval-preview01', type: 'approval', title: '値引きの承認', state: 'pending', due: null },
      { id: 'task-preview02', type: 'task', title: '見積書を作る', state: 'todo', due: '2026-11-05T15:00' },
    ],
  },
  notices: {
    available: true, unread: 1,
    items: [
      { id: 'n-1', kind: 'request_done', recordId: 'task-preview03', recordType: 'task', recordTitle: '提案書を作る', version: 4, text: '佐藤さんが「提案書を作る」を完了にしました', createdAt: '2026-11-01T06:00:00.000Z', read: false },
      { id: 'n-0', kind: 'due_changed', recordId: 'task-preview04', recordType: 'task', recordTitle: '請求書', version: 2, text: '佐藤さんが「請求書」の期限を11月7日に変えました', createdAt: '2026-10-31T06:00:00.000Z', read: true },
    ],
  },
}
const readIds: string[] = []
const withMeetings = new URLSearchParams(location.search).get('meetings') === '1'

function Preview() {
  const [opened, setOpened] = useState('')
  const [read, setRead] = useState('')
  installElectronAPI({
    watchNotifications: async () => {},
    getNotificationsState: async () => state,
    onNotificationsChanged: changed.subscribe,
    markNotificationsRead: async (companyId, ids) => {
      const list = ids === 'all' ? state.notices.items.map(i => i.id) : ids
      readIds.push(...list)
      setRead(readIds.join(','))
      const items = state.notices.items.map(i => (list.includes(i.id) ? { ...i, read: true } : i))
      state = { ...state, notices: { ...state.notices, items, unread: items.filter(i => !i.read).length } }
      setTimeout(() => changed.emit({ companyId }), 0)
      return { success: true }
    },
  })
  const notices = useNotices('co-preview')
  const meetings: MeetingTurnRow[] = withMeetings ? [
    { id: 'meeting-read01', title: 'A社 定例', kind: 'bundle', text: 'どの案件・プロジェクトの会議か選んでください', needsPerson: true, ai: null, actions: [{ label: '案件を選ぶ', run: () => setOpened('choose meeting-read01') }] },
    { id: 'meeting-new001', title: 'B社 打合せ', kind: 'minutes', text: 'AI が読み取っています', needsPerson: false, ai: null, actions: [] },
    { id: 'meeting-new002', title: 'C社 商談', kind: 'minutes', text: 'AI が読み取れませんでした：議事録が空でした', needsPerson: true, ai: null, actions: [{ label: '自分で読み取る', run: () => setOpened('read meeting-new002') }] },
  ] : []
  return (
    <main className="min-h-screen bg-white p-8 text-gray-900">
      <p className="mb-4 text-xs text-gray-500">表示確認用の人工データ。</p>
      <header className="flex justify-end"><TitleBarNotices companyId="co-preview" state={notices} meetings={meetings} onOpen={t => setOpened(`${t.recordId}|${t.title}`)} /></header>
      <pre id="opened">{opened}</pre>
      <pre id="read">{read}</pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
