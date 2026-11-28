import { memo, useState } from 'react'
import { ArrowsOut, CheckCircle, Hourglass, Robot, Warning, XCircle } from '@phosphor-icons/react'
import { Button, StatusBadge } from '../../../shared/ui/primitives'
import { STATE_BOX, type StateBoxTone } from '../../../shared/ui/stateStyles'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { outcomeByText, stateLine, type ApprovalCardRef } from '../../../../shared/approvals'
import type { ApprovalView } from '../../../../../shared/types/approvals'
import { approveApproval, getApproval, sameAsApproval, sendBackApproval, withdrawApproval, type ApprovalOutbound } from '../api'
import { putApproval } from '../approvalStore'
import { answerHint, pressFinished, type ApprovalPress } from '../approvalCard'
import { useApproval } from '../hooks/useApproval'
import { useUnknownResult } from '../hooks/useUnknownResult'
import { unknownMessage, type PressOutcome, type UnknownWords } from '../unknownResult'
import { BasisFolds, ChangeSection, DuplicateCheck } from './ApprovalCardParts'

/** What the card says when a press's answer did not come (it never says 「開き直すと分かります」). */
const PRESS_WORDS: Record<ApprovalPress, UnknownWords> = {
  approve: { whether: '承認できたかどうか', notDone: '承認はまだ届いていません' },
  'send-back': { whether: '差し戻せたかどうか', notDone: '差し戻しはまだ届いていません' },
  withdraw: { whether: '取り下げられたかどうか', notDone: '取り下げはまだ届いていません' },
  'same-as': { whether: '「同じ」と伝えられたかどうか', notDone: '「同じ」はまだ届いていません' },
}

// Awaiting approval is amber (owner decision 2026-11-21); amber otherwise means a warning only.
const STATE_TONE: Record<ApprovalView['state'], StateBoxTone> = {
  pending: 'awaiting', approved: 'ok', sent_back: 'warn', stale: 'warn', withdrawn: 'plain', failed: 'error',
}

function StateIcon({ state }: { state: ApprovalView['state'] }) {
  if (state === 'approved') return <CheckCircle size={15} weight="bold" aria-hidden className="text-success-icon" />
  if (state === 'failed') return <XCircle size={15} weight="bold" aria-hidden className="text-danger-icon" />
  if (state === 'pending') return <Hourglass size={15} weight="bold" aria-hidden className="text-awaiting-icon" />
  if (state === 'withdrawn') return <Warning size={15} weight="bold" aria-hidden className="text-text-muted" />
  return <Warning size={15} weight="bold" aria-hidden className="text-warning-icon" />
}

/** After 「同じ」: what happened to the meeting. */
const MEETING_TEXT = { linked: '会議もこの記録につなぎました。', 'not-linked': '会議はつなげませんでした（会議の担当の人か管理者がつなげます）。', 'not-asked': '' } as const

interface Props {
  card: ApprovalCardRef
  outbound?: ApprovalOutbound
  /**
   * A press here finished the request (approved, sent back, withdrawn, 「同じ」 — the server's answer says so; a write that
   * failed or went stale stays on the card): where the card is worked through a list (the inbox), the next one.
   */
  onDone?: () => void
  /** ［大きく開く（タブ）］: the same request as a tab in the middle (a consultation's card; absent where it already is one). */
  onOpenLarge?: () => void
}

/**
 * An approval request (承認のお願い; client/shared/approvals.ts), drawn by the app — never by a plugin or the AI's text.
 * It reads the request with the member's session each time it is shown; 「承認する」 sends the reason and the hash of the
 * content shown here, and the server acts only when that is still the content it holds. Laid out to decide (owner
 * decision 2026-11-28, 12番 案A): ① what changes, large → the folded basis → ② the duplicate check (a create) → ③ the
 * reason → ④ the buttons, in a bar that stays at the bottom of the view while the card is on screen.
 */
