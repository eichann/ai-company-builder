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
import { fakeDropLink } from './ui/fixtures/link-drop'

const params = new URLSearchParams(location.search)
// `?manual=1`: the user manual's story (client/tests/manual/scenes.ts, chapters 17–21): 検証A社, the member is 山田さん in
// 営業部 (プロジェクト), who asks 高橋さん and is asked by 佐藤さん; AI の番 with one running and one stopped (［もう一度］［人に渡す］);
// today's 14:00 meeting. `&absent=1`: 山田さん also covers 高橋さん (「高橋さんの代わり」). Fictional data only.
const MANUAL = params.get('manual') === '1'
const now = companyNow(Date.now())
const day = (n: number) => addDays(now.date, n)
const base = { type: 'task', typeLabel: 'タスク', version: 2, tags: [] as string[], waitingFor: null, personal: false, own: false, actingFor: null, bundle: null, finishedAt: null, stateLabel: null }
const it = (over: Partial<TaskListItem> & Pick<TaskListItem, 'id' | 'title' | 'turn'>): TaskListItem => ({ ...base, state: 'todo', due: null, ...over })
const defaultData: TaskListData = {
  available: true, listDepartmentIds: null, me: 'u-me',
  // 営業部 (the department on screen) makes 案件: the meeting question says 「案件」, never 「まとまり」.
  bundleKinds: { core: { type: 'project', name: 'プロジェクト', source: 'core' }, departments: [{ departmentId: 'd-sales', folder: '営業部', kind: { type: 'deal', name: '案件', source: 'plugin' } }], kinds: [] }, members: [{ id: 'u-me', name: '佐藤' }, { id: 'u-tanaka', name: '田中' }, { id: 'u-abe', name: '阿部' }],
  items: [
    it({ id: 'task-acc001', title: 'セキュリティのチェックシート', turn: 'acceptance', state: 'awaiting_acceptance', due: day(5) }),
    it({ id: 'task-mine01', title: 'お礼メールを確かめて送る', turn: 'mine', due: `${day(0)}T23:59`, tags: ['営業'], bundle: { id: 'deal-a00001', title: 'A社 問い合わせ対応', typeLabel: '案件' } }),
    it({ id: 'task-mine02', title: '見積書を作り直す', turn: 'mine', due: day(1), tags: ['営業', '見積'], own: true, personal: true, check: { action: 'complete' } }),
    // Asked with 確かめてから: the ☑ shows it to the checker instead of completing.
    it({ id: 'task-chk001', title: '提案書の数字を直す', turn: 'mine', state: 'in_progress', check: { action: 'request_review', reviewer: 'u-abe' } }),
    // Not started, nothing to press (main's `resting`): due far → 先のこと, no due → いつか (both folded, not counted).
    it({ id: 'task-far001', title: '来期の研修メニューを見直す', turn: 'mine', due: day(40), tags: ['社内'], resting: true }),
    it({ id: 'task-some01', title: '業界の本を読む', turn: 'mine', resting: true, own: true, personal: true }),
    it({ id: 'task-ai0001', title: '日程の候補を探す', turn: 'ai', state: 'preparing' }),
    it({ id: 'task-oth001', title: '金額の変更の承認', turn: 'others', waitingFor: '阿部さんの番' }),
    // Asked of someone else: no box, the 「人に頼んだもの」 mark.
    it({ id: 'task-ask001', title: 'セキュリティ資料を送る', turn: 'others', state: 'awaiting_acceptance', waitingFor: '田中さんに頼んだ・引き受け待ち', askedOfOthers: true }),
    // A 来た連絡 in 確認待ち that is the member's: its ☑ is 「済んだ」 (owner FB #20).
    it({ id: 'interaction-0001', type: 'interaction', typeLabel: '来た連絡', title: '日程のご相談', turn: 'mine', state: 'unsure', check: { action: 'settle' } }),
    it({ id: 'task-done01', title: '経費の申請', turn: 'done', state: 'done', finishedAt: new Date().toISOString() }),
    it({ id: 'meeting-00aa11', type: 'meeting', typeLabel: '会議', title: 'C社 打ち合わせ', turn: 'mine', state: 'read', waitingFor: 'どの案件・プロジェクトの会議か選んでください', needsBundle: true, bundleGroup: { key: 'g-c', label: 'C社 打ち合わせ' } }),
    // The server suggests the 相手's one open まとまり: 「『…』の会議ですか？」.
    it({ id: 'meeting-00cc31', type: 'meeting', typeLabel: '会議', title: 'E社 打ち合わせ', turn: 'mine', state: 'read', waitingFor: '『E社 研修導入』の会議ですか？', needsBundle: true, bundleGroup: { key: 'g-e', label: 'E社' }, suggestedBundle: { id: 'deal-e00001', title: 'E社 研修導入' } }),
    // Two meetings of one series (the server's group): one row 「まとまりを選ぶ会議 2件」.
    it({ id: 'meeting-00bb21', type: 'meeting', typeLabel: '会議', title: 'D社 定例 第1回', turn: 'mine', state: 'read', waitingFor: 'どの案件・プロジェクトの会議か選んでください', needsBundle: true, bundleGroup: { key: 'g-d', label: 'D社 定例' } }),
    it({ id: 'meeting-00bb22', type: 'meeting', typeLabel: '会議', title: 'D社 定例 第2回', turn: 'mine', state: 'read', waitingFor: 'どの案件・プロジェクトの会議か選んでください', needsBundle: true, bundleGroup: { key: 'g-d', label: 'D社 定例' } }),
  ],
}
const PROJECT = { id: 'project-a00001', title: 'A社 研修導入', typeLabel: 'プロジェクト' }
const manualData: TaskListData = {
  available: true, listDepartmentIds: null, me: 'u-me',
  bundleKinds: { core: { type: 'project', name: 'プロジェクト', source: 'core' }, departments: [], kinds: [] },
  members: [{ id: 'u-me', name: '山田' }, { id: 'u-takahashi', name: '高橋' }, { id: 'u-sato', name: '佐藤' }],
  items: [
    it({ id: 'task-macc01', title: 'セキュリティのチェックシートを埋める', turn: 'acceptance', state: 'awaiting_acceptance', due: day(5) }),
    it({ id: 'task-mmine1', title: 'お礼メールを確かめて送る', turn: 'mine', due: `${day(0)}T17:00`, tags: ['営業'], bundle: PROJECT, check: { action: 'complete' } }),
    it({ id: 'task-mmine2', title: 'B社 訪問メモをまとめる', turn: 'mine', due: `${day(3)}T15:00`, tags: ['営業', 'B社'], own: true, personal: true, check: { action: 'complete' } }),
    ...(params.get('absent') === '1' ? [it({ id: 'task-mcover', title: 'B社に資料を送る', turn: 'mine', due: day(0), tags: ['営業'], actingFor: '高橋', check: { action: 'complete' } })] : []),
    it({ id: 'task-mfar01', title: '来期の訪問計画を立てる', turn: 'mine', due: day(40), tags: ['営業'], resting: true, own: true, personal: true }),
    it({ id: 'task-msome1', title: '業界の本を読む', turn: 'mine', resting: true, own: true, personal: true }),
    it({ id: 'task-mai001', title: 'C社 日程の候補を探す', turn: 'ai', state: 'preparing' }),
    it({ id: 'task-mai002', title: 'B社 お問い合わせへの返事の下書き', turn: 'ai', state: 'preparing' }),
    it({ id: 'task-mask01', title: 'セキュリティ資料を送る', turn: 'others', state: 'awaiting_acceptance', waitingFor: '高橋さんに頼んだ・引き受け待ち', askedOfOthers: true, bundle: PROJECT }),
    it({ id: 'task-mwait1', title: 'A社 見積の回答をもらう', turn: 'others', state: 'waiting', waitingFor: '返事待ち：先方からの返事（11/25 ごろまで）', bundle: PROJECT }),
    it({ id: 'task-mdone1', title: '交通費の申請', turn: 'done', state: 'done', finishedAt: new Date().toISOString() }),
  ],
}
let data: TaskListData = MANUAL ? manualData : defaultData
// `?manual=1`: what the automatic 「AI の番」 says about its two rows (one working, one stopped after its tries).
const manualAiTurns = {
  items: [
    { recordId: 'task-mai001', state: 'running' as const, reason: '', canRetry: false, canHand: false },
    { recordId: 'task-mai002', state: 'failed' as const, reason: 'AI が最後まで終えられませんでした。理由は「AIへの相談」に残っています。', canRetry: true, canHand: true },
  ],
  retry: (id: string) => { acted.push(`retry ${id}`); document.getElementById('acted')!.textContent = acted.join(',') },
  handOver: (id: string) => { acted.push(`hand ${id}`); document.getElementById('acted')!.textContent = acted.join(',') },
}
// 45 archived tasks, newest first: the folded 「アーカイブ」 shows 20, then 20, then 5.
const MANUAL_ARCHIVED = ['展示会の備品をそろえる', 'D社 訪問の日程調整', '名刺の注文']
const archived = MANUAL ? MANUAL_ARCHIVED.map((title, n) => ({
  id: `task-marc${String(n).padStart(2, '0')}`, title, archivedAt: new Date(Date.now() - (n + 1) * 86400_000).toISOString(), personal: n !== 1,
})) : Array.from({ length: 45 }, (_, n) => ({
  id: `task-arc${String(n).padStart(3, '0')}`, title: `アーカイブした ${n + 1}`, archivedAt: new Date(Date.now() - n * 3600_000).toISOString(), personal: n % 3 === 0,
}))
const changed = emitter<{ companyId: string }>()
const acted: string[] = []

