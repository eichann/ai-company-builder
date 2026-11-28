import { useRef, useState } from 'react'
import { ArrowCounterClockwise, CheckSquare, Square } from '@phosphor-icons/react'
import { Button, StatusBadge, type StatusBadgeVariant } from '../../../shared/ui/primitives'
import { MoreMenu } from '../../../shared/ui/MoreMenu'
import { InputDialog } from '../../../shared/ui/InputDialog'
import { CALM, NEXT_STEP } from '../../../../shared/thing-words'
import { contactMailStaysArchived, finishContact, undoContactFinish, type ContactReads, type ContactWrites } from '../api'
import { contactLook, finishRequestOf, type ContactButton, type ContactTone } from '../contactModel'
import { pressFinish, pressUndo, type ContactResend, type ContactSaid } from '../contactPress'
import type { ContactStore, EraPort } from '../contactStore'
import { useContacts } from '../hooks/useContacts'

interface Props {
  companyId: string
  /** The contact's interaction (or a 返事のお願い of it). */
  contactId: string
  /** The inbox's store: the card and the contact's row read the same answer. */
  store: ContactStore
  /** Read again each time it changes (the card opened). */
  readKey: string
  writes?: ContactWrites
  /** Whether the mail stays archived in Gmail after ［取り消す］ (the contact's ledger). */
  reads?: ContactReads
  /** A member's name (the task list's), null when not known. */
  nameOf?: (memberId: string) => string | null
  onOpenTask: (taskId: string) => void
  /** ［下書きを確かめて送る］: the draft's own card (only it sends). */
  onCheckDraft: (draftId: string) => void
  /** ［詳しく見る］: the 来た連絡's record card (who, where, 経緯). */
  onOpenRecord: (recordId: string) => void
  era?: EraPort
}

const TONE: Record<ContactTone, StatusBadgeVariant> = { info: 'info', ai: 'ai', neutral: 'neutral', success: 'success' }

/**
 * 「連絡」1枚 (inbox.md "One contact", owner decision 2026-11-28 「5番」): a 来た連絡 and its 返事のお願い as one card — the state
 * in one line, the reply (who, by when, the draft), the やること made from it, and one main button that ends the reply and
 * the contact together (both or neither: the server's). Only the buttons the server says the member may press are shown.
 * Knows no frame: it is drawn wherever it is placed (the inbox's card window today, the 連絡 destination later).
 */
