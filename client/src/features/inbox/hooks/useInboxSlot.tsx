import { useMemo, useState, type ReactNode } from 'react'
import { NOTICES_OFFLINE_TEXT, type MeetingNewsRow, type NoticesState } from '../../../../shared/notifications-app'
import { DEFAULT_FEATURES, type CompanyFeatures } from '../../../../../shared/core/features'
import { getNoticeSettings, markNoticesRead, setNoticeSetting, undoNoticedAiChange, undoNoticedChange } from '../../notifications/api'
import { InboxChips, InboxList, type InboxRowButton } from '../components/InboxList'
import { InboxCardDialog } from '../components/InboxCardDialog'
import { InboxButton } from '../components/InboxButton'
import { NoticeSettingsDialog } from '../components/NoticeSettingsDialog'
import { hasFullAccessIn, readContact, type ContactReads, type ContactWrites } from '../api'
import { useInboxBrowserPlans, type InboxBrowserPlanList, type InboxPlanStates } from './useInboxBrowserPlans'
import { useContacts } from './useContacts'
import { ContactCard } from '../components/ContactCard'
import { CONTACT_ROW_READS, createContactStore, shownView } from '../contactStore'
import { contactsToRead, inboxView, settingsAfterSwitch, type InboxFilter, type InboxItem, type NoticeSettingsState } from '../model'
import { CONTACT_NAME } from '../../../../shared/thing-words'

interface InboxSlotInput {
  companyId: string | undefined
  /** What main read for the company on screen (AppShell's `useNotices`): the inbox reads nothing else. */
  notices: NoticesState
  /** The meetings of the last days as rows, with their buttons (the minutes feature's `inboxMeetings`). */
  meetings?: readonly MeetingNewsRow[]
  /** A finished meeting's 「読み終わりました」 was looked at here (the minutes feature keeps it on this PC). */
  onMeetingSeen?: (meetingId: string) => void
  /** Said above 新着 while there are meetings (the minutes feature's 「自動で読む」 suggestion). */
  meetingNote?: ReactNode
  /** The company's 「使う機能」: 「知らせの設定」 lists no kind of a feature that is off. */
  features?: CompanyFeatures
  /** The bottom panel is on screen now. */
  open: boolean
  /** The title bar's ［受け箱］ (the same as ⌘J). */
  onToggle: () => void
  onOpenRecord: (recordId: string) => void
  onOpenTasks: () => void
  onOpenJobs: () => void
  /** The app's own cards (features/chat), composed by AppShell: the inbox only shows them in its dialog. */
  renderApprovalCard: (approvalId: string) => ReactNode
  renderMailDraft: (messageId: string) => ReactNode
  /**
   * 「ブラウザ操作」's plans, composed by AppShell with a company open; main's list answers empty while the switch is
   * off on this PC (agent-browser.md "This PC's opt-in"). Absent = no plan row and nothing read. A row opens the plan's own card (`browser-plans`); only the card acts.
   */
  browserPlans?: { list: InboxBrowserPlanList; renderCard: (planId: string) => ReactNode; planStates: InboxPlanStates }
  /** The first day (`INBOX_NEWS_SINCE`); only a preview on a fixed clock before it hands another. */
  newsSince?: string
  /** A member's name for 「連絡」1枚's 「田中さんが返します」 (the task list's names, through AppShell); absent = 「ほかの人」. */
  memberName?: (memberId: string) => string | null
  /** 「連絡」1枚's ports (a preview hands fakes); absent = the main process. */
  contactPorts?: { reads?: ContactReads; writes?: ContactWrites }
}

type OpenCard = { kind: 'approval'; id: string } | { kind: 'mail'; id: string } | { kind: 'browser'; id: string } | { kind: 'contact'; id: string; readKey: string } | null

const NO_MEETINGS: readonly MeetingNewsRow[] = []

/**
 * The inbox (受け箱) as the bottom panel's content — its name, the chips and the list, the card dialog a row opens,
 * 「知らせの設定」 — and the title bar's ［受け箱］. Nothing while the company's records are off and it has no notices (no
 * panel, no button, ⌘J declined: never an empty frame). The chosen chip lives here, so moving the panel keeps it.
 */
