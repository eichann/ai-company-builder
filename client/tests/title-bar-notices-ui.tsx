/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the title bar's ［受け箱］ (I2: where 「あなたの番 N」 and the bell were): the real hook, button,
// bottom panel and list over a fake main process that keeps the read state like the server does (the read
// answer comes back through `notifications:changed`). The button opens and closes the panel as in the app.
// What was opened shows in `#opened` (the task list: `task list`), the ids marked read in `#read`.
// `window.__acbTitleBar.arrive()`: a new unread notice comes (the dot); `.task(false|true)`: a task leaves the turn / returns. `?meetings=1`: a department without
// the task list, whose meetings (a まとまり to choose, received minutes) the inbox carries; their buttons write
// `#opened`. `?undo=1`: a notice that the member's AI completed a task their reply finished (`replied_done`),
// whose ［元に戻す］ writes the undo asked for (`<record>|<version>|<expectedVersion>`) to `#undone`;
// `?undo=mail`: a mail closed because it was archived in Gmail, and one archived there (2026-11-05);
// `?undo=ai`: the AI changed a deal automatically; `?undo=turn`: below. `?features=off`: 会議と議事録 and 受信 are off in 「使う機能」.
// `?stop=1`: a scheduled job's run failed (a stop of あなた待ち; `__acbTitleBar.settle()` = it ran afterwards).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { useNotices } from '../src/features/notifications/hooks/useNotices'
import { useInboxSlot } from '../src/features/inbox/hooks/useInboxSlot'
import { BottomPanel } from '../src/features/workspace/components/BottomPanel'
import type { MeetingNewsRow, NoticesState } from '../shared/notifications-app'
import { NOTIFICATION_KINDS } from '../../shared/types/notifications'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'

// Recent notices (the preview hands the inbox a first day long before them: every unread one is 新着).
const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
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
      { id: 'n-1', kind: 'request_done', recordId: 'task-preview03', recordType: 'task', recordTitle: '提案書を作る', version: 4, text: '佐藤さんが「提案書を作る」を完了にしました', createdAt: recent(10), read: false },
      { id: 'n-m', kind: 'morning_summary', recordId: '', recordType: '', recordTitle: '', version: 0, text: '今日のあなたの番 2件（期限が今日 1件）', createdAt: recent(20), read: true },
      { id: 'n-0', kind: 'due_changed', recordId: 'task-preview04', recordType: 'task', recordTitle: '請求書', version: 2, text: '佐藤さんが「請求書」の期限を11月7日に変えました', createdAt: recent(30), read: true },
    ],
  },
}
const readIds: string[] = []
// `?theme=dark` for dark mode (the status-colours spec reads the new-item dot in both themes).
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.classList.add('dark')
const features = new URLSearchParams(location.search).get('features') === 'off'
  ? { taskList: true, meetings: false, inbox: false, decisions: true, projects: true, afterMeeting: false }
  : undefined
const withMeetings = new URLSearchParams(location.search).get('meetings') === '1'
if (new URLSearchParams(location.search).get('undo') === '1') {
  state = { ...state, notices: { ...state.notices, items: [
    { id: 'n-r', kind: 'replied_done', recordId: 'task-preview05', recordType: 'task', recordTitle: '見積書を送る', version: 7, text: '返事をしたので完了にしました：「見積書を送る」', createdAt: recent(40), read: false },
    ...state.notices.items,
  ] } }
}
if (new URLSearchParams(location.search).get('undo') === 'mail') {
  state = { ...state, notices: { ...state.notices, items: [
    { id: 'n-l', kind: 'mail_left_inbox', recordId: 'interaction-preview01', recordType: 'interaction', recordTitle: 'ご相談', version: 4, text: 'Gmail ではアーカイブ済みのため、閉じました：「ご相談」', createdAt: recent(50), read: false },
    { id: 'n-a', kind: 'mail_archived', recordId: 'interaction-preview02', recordType: 'interaction', recordTitle: '見積の件', version: 6, text: 'Gmail でもアーカイブしました：「見積の件」', createdAt: recent(60), read: false },
    ...state.notices.items,
  ] } }
}

