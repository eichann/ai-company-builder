import { memo, useState, type ReactNode } from 'react'
import { CheckCircle, Globe, PencilSimple, WarningCircle } from '@phosphor-icons/react'
import { Button, Callout } from '../../../shared/ui/primitives'
import { STATE_BOX, type StateBoxTone } from '../../../shared/ui/stateStyles'
import { BROWSER_WRITE_CARD_WORDS as W, type BrowserWriteGetResult, type BrowserWriteView } from '../../../../shared/browser-line-writes'
import type { BrowserInspectionView } from '../../../../shared/browser-inspection'
import { useInterval } from '../../../shared/hooks/useInterval'
import { cancelBrowserWrite, confirmBrowserWrite, confirmBrowserWriteValue, getBrowserWriteCard, runBrowserWrite, type BrowserWriteAnswers, type BrowserWriteOutbound, type BrowserWriteReads } from '../api'
import { WRITE_CARD_UNREADABLE, useBrowserWrite } from '../hooks/useBrowserWrite'
import { putWrite } from '../writeStore'

/** A write in doubt is read again this often (the server opens the confirm at `confirmableAt`). */
const UNSETTLED_REFRESH_MS = 15_000

// Confirming and awaiting ［任せる］ are amber (the member's turn), a run in doubt is amber too (they check the site),
// all done green, a stop grey (design-system.md 「止まっている」の色).
function frame(view: BrowserWriteView): StateBoxTone {
  if (view.result) return view.result.outcome === 'succeeded' ? 'ok' : view.result.outcome === 'unknown' ? 'warn' : 'plain'
  if (view.phase === 'failed') return 'plain'
  return view.phase === 'running' || view.phase === 'preparing' ? 'info' : 'awaiting'
}

const time = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

