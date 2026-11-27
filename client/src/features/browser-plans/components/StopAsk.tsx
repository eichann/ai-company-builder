import { useState } from 'react'
import { Question } from '@phosphor-icons/react'
import { Button } from '../../../shared/ui/primitives'
import { BROWSER_STOP_WORDS as W, stopAnswerMessage, type BrowserStopNext } from '../../../../shared/browser-operator-trail'
import { openBrowserSite } from '../api'

/**
 * What a stopped write task asks the member, first on its card (agent-browser.md "The stopped card asks one thing"):
 * 「決めてほしいこと：…」 with ［そのまま進める］［やめる］, or ［開いてログイン］. The two answers are the member's own message
 * to the consultation, sent through the chat's ordinary send (`say`): nothing here reaches the site — the consultation AI
 * asks again and the new run reads the site afresh. The question is the operator's words (outside text): React text only.
 */
export function StopAsk({ next, companyId, host, say }: { next: BrowserStopNext; companyId: string; host: string; say?: (text: string) => void }) {
  const [sent, setSent] = useState(false)
  if (next.kind === 'login') {
    return (
      <div className="mt-2">
        <Button size="sm" onClick={() => { void openBrowserSite(companyId, host) }}>{W.openSite}</Button>
      </div>
    )
  }
  const answer = (a: 'proceed' | 'cancel') => {
    if (!say || sent) return
    setSent(true)
    say(stopAnswerMessage(a, next.question))
  }
  return (
    <div data-stop-ask className="mt-2">
      <p className="flex items-start gap-1.5 text-body text-text">
        <Question size={15} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-warning-icon" />
        <span className="min-w-0 break-words"><span className="font-strong">{W.decide}：</span>{next.question}</span>
      </p>
      {/* The run already wrote something: no answer button (it would start the work over as a new run). */}
      {next.kind === 'question' && <p className="mt-1 text-small text-text-muted">{W.askAgain}</p>}
      {next.kind === 'decide' && say && (sent
        ? <p role="status" className="mt-1 text-small text-text-muted">{W.sent}</p>
        : (
          <>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => answer('proceed')}>{W.proceed}</Button>
              <Button size="sm" onClick={() => answer('cancel')}>{W.cancel}</Button>
            </div>
            <p className="mt-1 text-small text-text-muted">{W.sendsNote}</p>
          </>
        ))}
    </div>
  )
}
