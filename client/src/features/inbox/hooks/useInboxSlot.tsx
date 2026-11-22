import { useMemo, useState, type ReactNode } from 'react'
import { NOTICES_OFFLINE_TEXT, type MeetingTurn, type NoticesState } from '../../../../shared/notifications-app'
import { DEFAULT_FEATURES, type CompanyFeatures } from '../../../../../shared/core/features'
import { getNoticeSettings, markNoticesRead, setNoticeSetting, undoNoticedAiChange, undoNoticedChange } from '../../notifications/api'
import { InboxChips, InboxList, type InboxRowButton } from '../components/InboxList'
import { InboxCardDialog } from '../components/InboxCardDialog'
import { InboxButton } from '../components/InboxButton'
import { NoticeSettingsDialog } from '../components/NoticeSettingsDialog'
import { bulkSeenIds, hasInboxNews, inboxNewsBaseline, inboxNewsKeys, inboxView, type InboxFilter, type InboxItem } from '../model'

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
  /** The title bar's ［受け箱］ (the same as ⌘J). */
  onToggle: () => void
  onOpenRecord: (recordId: string) => void
  onOpenTasks: () => void
  onOpenJobs: () => void
  /** The app's own cards (features/chat), composed by AppShell: the inbox only shows them in its dialog. */
  renderApprovalCard: (approvalId: string) => ReactNode
  renderMailDraft: (messageId: string) => ReactNode
}

type OpenCard = { kind: 'approval'; id: string } | { kind: 'mail'; id: string } | null

const NO_MEETINGS: readonly InboxMeeting[] = []

/**
 * The inbox (受け箱) as the bottom panel's content — its name, the chips and the list, the card dialog a row
 * opens, 「知らせの設定」 — and the title bar's ［受け箱］ (I2). Nothing while the company's records are off and it
 * has no notices (no panel, no button, ⌘J declined: never an empty frame). The chosen chip lives here, so
 * moving the panel (under the middle, or under the whole left side while a wide tab covers the middle) keeps it.
 */
export function useInboxSlot({ companyId, notices, meetings = NO_MEETINGS, features = DEFAULT_FEATURES, open: shown, onToggle, onOpenRecord, onOpenTasks, onOpenJobs, renderApprovalCard, renderMailDraft }: InboxSlotInput):
  { title: string; heading: ReactNode; body: ReactNode; dialog: ReactNode; titleBarButton: ReactNode } | undefined {
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [card, setCard] = useState<OpenCard>(null)
  const [seenOpen, setSeenOpen] = useState(false)
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [settings, setSettings] = useState<{ kinds: Record<string, boolean> | null; error: string | null } | null>(null)
  // What was on screen when the inbox was last shown (memory only: AppShell is keyed by company).
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null)
  // Rebuilt from every answer main hands over (nothing of its own is kept); the 14-day line moves with it.
  const view = useMemo(() => inboxView(notices, new Date(), meetings), [notices, meetings])
  const newsKeys = useMemo(() => inboxNewsKeys(view), [view])
  const available = !!companyId && notices.available

  // Adjusted while rendering (no effect): the first answer sets what counts as seen; while the panel shows, exactly
  // what is on it is (a row that left and comes back after the panel closed is new again).
  if (available && seen === null) setSeen(new Set(shown ? newsKeys : inboxNewsBaseline(view)))
  else if (available && seen && shown && (hasInboxNews(newsKeys, seen) || seen.size !== newsKeys.length)) setSeen(new Set(newsKeys))

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
      setUndone(s => new Set([...s, item.key]))
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

  const dialog = card ? (card.kind === 'approval'
    ? <InboxCardDialog title="承認のお願い" note="一覧からは承認できません。中身・相手・いつ反映されるかを確かめてから押してください。" onClose={() => setCard(null)}>{renderApprovalCard(card.id)}</InboxCardDialog>
    : <InboxCardDialog title="送るメールの下書き" note="一覧からは送れません。宛先と中身を確かめてから送ってください。" onClose={() => setCard(null)}>{renderMailDraft(card.id)}</InboxCardDialog>)
    : settings && <NoticeSettingsDialog kinds={settings.kinds} error={settings.error} features={features} onSwitch={(k, on) => { void switchKind(k, on) }} onClose={() => setSettings(null)} />

  return {
    title: '受け箱',
    heading: <InboxChips view={view} filter={filter} onFilter={setFilter} onSettings={() => { void openSettings() }} />,
    body: <InboxList view={view} filter={filter} meetingButtons={meetingButtons} onOpen={openItem} onUndo={item => { void undo(item) }} undone={undone}
      onBulkSeen={scope => markRead(bulkSeenIds(view, scope))} seenOpen={seenOpen} onToggleSeen={() => setSeenOpen(o => !o)} error={error} status={status} />,
    dialog,
    titleBarButton: <InboxButton waiting={view.counts.waiting} news={!shown && seen !== null && hasInboxNews(newsKeys, seen)} open={shown} onToggle={onToggle} />,
  }
}
