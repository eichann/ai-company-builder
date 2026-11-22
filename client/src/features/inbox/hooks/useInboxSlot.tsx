import { useMemo, useState, type ReactNode } from 'react'
import type { NoticesState } from '../../../../shared/notifications-app'
import { markNoticesRead, undoNoticedAiChange, undoNoticedChange } from '../../notifications/api'
import { InboxChips, InboxList } from '../components/InboxList'
import { InboxCardDialog } from '../components/InboxCardDialog'
import { bulkSeenIds, inboxView, type InboxFilter, type InboxItem } from '../model'

interface InboxSlotInput {
  companyId: string | undefined
  /** What main read for the company on screen (AppShell's `useNotices`): the inbox reads nothing else. */
  notices: NoticesState
  onOpenRecord: (recordId: string) => void
  onOpenTasks: () => void
  onOpenJobs: () => void
  /** The app's own cards (features/chat), composed by AppShell: the inbox only shows them in its dialog. */
  renderApprovalCard: (approvalId: string) => ReactNode
  renderMailDraft: (messageId: string) => ReactNode
}

type OpenCard = { kind: 'approval'; id: string } | { kind: 'mail'; id: string } | null

/**
 * The inbox (受け箱, I1) as the bottom panel's content: its name, the chips and the list, plus the card
 * dialog a row opens. Nothing while the company's records are off and it has no notices (no panel,
 * no button, ⌘J declined: never an empty frame). The chosen chip lives here, so moving the panel
 * (under the middle, or under the whole left side while a wide tab covers the middle) keeps it.
 */
export function useInboxSlot({ companyId, notices, onOpenRecord, onOpenTasks, onOpenJobs, renderApprovalCard, renderMailDraft }: InboxSlotInput):
  { title: string; heading: ReactNode; body: ReactNode; dialog: ReactNode } | undefined {
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [card, setCard] = useState<OpenCard>(null)
  const [seenOpen, setSeenOpen] = useState(false)
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // Rebuilt from every answer main hands over (nothing of its own is kept); the 14-day line moves with it.
  const view = useMemo(() => inboxView(notices, new Date()), [notices])

  if (!companyId || !notices.available) return undefined

  const markRead = (ids: string[]) => {
    if (ids.length === 0) return
    void markNoticesRead(companyId, ids).then(r => { if (r && !r.success) setError(r.error) }, () => {})
  }
  // Opening is what marks a row's notices seen (as the bell does); approving and sending happen on the card only.
  const open = (item: InboxItem) => {
    setError(null)
    markRead(item.unreadNoticeIds)
    const a = item.action
    switch (a.kind) {
      case 'openRecord': onOpenRecord(a.recordId); break
      case 'openApprovalCard': setCard({ kind: 'approval', id: a.approvalId }); break
      case 'openMailDraft': setCard({ kind: 'mail', id: a.messageId }); break
      case 'openTasks': onOpenTasks(); break
      case 'openJobs': onOpenJobs(); break
      case 'none': break
    }
  }
  const undo = async (item: InboxItem) => {
    if (!item.undo) return
    setError(null)
    const u = item.undo
    const r = u.aiChange ? await undoNoticedAiChange(companyId, u.aiChange.pluginId, u.aiChange.operationId) : await undoNoticedChange(companyId, u.recordId, u.version)
    if (r?.success) {
      setUndone(s => new Set([...s, item.key]))
      markRead([u.noticeId])
    } else setError(r?.error ?? '元に戻せませんでした。そのあとに変わったかもしれません。')
  }

  const dialog = card && (card.kind === 'approval'
    ? <InboxCardDialog title="承認のお願い" note="一覧からは承認できません。中身・相手・いつ反映されるかを確かめてから押してください。" onClose={() => setCard(null)}>{renderApprovalCard(card.id)}</InboxCardDialog>
    : <InboxCardDialog title="送るメールの下書き" note="一覧からは送れません。宛先と中身を確かめてから送ってください。" onClose={() => setCard(null)}>{renderMailDraft(card.id)}</InboxCardDialog>)

  return {
    title: '受け箱',
    heading: <InboxChips view={view} filter={filter} onFilter={setFilter} />,
    body: <InboxList view={view} filter={filter} onOpen={open} onUndo={item => { void undo(item) }} undone={undone}
      onBulkSeen={scope => markRead(bulkSeenIds(view, scope))} seenOpen={seenOpen} onToggleSeen={() => setSeenOpen(o => !o)} error={error} />,
    dialog,
  }
}
