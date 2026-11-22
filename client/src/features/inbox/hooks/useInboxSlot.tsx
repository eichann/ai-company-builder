import { useMemo, useState, type ReactNode } from 'react'
import { NOTICES_OFFLINE_TEXT, type MeetingTurn, type NoticesState } from '../../../../shared/notifications-app'
import { DEFAULT_FEATURES, type CompanyFeatures } from '../../../../../shared/core/features'
import { getNoticeSettings, markNoticesRead, setNoticeSetting, undoNoticedAiChange, undoNoticedChange } from '../../notifications/api'
import { InboxChips, InboxList, type InboxRowButton } from '../components/InboxList'
import { InboxCardDialog } from '../components/InboxCardDialog'
import { InboxButton } from '../components/InboxButton'
import { NoticeSettingsDialog } from '../components/NoticeSettingsDialog'
import { useInboxBrowserPlans, type InboxBrowserPlanList } from './useInboxBrowserPlans'
import { bulkSeenIds, hasInboxNews, inboxNewsBaseline, inboxNewsKeys, inboxView, sameKeys, seenWhileShown, type InboxFilter, type InboxItem } from '../model'

/** A meeting of a department without the task list, with its own buttons (the minutes feature's `titleBarMeetings`). */
export type InboxMeeting = MeetingTurn & { actions: InboxRowButton[] }

interface InboxSlotInput {
  companyId: string | undefined
  /** What main read for the company on screen (AppShell's `useNotices`): the inbox reads nothing else. */
  notices: NoticesState
  /** Only where the department on screen shows no task list: its meetings wait here instead. */
  meetings?: readonly InboxMeeting[]
  /** The company's 「使う機能」: 「知らせの設定」 lists no kind of a feature that is off. */
  features?: CompanyFeatures
  /** The bottom panel is on screen now (what the title bar's dot compares against). */
  open: boolean
  /** Every source of the rows answered once (absent: true): until then the rows count as seen, only notices are new. */
  ready?: boolean
  /** The title bar's ［受け箱］ (the same as ⌘J). */
  onToggle: () => void
  onOpenRecord: (recordId: string) => void
  onOpenTasks: () => void
  onOpenJobs: () => void
  /** The app's own cards (features/chat), composed by AppShell: the inbox only shows them in its dialog. */
  renderApprovalCard: (approvalId: string) => ReactNode
  renderMailDraft: (messageId: string) => ReactNode
  /**
   * 「ブラウザ操作」's plans, composed by AppShell only while the build's switch is on (agent-browser.md): absent =
   * no plan row and nothing read. A row opens the plan's own card (`browser-plans`); only the card acts.
   */
  browserPlans?: { list: InboxBrowserPlanList; renderCard: (planId: string) => ReactNode }
}

type OpenCard = { kind: 'approval'; id: string } | { kind: 'mail'; id: string } | { kind: 'browser'; id: string } | null

const NO_MEETINGS: readonly InboxMeeting[] = []

/**
 * The inbox (受け箱) as the bottom panel's content — its name, the chips and the list, the card dialog a row
 * opens, 「知らせの設定」 — and the title bar's ［受け箱］ (I2). Nothing while the company's records are off and it
 * has no notices (no panel, no button, ⌘J declined: never an empty frame). The chosen chip lives here, so
 * moving the panel (under the middle, or under the whole left side while a wide tab covers the middle) keeps it.
 */
