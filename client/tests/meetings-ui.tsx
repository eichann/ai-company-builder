/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for meetings seen by their attendees (minutes.md "Meetings for their attendees"):
// the real banner 「議事録が届きました」 on top of やること (MeetingBanners) and the real meeting card
// (RecordCard with the app's MeetingPanel and 案件 field) over a fake main kept in memory. Synthetic
// data only. `?viewer=suzuki`: another attendee's screen (阿部 already chose ［読まない］ for 採用面接).
// `?noaccess=1`: the member's Google cannot open the minutes. `?renew=1`: their permission is from before the Docs API. `?flood=N`: a first discovery, N more
// meetings at once, and a long list below. `window.__acbMeetings.finish(id)`: the
// member's AI finished reading (what the runner does in the app). Presses show in `#log`.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { MeetingArrival } from '../../shared/types/minutes'
import type { RecordSummary } from '../../shared/types/records'
import { MeetingBanners } from '../src/features/minutes/components/MeetingBanners'
import { useMeetingArrivals } from '../src/features/minutes/hooks/useMeetingArrivals'
import { RecordCard } from '../src/features/records/components/RecordCard'
import { renderMeetingPanel } from '../src/app/meetingCard'
import { renderRecordBundleField } from '../src/app/recordBundleField'
import { recordDetailOf } from '../shared/record-details'
import { summaryView } from '../shared/record-views'
import { MEETING_NO_ACCESS_TEXT } from '../shared/minutes-app'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
const ME = params.get('viewer') === 'suzuki' ? 'u-suzuki' : 'u-abe'
const people: Record<string, string> = { 'u-abe': '阿部', 'u-suzuki': '鈴木', 'u-tamura': '田村', 'u-boss': '田中部長' }
const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
const today = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString() }

interface Meeting { id: string; title: string; at: string; state: string; version: number; by: string | null; series: boolean; members: string[] }
const meetings: Meeting[] = [
  { id: 'meeting-teirei01', title: '定例ミーティング', at: today(12), state: 'arrived', version: 1, by: null, series: true, members: ['u-abe', 'u-suzuki', 'u-tamura'] },
  { id: 'meeting-mensetu1', title: '採用面接', at: today(10), state: ME === 'u-suzuki' ? 'skipped' : 'arrived', version: ME === 'u-suzuki' ? 2 : 1, by: ME === 'u-suzuki' ? 'u-abe' : null, series: false, members: ['u-abe', 'u-suzuki'] },
]
const flood = Number(params.get('flood') ?? 0)
for (let n = 0; n < flood; n++) {
  meetings.push({ id: `meeting-flood${String(n).padStart(3, '0')}`, title: `とても長い名前の部長会議 その${n}（会議室③・オンライン併用）`, at: today(9), state: 'arrived', version: 1, by: null, series: false, members: ['u-abe'] })
}
const autoSeries = new Set<string>()
const before = new Map<string, Meeting>()
const log: string[] = []
const say = (line: string) => { log.push(line); document.getElementById('log')!.textContent = log.join('\n') }
const changed = emitter<{ companyId: string }>()
const tell = () => changed.emit({ companyId: 'co' })
const rec = (id: string, type: string, title: string, state: string, fields: RecordSummary['fields'] = {}): RecordSummary =>
  ({ id, type, typeVersion: 1, title, summary: '', path: null, state, fields, version: 1, updatedAt: '2026-11-04T04:00:00.000Z' })
const outputs = (m: Meeting) => m.state !== 'read' ? [] : [
  rec('decision-dec00001', 'decision', '日報は 11月から AI の下書きを使う', 'unconfirmed', { owner: 'u-abe' }),
  rec('decision-dec00002', 'decision', '勉強会は月1回・第2水曜にする', 'unconfirmed', { owner: 'u-abe' }),
  rec('task-prop0001', 'task', '新しい日報の書き方を部署に案内する', 'proposed', { assignee: 'u-abe' }),
  rec('task-prop0002', 'task', '11月の勉強会の会場を押さえる', 'proposed', { assignee: 'u-suzuki' }),
  rec('task-prop0003', 'task', '経費精算の締め日をみんなに知らせる', 'proposed', { assignee: 'u-tamura' }),
]
const meetingRecord = (m: Meeting) => rec(m.id, 'meeting', m.title, m.state === 'asked' ? 'received' : m.state, {
  meeting_at: m.at, attendees: JSON.stringify(m.members), ...(m.by && m.state !== 'skipped' ? { assignee: m.by } : {}),
  ...(m.state === 'read' ? { summary_text: '日報の書き方を見直し、11月から AI の下書きを使うことにしました。' } : {}),
})
const detailOf = (m: Meeting) => ({ record: { ...meetingRecord(m), version: m.version }, links: outputs(m).map(r => ({ name: 'meeting', direction: 'in' as const, record: r })) })
const arrivalOf = (m: Meeting): MeetingArrival => ({
  recordId: m.id, title: m.title, version: m.version, meetingAt: m.at, status: m.state as MeetingArrival['status'], attendeeCount: m.members.length,
  by: m.by ? { memberId: m.by, displayName: people[m.by] } : null, byYou: m.by === ME, series: m.series, autoSeries: m.series && autoSeries.has(m.id),
})
// What main counts for 「決めたことN・やることの案N」 (electron/features/minutes/meetings.ts, tested there).
const madeOf = (d: ReturnType<typeof detailOf>) => ({ decisions: d.links.filter(l => l.record.type === 'decision').length, proposals: d.links.filter(l => l.record.type === 'task').length })
const find = (id: string) => meetings.find(m => m.id === id)!
const move = (id: string, patch: Partial<Meeting>) => { const m = find(id); before.set(id, { ...m }); Object.assign(m, patch, { version: m.version + 1 }); tell() }

