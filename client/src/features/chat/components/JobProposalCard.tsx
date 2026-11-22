import { memo, useState } from 'react'
import { CalendarCheck } from '@phosphor-icons/react'
import { Button, StatusBadge } from '../../../shared/ui/primitives'
import { STATE_BOX, type StateBoxTone } from '../../../shared/ui/stateStyles'
import {
  JOB_CANDIDATE_GONE_TEXT, JOB_CANDIDATE_NOTES, JOB_PROPOSAL_READ_AGAIN_CODES, jobCandidateLines, jobProposalCardState, jobProposalStateLine,
  jobProposalStateWord, type JobProposalCardRef,
} from '../../../../shared/job-proposals'
import { submitJobProposal, withdrawJobProposal, type JobProposalCardPort } from '../api'
import { putJobProposal, reloadJobCandidate } from '../../../shared/lib/jobProposalStore'
import { useJobProposal } from '../hooks/useJobProposal'

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

  const readAgain = () => reloadJobCandidate(key)

  const submit = async (candidateId: string, fingerprint: string) => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const r = await (port ? submitJobProposal(card.companyId, candidateId, fingerprint, port) : submitJobProposal(card.companyId, candidateId, fingerprint))
      if (r.success) {
        putJobProposal(key, { success: true, candidate: state.kind === 'candidate' ? state.candidate : null, proposal: r.proposal })
        return
      }
      setMessage({ tone: r.offline ? 'info' : 'error', text: r.offline ? `${r.error} 出せたかどうかは、開き直すと分かります（もう一度押しても二重には出されません）。` : r.error })
      if (r.code && JOB_PROPOSAL_READ_AGAIN_CODES.includes(r.code)) readAgain()
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async (proposalId: string) => {
    if (busy || state.kind !== 'proposal') return
    setBusy(true)
    setMessage(null)
    try {
      const r = await (port ? withdrawJobProposal(card.companyId, proposalId, port) : withdrawJobProposal(card.companyId, proposalId))
      if (r.success) putJobProposal(key, { success: true, candidate: state.candidate, proposal: r.proposal })
      else {
        setMessage({ tone: r.offline ? 'info' : 'error', text: r.error })
        if (r.code && JOB_PROPOSAL_READ_AGAIN_CODES.includes(r.code)) readAgain()
      }
    } finally {
      setBusy(false)
    }
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
            {jobCandidateLines(candidate.definition).map(line => <li key={line}>{line}</li>)}
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
      {state.kind === 'candidate' && !declined && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void submit(state.submit.candidateId, state.submit.fingerprint)}>
            {busy ? '出しています…' : 'これで管理者に出す'}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDeclined(true); setMessage(null) }}>やめる</Button>
        </div>
      )}
      {state.kind === 'candidate' && declined && (
        <p role="status" className="mt-2 text-small text-text-muted">出さないことにしました。この案は作ってから24時間で消えます。</p>
      )}
      {state.kind === 'proposal' && state.withdraw && (
        <div className="mt-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void withdraw(state.proposal.id)}>取り下げる</Button>
        </div>
      )}
    </div>
  )
}, (prev, next) => prev.card.id === next.card.id)