// `?undo=ai`: the AI changed a deal automatically (`ai_changed`, 2026-11-06), and one already written back.
if (new URLSearchParams(location.search).get('undo') === 'ai') {
  state = { ...state, notices: { ...state.notices, items: [
    { id: 'n-ai', kind: 'ai_changed', recordId: 'deal-preview01', recordType: 'deal', recordTitle: 'A社 研修', version: 5, text: '佐藤さんの AIが「A社 研修」を自動で変えました：確度 B（中） → A（高）。理由：先方が予算を確保したため', createdAt: recent(70), read: false, aiChange: { pluginId: 'corporate-sales', operationId: 'op-preview01', undone: false } },
    { id: 'n-ai2', kind: 'ai_changed', recordId: 'deal-preview02', recordType: 'deal', recordTitle: 'B社 更新', version: 3, text: '佐藤さんの AIが「B社 更新」を自動で変えました：次のアクション （なし） → 見積を送る（元に戻しました）', createdAt: recent(80), read: false, aiChange: { pluginId: 'corporate-sales', operationId: 'op-preview02', undone: true } },
    ...state.notices.items,
  ] } }
}

// `?undo=turn`: the AI changed a task that is the member's turn (unread, merged into its row), an earlier change
// already read (「前に確認したもの」), and 3 unread notices past the server's list.
if (new URLSearchParams(location.search).get('undo') === 'turn') {
  const days = (n: number) => recent(n * 24 * 60)
  state = { ...state, notices: { ...state.notices, unread: 2 + 3, items: [
    { id: 'n-ait', kind: 'ai_changed', recordId: 'task-preview02', recordType: 'task', recordTitle: '見積書を作る', version: 6, text: 'あなたの AIが「見積書を作る」を自動で変えました：期限 11/5 → 11/6', createdAt: recent(5), read: false, aiChange: { pluginId: 'corporate-sales', operationId: 'op-turn01', undone: false } },
    ...state.notices.items,
    { id: 'n-old', kind: 'ai_changed', recordId: 'deal-preview03', recordType: 'deal', recordTitle: 'C社 更新', version: 2, text: 'あなたの AIが「C社 更新」を自動で変えました：確度 C → B', createdAt: days(3), read: true, aiChange: { pluginId: 'corporate-sales', operationId: 'op-old01', undone: false } },
  ] } }
}
if (new URLSearchParams(location.search).get('stop') === '1') {
  state = { ...state, notices: { ...state.notices, unread: state.notices.unread + 1, items: [
    { id: 'n-stop', kind: 'job_failed', recordId: '', recordType: '', recordTitle: '', version: 0, text: '定期の仕事「朝の問い合わせまとめ」の今日の回が、うまくできませんでした', createdAt: recent(15), read: false },
    ...state.notices.items,
  ] } }
}

