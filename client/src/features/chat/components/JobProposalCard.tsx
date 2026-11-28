// The card's presses (出す・やめる・取り下げる・その場で直す) share one lock and one unknown-answer path, so they stay in this
// one file; the editable rows are `JobProposalEditRows.tsx`, the lists and words `jobProposalEdit.ts`.
import { memo, useMemo, useState } from 'react'
import { ArrowsOut, CalendarCheck } from '@phosphor-icons/react'
import { Button, StatusBadge } from '../../../shared/ui/primitives'
import { STATE_BOX, type StateBoxTone } from '../../../shared/ui/stateStyles'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { proposalInputOf, type JobCandidateInput } from '../../../../../shared/core/job-proposals'
import {
  JOB_CANDIDATE_DISCARDED_TEXT, JOB_CANDIDATE_GONE_TEXT, JOB_CANDIDATE_NOTES, JOB_PROPOSAL_READ_AGAIN_CODES, JOB_REVISE_READ_AGAIN_CODES, jobCandidateLines,
  jobProposalCardState, jobProposalStateLine, jobProposalStateWord, type JobCandidateResult, type JobProposalCardRef,
} from '../../../../shared/job-proposals'
import { discardJobCandidate, reviseJobCandidate, submitJobProposal, withdrawJobProposal, type JobProposalCardPort } from '../api'
import { changeText, sameInput } from '../jobProposalEdit'
import { useJobProposalChoices } from '../hooks/useJobProposalChoices'
import { JobProposalEditRows } from './JobProposalEditRows'
import { putJobProposal, readJobCandidateNow, reloadJobCandidate } from '../../../shared/lib/jobProposalStore'
import { useJobProposal } from '../hooks/useJobProposal'
import { useUnknownResult } from '../hooks/useUnknownResult'
import { unknownMessage, type PressOutcome, type UnknownWords } from '../unknownResult'

type PressKind = 'submit' | 'withdraw' | 'discard' | 'revise'
/** What the card says when a press's answer did not come (it never says 「開き直すと分かります」). */
const PRESS_WORDS: Record<PressKind, UnknownWords> = {
  revise: { whether: '直せたかどうか', notDone: 'まだ直っていません（元の内容のままです）' },
  submit: { whether: '管理者に出せたかどうか', notDone: 'まだ管理者に出されていません' },
  withdraw: { whether: '取り下げられたかどうか', notDone: 'まだ取り下げられていません' },
  discard: { whether: 'やめられたかどうか', notDone: 'まだやめていません' },
}
/** What the server's answer shows when the press happened. */
const PRESS_DONE: Record<Exclude<PressKind, 'revise'>, (r: Extract<JobCandidateResult, { success: true }>) => boolean> = {
  submit: r => r.proposal !== null,
  withdraw: r => r.proposal !== null && r.proposal.state !== 'submitted',
  discard: r => r.discarded === true,
}

const STATE_BADGE: Record<string, 'awaiting' | 'success' | 'warning' | 'paused' | 'neutral'> = {
  submitted: 'awaiting', approved: 'success', returned: 'warning', withdrawn: 'paused',
}

/**
 * 「定期の仕事の案」 (client/shared/job-proposals.ts), drawn by the app — never from the AI's text. It reads the candidate
 * with the member's session each time it is shown; 「これで管理者に出す」 sends the candidate's id and the fingerprint shown
 * here (the member's own press, the only path to the submit), and afterwards the card shows what became of it.
 */
interface Props {
  card: JobProposalCardRef
  port?: JobProposalCardPort
  /** ［大きく開く（タブ）］: the same candidate as a tab in the middle (a consultation's card; absent where it already is one). */
  onOpenLarge?: () => void
}