export function useInboxSlot({ companyId, notices, meetings = NO_MEETINGS, features = DEFAULT_FEATURES, open: shown, ready = true, onToggle, onOpenRecord, onOpenTasks, onOpenJobs, renderApprovalCard, renderMailDraft, browserPlans }: InboxSlotInput):
  { title: string; heading: ReactNode; body: ReactNode; dialog: ReactNode; titleBarButton: ReactNode } | undefined {
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [card, setCard] = useState<OpenCard>(null)
  const [seenOpen, setSeenOpen] = useState(false)
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [settings, setSettings] = useState<{ kinds: Record<string, boolean> | null; error: string | null } | null>(null)
  // What was on screen when the inbox was last shown (memory only: AppShell is keyed by company); `fixed` once
  // every source answered or the panel was shown — before that the rows that arrive are the baseline, not news.
  const [seen, setSeen] = useState<{ keys: ReadonlySet<string>; fixed: boolean } | null>(null)
  const [beforeOpen, setBeforeOpen] = useState(false)
  const [wasShown, setWasShown] = useState(shown)
  // The plans are read again when the panel opens and when a card closes (approved or run there, or elsewhere).
  const [planReadKey, setPlanReadKey] = useState(0)
  const plans = useInboxBrowserPlans(companyId, browserPlans?.list, planReadKey)
  // Rebuilt from every answer main hands over (nothing of its own is kept); the 14-day line moves with it, and a
  // run's confirm time with the plans' own read at that time (a new answer).
  const view = useMemo(() => inboxView(notices, new Date(), meetings, plans.inbox), [notices, meetings, plans.inbox])
  const newsKeys = useMemo(() => inboxNewsKeys(view), [view])
  const shownKeys = useMemo(() => inboxNewsKeys(view, filter), [view, filter])
  const available = !!companyId && notices.available

  // Adjusted while rendering (no effect), each set only when it differs: while the panel shows, what the chosen
  // chip shows counts as seen; before every source answered (and nothing was shown) the rows are the baseline.
  if (available) {
    const baseline = new Set(inboxNewsBaseline(view))
    const allRead = ready && plans.read
    const next = shown ? { keys: seenWhileShown(seen && seen.fixed ? seen.keys : baseline, newsKeys, shownKeys), fixed: true }
      : !seen ? { keys: baseline, fixed: allRead }
      : !seen.fixed ? { keys: baseline, fixed: allRead }
      : null
    if (next && (!seen || seen.fixed !== next.fixed || !sameKeys(seen.keys, next.keys))) setSeen(next)
  }
  // The undo line is about what was just pressed: gone once the panel closes or opens again.
  if (wasShown !== shown) { setWasShown(shown); setStatus(null); if (shown) setPlanReadKey(k => k + 1) }

  if (!companyId || !available) return undefined

  const markRead = (ids: string[]) => {
    if (ids.length === 0) return
    void markNoticesRead(companyId, ids).then(r => { if (!r?.success) setError(r?.error || NOTICES_OFFLINE_TEXT) }, () => setError(NOTICES_OFFLINE_TEXT))
  }
  // Opening is what marks a row's notices seen (as the bell did); approving and sending happen on the card only.
  const openItem = (item: InboxItem) => {
    setError(null)
    setStatus(null)
    markRead(item.unreadNoticeIds)
    const a = item.action
    switch (a.kind) {
      case 'openRecord': onOpenRecord(a.recordId); break
      case 'openApprovalCard': setCard({ kind: 'approval', id: a.approvalId }); break
      case 'openMailDraft': setCard({ kind: 'mail', id: a.messageId }); break
      case 'openBrowserPlan': setCard({ kind: 'browser', id: a.planId }); break
      case 'openTasks': onOpenTasks(); break
      case 'openJobs': onOpenJobs(); break
      case 'none': break
      // Every kind is handled here; a new one (never an approve or a send: model.ts) must be added on purpose.
      default: { const unhandled: never = a; return unhandled }
    }
  }
  const undo = async (item: InboxItem) => {
    if (!item.undo) return
    setError(null)
    setStatus(null)
    const u = item.undo
    const r = u.aiChange ? await undoNoticedAiChange(companyId, u.aiChange.pluginId, u.aiChange.operationId) : await undoNoticedChange(companyId, u.recordId, u.version)
    if (r?.success) {
      setUndone(s => new Set([...s, u.noticeId]))
      // Marked seen, the row folds into 「きょう確認したもの」: this line says it was done (as the bell's row did).
      setStatus(`「${item.title}」を元に戻しました。`)
      markRead([u.noticeId])
    } else setError(r?.error ?? '元に戻せませんでした。そのあとに変わったかもしれません。')
  }
  const openSettings = async () => {
    setSettings({ kinds: null, error: null })
    const r = await getNoticeSettings(companyId)
    // Closed meanwhile: the answer must not open it again.
    setSettings(s => s && (r?.success ? { kinds: r.kinds, error: null } : { kinds: null, error: r?.error ?? '知らせの設定を読めませんでした。' }))
  }
  const switchKind = async (kind: string, on: boolean) => {
    const put = (value: boolean, err: string | null) => setSettings(s => (s?.kinds ? { kinds: { ...s.kinds, [kind]: value }, error: err } : s))
    put(on, null)
    const r = await setNoticeSetting(companyId, kind, on)
    if (!r?.success) put(!on, r?.error ?? '変えられませんでした。')
  }
  const meetingButtons = (id: string) => meetings.find(m => m.id === id)?.actions ?? []

  const closeCard = () => { setCard(null); setPlanReadKey(k => k + 1) }
  const dialog = card ? (card.kind === 'approval'
    ? <InboxCardDialog title="承認のお願い" note="一覧からは承認できません。中身・相手・いつ反映されるかを確かめてから押してください。" onClose={closeCard}>{renderApprovalCard(card.id)}</InboxCardDialog>
    : card.kind === 'browser'
    ? <InboxCardDialog title="承認のお願い（ブラウザ操作）" note="一覧からは任せられません。サイトから読み取った中身と届く時を、カードで確かめてから押してください。" onClose={closeCard}>{browserPlans?.renderCard(card.id)}</InboxCardDialog>
    : <InboxCardDialog title="送るメールの下書き" note="一覧からは送れません。宛先と中身を確かめてから送ってください。" onClose={closeCard}>{renderMailDraft(card.id)}</InboxCardDialog>)
    : settings && <NoticeSettingsDialog kinds={settings.kinds} error={settings.error} features={features} onSwitch={(k, on) => { void switchKind(k, on) }} onClose={() => setSettings(null)} />

  return {
    title: '受け箱',
    heading: <InboxChips view={view} filter={filter} onFilter={setFilter} onSettings={() => { void openSettings() }} />,
    body: <InboxList view={view} filter={filter} meetingButtons={meetingButtons} onOpen={openItem} onUndo={item => { void undo(item) }} undone={undone}
      onBulkSeen={scope => markRead(bulkSeenIds(view, scope))} seenOpen={seenOpen} onToggleSeen={() => setSeenOpen(o => !o)} beforeOpen={beforeOpen} onToggleBefore={() => setBeforeOpen(o => !o)}
      error={error} status={status} />,
    dialog,
    titleBarButton: <InboxButton waiting={view.counts.waiting} news={!shown && seen !== null && hasInboxNews(newsKeys, seen.keys)} open={shown} onToggle={onToggle} />,
  }
}