function Preview() {
  const [opened, setOpened] = useState('')
  const [read, setRead] = useState('')
  const [undone, setUndone] = useState('')
  const [open, setOpen] = useState(false)
  installElectronAPI({
    watchNotifications: async () => {},
    getNotificationsState: async () => state,
    onNotificationsChanged: changed.subscribe,
    getNotificationSettings: async () => ({ success: true, kinds: Object.fromEntries(NOTIFICATION_KINDS.map(k => [k, true])) }),
    setNotificationSetting: async () => ({ success: true }),
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
  const meetings: MeetingNewsRow[] = withMeetings ? MEETINGS(setOpened) : []
  const inbox = useInboxSlot({
    companyId: 'co-preview', notices, meetings, features, open, onToggle: () => setOpen(o => !o), newsSince: '2026-01-01T00:00:00.000Z',
    onOpenRecord: id => setOpened(`record ${id}`), onOpenTasks: () => setOpened('task list'), onOpenJobs: () => setOpened('jobs'),
    renderApprovalCard: id => <p>承認のカード {id}</p>, renderMailDraft: id => <p>メールのカード {id}</p>,
  })
  return (
    <main className="flex h-screen flex-col bg-bg text-text">
      <header className="flex h-12 items-center justify-end gap-2 border-b border-[color:var(--color-border)] bg-[var(--color-surface)] px-4">{inbox?.titleBarButton}</header>
      <p className="p-3 text-small text-text-muted">表示確認用の人工データ。</p>
      <pre id="opened">{opened}</pre>
      <pre id="read">{read}</pre>
      <pre id="undone">{undone}</pre>
      <div className="mt-auto h-[460px]">{inbox && open && <BottomPanel content={inbox} onClose={() => setOpen(false)} />}</div>
      {inbox?.dialog}
    </main>
  )
}

const meetingRow = (id: string, title: string, stage: MeetingNewsRow['stage'], line: string, over: Partial<MeetingNewsRow> = {}): MeetingNewsRow =>
  ({ id, title, stage, line, meetingAt: recent(90), expiresSoon: false, seen: false, actions: [], ...over })
const MEETINGS = (setOpened: (s: string) => void): MeetingNewsRow[] => [
  meetingRow('meeting-read01', 'A社 定例', 'ask', 'どの案件・プロジェクトの会議か選んでください', { actions: [{ label: '案件を選ぶ', run: () => setOpened('choose meeting-read01') }] }),
  meetingRow('meeting-new001', 'B社 打合せ', 'reading', 'AI が読み取っています'),
  meetingRow('meeting-new002', 'C社 商談', 'stopped', 'AI が読み取れませんでした：議事録が空でした', { stop: 'failed', actions: [{ label: '自分で読み取る', run: () => setOpened('read meeting-new002') }] }),
  meetingRow('meeting-new003', 'D社 定例', 'read', '読み終わりました：決めたこと1・やることの案2', { actions: [{ label: '見る', primary: true, run: () => setOpened('view meeting-new003') }] }),
]

const TASK = state.myTurn.items.find(i => i.id === 'task-preview02')!
Object.assign(window, {
  __acbTitleBar: {
    /** The failed run of `?stop=1` ran afterwards (「もう一度」): the server marks its notice settled. */
    settle() {
      state = { ...state, notices: { ...state.notices, items: state.notices.items.map(i => (i.id === 'n-stop' ? { ...i, settled: true } : i)) } }
      changed.emit({ companyId: 'co-preview' })
    },
    /** The AI changes 「見積書を作る」 once more (`?undo=turn`): a new change to undo on the same row. */
    changeAgain() {
      const item = { id: 'n-ait2', kind: 'ai_changed' as const, recordId: 'task-preview02', recordType: 'task', recordTitle: '見積書を作る', version: 8, text: 'あなたの AIが「見積書を作る」をまた変えました：期限 11/6 → 11/7', createdAt: new Date().toISOString(), read: false, aiChange: { pluginId: 'corporate-sales', operationId: 'op-turn02', undone: false } }
      state = { ...state, notices: { ...state.notices, items: [item, ...state.notices.items], unread: state.notices.unread + 1 } }
      changed.emit({ companyId: 'co-preview' })
    },
    /** 「見積書を作る」 leaves the member's turn (done on the other PC), or comes back to it. */
    task(present: boolean) {
      const items = [...state.myTurn.items.filter(i => i.id !== TASK.id), ...(present ? [TASK] : [])]
      state = { ...state, myTurn: { ...state.myTurn, items, total: items.length } }
      changed.emit({ companyId: 'co-preview' })
    },
    /** A new unread notice comes from the server (someone finished what the member asked). */
    arrive() {
      const item = { id: 'n-new', kind: 'request_done' as const, recordId: 'task-preview09', recordType: 'task', recordTitle: '契約書', version: 2, text: '田中さんが「契約書」を完了にしました', createdAt: new Date().toISOString(), read: false }
      state = { ...state, notices: { ...state.notices, items: [item, ...state.notices.items], unread: state.notices.unread + 1 } }
      changed.emit({ companyId: 'co-preview' })
    },
  },
})

createRoot(document.getElementById('root')!).render(<Preview />)
