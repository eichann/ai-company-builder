import { memo, useState } from 'react'
import { CalendarCheck } from '@phosphor-icons/react'
import { Button, StatusBadge } from '../../../shared/ui/primitives'
import { STATE_BOX, type StateBoxTone } from '../../../shared/ui/stateStyles'
import {
  JOB_CANDIDATE_DISCARDED_TEXT, JOB_CANDIDATE_GONE_TEXT, JOB_CANDIDATE_NOTES, JOB_PROPOSAL_READ_AGAIN_CODES, jobCandidateLines, jobProposalCardState, jobProposalStateLine,
  jobProposalStateWord, type JobCandidateResult, type JobProposalCardRef,
} from '../../../../shared/job-proposals'
import { discardJobCandidate, submitJobProposal, withdrawJobProposal, type JobProposalCardPort } from '../api'
import { putJobProposal, readJobCandidateNow, reloadJobCandidate } from '../../../shared/lib/jobProposalStore'
import { useJobProposal } from '../hooks/useJobProposal'
import { useUnknownResult } from '../hooks/useUnknownResult'
import { unknownMessage, type PressOutcome, type UnknownWords } from '../unknownResult'

type PressKind = 'submit' | 'withdraw' | 'discard'
/** What the card says when a press's answer did not come (it never says 「開き直すと分かります」). */
const PRESS_WORDS: Record<PressKind, UnknownWords> = {
  submit: { whether: '管理者に出せたかどうか', notDone: 'まだ管理者に出されていません' },
  withdraw: { whether: '取り下げられたかどうか', notDone: 'まだ取り下げられていません' },
  discard: { whether: 'やめられたかどうか', notDone: 'まだやめていません' },
}
/** What the server's answer shows when the press happened. */
const PRESS_DONE: Record<PressKind, (r: Extract<JobCandidateResult, { success: true }>) => boolean> = {
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
export const JobProposalCard = memo(function JobProposalCard({ card, port }: { card: JobProposalCardRef; port?: JobProposalCardPort }) {
  const { key, result } = useJobProposal(card.companyId, card.candidateId, port)
  const [busy, setBusy] = useState(false)
  const [declined, setDeclined] = useState(false)
  const [message, setMessage] = useState<{ tone: StateBoxTone; text: string } | null>(null)
  const state = jobProposalCardState(result)
  // A press whose answer never came: no press is offered until a read says what happened (never sent twice).
  // (Kept per candidate, not per card: a card shown again or a second card of it offers no press either.)
  const unknown = useUnknownResult<PressKind>(key)
  const locked = busy || unknown.unsure !== null

  const readAgain = () => reloadJobCandidate(key)

  /** One read of the candidate: whether the press happened (null: it could not be read). */
  const readAfter = (kind: PressKind) => async (): Promise<PressOutcome | null> => {
    const r = await readJobCandidateNow(key)
    if (!r || !r.success) return null
    return PRESS_DONE[kind](r) ? 'done' : 'not-done'
  }
  /** After an unknown answer: read again by itself; done → the card shows the state, not done → press again. */
  const settle = async (kind: PressKind, how: 'start' | 'checkNow') => {
    setMessage(null)
    const outcome = await unknown[how](kind, readAfter(kind))
    if (outcome === 'not-done') setMessage({ tone: 'info', text: unknownMessage(PRESS_WORDS[kind], 'not-done') })
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
  return (
    <div role="group" aria-label="定期の仕事の案" data-state={proposal?.state ?? 'candidate'} className={`my-2 rounded-card border p-3 ${STATE_BOX[tone]}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-body font-strong text-text">
        <CalendarCheck size={15} weight="bold" aria-hidden className="text-text-muted" />
        定期の仕事の案{candidate ? `：${candidate.definition.name}` : ''}
        {proposal && <StatusBadge variant={STATE_BADGE[proposal.state] ?? 'neutral'} className="ml-auto">{jobProposalStateWord(proposal.state)}</StatusBadge>}
      </div>
      {candidate && (
        <>
          <ul aria-label="案の内容" className="mt-2 space-y-0.5 text-small text-text">
            {jobCandidateLines(candidate.definition, candidate.timeZone).map(line => <li key={line}>{line}</li>)}
          </ul>
          {!proposal && (
            <ul aria-label="出す前に" className="mt-2 space-y-0.5 text-small text-text-muted">
              {JOB_CANDIDATE_NOTES.map(line => <li key={line}>{line}</li>)}
            </ul>
          )}
        </>
      )}
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
}, (prev, next) => prev.card.id === next.card.id)