export function ContactCard({ companyId, contactId, store, readKey, writes, reads, nameOf, onOpenTask, onCheckDraft, onOpenRecord, era }: Props) {
  const entry = useContacts(store, companyId, [`${contactId}@${readKey}`]).get(contactId)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<ContactSaid | null>(null)
  const [asking, setAsking] = useState<Extract<ContactButton, { kind: 'finish' }> | null>(null)
  // Two clicks before the next draw are one press (the state above is the draw's).
  const pressing = useRef(false)

  if (!entry) return <p className="text-small text-text-muted">{CALM.loading}</p>
  if (entry.kind === 'gone') return <p className="text-small text-text-muted">この連絡は見つからないか、見られなくなりました。</p>
  if (entry.kind === 'failed') return <p role="alert" className="text-small text-danger-text">{entry.error}</p>
  const view = entry.view
  const look = contactLook(view, nameOf)
  const reread = () => store.refresh(companyId, contactId)

  const run = async (work: () => Promise<void>) => {
    if (pressing.current) return
    pressing.current = true
    setBusy(true)
    try { await work() } finally { pressing.current = false; setBusy(false) }
  }
  const send = (press: ContactResend) => run(async () => {
    setSaid(null)
    await pressFinish(req => finishContact(companyId, view.interaction.id, req, writes), press, { era, say: setSaid, reread })
  })
  const finish = (b: Extract<ContactButton, { kind: 'finish' }>, note?: string) => {
    const request = finishRequestOf(view, b, note)
    if (!request) return
    const hadDrafts = (view.replyRequests.find(r => r.id === b.replyId)?.drafts.length ?? 0) > 0
    return send({ request, end: b.end, hadDrafts })
  }
  const undo = () => run(async () => {
    if (!said?.undo) return
    // At the versions the finish answered (`undoRequestOf`): a change made in between refuses it on the server.
    await pressUndo(req => undoContactFinish(companyId, view.interaction.id, req, writes), said.undo, {
      era, say: setSaid, reread, stillArchived: after => contactMailStaysArchived(companyId, view.interaction.id, after, reads),
    })
  })
  const press = (b: ContactButton) => {
    if (b.kind === 'checkDraft') onCheckDraft(b.draftId)
    else if (b.asksReason) setAsking(b)
    else void finish(b)
  }

  return (
    <div data-contact-card={view.interaction.id} className="flex flex-col gap-3 text-body text-text">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-title font-strong">{view.interaction.title}</h3>
        <StatusBadge variant={TONE[look.status.tone]}>{look.status.word}</StatusBadge>
      </div>

      {(look.reply || look.others.length > 0) && (
        <section aria-label="返事" className="flex flex-col gap-1">
          <h4 className="text-small font-strong text-text-muted">返事</h4>
          {look.reply && look.reply.lines.length > 0 && <p className="text-small text-text">{look.reply.lines.join('・')}</p>}
          {look.others.map(line => <p key={line} className="text-small text-text-muted">{line}</p>)}
        </section>
      )}

      {(look.main || look.menu.length > 0 || said) && (
        <div className="flex flex-wrap items-center gap-2">
          {look.main && <Button variant="primary" disabled={busy} title={look.main.hint} onClick={() => press(look.main!)}>{look.main.label}</Button>}
          {look.menu.length > 0 && <MoreMenu items={look.menu.map(b => ({ label: b.label, hint: b.hint, onClick: () => { if (!busy) press(b) } }))} />}
          {said?.undo && (
            <Button variant="secondary" disabled={busy} onClick={() => { void undo() }}><ArrowCounterClockwise size={12} aria-hidden />{NEXT_STEP.undoFinish}</Button>
          )}
          {said?.resend && <Button variant="secondary" disabled={busy} onClick={() => { void send(said.resend!) }}>もう一度送る</Button>}
        </div>
      )}
      {said && <p role={said.refused ? 'alert' : 'status'} className={`text-small ${said.refused ? 'text-danger-text' : 'text-success-text'}`}>{said.text}</p>}

      {look.tasks.length > 0 && (
        <section aria-label="この連絡から生まれたやること" className="flex flex-col gap-1">
          <h4 className="text-small font-strong text-text-muted">この連絡から生まれたやること</h4>
          {look.leftWork && <p className="text-small text-text">{look.leftWork}</p>}
          <ul className="flex flex-col">
            {look.tasks.map(t => (
              <li key={t.id}>
                <button type="button" data-contact-task={t.id} onClick={() => onOpenTask(t.id)}
                  className="flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left hover:bg-surface-sunken">
                  {t.open ? <Square size={14} aria-hidden className="text-text-subtle" /> : <CheckSquare size={14} aria-hidden className="text-success-icon" />}
                  <span className={`min-w-0 flex-1 truncate ${t.open ? '' : 'text-text-muted line-through'}`}>{t.title}</span>
                  <span className="text-caption text-text-subtle">{t.state}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {look.truncated && <p className="text-caption text-text-subtle">つながっている記録が多いため、一部だけを表示しています。</p>}

      <div>
        <Button size="sm" variant="ghost" onClick={() => onOpenRecord(view.interaction.id)}>詳しく見る</Button>
      </div>

      <InputDialog isOpen={asking !== null} title="返事をしないわけ" placeholder="例：電話で話がつきました" confirmText="返事をしない"
        onCancel={() => setAsking(null)}
        onConfirm={async note => { const b = asking; setAsking(null); if (b) await finish(b, note) }} />
    </div>
  )
}
