/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for meetings seen by their attendees (minutes.md "Meetings for their attendees"):
// the meetings' rows of the inbox (the real `useMeetingInboxRows`, `inboxView` and `InboxList`, the banner on やること
// before 2026-11-26) and the real meeting card (RecordCard with the app's MeetingPanel and 案件 field) over a fake main
// kept in memory. Synthetic data only. `?viewer=suzuki`: another attendee's screen (阿部 already chose ［読まない］ for
// 採用面接). `?noaccess=1`: the member's Google cannot open the minutes. `?renew=1`: their permission is from before the
// Docs API. `?flood=N`: a first discovery, N more meetings at once. `?bundle=suggest`: the server suggests one 案件 for the
// card's question (`?bundle=declined`: 案件はない was chosen). `window.__acbMeetings.finish(id)`: the
// member's AI finished reading (what the runner does in the app). Presses show in `#log`.
// 「やることを足す」 answers 「似ている」 for a title close to a proposal (the server decides in the app).
// `?three=1`: a server that keeps a series' three choices (`seriesChoice`). `?autoread=new`: the member
// never chose 「届いた議事録を AI が自動で読む」 and starts at 自動では読まない (else the server does not answer it).
// `?card=fail|off|throw`: main's answer to the card (failed / an older server / no answer).
// `?clock=1`: the server's clock asked 定例ミーティング for 鈴木さん, its organiser, not started yet (`?clock=taken`: a
// press then answers 409 MEETING_NOT_WAITING, someone's reading having started meanwhile).
const CLOCK = new URLSearchParams(location.search).get('clock')
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { MeetingArrival } from '../../shared/types/minutes'
import type { RecordSummary } from '../../shared/types/records'
import type { NotificationItem } from '../../shared/types/notifications'
import { useMeetingArrivals } from '../src/features/minutes/hooks/useMeetingArrivals'
import { useMeetingInboxRows } from '../src/features/minutes/hooks/useMeetingInboxRows'
import { InboxList } from '../src/features/inbox/components/InboxList'
import { inboxView } from '../src/features/inbox/model'
import { sectionsOf } from '../src/features/inbox/workModel'
import { RecordCard } from '../src/features/records/components/RecordCard'
import { useCommandHandler } from '../src/shared/commands/commands'
import { renderMeetingPanel } from '../src/app/meetingCard'
import { renderRecordBundleField } from '../src/app/recordBundleField'
import { recordDetailOf } from '../shared/record-details'
import { summaryView } from '../shared/record-views'
import { MEETING_NO_ACCESS_TEXT, MINUTES_OFFLINE_TEXT } from '../shared/minutes-app'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
const ME = params.get('viewer') === 'suzuki' ? 'u-suzuki' : 'u-abe'
// `?manual=1`: the user manual's story (client/tests/manual/scenes.ts, chapter 24): the member is 山田さん of 営業部 (the same
// ids, other names), A社 打ち合わせ and 営業部 定例, プロジェクト instead of 案件. Fictional data only.
const MANUAL = params.get('manual') === '1'
const people: Record<string, string> = MANUAL
  ? { 'u-abe': '山田', 'u-suzuki': '高橋', 'u-tamura': '佐藤', 'u-boss': '木下部長' }
  : { 'u-abe': '阿部', 'u-suzuki': '鈴木', 'u-tamura': '田村', 'u-boss': '田中部長' }
const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
const today = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString() }