export const ApprovalCard = memo(function ApprovalCard({ card, outbound, onDone, onOpenLarge }: Props) {
  const { key, view, names, error: loadError } = useApproval(card.companyId, card.approvalId, outbound)
  // The card is memoised by its id: the latest callbacks are read when a press ends.
  const callbacks = useLatestRef({ onDone, onOpenLarge })
  const [message, setMessage] = useState<{ tone: StateBoxTone; text: string } | null>(null)
  // null until the approver edits it: the AI's draft is shown first.
  const [edited, setEdited] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 「別の…として作る」 holds for the content it was chosen on: new content (another hash) asks again.
  const [distinctFor, setDistinctFor] = useState<string | null>(null)
  const [linkMeeting, setLinkMeeting] = useState(true)
  // A press whose answer never came: no press is offered until a read says what happened (never sent twice).
  // (Kept per request, not per card: a card shown again or a second card of it offers no press either.)
  const unknown = useUnknownResult<{ kind: ApprovalPress; before: ApprovalView['state'] }>(key)
  const reason = edited ?? view?.proposedReason ?? ''
  const locked = busy || unknown.unsure !== null

  /** One read of the request: whether the press moved it from `before` (null: it could not be read). */
  const readAfter = (before: ApprovalView['state']) => async (): Promise<PressOutcome | null> => {
    const r = await (outbound ? getApproval(card.companyId, card.approvalId, outbound) : getApproval(card.companyId, card.approvalId))
    if (!r.success || !r.approval) return null
    putApproval(key, r)
    return r.approval.state !== before ? 'done' : 'not-done'
  }
  /** After an unknown answer: read again by itself; done → the state line says what happened, not done → press again. */
  const settle = async (kind: ApprovalPress, before: ApprovalView['state'], how: 'start' | 'checkNow') => {
    setMessage(null)
    const outcome = await unknown[how]({ kind, before }, readAfter(before))
    if (outcome === 'not-done') setMessage({ tone: 'info', text: unknownMessage(PRESS_WORDS[kind], 'not-done') })
  }
  const unsureBox = unknown.unsure && (
    <div role="alert" className={`mt-2 rounded-control border px-2 py-1.5 text-small ${STATE_BOX.info}`}>
      {unknownMessage(PRESS_WORDS[unknown.unsure.press.kind], unknown.unsure.checking ? 'checking' : 'unreadable')}
      {/* Only a read: 「結果を確かめる」 never sends the press again. */}
      {!unknown.unsure.checking && <Button size="sm" className="ml-2 mt-1" onClick={() => void settle(unknown.unsure!.press.kind, unknown.unsure!.press.before, 'checkNow')}>結果を確かめる</Button>}
    </div>
  )

  /** 「これと同じ…です（作らない）」: nothing is made; the request ends (and the meeting may belong to that record). */
  const sameAs = async (recordId: string) => {
    if (!view || locked) return
    setBusy(true)
    setMessage(null)
    try {
      const withMeeting = linkMeeting && view.basis.meetingId !== null
      const r = await (outbound ? sameAsApproval(card.companyId, view.id, recordId, withMeeting, outbound) : sameAsApproval(card.companyId, view.id, recordId, withMeeting))
      putApproval(key, r)
      if (r.success) {
        setMessage({ tone: 'ok', text: `作りませんでした。${MEETING_TEXT[r.meeting ?? 'not-asked']}` })
        if (pressFinished('same-as', r.approval.state)) callbacks.current.onDone?.()
      } else if (r.offline) void settle('same-as', view.state, 'start')
      else setMessage({ tone: 'error', text: r.error })
    } finally {
      setBusy(false)
    }
  }

  // `shown` is the view this render draws: 「承認する」 sends its hash, never one read at another time.
  const act = async (kind: 'approve' | 'send-back' | 'withdraw', shown: ApprovalView) => {
    if (locked) return
    setBusy(true)
    setMessage(null)
    try {
      const r = kind === 'approve'
        ? await (outbound ? approveApproval(card.companyId, shown.id, shown.hash, reason, outbound) : approveApproval(card.companyId, shown.id, shown.hash, reason))
        : kind === 'send-back'
          ? await (outbound ? sendBackApproval(card.companyId, shown.id, reason, outbound) : sendBackApproval(card.companyId, shown.id, reason))
          : await (outbound ? withdrawApproval(card.companyId, shown.id, outbound) : withdrawApproval(card.companyId, shown.id))
      putApproval(key, r)
      if (r.success) { if (pressFinished(kind, r.approval.state)) callbacks.current.onDone?.() }
      else if (r.offline) void settle(kind, shown.state, 'start')
      else {
        setMessage({ tone: 'error', text: r.error })
        // The content changed (or the state moved): show what the server holds now.
        if (!r.approval && (r.code === 'CONTENT_CHANGED' || r.code === 'NOT_PENDING')) {
          putApproval(key, await (outbound ? getApproval(card.companyId, shown.id, outbound) : getApproval(card.companyId, shown.id)))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  if (!view) {
    return (
      <div role="group" aria-label="承認のお願い" className={`my-2 rounded-card border p-3 text-small text-text-muted ${STATE_BOX.plain}`}>
        {loadError ?? '承認のお願いを読み込んでいます…'}
      </div>
    )
  }

  const pending = view.state === 'pending'
  const canAnswer = pending && view.viewerMayApprove
  const canWithdraw = view.viewerIsRequester && (pending || view.state === 'sent_back')
  const similarItems = view.similar?.items ?? []
  const distinct = distinctFor === view.hash
  // Before approving a new record with similar ones listed, the person says which it is.
  const mustChoose = canAnswer && similarItems.length > 0 && !distinct
  const answering = canAnswer && !unknown.unsure
  const reasonEmpty = reason.trim() === ''
  return (
    <div role="group" aria-label="承認のお願い" data-state={view.state} className={`my-2 rounded-card border ${STATE_BOX[STATE_TONE[view.state]]}`}>
      <div className="p-3">
        <div className="flex flex-wrap items-center gap-1.5 text-body font-strong text-text">
          <StateIcon state={view.state} />
          <span className="min-w-0">承認のお願い：{view.operationLabel}</span>
          <span className="ml-auto flex items-center gap-1">
            {view.requestedByAi && <StatusBadge variant="ai" icon={Robot}>AI の案から</StatusBadge>}
            {onOpenLarge && <Button size="sm" variant="ghost" title="真ん中のタブで大きく開きます" onClick={() => callbacks.current.onOpenLarge?.()}>
              <ArrowsOut size={12} aria-hidden />大きく開く（タブ）
            </Button>}
          </span>
        </div>
        <p role="status" className={`mt-1 text-small ${pending ? 'text-text-muted' : 'text-text'}`}>{stateLine(view, names)}</p>
        {!pending && view.state !== 'sent_back' && view.outcome && <p className="mt-0.5 text-caption font-normal text-text-subtle">{outcomeByText(view.outcome, names)}・{view.outcome.at.slice(0, 16).replace('T', ' ')}</p>}
        <ChangeSection view={view} />
        <BasisFolds view={view} names={names} />
        {view.similar && <DuplicateCheck view={view} names={names} chosen={distinct} actable={(canAnswer || canWithdraw) && !unknown.unsure} locked={locked}
          linkMeeting={linkMeeting} onLinkMeeting={setLinkMeeting} onSame={id => void sameAs(id)}
          onDistinct={() => setDistinctFor(view.hash)} onChooseAgain={() => setDistinctFor(null)} />}
        {!canAnswer && view.proposedReason && <p className="mt-2 text-small text-text-muted">{view.requestedByAi ? 'AI のまとめ（参考）' : 'お願いした人のまとめ'}：{view.proposedReason}</p>}
        {message && <div role="alert" className={`mt-2 rounded-control border px-2 py-1.5 text-small ${STATE_BOX[message.tone]}`}>{message.text}</div>}
        {unsureBox}
        {answering && <label className="mt-3 block text-small text-text-muted">
          理由（必ず書きます）
          {view.proposedReason && edited === null && <span className="ml-1 text-caption font-normal text-text-subtle">{view.requestedByAi ? 'AI の下書きが入っています。直せます' : 'お願いした人の下書きが入っています。直せます'}</span>}
          <textarea value={reason} onChange={e => setEdited(e.target.value)} rows={2} maxLength={2000}
            className="mt-1 w-full rounded-control border border-border-control bg-bg p-2 text-body text-text focus:border-focus-border focus:outline-none" />
        </label>}
        {canWithdraw && !canAnswer && <div className="mt-2">
          <Button size="sm" disabled={locked} onClick={() => void act('withdraw', view)}>取り下げる</Button>
        </div>}
      </div>
      {/* ④ The buttons stay in reach at the bottom of the view (a short screen, a long card) while the card is shown. */}
      {answering && <div data-approval-bar className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-b-card border-t border-[color:var(--color-border)] bg-surface-raised px-3 py-2">
        <Button variant="primary" disabled={busy || reasonEmpty || mustChoose} onClick={() => void act('approve', view)}>{busy ? '承認しています…' : '承認する'}</Button>
        <Button disabled={busy || reasonEmpty} onClick={() => void act('send-back', view)}>差し戻す</Button>
        <span className="text-caption font-normal text-text-subtle">{answerHint({ mustChoose, reasonEmpty })}</span>
      </div>}
    </div>
  )
}, (prev, next) => prev.card.id === next.card.id && !prev.onOpenLarge === !next.onOpenLarge)
