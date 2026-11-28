/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the inbox (受け箱, features/inbox; あなた待ち and 新着 since 2026-11-26): the real slot hook, list and card dialog in the
// real bottom panel frame, over a fake main process that keeps the read state like the server does (the
// read answer comes back through `notifications:changed`). The approval card is the real one (it reads
// the request through `getApproval`). What was opened shows in `#opened`, the ids marked read in
// `#read`, an approval or a send that reached main in `#acted` (a row must never get there by itself).
// `window.__acbInbox.approvedElsewhere()`: another PC approved the request — main reads again without it.
// `?theme=dark` for dark mode; `?offline=1`: marking read cannot reach the server. Synthetic data only.
// `?plans=1`: 「ブラウザ操作」 is switched on — the slot gets the plans' list and the real plan card (a draft and a
// run nobody knows the result of); `?plans=off`: switched off (no list handed in, as AppShell does). Every
// `listBrowserPlans` reaching main counts in `#plan-reads`; a run, cancel or confirm shows in `#acted`.
// `window.__acbInbox.planApprovedElsewhere()`: the draft was approved on another PC (the next read lacks it).
// `&chatcard=1`: the draft's card as a consultation shows it, outside the inbox (its ［任せる］ runs it there).
// `?many=N` (working through the inbox, notifications.md "Working through the inbox"): N more 新着 on a fixed clock
// (2026-11-27), so the list has more than its first 15 rows; `&approvals=N` N more approvals waiting. `?narrow=1`: the
// panel 360 px wide (the kind chips fold into 「その他」). The keys ↑ ↓ Enter Esc are the app's (`useKeybindings`).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { useNotices } from '../src/features/notifications/hooks/useNotices'
import { useInboxSlot } from '../src/features/inbox/hooks/useInboxSlot'
import { BottomPanel } from '../src/features/workspace/components/BottomPanel'
import { ApprovalCard } from '../src/features/chat/components/ApprovalCard'
import { PreparedMailCard } from '../src/features/chat/components/PreparedMailCard'
import { BrowserPlanCard } from '../src/features/browser-plans/components/BrowserPlanCard'
import { listBrowserPlans } from '../src/features/browser-plans/api'
import { planStatesVersion, subscribePlanStates } from '../src/features/browser-plans/planStore'
import type { BrowserInboxPlans } from '../shared/browser-plans'
import type { BrowserPlanView } from '../../shared/types/browser-plans'
import type { NoticesState } from '../shared/notifications-app'
import type { NotificationItem } from '../../shared/types/notifications'
import type { ApprovalView } from '../../shared/types/approvals'
import type { ContactFinishAnswer, ContactFinishRequest, ContactUndoAnswer, ContactUndoRequest, ContactView } from '../shared/contact-card'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'
import { useKeybindings } from '../src/shared/commands/commands'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

const at = (daysAgo: number, hour = 9) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}
/** A moment already passed whatever the hour the tests run at (`at(0, 8)` is still ahead before 08:00). */
const justPast = () => new Date(Date.now() - 60_000).toISOString()
const note = (id: string, kind: NotificationItem['kind'], recordId: string, recordType: string, recordTitle: string, text: string, createdAt: string, read = false): NotificationItem =>
  ({ id, kind, recordId, recordType, recordTitle, version: 4, text, createdAt, read })