interface Meeting { id: string; title: string; at: string; state: string; version: number; by: string | null; series: boolean; members: string[]; clockAsked?: boolean; organiser?: string }
const meetings: Meeting[] = MANUAL ? [
  { id: 'meeting-teirei01', title: '営業部 定例', at: today(9), state: 'arrived', version: 1, by: null, series: true, members: ['u-abe', 'u-suzuki', 'u-tamura'] },
  { id: 'meeting-mensetu1', title: 'A社 打ち合わせ', at: today(10), state: 'arrived', version: 1, by: null, series: false, members: ['u-abe', 'u-suzuki'] },
] : [
  { id: 'meeting-teirei01', title: '定例ミーティング', at: today(12), state: 'arrived', version: 1, by: null, series: true, members: ['u-abe', 'u-suzuki', 'u-tamura'] },
  { id: 'meeting-mensetu1', title: '採用面接', at: today(10), state: ME === 'u-suzuki' ? 'skipped' : 'arrived', version: ME === 'u-suzuki' ? 2 : 1, by: ME === 'u-suzuki' ? 'u-abe' : null, series: false, members: ['u-abe', 'u-suzuki'] },
]
if (CLOCK) Object.assign(meetings[0], { state: 'asked', by: 'u-suzuki', clockAsked: true, organiser: 'u-suzuki' })
const flood = Number(params.get('flood') ?? 0)
for (let n = 0; n < flood; n++) {
  meetings.push({ id: `meeting-flood${String(n).padStart(3, '0')}`, title: `とても長い名前の部長会議 その${n}（会議室③・オンライン併用）`, at: today(9), state: 'arrived', version: 1, by: null, series: false, members: ['u-abe'] })
}
const autoSeries = new Set<string>()
const THREE = params.get('three') === '1'
// How main answers the card (`?card=fail|off|throw`, or `__acbMeetings.cardAnswer` later): null = the meeting.
let cardAnswer: 'fail' | 'off' | 'throw' | null = (['fail', 'off', 'throw'] as const).find(k => k === params.get('card')) ?? null
const seriesOff = new Set<string>()
let autoRead = { mode: 'off' as 'outside' | 'all' | 'off', chosen: false }
const before = new Map<string, Meeting>()
const log: string[] = []
const say = (line: string) => { log.push(line); document.getElementById('log')!.textContent = log.join('\n') }
const changed = emitter<{ companyId: string }>()
const tell = () => changed.emit({ companyId: 'co' })
const rec = (id: string, type: string, title: string, state: string, fields: RecordSummary['fields'] = {}): RecordSummary =>
  ({ id, type, typeVersion: 1, title, summary: '', path: null, state, fields, version: 1, updatedAt: '2026-11-04T04:00:00.000Z' })
const outputs = (m: Meeting) => m.state !== 'read' ? [] : MANUAL ? [
  rec('decision-dec00001', 'decision', '訪問メモは翌日までに共有する', 'unconfirmed', { owner: 'u-abe' }),
  rec('decision-dec00002', 'decision', '12月の展示会には2人で出る', 'unconfirmed', { owner: 'u-abe' }),
  rec('task-prop0001', 'task', '展示会の申し込みをする', 'proposed', { assignee: 'u-abe' }),
  rec('task-prop0002', 'task', '展示会の資料をそろえる', 'proposed', { assignee: 'u-suzuki' }),
  rec('task-prop0003', 'task', '訪問メモのひな形を直す', 'proposed', { assignee: 'u-tamura' }),
] : [
  rec('decision-dec00001', 'decision', '日報は 11月から AI の下書きを使う', 'unconfirmed', { owner: 'u-abe' }),
  rec('decision-dec00002', 'decision', '勉強会は月1回・第2水曜にする', 'unconfirmed', { owner: 'u-abe' }),
  rec('task-prop0001', 'task', '新しい日報の書き方を部署に案内する', 'proposed', { assignee: 'u-abe' }),
  rec('task-prop0002', 'task', '11月の勉強会の会場を押さえる', 'proposed', { assignee: 'u-suzuki' }),
  rec('task-prop0003', 'task', '経費精算の締め日をみんなに知らせる', 'proposed', { assignee: 'u-tamura' }),
]
const meetingRecord = (m: Meeting) => rec(m.id, 'meeting', m.title, m.state === 'asked' ? 'received' : m.state, {
  meeting_at: m.at, attendees: JSON.stringify(m.members), ...(m.by && m.state !== 'skipped' ? { assignee: m.by } : {}),
  ...(m.state === 'read' ? { summary_text: MANUAL ? '今週の訪問の振り返りと、12月の展示会の分担を話し合いました。' : '日報の書き方を見直し、11月から AI の下書きを使うことにしました。' } : {}),
  source_ref: JSON.stringify({ conference: 'c1', event: 'e1', docs: [{ kind: 'notes', id: 'notesDoc12345' }, { kind: 'transcript', id: 'transcriptDoc123' }] }),
})
// What a read meeting links besides: a proposal put away, one already added, and its 「議事録を確認する」.
const putAway = rec('task-prop0004', 'task', MANUAL ? '会議室を予約する' : '議事録の置き場所を決める', 'dismissed', { assignee: 'u-abe' })
const added = rec('task-made0001', 'task', MANUAL ? '先週の訪問メモを共有する' : '日報のひな形を直す', 'todo', { assignee: 'u-abe' })
const reviewTask = rec('task-review01', 'task', MANUAL ? '議事録を確認する：営業部 定例' : '議事録を確認する：定例ミーティング', 'todo', { assignee: 'u-abe', task_kind: 'minutes_review' })
const cardLinks = (m: Meeting) => (m.state !== 'read' ? [] : [...outputs(m), putAway, added, reviewTask].map(r => ({ label: '会議', recordVersion: 1, record: summaryView(r, defs.get(r.type)) })))
const detailOf = (m: Meeting) => ({ record: { ...meetingRecord(m), version: m.version }, links: outputs(m).map(r => ({ name: 'meeting', direction: 'in' as const, record: r })) })
const arrivalOf = (m: Meeting): MeetingArrival => ({
  recordId: m.id, title: m.title, version: m.version, meetingAt: m.at, status: m.state as MeetingArrival['status'], attendeeCount: m.members.length,
  by: m.by ? { memberId: m.by, displayName: people[m.by] } : null, byYou: m.by === ME, series: m.series, autoSeries: m.series && autoSeries.has(m.id),
  ...(THREE && m.series ? { seriesChoice: autoSeries.has(m.id) ? 'auto' as const : seriesOff.has(m.id) ? 'off' as const : null } : {}),
  ...(m.clockAsked ? { askedAutomatically: true } : {}),
  ...(m.by && m.by === m.organiser ? { byOrganiser: true } : {}),
})
// What main counts for 「決めたことN・やることの案N」 (electron/features/minutes/meetings.ts, tested there).
const madeOf = (d: ReturnType<typeof detailOf>) => ({ decisions: d.links.filter(l => l.record.type === 'decision').length, proposals: d.links.filter(l => l.record.type === 'task').length })
const find = (id: string) => meetings.find(m => m.id === id)!
const move = (id: string, patch: Partial<Meeting>) => { const m = find(id); before.set(id, { ...m }); Object.assign(m, patch, { version: m.version + 1 }); tell() }