export function useInboxSlot({ companyId, notices, meetings = NO_MEETINGS, onMeetingSeen, meetingNote, features = DEFAULT_FEATURES, open: shown, onToggle, onOpenRecord, onOpenTasks, onOpenJobs, renderApprovalCard, renderMailDraft, browserPlans, newsSince, memberName, contactPorts }: InboxSlotInput):
  { title: string; heading: ReactNode; body: ReactNode; dialog: ReactNode; titleBarButton: ReactNode } | undefined {
  const [filter, setFilter] = useState<InboxFilter>('new')
  const [card, setCard] = useState<OpenCard>(null)
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [settings, setSettings] = useState<NoticeSettingsState | null>(null)
  const [wasShown, setWasShown] = useState(shown)
  // The plans are read again when the panel opens and when a card closes (approved or run there, or elsewhere).
  const [planReadKey, setPlanReadKey] = useState(0)
  const plans = useInboxBrowserPlans(companyId, browserPlans?.list, planReadKey, browserPlans?.planStates)
  // 「連絡」1枚: the contacts the notices name, read into one store the rows and the card share (memory only).
  const contactReads = contactPorts?.reads
  const [contacts] = useState(() => createContactStore((c, id) => readContact(c, id, contactReads)))
  const contactsShown = useContacts(contacts, companyId, useMemo(() => contactsToRead(notices, CONTACT_ROW_READS), [notices]))
  // Rebuilt from every answer main hands over (nothing of its own is kept but the contacts' last answers).
  const view = useMemo(() => inboxView(notices, meetings, plans.inbox, newsSince, id => shownView(contactsShown.get(id))),
    [notices, meetings, plans.inbox, newsSince, contactsShown])
  const available = !!companyId && notices.available

  // The undo line is about what was just pressed: gone once the panel closes or opens again.
  if (wasShown !== shown) { setWasShown(shown); setStatus(null); if (shown) setPlanReadKey(k => k + 1) }

  if (!companyId || !available) return undefined

  const markRead = (ids: string[]) => {
    if (ids.length === 0) return
    void markNoticesRead(companyId, ids).then(r => { if (!r?.success) setError(r?.error || NOTICES_OFFLINE_TEXT) }, () => setError(NOTICES_OFFLINE_TEXT))
  }
  /** Looked at: its notices read on the server (every PC agrees), a finished meeting's news on this PC. */
  const seeRow = (item: InboxItem) => {
    markRead(item.unreadNoticeIds)
    if (item.meetingNews && item.meetingId) onMeetingSeen?.(item.meetingId)
  }
  // Opening marks a 新着 row seen (as the bell did); a stop of あなた待ち stays until ［済んだ］ or the server settles it.
  const openItem = (item: InboxItem) => {
    setError(null)
    setStatus(null)
    if (!item.stop) seeRow(item)
    const a = item.action
    switch (a.kind) {
      case 'openRecord': onOpenRecord(a.recordId); break
      case 'openApprovalCard': setCard({ kind: 'approval', id: a.approvalId }); break
      case 'openMailDraft': setCard({ kind: 'mail', id: a.messageId }); break
      case 'openBrowserPlan': setCard({ kind: 'browser', id: a.planId }); break
      // Each opening reads the contact again (the card shows what is true now before anything is pressed).
      case 'openContact': setCard({ kind: 'contact', id: a.contactId, readKey: `open${Date.now()}` }); break
      case 'openTasks': onOpenTasks(); break
      case 'openJobs': onOpenJobs(); break
      case 'none': break
      // Every kind is handled here; a new one (never an approve or a send: model.ts) must be added on purpose.
      default: { const unhandled: never = a; return unhandled }
    }
  }
  // A row's own button (［AI に読ませる］, ［読まない］…) is the member acting on it: its news is seen too.
  const pressButton = (item: InboxItem, button: InboxRowButton) => {
    setError(null)
    if (!item.stop) markRead(item.unreadNoticeIds)
    button.run()
  }
  const allSeen = () => {
    setError(null)
    markRead(view.newsNoticeIds)
    for (const id of view.newsMeetingIds) onMeetingSeen?.(id)
  }
  const undo = async (item: InboxItem) => {
    if (!item.undo) return
    setError(null)
    setStatus(null)
    const u = item.undo
    const r = u.aiChange ? await undoNoticedAiChange(companyId, u.aiChange.pluginId, u.aiChange.operationId) : await undoNoticedChange(companyId, u.recordId, u.version)
    if (r?.success) {
      setUndone(s => new Set([...s, u.noticeId]))
      // Marked seen, the row goes to 「確認したもの」: this line says it was done (as the bell's row did).
      setStatus(`「${item.title}」を元に戻しました。`)
      markRead([u.noticeId])
    } else setError(r?.error ?? '元に戻せませんでした。そのあとに変わったかもしれません。')
  }
  const openSettings = async () => {
    setSettings({ kinds: null, error: null })
    // The member's role decides whether the owner / admin-only kinds are offered (not known → not offered).
    const [r, fullAccess] = await Promise.all([getNoticeSettings(companyId), hasFullAccessIn(companyId)])
    // Closed meanwhile: the answer must not open it again.
    setSettings(s => s && (r?.success ? { kinds: r.kinds, error: null, fullAccess } : { kinds: null, error: r?.error ?? '知らせの設定を読めませんでした。' }))
  }
  const switchKind = async (kind: string, on: boolean) => {
    const put = (value: boolean, err: string | null) => setSettings(s => settingsAfterSwitch(s, kind, value, err))
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
    : card.kind === 'contact'
    ? <InboxCardDialog title={CONTACT_NAME} note="来た連絡と、その返事・生まれたやることを一緒に見られます。" onClose={closeCard}>
        <ContactCard companyId={companyId} contactId={card.id} store={contacts} readKey={card.readKey} writes={contactPorts?.writes} nameOf={memberName}
          onOpenTask={id => { setCard(null); onOpenRecord(id) }} onOpenRecord={id => { setCard(null); onOpenRecord(id) }}
          onCheckDraft={id => setCard({ kind: 'mail', id })} />
      </InboxCardDialog>
    : <InboxCardDialog title="送るメールの下書き" note="一覧からは送れません。宛先と中身を確かめてから送ってください。" onClose={closeCard}>{renderMailDraft(card.id)}</InboxCardDialog>)
    : settings && <NoticeSettingsDialog kinds={settings.kinds} error={settings.error} features={features} fullAccess={settings.fullAccess ?? null} onSwitch={(k, on) => { void switchKind(k, on) }} onClose={() => setSettings(null)} />

  return {
    title: '受け箱',
    heading: <InboxChips view={view} filter={filter} onFilter={setFilter} onSettings={() => { void openSettings() }} />,
    body: <InboxList view={view} filter={filter} meetingButtons={meetingButtons} onOpen={openItem} onSeen={item => { setError(null); seeRow(item) }} onButton={pressButton}
      onUndo={item => { void undo(item) }} undone={undone} onAllSeen={allSeen} meetingNote={meetingNote} error={error} status={status} />,
    dialog,
    titleBarButton: <InboxButton news={view.counts.news} waiting={view.counts.waiting} open={shown} onToggle={onToggle} />,
  }
}
