// The inbox's slot: the chips, the list worked through and the card beside it, and 「知らせの設定」. Over ~300 lines on
// purpose: what opening a row does (read, kept in place, beside or in the middle, the next after a card's press) is one
// sequence that reads the same state, and splitting it would pass that state around.
import { useMemo, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { NOTICES_OFFLINE_TEXT, type MeetingNewsRow, type NoticesState } from '../../../../shared/notifications-app'
import { DEFAULT_FEATURES, type CompanyFeatures } from '../../../../../shared/core/features'
import { getNoticeSettings, markNoticesRead, refreshNotices, setNoticeSetting, undoNoticedAiChange, undoNoticedChange } from '../../notifications/api'
import { InboxChips, InboxList, KindChips, type InboxRowButton } from '../components/InboxList'
import { InboxButton } from '../components/InboxButton'
import { NoticeSettingsDialog } from '../components/NoticeSettingsDialog'
import { hasFullAccessIn, readContact, type ContactReads, type ContactWrites } from '../api'
import { useInboxBrowserPlans, type InboxBrowserPlanList, type InboxPlanStates } from './useInboxBrowserPlans'
import { useContacts } from './useContacts'
import { ContactCard } from '../components/ContactCard'
import { CONTACT_ROW_READS, createContactStore, rowContact } from '../contactStore'
import { contactsToRead, inboxView, settingsAfterSwitch, type InboxFilter, type InboxItem, type NoticeSettingsState } from '../model'
import { CONTACT_NAME } from '../../../../shared/thing-words'
import { besideCardOf, INBOX_PAGE, kindCounts, limitShowing, narrowed, orderOf, paged, sectionsOf, type BesideCard, type InboxKind } from '../workModel'
import { useWorkThrough } from '../../../shared/hooks/useWorkThrough'
import { WorkThroughBar, WorkThroughNotice } from '../../../shared/ui/WorkThrough'
import { commandArea } from '../../../shared/commands/commands'
import type { WorkUndoAnswer } from '../../../shared/lib/workThrough'
import { finishBeside, INBOX_WORK_KEY, openBeside, type Beside } from '../besideDone'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { useEventListener } from '../../../shared/hooks/useEventListener'

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
  /**
   * The app's own cards (features/chat), composed by AppShell: the inbox only shows them beside its list. `onDone`: a
   * press on the card finished it there (approved, sent…), so the inbox goes on to the next row.
   */
  renderApprovalCard: (approvalId: string, onDone: () => void) => ReactNode
  renderMailDraft: (messageId: string, onDone: () => void) => ReactNode
  /**
   * 「ブラウザ操作」's plans, composed by AppShell with a company open; main's list answers empty while the switch is
   * off on this PC (agent-browser.md "This PC's opt-in"). Absent = no plan row and nothing read. A row opens the plan's own card (`browser-plans`); only the card acts.
   */
  browserPlans?: { list: InboxBrowserPlanList; renderCard: (planId: string, onDone: () => void) => ReactNode; planStates: InboxPlanStates }
  /** The first day (`INBOX_NEWS_SINCE`); only a preview on a fixed clock before it hands another. */
  newsSince?: string
  /** A member's name for 「連絡」1枚's 「田中さんが返します」 (the task list's names, through AppShell); absent = 「ほかの人」. */
  memberName?: (memberId: string) => string | null
  /** 「連絡」1枚's ports (a preview hands fakes); absent = the main process. */
  contactPorts?: { reads?: ContactReads; writes?: ContactWrites }
}

const BESIDE_WORDS: Record<BesideCard['kind'], { title: string; note: string }> = {
  approval: { title: '承認のお願い', note: '一覧からは承認できません。中身・相手・いつ反映されるかを確かめてから押してください。' },
  browser: { title: '承認のお願い（ブラウザ操作）', note: '一覧からは任せられません。サイトから読み取った中身と届く時を、カードで確かめてから押してください。' },
  contact: { title: CONTACT_NAME, note: '来た連絡と、その返事・生まれたやることを一緒に見られます。' },
  mail: { title: '送るメールの下書き', note: '一覧からは送れません。宛先と中身を確かめてから送ってください。' },
}

const NO_MEETINGS: readonly MeetingNewsRow[] = []

/**
 * The inbox (受け箱) as the bottom panel's content — its name, the chips, the list worked through (↑ ↓ Enter Esc, 15 rows
 * first) with the card a row opens beside it, 「知らせの設定」 — and the title bar's ［受け箱］. Nothing while the company's
 * records are off and it has no notices (no panel, no button, ⌘J declined: never an empty frame). The chosen chip lives
 * here, so moving the panel keeps it.
 */