installElectronAPI({
  getMeetingArrivals: async () => ({ available: true, items: meetings.map(m => ({ ...arrivalOf(m), made: m.state === 'read' ? madeOf(detailOf(m)) : null })) }),
  getMeetingCardState: async (_c, id) => {
    if (cardAnswer === 'fail') return { success: false, error: MINUTES_OFFLINE_TEXT }
    if (cardAnswer === 'off') return { success: false, error: '' }
    if (cardAnswer === 'throw') throw new Error('main did not answer')
    const m = find(id)
    const d = detailOf(m)
    return { success: true, ...(params.get('renew') === '1' ? { renewGoogle: true as const } : {}), meeting: { ...arrivalOf(m), made: m.state === 'read' ? madeOf(d) : null },
      review: m.state === 'read' ? { meetingId: m.id, meetingTitle: m.title, summary: '要約', decisions: outputs(m).filter(r => r.type === 'decision').map(r => ({ id: r.id, title: r.title, state: r.state, version: 1, may: { confirm: r.fields.owner === ME, reject: r.fields.owner === ME }, cannotRead: [] })) } : null }
  },
  connectGoogle: async (_c, features) => { say(`google ${features.join(',')}`); return { success: true } },
  requestMeetingReading: async (_c, id, at) => {
    say(`read ${id}@${at}`)
    if (params.get('noaccess') === '1') return { success: false, error: MEETING_NO_ACCESS_TEXT, noAccess: true }
    if (CLOCK === 'taken') return { success: false, error: 'この会議は、もう AI が読んでいるか、読み終わっています。' }
    move(id, { state: 'asked', by: ME, clockAsked: false })
    return { success: true, version: find(id).version }
  },
  skipMeetingReading: async (_c, id, at) => { say(`skip ${id}@${at}`); move(id, { state: 'skipped', by: ME }); return { success: true, version: find(id).version } },
  undoTaskAction: async (_c, id, version, expected) => {
    say(`undo ${id} ${version}@${expected}`)
    const b = before.get(id)
    if (b) Object.assign(find(id), b, { version: find(id).version + 1 })
    tell()
    return { success: true, recordId: id }
  },
  // 「やることを足す」: a title close to a proposal is answered with it (the server's similarInSlot, tested there).
  createTask: async (_c, input) => {
    say(`create ${input.title} meeting=${input.meetingId ?? ''}`)
    const close = outputs(find(String(input.meetingId))).find(r => r.type === 'task' && (r.title.includes(input.title) || input.title.includes(r.title)))
    return { success: true, recordId: 'task-hand0001', state: 'todo', ...(close ? { similar: { id: close.id, title: close.title } } : {}) }
  },
  actOnTask: async (_c, id, input) => { say(`act ${id} ${input.action}@${input.expectedVersion} ${input.note ?? ''}`.trim()); return { success: true, recordId: id } },
  setMeetingAutoSeries: async (_c, id, auto) => {
    say(`auto ${id} ${auto}`)
    autoSeries.delete(id)
    seriesOff.delete(id)
    if (auto === true) autoSeries.add(id)
    if (auto === false && THREE) seriesOff.add(id)
    tell()
    return { success: true }
  },
  getMeetingAutoRead: async () => params.get('autoread') === 'new' ? { success: true, setting: autoRead } : { success: false, error: '' },
  setMeetingAutoRead: async (_c, mode) => { say(`auto-read ${mode}`); autoRead = { mode, chosen: true }; return { success: true, setting: autoRead } },
  inviteToRecord: async (_c, id, add, at, sets = []) => {
    say(`invite ${id} ${[...add, ...sets.map(x => `${x.type}:${x.id}`)].join(',')}@${at}`)
    return { success: true, added: add, addedSets: sets }
  },
  // The server decides who may add a group or a department (record-member-subjects.test.ts); here: this member may.
  getInviteChoices: async () => ({
    success: true, maySets: !MANUAL, groups: MANUAL ? [] : [{ id: 'grp-1', name: '採用チーム' }], departments: [{ id: 'dep-1', name: '営業部' }],
    listed: MANUAL ? [] : [{ type: 'group', id: 'grp-0', name: '面接官' }],
  }),
  getRecordCard: async (_c, id) => {
    const m = find(id)
    const r = { ...meetingRecord(m), version: m.version }
    return { success: true, card: { record: summaryView(r, defs.get('meeting')), version: m.version, detail: recordDetailOf(r, people, ME) ?? undefined, fields: [], links: cardLinks(m),
      history: [{ at: '2026-11-04T07:19:00.000Z', text: 'AI：読み終えた', ai: true }],
      ...(m.state === 'read' ? { ai: { working: false, done: { at: '2026-11-04T07:19:00.000Z', text: '読み終えた' } } } : {}),
      viewers: { kind: 'people' as const, text: `${m.members.length}人が見られます`, count: m.members.length } } }
  },
  getTaskProposals: async (_c, id) => ({ success: true, proposals: [...outputs(find(id)).filter(r => r.type === 'task'), putAway].map(r => ({ id: r.id, kind: 'task' as const, title: r.title, state: r.state === 'dismissed' ? 'dismissed' as const : 'proposed' as const, version: 1, assignee: String(r.fields.assignee), assigneeName: people[String(r.fields.assignee)], due: null,
    basis: null, addedBy: null, addedByName: null, similarTo: null, may: { adopt: true, dismiss: true, proposeAgain: true, keepApart: true } })) }),
  getMeetingBundleQuestion: async (_c, id) => ({ success: true, title: find(id).title, canChoose: true, noBundle: params.get('bundle') === 'declined',
    suggested: params.get('bundle') === 'suggest' ? { id: 'deal-bsha0001', title: 'B社 研修導入' } : null }),
  declineMinutesBundle: async (_c, id) => { say(`nobundle ${id}`); return { success: true } },
  getBundleChoices: async () => ({ success: true, bundles: [{ id: 'deal-bsha0001', title: 'B社 研修導入', typeLabel: '案件' }] }),
  getViewers: async () => ({ success: true, answer: { records: { 'deal-bsha0001': { kind: 'department', text: '営業部のみんな', count: 6 } }, files: {} } }),
  linkMinutesBundle: async (_c, id, bundleId) => { say(`link ${id}=${bundleId}`); return { success: true } },
  onMinutesChanged: changed.subscribe,
  onRecordsChanged: changed.subscribe,
})
;(window as unknown as { __acbMeetings: unknown }).__acbMeetings = {
  finish: (id: string) => move(id, { state: 'read' }),
  // Main's next answers to the card; `reread` says the meetings may have changed (the card reads again).
  cardAnswer: (kind: 'fail' | 'off' | 'throw' | null) => { cardAnswer = kind },
  reread: () => tell(),
  // The member chose elsewhere (Settings, another PC): the server now holds it.
  chooseAutoRead: (mode: 'outside' | 'all' | 'off') => { autoRead = { mode, chosen: true } },
}