export const JobProposalCard = memo(function JobProposalCard({ card, port, onOpenLarge }: Props) {
  const { key, result } = useJobProposal(card.companyId, card.candidateId, port)
  const [busy, setBusy] = useState(false)
  const [declined, setDeclined] = useState(false)
  const [message, setMessage] = useState<{ tone: StateBoxTone; text: string } | null>(null)
  // A change sent and not answered yet: shown in place while the server checks it; nothing else is offered meanwhile.
  const [checking, setChecking] = useState<JobCandidateInput | null>(null)
  // The last change sent: what a read after an answer that never came is compared with.
  const [sentChange, setSentChange] = useState<JobCandidateInput | null>(null)
  const { choices, load: loadChoices } = useJobProposalChoices(card.companyId)
  const callbacks = useLatestRef({ onOpenLarge })
  const state = jobProposalCardState(result)
  // A press whose answer never came: no press is offered until a read says what happened (never sent twice).
  // (Kept per candidate, not per card: a card shown again or a second card of it offers no press either.)
  const unknown = useUnknownResult<PressKind>(key)
  const locked = busy || checking !== null || unknown.unsure !== null
  const editing = state.kind === 'candidate' ? state.candidate : null
  const shownInput = useMemo(() => (editing ? proposalInputOf(editing.definition) : null), [editing])

  const readAgain = () => reloadJobCandidate(key)

  /** One read of the candidate: whether the press happened (null: it could not be read). */
  const readAfter = (kind: PressKind) => async (): Promise<PressOutcome | null> => {
    const r = await readJobCandidateNow(key)
    if (!r || !r.success) return null
    if (kind !== 'revise') return PRESS_DONE[kind](r) ? 'done' : 'not-done'
    const now = r.candidate ? proposalInputOf(r.candidate.definition) : null
    return now && sentChange && sameInput(now, sentChange) ? 'done' : 'not-done'
  }
  /** After an unknown answer: read again by itself; done → the card shows the state, not done → press again. */
  const settle = async (kind: PressKind, how: 'start' | 'checkNow') => {
    setMessage(null)
    const outcome = await unknown[how](kind, readAfter(kind))
    if (outcome === 'not-done') setMessage({ tone: 'info', text: unknownMessage(PRESS_WORDS[kind], 'not-done') })
    if (outcome === 'done' && kind === 'revise') setMessage({ tone: 'ok', text: '直した案をサーバーで確かめました。出すのはこの案です。' })
  }

  /**
   * 「その場で直す」: the whole input with the fingerprint shown; the server rebuilds and checks it (the same id). Refused → the
   * card shows the server's content again (the change goes back) and says why in fixed words naming no place.
   */
  const revise = async (next: JobCandidateInput) => {
    if (locked || state.kind !== 'candidate' || !shownInput || sameInput(shownInput, next)) return
    const before = shownInput
    setChecking(next)
    setSentChange(next)
    setMessage(null)
    try {
      const r = await (port ? reviseJobCandidate(card.companyId, state.candidate.id, state.candidate.fingerprint, next, port)
        : reviseJobCandidate(card.companyId, state.candidate.id, state.candidate.fingerprint, next))
      if (r.success) {
        putJobProposal(key, { success: true, candidate: r.candidate, proposal: null })
        setMessage({ tone: 'ok', text: `直した案をサーバーで確かめました。出すのはこの案です（${changeText(before, next)}）。` })
        return
      }
      if (r.offline) { void settle('revise', 'start'); return }
      setMessage({ tone: 'warn', text: r.error })
      if (r.code && JOB_REVISE_READ_AGAIN_CODES.includes(r.code)) readAgain()
    } finally {
      setChecking(null)
    }
  }

  const submit = async (candidateId: string, fingerprint: string) => {
    if (locked) return
    setBusy(true)
    setMessage(null)
    try {
      const r = await (port ? submitJobProposal(card.companyId, candidateId, fingerprint, port) : submitJobProposal(card.companyId, candidateId, fingerprint))
      if (r.success) {
        putJobProposal(key, { success: true, candidate: state.kind === 'candidate' ? state.candidate : null, proposal: r.proposal })
        return
      }
      if (r.offline) { void settle('submit', 'start'); return }
      setMessage({ tone: 'error', text: r.error })
      if (r.code && JOB_PROPOSAL_READ_AGAIN_CODES.includes(r.code)) readAgain()
    } finally {
      setBusy(false)
    }
  }

  /** 「やめる」: discarded on the server (the card then says so, also when reopened); a server before it only closes the buttons here. */
  const discard = async (candidateId: string) => {
    if (locked) return
    setBusy(true)
    setMessage(null)
    try {
      const r = await (port ? discardJobCandidate(card.companyId, candidateId, port) : discardJobCandidate(card.companyId, candidateId))
      if (r.success && r.supported) putJobProposal(key, { success: true, candidate: null, proposal: null, discarded: true })
      else if (r.success) setDeclined(true)
      else if (r.offline) void settle('discard', 'start')
      else {
        setMessage({ tone: r.offline ? 'info' : 'error', text: r.error })
        if (r.code && JOB_PROPOSAL_READ_AGAIN_CODES.includes(r.code)) readAgain()
      }
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async (proposalId: string) => {
    if (locked || state.kind !== 'proposal') return
    setBusy(true)
    setMessage(null)
    try {
      const r = await (port ? withdrawJobProposal(card.companyId, proposalId, port) : withdrawJobProposal(card.companyId, proposalId))
      if (r.success) putJobProposal(key, { success: true, candidate: state.candidate, proposal: r.proposal })
      else if (r.offline) void settle('withdraw', 'start')
      else {
        setMessage({ tone: r.offline ? 'info' : 'error', text: r.error })
        if (r.code && JOB_PROPOSAL_READ_AGAIN_CODES.includes(r.code)) readAgain()
      }
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'discarded') {
    return (
      <div role="group" aria-label="定期の仕事の案" data-state="discarded" className={`my-2 rounded-card border p-3 text-small text-text-muted ${STATE_BOX.plain}`}>
        {JOB_CANDIDATE_DISCARDED_TEXT}
      </div>
    )
  }
  if (state.kind === 'loading' || state.kind === 'error' || state.kind === 'gone') {
    return (
      <div role="group" aria-label="定期の仕事の案" className={`my-2 rounded-card border p-3 text-small text-text-muted ${STATE_BOX.plain}`}>
        {state.kind === 'loading' ? '定期の仕事の案を読み込んでいます…' : state.kind === 'error' ? state.text : JOB_CANDIDATE_GONE_TEXT}
        {/* A failed read (offline, the server's error) is never kept: ask again here, or it is read again when shown next. */}
        {state.kind === 'error' && <Button size="sm" variant="secondary" className="ml-2" onClick={readAgain}>読み直す</Button>}
      </div>
    )
  }

  const candidate = state.candidate
  const proposal = state.kind === 'proposal' ? state.proposal : null
  const tone: StateBoxTone = proposal?.state === 'submitted' ? 'awaiting' : 'plain'
  // Changed in place only before it is sent, and only a shape the server rebuilds (schema 4: `proposalInputOf`).
  const editable = state.kind === 'candidate' && shownInput !== null && !declined
  const deadline = candidate ? jobCandidateLines(candidate.definition, candidate.timeZone).find(l => l.startsWith('期限：')) : undefined
  const [firstNote, ...otherNotes] = JOB_CANDIDATE_NOTES
  return (
    <div role="group" aria-label="定期の仕事の案" data-state={proposal?.state ?? 'candidate'} aria-busy={checking !== null}
      className={`my-2 rounded-card border p-3 ${STATE_BOX[tone]}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-body font-strong text-text">
        <CalendarCheck size={15} weight="bold" aria-hidden className="text-text-muted" />
        <span className="min-w-0">定期の仕事の案{candidate ? `：${candidate.definition.name}` : ''}</span>
        <span className="ml-auto flex items-center gap-1">
          {proposal && <StatusBadge variant={STATE_BADGE[proposal.state] ?? 'neutral'}>{jobProposalStateWord(proposal.state)}</StatusBadge>}
          {onOpenLarge && <Button size="sm" variant="ghost" title="真ん中のタブで大きく開きます" onClick={() => callbacks.current.onOpenLarge?.()}>
            <ArrowsOut size={12} aria-hidden />大きく開く（タブ）
          </Button>}
        </span>
      </div>
      {candidate && editable && shownInput && (
        <>
          <p className="mt-0.5 text-caption font-normal text-text-muted">名前は「すること」と「いつ」から自動で付きます。下線のところを押すと、その場で直せます。</p>
          <JobProposalEditRows input={checking ?? shownInput}
            skillChangeable={candidate.definition.run.kind === 'procedure' && candidate.definition.run.procedure.source === 'company_skill'}
            timeZone={candidate.timeZone} disabled={locked} choices={choices} onLoadChoices={loadChoices} onChange={next => void revise(next)} />
          {deadline && <p className="mt-1 text-caption font-normal text-text-muted">{deadline}</p>}
        </>
      )}
      {candidate && !editable && (
        <ul aria-label="案の内容" className="mt-2 space-y-0.5 text-small text-text">
          {jobCandidateLines(candidate.definition, candidate.timeZone).map(line => <li key={line}>{line}</li>)}
        </ul>
      )}
      {candidate && !proposal && (
        // Owner decision 2026-11-28 (12・13番 4): the first note shown, the rest folded.
        <div role="group" aria-label="出す前に" className="mt-2 text-small text-text-muted">
          <p>{firstNote}</p>
          <details className="group mt-0.5">
            <summary className="cursor-pointer list-none hover:text-text [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>ほかに出す前に知っておくこと（{otherNotes.length}）
            </summary>
            <ul className="mt-1 space-y-0.5 pl-3">{otherNotes.map(line => <li key={line}>{line}</li>)}</ul>
          </details>
        </div>
      )}
      {checking && <p role="status" className={`mt-2 rounded-control border px-2 py-1.5 text-small ${STATE_BOX.info}`}>直した案をサーバーで確かめています…（確かめ終わるまで、出すことはできません）</p>}
      {proposal && <p role="status" className="mt-2 text-small text-text">{jobProposalStateLine(proposal)}</p>}
      {message && <div role="alert" className={`mt-2 rounded-control border px-2 py-1.5 text-small ${STATE_BOX[message.tone]}`}>{message.text}</div>}
      {unknown.unsure && <div role="alert" className={`mt-2 rounded-control border px-2 py-1.5 text-small ${STATE_BOX.info}`}>
        {unknownMessage(PRESS_WORDS[unknown.unsure.press], unknown.unsure.checking ? 'checking' : 'unreadable')}
        {/* Only a read: 「結果を確かめる」 never sends the press again. */}
        {!unknown.unsure.checking && (
          <Button size="sm" variant="secondary" className="ml-2 mt-1" onClick={() => void settle(unknown.unsure!.press, 'checkNow')}>結果を確かめる</Button>
        )}
      </div>}
      {state.kind === 'candidate' && !declined && !unknown.unsure && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={locked} onClick={() => void submit(state.submit.candidateId, state.submit.fingerprint)}>
            {busy ? '出しています…' : 'これで管理者に出す'}
          </Button>
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => void discard(state.submit.candidateId)}>やめる</Button>
        </div>
      )}
      {state.kind === 'candidate' && declined && (
        <p role="status" className="mt-2 text-small text-text-muted">出さないことにしました（このサーバーでは案を消せないため、作ってから24時間で消えます）。</p>
      )}
      {state.kind === 'proposal' && state.withdraw && !unknown.unsure && (
        <div className="mt-2">
          <Button size="sm" variant="secondary" disabled={locked} onClick={() => void withdraw(state.proposal.id)}>取り下げる</Button>
        </div>
      )}
    </div>
  )
}, (prev, next) => prev.card.id === next.card.id && !prev.onOpenLarge === !next.onOpenLarge)