const changed = emitter<{ companyId: string }>()
// `?manual=1`: the user manual's story (client/tests/manual/scenes.ts, chapter 25): 山田さん's inbox — a draft to check
// and send, a minutes check, a task 佐藤さん asked, and what 高橋さん and 佐藤さん did; with `&plans=1` the plans are a
// made-up 配信ツール's (chapter 32). Fictional data only.
const MANUAL = params.get('manual') === '1'
const manualState: NoticesState = {
  available: true,
  myTurn: {
    total: 3,
    items: [
      { id: 'outbound_message-manual01', type: 'outbound_message', title: 'A社 田村様へのお礼メール', state: 'draft', due: null },
      { id: 'task-review0001', type: 'task', title: '議事録を確認する：営業部 定例', state: 'todo', due: null },
      { id: 'task-asked0001', type: 'task', title: 'セキュリティのチェックシートを埋める', state: 'awaiting_acceptance', due: '2026-11-25' },
    ],
    resting: 2,
  },
  notices: {
    available: true, unread: 3,
    items: [
      note('n-asked', 'asked', 'task-asked0001', 'task', 'セキュリティのチェックシートを埋める', '佐藤さんから「セキュリティのチェックシートを埋める」を頼まれました。引き受けるか、受けられないかを決めてください', at(0, 9)),
      note('n-accepted', 'request_accepted', 'task-sec00001', 'task', 'セキュリティ資料を送る', '高橋さんが「セキュリティ資料を送る」を引き受けました', at(0, 8)),
      note('n-approved', 'approval_result', 'approval-manual01', 'approval', '金額の変更（A社 研修導入）', '「金額の変更（A社 研修導入）」が承認されました（佐藤さん）', at(1, 16)),
    ],
  },
}
let state: NoticesState = MANUAL ? manualState : {
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
// A fixed clock for the rows added below (never the real date: a test must not change with the day it runs).
const FIXED = (minute: number) => new Date(Date.UTC(2026, 10, 27, 0, 0) + minute * 60_000).toISOString()
const MANY = Number(params.get('many') ?? 0)
const APPROVALS = Number(params.get('approvals') ?? 0)
if (MANY > 0 || APPROVALS > 0) {
  const more = Array.from({ length: MANY }, (_, i) => note(`n-many${i + 1}`, 'request_done', `task-many${String(i + 1).padStart(4, '0')}`, 'task', `報告 ${i + 1}`, `高橋さんが「報告 ${i + 1}」を完了にしました`, FIXED(-i)))
  const approvals = Array.from({ length: APPROVALS }, (_, i) => ({ id: `approval-more${String(i + 1).padStart(4, '0')}`, type: 'approval', title: `値引きの承認 ${i + 1}`, state: 'pending', due: null }))
  const items = [...state.notices.items, ...more]
  state = { ...state, myTurn: { ...state.myTurn, total: state.myTurn.total + approvals.length, items: [...state.myTurn.items, ...approvals] }, notices: { ...state.notices, items, unread: items.filter(i => !i.read).length } }
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

const DRAFT = `bp_${'1a'.repeat(16)}`
const UNSURE = `bp_${'2b'.repeat(16)}`
let browserInbox: BrowserInboxPlans = {
  plans: [{ planId: DRAFT, state: 'draft', label: 'リマインダの段にテンプレートを足す', site: MANUAL ? '配信ツール' : 'Lステップ', createdAt: at(0, 9) }],
  unsure: [{ planId: UNSURE, state: 'unknown', label: 'リマインダの段にテンプレートを足す', permittedAt: at(0, 8), confirmableAt: justPast(), canConfirm: true }],
}
let draftRan = false
const planView = (id: string): BrowserPlanView => ({
  id, state: id === DRAFT && !draftRan ? 'draft' : 'claimed', closeReason: null, connector: MANUAL ? { id: 'haishin', version: '0.1.0', label: '配信ツール' } : { id: 'lstep', version: '0.6.0', label: 'Lステップ' },
  operation: 'reminder_step_add_template', label: 'リマインダの段にテンプレートを足す', sharedNote: null, delivers: 'scheduled', account: '5550001',
  target: { reminder: '7001001', step: '7002001' }, change: { template: '7003002' }, facts: {}, explanation: null,
  createdAt: at(0, 9), expiresAt: new Date(Date.now() + 3_000_000).toISOString(), approvedAt: null, contentHash: `sha256:${'7a'.repeat(32)}`,
  execution: id === DRAFT && !draftRan ? null : { id: `bx_${'3c'.repeat(16)}`, state: 'unknown', claimedAt: at(0, 8), permittedAt: at(0, 8), settledAt: null, confirmableAt: justPast(), voidReason: null, confirmedBy: null },
})

const PLAN_STATES = { subscribe: subscribePlanStates, version: planStatesVersion }

// `?contact=own|draft|waiting|other|made|conflict|changed|archived`: 「連絡」1枚 (inbox.md "One contact") — a 来た連絡 and its 返事のお願い, each
// with a notice; a fake server keeps the two records like the real one (one finish ends both, its undo brings both back,
// `conflict` refuses the finish as 「先に変えた」). What a press sent shows in `#acted`. Synthetic data only.
const CONTACT = params.get('contact')
const IID = 'interaction-prev01a'
const RID = 'reply_request-prev01a'
const ALLOWED = { replied_elsewhere: true, close: true, drop: true }
function sceneContact(scene: string): ContactView {
  const reply: ContactView['replyRequests'][number] = { id: RID, title: 'A社 見積のご相談への返事', state: 'open', version: 4, assignee: 'u-me', due: '2026-12-02', guidelineDue: null, waitUntil: null, drafts: [], may: ALLOWED }
  const interaction: ContactView['interaction'] = { id: IID, title: 'A社 見積のご相談', state: 'unsure', version: 7, assignee: 'u-me', maySettle: true }
  switch (scene) {
    case 'draft': return { interaction, replyRequests: [{ ...reply, drafts: [{ id: 'outbound_message-prev01a', version: 2 }] }], tasks: [] }
    case 'waiting': return { interaction: { ...interaction, state: 'handled', maySettle: false }, replyRequests: [{ ...reply, state: 'waiting_reply', waitUntil: '2026-12-05' }], tasks: [] }
    case 'other': return { interaction: { ...interaction, state: 'handled', assignee: 'u-tanaka', maySettle: false }, replyRequests: [{ ...reply, assignee: 'u-tanaka', may: { replied_elsewhere: false, close: false, drop: false } }], tasks: [] }
    case 'made': return {
      interaction: { ...interaction, state: 'handled', maySettle: false },
      replyRequests: [{ ...reply, state: 'closed', may: { replied_elsewhere: false, close: false, drop: false } }],
      tasks: [{ id: 'task-prev01a', title: '経費の申請を承認する', state: 'todo', version: 2, assignee: 'u-me' }],
    }
  }
  return { interaction, replyRequests: [reply], tasks: [] }
}
let contactNow: ContactView | null = CONTACT ? sceneContact(CONTACT) : null
let contactBefore: ContactView | null = null
if (contactNow) {
  const items = [
    note('n-reply', 'reply_arrived', RID, 'reply_request', 'A社 見積のご相談への返事', 'A社から返事が来ました', at(0, 10)),
    note('n-unsure', 'intake_unsure', IID, 'interaction', 'A社 見積のご相談', '「A社 見積のご相談」を確かめてください', at(0, 9)),
    ...state.notices.items,
  ]
  state = { ...state, notices: { ...state.notices, items, unread: items.filter(i => !i.read).length } }
}
/** The fake server's finish: the 返事のお願い's end and, from 確認待ち, the contact's 「済んだ」 — both or neither. */
function finishOnServer(input: ContactFinishRequest): ContactFinishAnswer {
  const now = contactNow!
  const reply = now.replyRequests[0]
  if (CONTACT === 'conflict' || input.interaction.expectedVersion !== now.interaction.version || input.replyRequest.expectedVersion !== reply.version) {
    return { success: false, offline: false, gone: false, code: 'VERSION_CONFLICT', part: 'replyRequest', error: 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください' }
  }
  const settles = now.interaction.state === 'unsure'
  contactBefore = now
  contactNow = {
    ...now,
    interaction: settles ? { ...now.interaction, state: 'handled', version: now.interaction.version + 1, maySettle: false } : now.interaction,
    replyRequests: [{ ...reply, state: input.replyRequest.action === 'drop' ? 'dropped' : 'closed', version: reply.version + 1, drafts: [], may: { replied_elsewhere: false, close: false, drop: false } }],
  }
  // `?contact=changed`: someone (another person, the AI) changes the contact right after the finish answered.
  if (CONTACT === 'changed') contactNow = { ...contactNow, interaction: { ...contactNow.interaction, version: contactNow.interaction.version + 1 } }
  return { success: true, result: {
    interaction: settles ? { recordId: IID, outcome: 'done', state: 'handled', recordVersion: now.interaction.version + 1, version: now.interaction.version + 1 } : { recordId: IID, outcome: 'unchanged', state: now.interaction.state, recordVersion: now.interaction.version, version: null },
    replyRequest: { recordId: RID, outcome: 'done', state: contactNow.replyRequests[0].state, recordVersion: reply.version + 1, version: reply.version + 1 },
  } }
}
function undoOnServer(input: ContactUndoRequest): ContactUndoAnswer {
  // Like the engine's undo: the version the card saw must still be the record's (something changed since → refused).
  const now = contactNow!
  if ((input.interaction && input.interaction.expectedVersion !== now.interaction.version) || input.replyRequest.expectedVersion !== now.replyRequests[0].version) {
    return { success: false, offline: false, gone: false, code: 'VERSION_CONFLICT', part: 'interaction', error: 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください' }
  }
  const before = contactBefore!
  contactNow = { ...before, interaction: { ...before.interaction, version: before.interaction.version + (input.interaction ? 2 : 0) }, replyRequests: before.replyRequests.map(r => ({ ...r, version: r.version + 2 })) }
  contactBefore = null
  return { success: true, result: {
    interaction: input.interaction ? { recordId: IID, outcome: 'done', state: contactNow.interaction.state, recordVersion: contactNow.interaction.version, version: contactNow.interaction.version } : null,
    replyRequest: { recordId: RID, outcome: 'done', state: contactNow.replyRequests[0].state, recordVersion: contactNow.replyRequests[0].version, version: contactNow.replyRequests[0].version },
  } }
}

function Preview() {
  const [opened, setOpened] = useState('')
  const [read, setRead] = useState('')
  const [acted, setActed] = useState('')
  const [planReads, setPlanReads] = useState(0)
  // Every read of the notices main hands over (`#state-reads`): going down the list must ask nothing more.
  const [stateReads, setStateReads] = useState(0)
  installElectronAPI({
    listBrowserPlans: async () => { setPlanReads(n => n + 1); return { ok: true, inbox: browserInbox } },
    getBrowserPlan: async (_companyId, planId) => ({ ok: true, card: { plan: planView(planId), ready: { ok: true }, stoppedHere: false, runningHere: false, siteHost: MANUAL ? 'haishin.example.net' : 'manager.linestep.net' } }),
    runBrowserPlan: async () => {
      setActed('run')
      // The run's answer was lost: the draft became a run nobody knows the result of (the server's lists move with it).
      draftRan = true
      browserInbox = { plans: [], unsure: [...browserInbox.unsure, { planId: DRAFT, state: 'unknown', label: 'リマインダの段にテンプレートを足す', permittedAt: at(0, 9), confirmableAt: justPast(), canConfirm: true }] }
      return { ok: true, result: { outcome: 'unknown', reason: 'no-answer' } }
    },
    cancelBrowserPlan: async () => { setActed('cancel'); return { ok: false, offline: true, message: '（見本）' } },
    confirmBrowserExecution: async () => { setActed('confirm'); return { ok: false, offline: true, message: '（見本）' } },
    watchNotifications: async () => {},
    getNotificationsState: async () => { setStateReads(n => n + 1); return state },
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
    getApproval: async (_companyId, id) => ({ success: true, approval: approved && id === view.id ? { ...view, state: 'approved', viewerMayApprove: false, outcome: { at: at(0, 11), by: 'u-tanaka', onBehalfOf: null, note: '承認します', resultOperationId: 'op-1' } } : { ...view, id, recordTitle: state.myTurn.items.find(i => i.id === id)?.title ?? view.recordTitle }, names: { 'u-yamada': '山田', 'u-me': '阿部', 'u-tanaka': '田中' } }),
    // `&approvals=N`: an approve lands (the request leaves the turn, as the server's next read says); otherwise offline.
    approveApproval: async (companyId, id) => {
      setActed(a => [a, `approve ${id}`].filter(Boolean).join('|'))
      if (APPROVALS === 0) return { success: false, offline: true, error: '（見本）' } as never
      state = { ...state, myTurn: { ...state.myTurn, total: state.myTurn.total - 1, items: state.myTurn.items.filter(i => i.id !== id) } }
      setTimeout(() => changed.emit({ companyId }), 0)
      return { success: true, approval: { ...view, id, state: 'approved', viewerMayApprove: false, outcome: { at: FIXED(1), by: 'u-me', onBehalfOf: null, note: '承認します', resultOperationId: 'op-2' } } } as never
    },
    getOutboundMail: async () => ({ success: false, offline: false, code: null, error: '（見本）下書きは、このページでは読み込みません。' }),
    sendOutboundMail: async () => { setActed('send'); return { success: false, offline: true, error: '（見本）' } as never },
    getContact: async (_companyId, id) => (contactNow && (id === IID || id === RID) ? { success: true, contact: contactNow } : { success: false, gone: true }),
    finishContact: async (_companyId, _id, input) => { setActed(`finish ${JSON.stringify(input)}`); return finishOnServer(input) },
    undoContactFinish: async (_companyId, _id, input) => { setActed(`undo ${JSON.stringify(input)}`); return undoOnServer(input) },
    // `?contact=archived`: ACB archived the mail in Gmail right after the 「済んだ」 (its note follows the finish's entry 8).
    getContactArchived: async (_companyId, _id, afterVersion) => ({ success: true, stays: CONTACT === 'archived' && afterVersion === 8 }),
  })
  useKeybindings()
  const notices = useNotices('co-preview')
  const inbox = useInboxSlot({
    companyId: 'co-preview', notices, open: true, onToggle: () => setOpened('toggled'),
    // The manual's fixed clock (2026-11-20) is before the inbox's first day: its notices count as 新着 here.
    newsSince: '2026-01-01T00:00:00.000Z',
    onOpenRecord: id => setOpened(`record ${id}`), onOpenTasks: () => setOpened('task list'), onOpenJobs: () => setOpened('jobs'),
    renderApprovalCard: (id, onDone) => <ApprovalCard key={id} card={{ id: `card-${id}`, companyId: 'co-preview', conversationId: null, approvalId: id, origin: 'shown', at: '' }} onDone={onDone} />,
    renderMailDraft: (id, onDone) => <PreparedMailCard key={id} companyId="co-preview" messageId={id} onDone={onDone} />,
    browserPlans: params.get('plans') === '1' ? { list: listBrowserPlans, renderCard: (id, onDone) => <BrowserPlanCard key={id} companyId="co-preview" planId={id} onDone={onDone} />, planStates: PLAN_STATES } : undefined,
    memberName: id => (id === 'u-tanaka' ? '田中' : null),
  })
  return (
    <main className="flex h-screen flex-col bg-bg text-text">
      <p className="p-3 text-small text-text-muted">表示確認用の人工データ。</p>
      <pre id="opened">{opened}</pre>
      <pre id="read">{read}</pre>
      <pre id="acted">{acted}</pre>
      <pre id="plan-reads">{planReads}</pre>
      <pre id="state-reads">{stateReads}</pre>
      {params.get('chatcard') === '1' && <section aria-label="相談のカード"><BrowserPlanCard companyId="co-preview" planId={DRAFT} /></section>}
      <div className="mt-auto h-[480px]" style={params.get('narrow') === '1' ? { width: 360 } : undefined}>{inbox && <BottomPanel content={inbox} onClose={() => setOpened('closed')} />}</div>
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
    /** The browser plan's draft was approved on another PC: the next read of the plans no longer lists it. */
    planApprovedElsewhere() {
      browserInbox = { ...browserInbox, plans: [] }
    },
    /** Every plan settled elsewhere: the next read lists none. */
    plansSettled() {
      browserInbox = { plans: [], unsure: [] }
    },
    /** The draft claimed elsewhere ended without an answer: the next read lists it as a confirmable unknown run. */
    claimedRunUnknown() {
      draftRan = true
      browserInbox = { plans: [], unsure: [{ planId: DRAFT, state: 'unknown', label: 'リマインダの段にテンプレートを足す', permittedAt: at(0, 9), confirmableAt: justPast(), canConfirm: true }] }
    },
  },
})

createRoot(document.getElementById('root')!).render(<Preview />)