// The manual's fixed clock (2026-11-20) is before the inbox's first day: its notices count as 新着 here.
const PREVIEW_NEWS_SINCE = '2026-01-01T00:00:00.000Z'
// Each meeting's 「議事録が届きました」 notice (the server writes one per attendee), unread until the row is looked at.
const arrivedNotices = (read: ReadonlySet<string>): NotificationItem[] => meetings.map(m => ({
  id: `n-${m.id}`, kind: 'minutes_arrived', recordId: m.id, recordType: 'meeting', recordTitle: m.title, version: 1,
  text: `議事録が届きました：「${m.title}」`, createdAt: new Date().toISOString(), read: read.has(`n-${m.id}`),
}))

function Preview() {
  const { arrivals, reload } = useMeetingArrivals('co')
  useCommandHandler('record.open', ({ recordId }) => say(`open ${recordId}`))
  const [open, setOpen] = useState<string | null>(null)
  const [read, setRead] = useState<ReadonlySet<string>>(new Set())
  const rows = useMeetingInboxRows({ companyId: 'co', items: arrivals.available ? arrivals.items : [], aiTurns: null, decisionsOn: true, onView: m => setOpen(m.id), onChanged: reload })
  const notices = arrivedNotices(read)
  const view = inboxView({ available: true, myTurn: { total: 0, items: [] }, notices: { available: true, unread: notices.filter(x => !x.read).length, items: notices } }, rows.rows, undefined, PREVIEW_NEWS_SINCE)
  const see = (ids: readonly string[]) => setRead(r => new Set([...r, ...ids]))
  return (
    <main className="flex min-h-screen bg-white text-gray-900">
      {/* The inbox's list as the bottom panel shows it (the meetings' rows since 2026-11-26), and the log. */}
      <aside style={{ width: 520 }} className="flex h-screen min-w-0 shrink-0 flex-col overflow-y-auto border-r" aria-label="受け箱">
        {(['new', 'seen'] as const).map(filter => (
          <InboxList key={filter} sections={sectionsOf(view, filter, new Map())} totals={view.counts} filter={filter} meetingButtons={id => rows.rows.find(r => r.id === id)?.actions ?? []}
            onOpen={i => { see(i.unreadNoticeIds); if (i.meetingNews && i.meetingId) rows.markSeen(i.meetingId); if (i.meetingId) setOpen(i.meetingId) }}
            onSeen={i => { see(i.unreadNoticeIds); if (i.meetingNews && i.meetingId) rows.markSeen(i.meetingId) }}
            onButton={(i, b) => { see(i.unreadNoticeIds); b.run() }} onUndo={() => {}} undone={new Set()} onAllSeen={() => { see(view.newsNoticeIds); view.newsMeetingIds.forEach(rows.markSeen) }}
            meetingNote={rows.suggestion} error={null} />
        ))}
        <pre id="log" className="p-2 text-caption" />
        {rows.toast}
      </aside>
      <section className="min-w-0 flex-1">
        {open && <RecordCard key={open} companyId="co" rootPath="/Users/me/company" recordId={open}
          renderBundleField={f => renderRecordBundleField('co', f, MANUAL ? { type: 'project', name: 'プロジェクト', source: 'core' } : { type: 'deal', name: '案件', source: 'plugin' }, '営業部')}
          renderMeeting={(r, parts) => renderMeetingPanel('co', r.id, {
            parts, members: MANUAL ? [{ id: 'u-boss', name: '木下部長' }, { id: 'u-nakamura', name: '中村' }] : Object.entries(people).filter(([id]) => id !== ME).map(([id, name]) => ({ id, name })),
            onConsult: m => say(`consult ${m.id}`), onChanged: reload,
          })} />}
        {!open && <button type="button" className="m-4 text-small text-link" onClick={() => setOpen('meeting-teirei01')}>定例ミーティングを開く</button>}
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