export function useInboxSlot({ companyId, notices, meetings = NO_MEETINGS, onMeetingSeen, meetingNote, features = DEFAULT_FEATURES, open: shown, onToggle, onOpenRecord, onOpenTasks, onOpenJobs, renderApprovalCard, renderMailDraft, browserPlans, newsSince, memberName, contactPorts }: InboxSlotInput):
  { title: string; heading: ReactNode; body: ReactNode; dialog: ReactNode; titleBarButton: ReactNode } | undefined {
  const [filter, setFilter] = useState<InboxFilter>('new')
  const [kind, setKind] = useState<InboxKind>('all')
  const [limit, setLimit] = useState(INBOX_PAGE)
  // 新着 opened in this look, kept in their place until the chips change or the panel opens again (decision 11番-3).
  const [lingering, setLingering] = useState<ReadonlySet<string>>(new Set())
  const [beside, setBeside] = useState<Beside | null>(null)
  // The row opened last (beside or in the middle): where ↑ ↓ go on from.
  const [shownKey, setShownKey] = useState<string | null>(null)
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
  // A contact gone (not the member's to read now): the notices on screen were read before that, so main reads them again.
  const [contacts] = useState(() => createContactStore((c, id) => readContact(c, id, contactReads), undefined, c => refreshNotices(c)))
  // A contact not read (offline) is asked again only when the PC is back online or the panel opens again (never on a timer).
  const [contactsAgain, setContactsAgain] = useState(0)
  useEventListener(window, 'online', () => setContactsAgain(k => k + 1))
  const contactsShown = useContacts(contacts, companyId, useMemo(() => contactsToRead(notices, CONTACT_ROW_READS), [notices]), contactsAgain)
  // Rebuilt from every answer main hands over (nothing of its own is kept but the contacts' last answers).
  const view = useMemo(() => inboxView(notices, meetings, plans.inbox, newsSince, id => rowContact(contactsShown.get(id))),
    [notices, meetings, plans.inbox, newsSince, contactsShown])
  const available = !!companyId && notices.available

  // What this look shows: the chip's sections with the opened 新着 kept, narrowed to the kind, the first `limit` rows drawn.
  const sections = sectionsOf(view, filter, lingering)
  const kindCount = kindCounts(sections)
  const rows = narrowed(sections, kind)
  const order = orderOf(rows)
  const drawn = paged(rows, limit)
  const totals = { waiting: rows.waiting.length, news: rows.news.filter(i => !i.seenHere).length, seen: rows.seen.length }
  const rowOf = (key: string) => [...rows.waiting, ...rows.news, ...rows.moving, ...rows.seen].find(i => i.key === key)
  const work = useWorkThrough({ listKey: INBOX_WORK_KEY, shownId: shownKey, open: key => { const item = rowOf(key); if (item) openItem(item) } })
  const besideNow = useLatestRef(beside)

  /** A new look (another chip or kind, the panel opened again): the opened 新着 go where they belong, 15 rows again. */
  const newLook = () => { setLingering(new Set()); setLimit(INBOX_PAGE) }
  // The undo line is about what was just pressed: gone once the panel closes or opens again.
  if (wasShown !== shown) { setWasShown(shown); setStatus(null); newLook(); setBeside(null); if (shown) { setPlanReadKey(k => k + 1); setContactsAgain(k => k + 1) } }

  /** Looked at: its notices read on the server (every PC agrees), a finished meeting's news on this PC. */
  const markRead = (ids: string[]) => {
    if (ids.length === 0 || !companyId) return
    void markNoticesRead(companyId, ids).then(r => { if (!r?.success) setError(r?.error || NOTICES_OFFLINE_TEXT) }, () => setError(NOTICES_OFFLINE_TEXT))
  }
  const seeRow = (item: InboxItem) => {
    markRead(item.unreadNoticeIds)
    if (item.meetingNews && item.meetingId) onMeetingSeen?.(item.meetingId)
  }
  // Opening marks a 新着 row seen (as the bell did) and keeps it where it is; a stop of あなた待ち stays until ［済んだ］ or
  // the server settles it. A card opens beside the list; anything else where it lives (the middle, the settings).
  function openItem(item: InboxItem) {
    setError(null)
    setStatus(null)
    if (!item.stop) seeRow(item)
    if (item.section === 'new' && !item.seenHere) setLingering(m => new Set(m).add(item.key))
    setShownKey(item.key)
    // A row past the drawn ones (↓ from the last): drawn now, so the list can move the focus onto it at once.
    const needed = limitShowing(order, item.key, limit)
    if (needed > limit) flushSync(() => setLimit(needed))
    const card = besideCardOf(item)
    // Each opening reads a contact again (the card shows what is true now before anything is pressed).
    setBeside(card ? openBeside(card, { rowKey: item.key, title: item.title, readKey: `open${Date.now()}`, at: Math.max(0, order.indexOf(item.key)) }) : null)
    const a = item.action
    switch (a.kind) {
      case 'openRecord': onOpenRecord(a.recordId); break
      case 'openTasks': onOpenTasks(); break
      case 'openJobs': onOpenJobs(); break
      // Beside the list (`besideCardOf`): only the card's own buttons act.
      case 'openApprovalCard': case 'openMailDraft': case 'openBrowserPlan': case 'openContact': break
      case 'none': break
      // Every kind is handled here; a new one (never an approve or a send: model.ts) must be added on purpose.
      default: { const unhandled: never = a; return unhandled }
    }
  }

  if (!companyId || !available) return undefined

  /**
   * The one way every card beside the list (approval, mail, browser plan, 連絡) tells the list it was finished there
   * (`finishBeside`: the next row, or nothing in another company era than the card's).
   */
  const doneOf = (done: Beside) => (undo?: () => Promise<WorkUndoAnswer>) => finishBeside(done, undo, {
    ended: work.ended, show: work.show, current: () => besideNow.current, close: () => setBeside(null), readPlansAgain: () => setPlanReadKey(k => k + 1),
  })
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
  const switchKind = async (noticeKind: string, on: boolean) => {
    const put = (value: boolean, err: string | null) => setSettings(s => settingsAfterSwitch(s, noticeKind, value, err))
    put(on, null)
    const r = await setNoticeSetting(companyId, noticeKind, on)
    if (!r?.success) put(!on, r?.error ?? '変えられませんでした。')
  }
  const meetingButtons = (id: string) => meetings.find(m => m.id === id)?.actions ?? []
  const chooseFilter = (f: InboxFilter) => { setFilter(f); newLook() }
  const chooseKind = (k: InboxKind) => { setKind(k); newLook() }
  const closeBeside = () => { setBeside(null); setPlanReadKey(k => k + 1) }

  const onDone = beside && doneOf(beside)
  const besideCard = beside && onDone && (beside.kind === 'approval'
    ? renderApprovalCard(beside.id, () => onDone())
    : beside.kind === 'browser'
    ? browserPlans?.renderCard(beside.id, () => onDone())
    : beside.kind === 'contact'
    ? <ContactCard key={beside.id} companyId={companyId} contactId={beside.id} store={contacts} readKey={beside.readKey} writes={contactPorts?.writes} reads={contactPorts?.reads} nameOf={memberName}
        onOpenTask={id => { setBeside(null); onOpenRecord(id) }} onOpenRecord={id => { setBeside(null); onOpenRecord(id) }}
        onCheckDraft={id => setBeside({ ...beside, kind: 'mail', id })}
        onFinished={u => onDone(u ?? undefined)} />
    : renderMailDraft(beside.id, () => onDone()))
  const words = beside ? BESIDE_WORDS[beside.kind] : null
  // The card beside the list (owner decision 2026-11-28, 11番): 「3 / 11」, ［前の件］［次の件］ and ［閉じる］ over it.
  const besidePane = beside && words && (
    <section aria-label={words.title} data-work-card={INBOX_WORK_KEY} data-inbox-beside={beside.kind} tabIndex={-1} {...commandArea('list', INBOX_WORK_KEY)}
      className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
      <WorkThroughBar position={beside.rowKey ? work.position : null} onStep={work.step} onClose={closeBeside} />
      <p className="flex-shrink-0 px-3 pt-2 text-small text-text-muted">{words.note}</p>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 pt-2">{besideCard}</div>
    </section>
  )

  const dialog = settings && <NoticeSettingsDialog kinds={settings.kinds} error={settings.error} features={features} fullAccess={settings.fullAccess ?? null} onSwitch={(k, on) => { void switchKind(k, on) }} onClose={() => setSettings(null)} />

  return {
    title: '受け箱',
    heading: <InboxChips filter={filter} seenCount={view.counts.seen} onFilter={chooseFilter} onSettings={() => { void openSettings() }} />,
    body: (
      <div className="flex h-full min-h-0">
        <div className={`flex min-h-0 min-w-0 flex-col ${besidePane ? 'w-2/5 flex-shrink-0 border-r border-[color:var(--color-border)]' : 'flex-1'}`}>
          <div className="flex-shrink-0 border-b border-[color:var(--color-border)] bg-bg"><KindChips kind={kind} counts={kindCount} onKind={chooseKind} /></div>
          <div className="min-h-0 flex-1 overflow-auto">
            <InboxList sections={drawn.sections} totals={totals} redCount={kind === 'all'} filter={filter} elsewhere={view.counts.elsewhere} onOpenTasks={onOpenTasks}
              turnNotListed={view.turnNotListed} unreadNotListed={view.unreadNotListed}
              more={{ left: drawn.left, onMore: () => setLimit(l => l + INBOX_PAGE) }}
              work={{ listKey: INBOX_WORK_KEY, order, currentKey: beside?.rowKey ?? null }} notice={<WorkThroughNotice listKey={INBOX_WORK_KEY} />}
              meetingButtons={meetingButtons} onOpen={item => work.show(item.key)} onSeen={item => { setError(null); seeRow(item) }} onButton={pressButton}
              onUndo={item => { void undo(item) }} undone={undone} onAllSeen={allSeen} meetingNote={meetingNote} error={error} status={status} />
          </div>
        </div>
        {besidePane}
      </div>
    ),
    dialog,
    titleBarButton: <InboxButton news={view.counts.news} waiting={view.counts.waiting} open={shown} onToggle={onToggle} />,
  }
}
