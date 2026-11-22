/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the inbox (受け箱, features/inbox, I1): the real slot hook, list and card dialog in the
// real bottom panel frame, over a fake main process that keeps the read state like the server does (the
// read answer comes back through `notifications:changed`). The approval card is the real one (it reads
// the request through `getApproval`). What was opened shows in `#opened`, the ids marked read in
// `#read`, an approval or a send that reached main in `#acted` (a row must never get there by itself).
// `window.__acbInbox.approvedElsewhere()`: another PC approved the request — main reads again without it.
// `?theme=dark` for dark mode; `?offline=1`: marking read cannot reach the server. Synthetic data only.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { useNotices } from '../src/features/notifications/hooks/useNotices'
import { useInboxSlot } from '../src/features/inbox/hooks/useInboxSlot'
import { BottomPanel } from '../src/features/workspace/components/BottomPanel'
import { ApprovalCard } from '../src/features/chat/components/ApprovalCard'
import { PreparedMailCard } from '../src/features/chat/components/PreparedMailCard'
import type { NoticesState } from '../shared/notifications-app'
import type { NotificationItem } from '../../shared/types/notifications'
import type { ApprovalView } from '../../shared/types/approvals'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

const at = (daysAgo: number, hour = 9) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}
const note = (id: string, kind: NotificationItem['kind'], recordId: string, recordType: string, recordTitle: string, text: string, createdAt: string, read = false): NotificationItem =>
  ({ id, kind, recordId, recordType, recordTitle, version: 4, text, createdAt, read })

const changed = emitter<{ companyId: string }>()
let state: NoticesState = {
  available: true,
  myTurn: {
    total: 4,
    items: [
      { id: 'task-check0001', type: 'task', title: '朝の問い合わせまとめ（11/22）', state: 'review', due: null },
      { id: 'approval-preview0001', type: 'approval', title: '金額の変更（〇〇商事の案件）', state: 'pending', due: null },
      { id: 'outbound_message-preview01', type: 'outbound_message', title: '△△様へのお礼メール', state: 'draft', due: null },
      { id: 'task-asked0001', type: 'task', title: '見積書を作る', state: 'todo', due: '2026-11-25' },
    ],
    resting: 2,
  },
  notices: {
    available: true, unread: 5,
    items: [
      note('n-stop', 'job_failed', '', '', '', '定期の仕事「朝の問い合わせまとめ」の 11/22 の回が、うまくできませんでした', at(0, 8)),
      note('n-asked', 'asked', 'task-asked0001', 'task', '見積書を作る', '佐藤さんから「見積書を作る」を頼まれました', at(0, 9)),
      note('n-done', 'request_done', 'task-done0001', 'task', '見積書の確認', '佐藤さんが「見積書の確認」を完了にしました', at(1, 10)),
      note('n-due', 'due_changed', 'task-due00001', 'task', '請求書', '佐藤さんが「請求書」の期限を11月28日に変えました', at(2, 11)),
      note('n-old', 'request_done', 'task-old00001', 'task', '先月の報告', '田中さんが「先月の報告」を完了にしました', at(20, 9)),
      note('n-seen', 'ok_completed', 'task-seen0001', 'task', '議事録の確認', 'あなたの OK で「議事録の確認」を完了にしました', at(0, 7), true),
    ],
  },
}
const HASH = `sha256:${'9c1e'.repeat(16)}`
const view: ApprovalView = {
  id: 'approval-preview0001', state: 'pending', recordVersion: 1, pluginId: 'hubspot', operation: 'update_deal',
  operationLabel: '案件の欄を HubSpot に書き戻す', systemLabel: 'HubSpot', recordId: 'deal-preview01', recordTitle: '〇〇商事の案件',
  changes: [{ field: 'amount', label: '金額', before: 1200000, after: 1500000, beforeShown: '1,200,000', afterShown: '1,500,000', changePercent: 25 }],
  create: null, similar: null, basis: { meetingId: null, meetingTitle: null, quote: null }, precedents: { total: 0, items: [] }, materials: [],
  proposedReason: '2 拠点の追加導入のため', requestedBy: 'u-yamada', requestedByAi: true, approver: 'u-me', approverRule: 'dept_manager', approverRuleLabel: '部署の管理役',
  hash: HASH, version: 1, createdAt: at(0, 10), viewerMayApprove: true, viewerIsRequester: false, outcome: null,
}
let approved = false

function Preview() {
  const [opened, setOpened] = useState('')
  const [read, setRead] = useState('')
  const [acted, setActed] = useState('')
  installElectronAPI({
    watchNotifications: async () => {},
    getNotificationsState: async () => state,
    onNotificationsChanged: changed.subscribe,
    markNotificationsRead: async (companyId, ids) => {
      if (params.get('offline') === '1') throw new Error('offline')
      const list = ids === 'all' ? state.notices.items.map(i => i.id) : ids
      setRead(r => [r, list.join(',')].filter(Boolean).join('|'))
      const items = state.notices.items.map(i => (list.includes(i.id) ? { ...i, read: true } : i))
      state = { ...state, notices: { ...state.notices, items, unread: items.filter(i => !i.read).length } }
      setTimeout(() => changed.emit({ companyId }), 0)
      return { success: true }
    },
    getApproval: async () => ({ success: true, approval: approved ? { ...view, state: 'approved', viewerMayApprove: false, outcome: { at: at(0, 11), by: 'u-tanaka', onBehalfOf: null, note: '承認します', resultOperationId: 'op-1' } } : view, names: { 'u-yamada': '山田', 'u-me': '阿部', 'u-tanaka': '田中' } }),
    approveApproval: async () => { setActed('approve'); return { success: false, offline: true, error: '（見本）' } as never },
    getOutboundMail: async () => ({ success: false, offline: false, code: null, error: '（見本）下書きは、このページでは読み込みません。' }),
    sendOutboundMail: async () => { setActed('send'); return { success: false, offline: true, error: '（見本）' } as never },
  })
  const notices = useNotices('co-preview')
  const inbox = useInboxSlot({
    companyId: 'co-preview', notices,
    onOpenRecord: id => setOpened(`record ${id}`), onOpenTasks: () => setOpened('task list'), onOpenJobs: () => setOpened('jobs'),
    renderApprovalCard: id => <ApprovalCard card={{ id: `card-${id}`, companyId: 'co-preview', conversationId: null, approvalId: id, origin: 'shown', at: '' }} />,
    renderMailDraft: id => <PreparedMailCard companyId="co-preview" messageId={id} />,
  })
  return (
    <main className="flex h-screen flex-col bg-bg text-text">
      <p className="p-3 text-small text-text-muted">表示確認用の人工データ。</p>
      <pre id="opened">{opened}</pre>
      <pre id="read">{read}</pre>
      <pre id="acted">{acted}</pre>
      <div className="mt-auto h-[480px]">{inbox && <BottomPanel content={inbox} onClose={() => setOpened('closed')} />}</div>
      {inbox?.dialog}
    </main>
  )
}

Object.assign(window, {
  __acbInbox: {
    /** Another PC (or person) approved the request: the next read no longer lists it. */
    approvedElsewhere() {
      approved = true
      state = { ...state, myTurn: { ...state.myTurn, total: state.myTurn.total - 1, items: state.myTurn.items.filter(i => i.type !== 'approval') } }
      changed.emit({ companyId: 'co-preview' })
    },
  },
})

createRoot(document.getElementById('root')!).render(<Preview />)
