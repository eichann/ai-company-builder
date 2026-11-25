import { memo } from 'react'
import { CheckCircle, Globe, Hourglass, WarningCircle, XCircle } from '@phosphor-icons/react'
import { Callout } from '../../../shared/ui/primitives'
import { STATE_BOX, type StateBoxTone } from '../../../shared/ui/stateStyles'
import { BROWSER_CARD_CHECKED_BY_WORDS, BROWSER_CARD_MARK_WORDS, type BrowserCard, type BrowserCardMark, type BrowserCardRow, type BrowserCardValue } from '../../../../../shared/core/browser-card'
import { BROWSER_INSPECTION_CARD_WORDS as W, type BrowserInspectionView } from '../../../../shared/browser-inspection'
import type { BrowserInspectionReads } from '../api'
import { useBrowserInspection } from '../hooks/useBrowserInspection'
import { BrowserWriteCard } from './BrowserWriteCard'

// Everything ✓ is green; a ✗ or something unread asks the member to look at the site, so amber (design-system.md
// 「止まっている」の色: something to do).
const FRAME: Record<BrowserCard['state'], StateBoxTone> = { all_ok: 'ok', ng: 'warn', not_read: 'warn' }

const MARK: Record<BrowserCardMark, { icon: typeof CheckCircle; className: string }> = {
  ok: { icon: CheckCircle, className: 'text-success-text' },
  ng: { icon: XCircle, className: 'text-danger-text' },
  unreadable: { icon: WarningCircle, className: 'text-warning-text' },
  later: { icon: Hourglass, className: 'text-text-muted' },
}

const time = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

/** A value as the site showed it, or 「読み取れませんでした」 in amber — never a stand-in. */
function Value({ value }: { value: BrowserCardValue }) {
  if (value.status === 'read') return <span className="whitespace-pre-wrap break-words">{value.text}</span>
  return (
    <span data-value="unreadable" className="inline-flex items-center gap-1 text-warning-text">
      <WarningCircle size={13} weight="fill" aria-hidden className="text-warning-icon" />{W.unreadable}
    </span>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1">
      <dt className="w-36 shrink-0 text-small text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-body text-text">{children}</dd>
    </div>
  )
}

/**
 * A 「ブラウザ操作」 inspection's card (agent-browser.md "The inspection in the chat"): what main read from the site, the
 * checks' ✓ / ✗ / 「読み取れませんでした」 and the site's notes. Only the member sees these values (the AI gets the marks
 * only); main keeps them in memory, so after a restart the card says the result is gone. Nothing here can act on the site.
 */
export const BrowserInspectionCard = memo(function BrowserInspectionCard({ companyId, planId, reads }: { companyId: string; planId: string; reads?: BrowserInspectionReads }) {
  // A write card (`wp_…`, generalization PR 5c) shares the chat's reference; it draws what was read with this body.
  // A write run's card (`bf_…`, step ⑤b) is a write card too.
  if (planId.startsWith('wp_') || planId.startsWith('bf_')) return <BrowserWriteCard companyId={companyId} cardId={planId} readCard={v => <InspectionBody view={v} />} />
  return <InspectionCardOf companyId={companyId} planId={planId} reads={reads} />
})

function InspectionCardOf({ companyId, planId, reads }: { companyId: string; planId: string; reads?: BrowserInspectionReads }) {
  const { view, message } = useBrowserInspection(companyId, planId, reads)
  if (!view) {
    return (
      <section role="group" aria-label="点検のカード" className={`my-2 rounded-card border p-3 ${STATE_BOX.plain}`}>
        <p className="text-body text-text-muted">{message ?? W.loading}</p>
      </section>
    )
  }
  return <InspectionBody view={view} />
}

/**
 * A write's row: before → after, and — on the after-read card (step ⑤b) — what it is compared to and who checked it
 * (機械で確かめた / AI が確かめた / 確かめていない), with ✓ / ✗ when someone did. Both sides always shown (bug 1).
 */
function BeforeAfter({ row }: { row: Extract<BrowserCardRow, { before: BrowserCardValue }> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5" data-checked-by={row.by}>
      <span><Value value={row.before} /> → <Value value={row.after} /></span>
      {row.compared && <span className="text-small text-text-muted">（比べ元：<Value value={row.compared} />）</span>}
      {row.mark && <span className={`font-strong ${MARK[row.mark].className}`}>{BROWSER_CARD_MARK_WORDS[row.mark]}</span>}
      {row.by && <span className="text-small text-text-muted">{BROWSER_CARD_CHECKED_BY_WORDS[row.by]}</span>}
    </span>
  )
}

export function InspectionBody({ view }: { view: BrowserInspectionView }) {
  const { card } = view
  return (
    <section role="group" aria-label={card.title} data-inspection-state={card.state} className={`my-2 rounded-card border p-3 ${STATE_BOX[FRAME[card.state]]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Globe size={15} weight="bold" aria-hidden className="text-text-muted" />
        <span className="text-title text-text">{card.title}</span>
        <span className="text-small text-text-muted">{view.siteLabel}</span>
      </div>
      <p role="status" className="mt-1 text-body text-text">{card.headline}</p>

      <div className="mt-2">
        <p className="text-small font-strong text-text-muted">{W.checks}</p>
        <ul className="mt-1 space-y-1">
          {card.checks.map((c, i) => {
            const m = MARK[c.mark]
            const Icon = m.icon
            return (
              <li key={i} data-mark={c.mark} className="flex items-start gap-1.5 text-body text-text">
                <Icon size={15} weight="fill" aria-hidden className={`mt-0.5 shrink-0 ${m.className}`} />
                <span className="min-w-0 flex-1">
                  <span>{c.label}</span>
                  <span className={`ml-1.5 font-strong ${m.className}`}>{BROWSER_CARD_MARK_WORDS[c.mark]}</span>
                  {c.mark === 'ng' && c.fields.length > 0 && <span className="ml-1 text-small text-text-muted">（違う・同じままの項目：{c.fields.join('、')}）</span>}
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="mt-2 rounded-control border border-[color:var(--color-border)] bg-surface-raised p-2">
        <p className="text-small font-strong text-text-muted">{W.siteValues}</p>
        <dl className="mt-1">
          {card.account && <Row label={card.account.label}><Value value={card.account.value} /></Row>}
        </dl>
        {card.sections.map((s, i) => (
          <div key={i} className="mt-2">
            <p className="text-small font-strong text-text">{s.heading}</p>
            <dl>
              {s.rows.map((r, j) => (
                <Row key={j} label={r.label}>
                  {'value' in r ? <Value value={r.value} /> : <BeforeAfter row={r} />}
                </Row>
              ))}
            </dl>
          </div>
        ))}
        {view.readAt && <dl className="mt-1"><Row label={W.readAt}>{time(view.readAt)}</Row></dl>}
      </div>

      {card.notes.map((n, i) => <Callout key={i} tone="warning" className="mt-2">{n}</Callout>)}
    </section>
  )
}