installElectronAPI({
  getTaskList: async () => ({ success: true, data }),
  // Something dropped on a row (a file, folder, record or consultation) links it (tasks-ui.md "Dropping links").
  dropLinkOnRecord: fakeDropLink(line => { acted.push(line); document.getElementById('acted')!.textContent = acted.join(',') }),
  patchChatSession: async (_c, sessionId, patch) => { acted.push(`topic ${sessionId}=${String(patch.topicRecordId)}`); document.getElementById('acted')!.textContent = acted.join(','); return {} as never },
  getArchivedTasks: async (_companyId, cursor) => {
    acted.push(`archived ${cursor.assignee}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    const at = cursor.assignee
    const end = Math.min(at + 20, archived.length)
    return { success: true, items: archived.slice(at, end), next: end < archived.length ? { assignee: end, requester: end } : null }
  },
  onNotificationsChanged: changed.subscribe,
  getCalendarToday: async () => ({
    success: true,
    data: {
      date: now.date, timeZone: 'Asia/Tokyo', reason: null, events: MANUAL ? [
        { id: 'ev-m-later', title: 'A社 打ち合わせ', start: `${now.date}T14:00:00+09:00`, end: `${now.date}T15:00:00+09:00`, allDay: false, online: true, attendeeCount: 4, hasExternalAttendees: true },
        { id: 'ev-m-over', title: '営業部 朝会', start: `${now.date}T09:00:00+09:00`, end: `${now.date}T09:30:00+09:00`, allDay: false, online: false, attendeeCount: 6, hasExternalAttendees: false },
      ] : [
        { id: 'ev-later', title: 'B社 見積のオンライン確認', start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 5400_000).toISOString(), allDay: false, online: true, attendeeCount: 3, hasExternalAttendees: true },
        { id: 'ev-over', title: '営業部 週次定例', start: new Date(Date.now() - 7200_000).toISOString(), end: new Date(Date.now() - 5400_000).toISOString(), allDay: false, online: false, attendeeCount: 5, hasExternalAttendees: false },
      ],
    },
  }),
  createTask: async (_companyId, input) => {
    acted.push(`create ${JSON.stringify(input)}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    data = { ...data, items: [it({ id: 'task-new001', title: input.title, turn: 'mine', due: input.due ?? null, tags: input.tags ?? [], own: true, personal: true, ...(MANUAL ? { check: { action: 'complete' as const } } : {}) }), ...data.items] }
    return { success: true, recordId: 'task-new001' }
  },
  // Tag suggestions as main would answer them: a reading variant caught (えいぎょう → 営業).
  suggestTaskTags: async (_companyId, title, inUse) => ({ source: 'ai', tags: title.includes('えいぎょう') && inUse.includes('営業') ? ['営業'] : [] }),
  getBundleChoices: async () => (MANUAL ? { success: true, bundles: [{ id: PROJECT.id, title: PROJECT.title, typeLabel: 'プロジェクト' }] } : { success: true, bundles: [{ id: 'deal-c00001', title: 'C社 研修導入', typeLabel: '案件' }, { id: 'deal-c00002', title: 'C社 追加', typeLabel: '案件' }] }),
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
  undoTaskAction: async (_companyId, recordId, version, expected) => {
    acted.push(`${recordId}:undo ${version}@${expected}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    data = { ...data, items: data.items.map(i => (i.id === recordId ? { ...i, turn: 'mine' as const, state: 'unsure', version: i.version + 1, finishedAt: null, check: { action: 'settle' as const } } : i)) }
    return { success: true, recordId }
  },
  actOnTask: async (_companyId, recordId, input) => {
    acted.push(`${recordId}:${input.action}@${input.expectedVersion}${input.args?.reviewer ? `>${input.args.reviewer}` : ''}`)
    document.getElementById('acted')!.textContent = acted.join(',')
    if (input.action === 'accept') data = { ...data, items: data.items.map(i => (i.id === recordId ? { ...i, turn: 'mine' as const, state: 'todo' } : i)) }
    if (input.action === 'request_review') data = { ...data, items: data.items.map(i => (i.id === recordId ? { ...i, turn: 'others' as const, state: 'review', waitingFor: '阿部さんの番', check: undefined } : i)) }
    if (input.action === 'settle') data = { ...data, items: data.items.map(i => (i.id === recordId ? { ...i, turn: 'done' as const, state: 'handled', version: i.version + 1, finishedAt: new Date().toISOString(), check: { action: 'undo' as const, version: i.version + 1 } } : i)) }
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
        <TaskListPanel companyId="co-preview" rootPath="/Users/me/company" askFolder="営業部" list={list} aiTurns={MANUAL ? manualAiTurns : null} activeRecordId={opened} onOpen={setOpened}
          onConsult={t => { acted.push(`consult ${t.id}`); document.getElementById('acted')!.textContent = acted.join(',') }}
          onShowTable={() => { acted.push('show table'); document.getElementById('acted')!.textContent = acted.join(',') }} />
        {opened && <div data-testid="card">カード：{opened}</div>}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
