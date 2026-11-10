// What the minutes feature puts on the main screen (minutes.md "The app", "Meetings for their
// attendees"): AppShell places these parts and knows nothing else of minutes.
import { useMemo, useState, type ReactNode } from 'react'
import type { AiTurnItemsView } from '../../../../shared/ai-turns'
import type { MinutesNotice } from '../../../../shared/minutes-app'
import { arrivedMeetingTurns, meetingTurns, type MeetingTurn } from '../../../../shared/notifications-app'
import { meetingBundleWords, type TaskListItem } from '../../../../shared/tasks'
import type { CompanyFeatures } from '../../../../../shared/core/features'
import { declineMeetingBundle, requestMeetingReading, skipMinutes } from '../api'
import { MeetingBanners } from '../components/MeetingBanners'
import { MinutesCheckButton } from '../components/MinutesCheckButton'
import { startMinutesReading } from '../startReading'
import { useMeetingArrivals } from './useMeetingArrivals'
import { useMinutesNotices } from './useMinutesNotices'

const NO_NOTICES: readonly MinutesNotice[] = []

interface Args {
  companyId: string | undefined
  features: CompanyFeatures
  taskItems: readonly TaskListItem[]
  reloadTasks: () => void
  /** Where each waiting record stands with the automatic 「AI の番」 (the chat's runner reports it). */
  aiTurnItems: AiTurnItemsView | null
  /** The task list shows for the department on screen: then its meetings wait there, not in the title bar. */
  tasksShown: boolean
  /** The department's kind's name (「案件」): the questions never say 「まとまり」. */
  bundleWord: string
  /** はい on a suggested まとまり (the tasks feature's link). */
  linkBundle: (companyId: string, meetingId: string, bundleId: string) => Promise<unknown>
  openRecord: (recordId: string) => void
}

export function useMinutesSlots({ companyId, features, taskItems, reloadTasks, aiTurnItems, tasksShown, bundleWord, linkBundle, openRecord }: Args) {
  // Received minutes: main checks while Google may read the member's minutes; the
  // AI turn runner reads them, the task list shows them in 「AI の番」.
  const minutes = useMinutesNotices(companyId)
  // 「議事録が届きました」 (meetings for their attendees): the banner on やること; what the member asked to be read runs even with 自動で進める off.
  const meetings = useMeetingArrivals(companyId)
  const askedMeetings = useMemo(() => new Set(meetings.arrivals.items.filter(m => m.byYou && m.status === 'asked').map(m => m.recordId)), [meetings.arrivals])
  const aiTurnMinutes = useMemo(() => minutes.available ? minutes.notices : NO_NOTICES, [minutes.available, minutes.notices])
  // 「どのまとまりの会議ですか？」 chosen from the title bar (where the department shows no task list) or the list.
  const [choosingBundle, setChoosingBundle] = useState<{ id: string; title: string } | null>(null)
  // Bumped when a まとまり is chosen there, so an open meeting card reads again.
  const [bundleRev, setBundleRev] = useState(0)

  // 「議事録が届きました」 only while 会議と議事録 is on (the server answers none while it is off, too).
  const arrivalsShown = meetings.arrivals.available && features.meetings
  const changed = () => { meetings.reload(); reloadTasks() }
  const readMinutes = (recordId: string) => { const notice = minutes.notices.find(n => n.id === recordId); if (notice) startMinutesReading(notice, features) }

  const banners = (): ReactNode => !companyId || !arrivalsShown ? null : (
    <MeetingBanners key={companyId} companyId={companyId} items={meetings.arrivals.items} aiTurns={aiTurnItems} decisionsOn={features.decisions}
      onView={m => openRecord(m.id)} onChanged={changed} />
  )

  const taskListActions = companyId && minutes.available && features.meetings ? {
    read: readMinutes,
    skip: async (recordId: string) => { const r = await skipMinutes(companyId, recordId); return r && !r.success ? r.error : null },
  } : undefined

  const titleBarButton = minutes.available && features.meetings && companyId ? <MinutesCheckButton companyId={companyId} /> : undefined

  const meetingWords = meetingBundleWords(bundleWord)
  // A department without the task list: its meetings (received minutes, a まとまり to choose) wait in the title bar.
  const listMeetings = tasksShown || !companyId ? [] : meetingTurns(taskItems, aiTurnItems?.items ?? [], bundleWord)
  // Minutes that arrived and nobody asked the AI to read count too, with ［AI に読ませる］ (owner decision 2026-11-07).
  const arrivedMeetings = tasksShown || !companyId || !arrivalsShown ? [] : arrivedMeetingTurns(meetings.arrivals.items, new Set(listMeetings.map(m => m.id)))
  const titleBarMeetings: Array<MeetingTurn & { actions: Array<{ label: string; run: () => void }> }> = !companyId ? [] : [...arrivedMeetings, ...listMeetings].map(m => {
    const actions: Array<{ label: string; run: () => void }> = []
    if (m.kind === 'bundle') {
      const s = m.suggestedBundle
      if (s) actions.push({ label: 'はい', run: () => void linkBundle(companyId, m.id, s.id).then(() => reloadTasks()) })
      actions.push({ label: s ? 'ちがう／選ぶ' : meetingWords.choose, run: () => setChoosingBundle({ id: m.id, title: m.title }) })
      actions.push({ label: meetingWords.none, run: () => void declineMeetingBundle(companyId, m.id).then(() => reloadTasks()) })
    }
    if (arrivedMeetings.some(a => a.id === m.id)) {
      const arrival = meetings.arrivals.items.find(a => a.recordId === m.id)
      if (arrival) actions.push({ label: 'AI に読ませる', run: () => void requestMeetingReading(companyId, arrival.recordId, arrival.version).then(changed) })
      return { ...m, actions }
    }
    if (m.kind === 'minutes' && m.ai?.state !== 'running' && minutes.available && taskItems.find(i => i.id === m.id)?.state === 'received') {
      actions.push({ label: '自分で読み取る', run: () => readMinutes(m.id) })
      actions.push({ label: '今は読まない', run: () => void skipMinutes(companyId, m.id).then(() => reloadTasks()) })
    }
    if (m.ai?.canRetry) actions.push({ label: 'もう一度', run: () => aiTurnItems?.retry(m.id) })
    if (m.ai?.canHand) actions.push({ label: '人に渡す', run: () => aiTurnItems?.handOver(m.id) })
    return { ...m, actions }
  })

  return {
    /** The runner's queue: the received minutes, and the meetings the member asked to be read. */
    aiTurnMinutes,
    askedMeetings,
    banners,
    taskListActions,
    titleBarButton,
    titleBarMeetings,
    /** Something on a meeting changed (its card): the arrivals and the task list read again. */
    changed,
    /** A meeting's card is drawn again after a まとまり was chosen for it. */
    cardKey: (recordId: string) => recordId.startsWith('meeting-') || recordId.startsWith('minutes-') ? `${recordId}:${bundleRev}` : recordId,
    choosingBundle,
    bundleChosen: () => setBundleRev(n => n + 1),
    closeBundleChooser: () => setChoosingBundle(null),
  }
}