installElectronAPI({
  getMeetingArrivals: async () => ({ available: true, items: meetings.map(m => ({ ...arrivalOf(m), made: m.state === 'read' ? madeOf(detailOf(m)) : null })) }),
  getMeetingCardState: async (_c, id) => {
    const m = find(id)
    const d = detailOf(m)
    return { success: true, ...(params.get('renew') === '1' ? { renewGoogle: true as const } : {}), meeting: { ...arrivalOf(m), made: m.state === 'read' ? madeOf(d) : null },
      review: m.state === 'read' ? { meetingId: m.id, meetingTitle: m.title, summary: '要約', decisions: outputs(m).filter(r => r.type === 'decision').map(r => ({ id: r.id, title: r.title, state: r.state, version: 1, mine: r.fields.owner === ME })) } : null }
  },
  connectGoogle: async (_c, features) => { say(`google ${features.join(',')}`); return { success: true } },
  requestMeetingReading: async (_c, id, at) => {
    say(`read ${id}@${at}`)
    if (params.get('noaccess') === '1') return { success: false, error: MEETING_NO_ACCESS_TEXT, noAccess: true }
    move(id, { state: 'asked', by: ME })
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
  setMeetingAutoSeries: async (_c, id, auto) => { say(`auto ${id} ${auto}`); if (auto) autoSeries.add(id); else autoSeries.delete(id); tell(); return { success: true } },
  inviteToRecord: async (_c, id, add, at) => { say(`invite ${id} ${add.join(',')}@${at}`); return { success: true, added: add } },
  getRecordCard: async (_c, id) => {
    const m = find(id)
    const r = { ...meetingRecord(m), version: m.version }
    return { success: true, card: { record: summaryView(r, defs.get('meeting')), version: m.version, detail: recordDetailOf(r, people, ME) ?? undefined, fields: [], history: [], links: [],
      viewers: { kind: 'people' as const, text: `${m.members.length}人が見られます`, count: m.members.length } } }
  },
  getTaskProposals: async (_c, id) => ({ success: true, proposals: outputs(find(id)).filter(r => r.type === 'task').map(r => ({ id: r.id, kind: 'task' as const, title: r.title, state: 'proposed' as const, version: 1, assignee: String(r.fields.assignee), assigneeName: people[String(r.fields.assignee)], due: null })) }),
  getBundleChoices: async () => ({ success: true, bundles: [{ id: 'deal-bsha0001', title: 'B社 研修導入', typeLabel: '案件' }] }),
  getViewers: async () => ({ success: true, answer: { records: { 'deal-bsha0001': { kind: 'department', text: '営業部のみんな', count: 6 } }, files: {} } }),
  linkMinutesBundle: async (_c, id, bundleId) => { say(`link ${id}=${bundleId}`); return { success: true } },
  onMinutesChanged: changed.subscribe,
  onRecordsChanged: changed.subscribe,
})
;(window as unknown as { __acbMeetings: unknown }).__acbMeetings = { finish: (id: string) => move(id, { state: 'read' }) }

function Preview() {
  const { arrivals, reload } = useMeetingArrivals('co')
  const [open, setOpen] = useState<string | null>(null)
  return (
    <main className="flex min-h-screen bg-white text-gray-900">
      {/* The pane as AppShell lays it out: the block, then the list taking what is left. */}
      <aside style={{ width: 300 }} className="flex h-screen min-w-0 shrink-0 flex-col border-r" aria-label="やること">
        {arrivals.available && <MeetingBanners companyId="co" items={arrivals.items} aiTurns={null} onView={m => setOpen(m.id)} onChanged={reload} />}
        <div className="flex min-h-0 flex-1">
          <div data-testid="task-list" className="min-h-0 flex-1 overflow-y-auto">
            <p className="p-3 text-[12px] text-gray-400">（やることの一覧）</p>
            <pre id="log" className="p-2 text-[10px]" />
            {flood > 0 && Array.from({ length: 60 }, (_, n) => <p key={n} className="px-3 py-1.5 text-[12px]">やること {n}</p>)}
          </div>
        </div>
      </aside>
      <section className="min-w-0 flex-1">
        {open && <RecordCard key={open} companyId="co" rootPath="/Users/me/company" recordId={open}
          renderBundleField={f => renderRecordBundleField('co', f, { type: 'deal', name: '案件', source: 'plugin' }, '営業部')}
          renderMeeting={r => renderMeetingPanel('co', r.id, {
            members: Object.entries(people).filter(([id]) => id !== ME).map(([id, name]) => ({ id, name })),
            onConsult: m => say(`consult ${m.id}`), onChanged: reload,
          })} />}
        {!open && <button type="button" className="m-4 text-[12px] text-accent" onClick={() => setOpen('meeting-teirei01')}>定例ミーティングを開く</button>}
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
