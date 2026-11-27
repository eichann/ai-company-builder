import { memo, useState } from 'react'
import { UsersThree } from '@phosphor-icons/react'
import { Button } from '../../../shared/ui/primitives'
import { STATE_BOX, type StateBoxTone } from '../../../shared/ui/stateStyles'
import { SHARE_PROPOSAL_WORDS, type ShareProposalCardRef } from '../../../../shared/share-proposals'
import { pressShareProposal, type ShareProposalPort } from '../api'

/**
 * 「部署に出す案」 (client/shared/share-proposals.ts), drawn by the app — never from the AI's text. Nothing is shared until
 * the member presses ［部署に出す］: the task is read again with their session and shared at its version through the app's
 * own `tasks:share`; the server decides it as for the task card's button.
 */
export const ShareProposalCard = memo(function ShareProposalCard({ card, port }: { card: ShareProposalCardRef; port?: ShareProposalPort }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ tone: StateBoxTone; text: string; final: boolean } | null>(null)

  const press = async () => {
    if (busy) return
    setBusy(true)
    setOutcome(null)
    try {
      const r = await (port ? pressShareProposal(card, port) : pressShareProposal(card))
      if (r.kind === 'done') setOutcome({ tone: 'ok', text: SHARE_PROPOSAL_WORDS.done(card.folder), final: true })
      else if (r.kind === 'already') setOutcome({ tone: 'info', text: SHARE_PROPOSAL_WORDS.already, final: true })
      else if (r.kind === 'gone') setOutcome({ tone: 'info', text: SHARE_PROPOSAL_WORDS.gone, final: true })
      else setOutcome({ tone: 'error', text: r.text, final: false })
    } finally {
      setBusy(false)
    }
  }

  const finished = outcome?.final === true
  return (
    <div role="group" aria-label={SHARE_PROPOSAL_WORDS.heading} data-share-proposal className={`my-2 rounded-card border p-3 ${STATE_BOX.plain}`}>
      <div className="flex items-center gap-1.5 text-body font-strong text-text">
        <UsersThree size={15} weight="bold" aria-hidden className="text-text-muted" />
        {SHARE_PROPOSAL_WORDS.heading}
      </div>
      <p className="mt-2 text-small text-text">{SHARE_PROPOSAL_WORDS.line(card.title, card.folder)}</p>
      {outcome && <div role={outcome.tone === 'error' ? 'alert' : 'status'} className={`mt-2 rounded-control border px-2 py-1.5 text-small ${STATE_BOX[outcome.tone]}`}>{outcome.text}</div>}
      {!finished && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void press()}>{busy ? '出しています…' : SHARE_PROPOSAL_WORDS.press}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOutcome({ tone: 'plain', text: SHARE_PROPOSAL_WORDS.declined, final: true })}>{SHARE_PROPOSAL_WORDS.decline}</Button>
        </div>
      )}
    </div>
  )
})
