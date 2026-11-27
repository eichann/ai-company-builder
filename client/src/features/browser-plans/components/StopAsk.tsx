import { useState } from 'react'
import { Question } from '@phosphor-icons/react'
import { Button } from '../../../shared/ui/primitives'
import { BROWSER_STOP_WORDS as W, stopAnswerMessage, type BrowserStopNext, type BrowserStopScreen } from '../../../../shared/browser-operator-trail'
import { decideBrowserStop, openBrowserSite, type BrowserStopDecisions } from '../api'

/**
 * What a stopped write task asks the member, first on its card (agent-browser.md "The stopped card asks one thing"):
 * 「決めてほしいこと：…」 with ［そのまま進める］［やめる］, or ［開いてログイン］. An answer is kept in main bound to this card
 * (`browserLines:decide`, agent-browser.md "The stopped card's answer"), then the member's message — fixed words and the
 * card's id, **never the question** (a page could have shaped it) — goes through the chat's ordinary send (`say`): nothing
 * here reaches the site, and the run that continues takes the answer into its promise. The question is the operator's words
 * (outside text): React text only. Beside it, the screen the operator stopped on (agent-browser.md "The stopped card shows
 * the screen"): an image held in memory only, handed with the card's view — never kept by the chat.
 */
export function StopAsk({ next, companyId, cardId, host, say, screen, decisions }: {
  next: BrowserStopNext; companyId: string; cardId?: string; host: string; say?: (text: string) => void; screen?: BrowserStopScreen
  decisions?: BrowserStopDecisions
}) {
  const [sent, setSent] = useState<'no' | 'pending' | 'sent' | 'failed'>('no')
  const shot = screen ? <StopScreen screen={screen} /> : null
  if (next.kind === 'login') {
    return (
      <div className="mt-2">
        <Button size="sm" onClick={() => { void openBrowserSite(companyId, host) }}>{W.openSite}</Button>
        {shot}
      </div>
    )
  }
  const answer = (a: 'proceed' | 'cancel') => {
    if (!say || !cardId || sent !== 'no') return
    setSent('pending')
    void (decisions ? decideBrowserStop(companyId, cardId, a === 'proceed' ? 'proceed' : 'stop', decisions) : decideBrowserStop(companyId, cardId, a === 'proceed' ? 'proceed' : 'stop'))
      .catch(() => ({ ok: false as const, message: W.notKept }))
      .then((r) => {
        if (!r.ok) { setSent('failed'); return }
        setSent('sent')
        say(stopAnswerMessage(a, cardId))
      })
  }
  return (
    <div data-stop-ask className="mt-2">
      <p className="flex items-start gap-1.5 text-body text-text">
        <Question size={15} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-warning-icon" />
        <span className="min-w-0 break-words"><span className="font-strong">{W.decide}：</span>{next.question}</span>
      </p>
      {/* The run already wrote something: no answer button (it would start the work over as a new run). */}
      {next.kind === 'question' && <p className="mt-1 text-small text-text-muted">{W.askAgain}</p>}
      {next.kind === 'decide' && say && cardId && (sent === 'sent'
        ? <p role="status" className="mt-1 text-small text-text-muted">{W.sent}</p>
        : sent === 'failed'
          ? <p role="status" className="mt-1 text-small text-text-muted">{W.notKept}</p>
          : (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="primary" size="sm" disabled={sent === 'pending'} onClick={() => answer('proceed')}>{W.proceed}</Button>
                <Button size="sm" disabled={sent === 'pending'} onClick={() => answer('cancel')}>{W.cancel}</Button>
              </div>
              <p className="mt-1 text-small text-text-muted">{W.sendsNote}</p>
            </>
          ))}
      {shot}
    </div>
  )
}

/** The screen the operator stopped on: a JPEG from main's memory (its shape checked by the view's reader). */
function StopScreen({ screen }: { screen: BrowserStopScreen }) {
  return (
    <figure data-stop-screen className="mt-2">
      <img src={`data:${screen.mediaType};base64,${screen.base64}`} alt={W.screen} className="max-h-80 w-auto max-w-full rounded-control border border-border" />
      <figcaption className="mt-1 text-small text-text-muted">{W.screen}</figcaption>
    </figure>
  )
}