function List({ heading, items, tone }: { heading: string; items: readonly string[]; tone?: 'muted' }) {
  if (items.length === 0) return null
  return (
    <div className="mt-2">
      <p className="text-small font-strong text-text-muted">{heading}</p>
      <ul className={`mt-1 list-disc pl-5 text-body ${tone === 'muted' ? 'text-text-muted' : 'text-text'}`}>
        {items.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
    </div>
  )
}

type Ports = { reads?: BrowserWriteReads; answers?: BrowserWriteAnswers; outbound?: BrowserWriteOutbound }

/**
 * A 「ブラウザ操作」 write card (agent-browser.md "Writing on the new path"): the values the AI proposed, each a person must
 * confirm one by one; then what main read from the site and what will be done, ［任せる］ once; then the result with the
 * stopped card's four lists and, for a write in doubt, ［済んでいた］［されていなかった］ from its time. No resend anywhere.
 * `readCard` draws what was read (the inspection's body, handed in to keep the two files apart).
 */
export const BrowserWriteCard = memo(function BrowserWriteCard({ companyId, cardId, readCard, ports = {} }: {
  companyId: string; cardId: string; readCard: (view: BrowserInspectionView) => ReactNode; ports?: Ports
}) {
  const { view, message, key } = useBrowserWrite(companyId, cardId, ports.reads)
  const [busy, setBusy] = useState(false)
  // A write in doubt: main asks the server again so the confirm opens at its time (and a settled one shows).
  const waiting = view?.result?.confirm !== null && view?.result?.confirm !== undefined && !view.result.confirm.canNow
  useInterval(() => {
    void (ports.reads ? getBrowserWriteCard(companyId, cardId, ports.reads) : getBrowserWriteCard(companyId, cardId))
      .then(r => putWrite(key, r, WRITE_CARD_UNREADABLE)).catch(() => {})
  }, waiting && !busy ? UNSETTLED_REFRESH_MS : null)
  const press = (call: () => Promise<BrowserWriteGetResult>) => {
    setBusy(true)
    void call()
      .catch((): BrowserWriteGetResult => ({ ok: false, message: WRITE_CARD_UNREADABLE }))
      .then(r => putWrite(key, r, WRITE_CARD_UNREADABLE))
      .finally(() => setBusy(false))
  }
  if (!view) {
    return (
      <section role="group" aria-label="書き込みのカード" className={`my-2 rounded-card border p-3 ${STATE_BOX.plain}`}>
        <p className="text-body text-text-muted">{message ?? '読み込んでいます…'}</p>
      </section>
    )
  }
  const result = view.result
  return (
    <section role="group" aria-label={view.title} data-write-phase={view.phase} className={`my-2 rounded-card border p-3 ${STATE_BOX[frame(view)]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Globe size={15} weight="bold" aria-hidden className="text-text-muted" />
        <span className="text-title text-text">{view.title}</span>
        <span className="text-small text-text-muted">{view.siteLabel}</span>
      </div>

      {view.phase === 'confirming' && (
        <div className="mt-2">
          <p className="text-small font-strong text-text-muted">{W.confirmHeading}</p>
          <dl className="mt-1">
            {view.values.map(v => (
              <div key={v.name} className="flex flex-wrap items-center gap-2 py-1">
                <dt className="w-36 shrink-0 text-small text-text-muted">{v.label}</dt>
                <dd className="min-w-0 flex-1 text-body text-text">
                  {v.needsConfirm && <span className="mr-1 text-small text-warning-text">{W.aiProposed}：</span>}
                  <span className="break-words">{v.value}</span>
                  {v.needsConfirm && (v.confirmed
                    ? <span className="ml-2 inline-flex items-center gap-1 text-small text-success-text"><CheckCircle size={13} weight="fill" aria-hidden />{W.confirmed}</span>
                    : <Button size="sm" className="ml-2" disabled={busy} onClick={() => press(() => (ports.answers ? confirmBrowserWriteValue(companyId, cardId, v.name, ports.answers) : confirmBrowserWriteValue(companyId, cardId, v.name)))}>{W.confirm}</Button>)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="mt-2">
        <p className="text-small font-strong text-text-muted">{W.willDo}</p>
        <ul className="mt-1 space-y-1">
          {view.sentences.map((s, i) => (
            <li key={i} className="flex items-start gap-1.5 text-body text-text"><PencilSimple size={14} aria-hidden className="mt-0.5 shrink-0 text-text-muted" />{s}</li>
          ))}
        </ul>
      </div>

      {view.phase === 'preparing' && <p role="status" className="mt-2 text-body text-text-muted">{W.preparing}</p>}
      {view.card && readCard({ card: view.card, readAt: view.readAt ?? '', siteLabel: view.siteLabel })}

      {view.phase === 'ready' && view.contentHash && (
        <div className="mt-2 flex items-center gap-2">
          <Button variant="primary" disabled={busy} onClick={() => press(() => (ports.outbound ? runBrowserWrite(companyId, cardId, view.contentHash as string, ports.outbound) : runBrowserWrite(companyId, cardId, view.contentHash as string)))}>
            {busy ? W.entrusting : W.entrust}
          </Button>
          {view.cancellable && (
            <Button disabled={busy} onClick={() => press(() => (ports.outbound ? cancelBrowserWrite(companyId, cardId, ports.outbound) : cancelBrowserWrite(companyId, cardId)))}>
              {W.cancel}
            </Button>
          )}
        </div>
      )}
      {view.phase === 'running' && <p role="status" className="mt-2 text-body text-text-muted">{W.entrusting}</p>}

      {result && (
        <div className="mt-2">
          <p role="status" className="text-body font-strong text-text">{result.headline}</p>
          <List heading={W.doneList} items={result.done} />
          <List heading={W.notDoneList} items={result.notDone} tone="muted" />
          <List heading={W.unknownList} items={result.unknown} />
          <List heading={W.byHandList} items={result.byHand} />
          {result.confirm && (
            <div className="mt-2">
              <p className="text-small text-text-muted">{W.confirmUnknown}</p>
              {result.confirm.canNow
                ? (
                  <div className="mt-1 flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => press(() => (ports.answers ? confirmBrowserWrite(companyId, cardId, 'done', ports.answers) : confirmBrowserWrite(companyId, cardId, 'done')))}>{W.confirmDone}</Button>
                    <Button size="sm" disabled={busy} onClick={() => press(() => (ports.answers ? confirmBrowserWrite(companyId, cardId, 'not_done', ports.answers) : confirmBrowserWrite(companyId, cardId, 'not_done')))}>{W.confirmNotDone}</Button>
                  </div>
                )
                : result.confirm.from && <p className="mt-1 text-small text-text-muted">{W.confirmAt(time(result.confirm.from))}</p>}
            </div>
          )}
          <p className="mt-2 text-small text-text-muted">{W.noResend}</p>
        </div>
      )}

      {(view.message || message) && (
        <Callout tone="warning" className="mt-2"><span className="inline-flex items-start gap-1"><WarningCircle size={14} weight="fill" aria-hidden className="mt-0.5" />{view.message ?? message}</span></Callout>
      )}
    </section>
  )
})
