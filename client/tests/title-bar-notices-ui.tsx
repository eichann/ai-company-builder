/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the title bar's 「あなたの番 N」 and bell (features/notifications): the real hook
// and component over a fake main process that keeps the read state like the server does (the
// read answer comes back through `notifications:changed`). What was opened shows in `#opened`
// (the morning's 「今日のあなたの番」: `task list`),
// the ids marked read in `#read`. `?meetings=1`: a department without the task list, whose meetings
// (a まとまり to choose, received minutes) the title bar carries; their buttons write `#opened`.
// `?undo=1`: a notice that the member's AI completed a task their reply finished (`replied_done`),
// whose ［元に戻す］ writes the undo asked for (`<record>|<version>|<expectedVersion>`) to `#undone`;
// `?undo=mail`: a mail closed because it was archived in Gmail, and one archived there (2026-11-05).
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
      { id: 'n-m', kind: 'morning_summary', recordId: '', recordType: '', recordTitle: '', version: 0, text: '今日のあなたの番 2件（期限が今日 1件）', createdAt: '2026-11-01T00:00:00.000Z', read: true },
      { id: 'n-0', kind: 'due_changed', recordId: 'task-preview04', recordType: 'task', recordTitle: '請求書', version: 2, text: '佐藤さんが「請求書」の期限を11月7日に変えました', createdAt: '2026-10-31T06:00:00.000Z', read: true },
    ],
  },
}
const readIds: string[] = []
const withMeetings = new URLSearchParams(location.search).get('meetings') === '1'
if (new URLSearchParams(location.search).get('undo') === '1') {
  state = { ...state, notices: { ...state.notices, items: [
    { id: 'n-r', kind: 'replied_done', recordId: 'task-preview05', recordType: 'task', recordTitle: '見積書を送る', version: 7, text: '返事をしたので完了にしました：「見積書を送る」', createdAt: '2026-11-01T07:00:00.000Z', read: true },
    ...state.notices.items,
  ] } }
}
if (new URLSearchParams(location.search).get('undo') === 'mail') {
  state = { ...state, notices: { ...state.notices, items: [
    { id: 'n-l', kind: 'mail_left_inbox', recordId: 'interaction-preview01', recordType: 'interaction', recordTitle: 'ご相談', version: 4, text: 'Gmail ではアーカイブ済みのため、閉じました：「ご相談」', createdAt: '2026-11-01T07:00:00.000Z', read: true },
    { id: 'n-a', kind: 'mail_archived', recordId: 'interaction-preview02', recordType: 'interaction', recordTitle: '見積の件', version: 6, text: 'Gmail でもアーカイブしました：「見積の件」', createdAt: '2026-11-01T07:01:00.000Z', read: true },
    ...state.notices.items,
  ] } }
}

// `?undo=ai`: the AI changed a deal automatically (`ai_changed`, 2026-11-06), and one already written back.
if (new URLSearchParams(location.search).get('undo') === 'ai') {
  state = { ...state, notices: { ...state.notices, items: [
    { id: 'n-ai', kind: 'ai_changed', recordId: 'deal-preview01', recordType: 'deal', recordTitle: 'A社 研修', version: 5, text: '佐藤さんの AIが「A社 研修」を自動で変えました：確度 B（中） → A（高）。理由：先方が予算を確保したため', createdAt: '2026-11-06T07:00:00.000Z', read: true, aiChange: { pluginId: 'corporate-sales', operationId: 'op-preview01', undone: false } },
    { id: 'n-ai2', kind: 'ai_changed', recordId: 'deal-preview02', recordType: 'deal', recordTitle: 'B社 更新', version: 3, text: '佐藤さんの AIが「B社 更新」を自動で変えました：次のアクション （なし） → 見積を送る（元に戻しました）', createdAt: '2026-11-06T06:00:00.000Z', read: true, aiChange: { pluginId: 'corporate-sales', operationId: 'op-preview02', undone: true } },
    ...state.notices.items,
  ] } }
}

function Preview() {
  const [opened, setOpened] = useState('')
  const [read, setRead] = useState('')
  const [undone, setUndone] = useState('')
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
    undoPluginOperation: async (_companyId, pluginId, operationId) => {
      setUndone(`${pluginId}|${operationId}`)
      return { success: true, operation: { state: 'applied' } as never }
    },
    undoTaskAction: async (_companyId, recordId, version, expectedVersion) => {
      setUndone(`${recordId}|${version}|${expectedVersion}`)
      return { success: true, recordId }
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
      <header className="flex justify-end"><TitleBarNotices companyId="co-preview" state={notices} meetings={meetings} onOpen={t => setOpened(`${t.recordId}|${t.title}`)} onOpenTasks={() => setOpened('task list')} /></header>
      <pre id="opened">{opened}</pre>
      <pre id="read">{read}</pre>
      <pre id="undone">{undone}</pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
