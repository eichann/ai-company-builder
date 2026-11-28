import { memo, useState } from 'react'
import { CheckCircle, Globe, Hourglass, Info, WarningCircle } from '@phosphor-icons/react'
import { Button, Callout, StatusBadge } from '../../../shared/ui/primitives'
import { STATE_BOX, type StateBoxTone } from '../../../shared/ui/stateStyles'
import { useInterval } from '../../../shared/hooks/useInterval'
import type { BrowserPlanCardData } from '../../../../shared/browser-plans'
import { cancelBrowserPlan, confirmBrowserExecution, openBrowserSite, runBrowserPlan, type BrowserPlanOutbound, type BrowserPlanReads, type BrowserPlanWrites } from '../api'
import { useBrowserPlan } from '../hooks/useBrowserPlan'
import { PLAN_WORDS as W, notReadyText, planContent, planStatus, runResultText, type PlanTone } from '../model'

// Awaiting approval is amber, a result nobody knows is a warning (amber: the member checks it), a stop
// before sending is grey (nothing to undo), success green (design-system.md 「止まっている」の色).
const FRAME: Record<PlanTone, StateBoxTone> = { awaiting: 'awaiting', working: 'info', ok: 'ok', stopped: 'plain', unknown: 'warn' }

/** An execution still unsettled is read again this often: the server moves it on by time and the confirm opens at `confirmableAt`. */
const UNSETTLED_REFRESH_MS = 15_000

const time = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1">
      <dt className="w-28 shrink-0 text-small text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-body text-text">{children}</dd>
    </div>
  )
}

function Template({ name, body }: { name: string; body: string }) {
  return (
    <div className="mt-1 rounded-control border border-[color:var(--color-border)] bg-surface-sunken p-2">
      <p className="font-strong">{name}</p>
      {body && <p className="mt-1 whitespace-pre-wrap break-words text-small text-text-muted">{body}</p>}
    </div>
  )
}

export interface BrowserPlanCardPorts { reads?: BrowserPlanReads; outbound?: BrowserPlanOutbound; writes?: BrowserPlanWrites }

/**
 * A 「ブラウザ操作」 plan's approval card (agent-browser.md "The card, the IPC and the request tool"): opened
 * by plan id from anywhere (the chat's reply today, the inbox later). It reads the plan from the server
 * every time it is shown; what it shows is the facts the app read from the site, never the chat's text.
 * ［任せる］ sends main only the plan id and the hash of the content shown; there is no resend button.
 */
export const BrowserPlanCard = memo(function BrowserPlanCard({ companyId, planId, ports = {}, onDone }: {
  companyId: string; planId: string; ports?: BrowserPlanCardPorts
  /**
   * The plan is over here (cancelled, or the member said whether it was done): where the card is worked through a list,
   * the next one. Not after ［任せる］: what the run did is read on this card first.
   */
  onDone?: () => void
}) {
  const { card, error, reload } = useBrowserPlan(companyId, planId, ports.reads)
  const [pressed, setPressed] = useState<'run' | 'cancel' | 'confirm' | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const exec = card?.plan.execution?.state
  useInterval(() => { void reload() }, exec === 'claimed' || exec === 'permitted' || exec === 'unknown' ? UNSETTLED_REFRESH_MS : null)

  if (!card) {
    return (
      <section role="group" aria-label={W.title} className={`my-2 rounded-card border p-3 ${STATE_BOX.plain}`}>
        <p className="text-body text-text-muted">{error ?? '読み込んでいます…'}</p>
      </section>
    )
  }
  return <CardBody card={card} companyId={companyId} pressed={pressed} said={said} ports={ports} onDone={onDone}
    act={async (what, work) => {
      setPressed(what)
      setSaid(null)
      try { setSaid(await work()) } finally {
        setPressed(null)
        await reload()
      }
    }} />
})

function CardBody({ card, companyId, pressed, said, ports, act, onDone }: {
  card: BrowserPlanCardData; companyId: string; pressed: 'run' | 'cancel' | 'confirm' | null; said: string | null
  ports: BrowserPlanCardPorts; act: (what: 'run' | 'cancel' | 'confirm', work: () => Promise<string | null>) => Promise<void>
  onDone?: () => void
}) {
  const { plan, ready } = card
  const c = planContent(plan)
  const status = planStatus({ plan, runningHere: card.runningHere || pressed === 'run' }, Date.now())
  const site = plan.connector.label
  const notReady = !ready.ok ? notReadyText(ready.reason, site) : null
  const busy = pressed !== null
  const run = () => act('run', async () => {
    const r = ports.outbound ? await runBrowserPlan(companyId, plan.id, plan.contentHash, ports.outbound) : await runBrowserPlan(companyId, plan.id, plan.contentHash)
    return r.ok ? runResultText(r.result) : r.message
  })
  const cancel = () => act('cancel', async () => {
    const r = ports.writes ? await cancelBrowserPlan(companyId, plan.id, ports.writes) : await cancelBrowserPlan(companyId, plan.id)
    if (r.ok) onDone?.()
    return r.ok ? null : r.message
  })
  const confirm = (result: 'done' | 'not_done') => act('confirm', async () => {
    if (!plan.execution) return null
    const r = ports.writes ? await confirmBrowserExecution(companyId, plan.execution.id, result, ports.writes) : await confirmBrowserExecution(companyId, plan.execution.id, result)
    if (r.ok) onDone?.()
    return r.ok ? null : r.message
  })
  return (
    <section role="group" aria-label={W.title} data-plan-state={plan.state} data-plan-tone={status.tone}
      className={`my-2 rounded-card border p-3 ${STATE_BOX[FRAME[status.tone]]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Globe size={15} weight="bold" aria-hidden className="text-text-muted" />
        <span className="text-title text-text">{plan.label}</span>
        <span className="text-small text-text-muted">{site}</span>
        {status.tone === 'awaiting' && <StatusBadge variant="awaiting">承認を待っています</StatusBadge>}
      </div>
      <p role="status" className="mt-1 text-body text-text">{pressed === 'run' ? '確かめています…（終わるまで、この窓を閉じないでください）' : status.line}</p>

      <div className="mt-2 rounded-control border border-[color:var(--color-border)] bg-surface-raised p-2">
        <p className="text-small font-strong text-text-muted">{W.factsHeading}</p>
        <dl className="mt-1">
          {c.account && <Row label="アカウント">{c.account}</Row>}
          <Row label="リマインダ">{c.reminder ?? '（読み取れませんでした）'}</Row>
          <Row label="段">{c.step ?? '（読み取れませんでした）'}</Row>
          <Row label="いまのテンプレート">
            {c.onStep.length === 0 ? <span className="text-text-muted">ありません</span> : c.onStep.map(t => <Template key={t.id} name={t.name} body={t.body} />)}
          </Row>
          <Row label="足すテンプレート">{c.toAdd ? <Template name={c.toAdd.name} body={c.toAdd.body} /> : '（読み取れませんでした）'}</Row>
          <Row label="届く時">
            <span>{c.timing ?? '（読み取れませんでした）'}</span>
            {plan.delivers === 'scheduled' && <span className="mt-0.5 block text-small text-text-muted">{W.scheduled}</span>}
          </Row>
          <Row label="これから届く人数">
            {c.audience.known
              ? <span>{c.audience.count}人</span>
              : <span data-audience="unknown" className="inline-flex items-center gap-1 text-warning-text"><WarningCircle size={13} weight="fill" aria-hidden className="text-warning-icon" />{W.audienceUnknown}</span>}
          </Row>
          {c.sharedWith && <Row label="使っている回">{c.sharedWith.count}回{c.sharedWith.items.length > 0 && `（${c.sharedWith.items.join('、')}${c.sharedWith.items.length < c.sharedWith.count ? 'ほか' : ''}）`}</Row>}
          {c.readAt && <Row label="読み取った時刻">{time(c.readAt)}</Row>}
        </dl>
      </div>

      {plan.sharedNote && <Callout tone="warning" className="mt-2">{plan.sharedNote}</Callout>}

      {plan.explanation && (
        <div className="mt-2">
          <p className="text-small text-text-muted">{W.explanationHeading}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-small text-text-muted">{plan.explanation}</p>
        </div>
      )}

      {status.check && <p className="mt-2 text-body text-text">{status.check}</p>}
      {status.tone === 'unknown' && card.stoppedHere && (
        <p className="mt-1 flex items-start gap-1 text-small text-text-muted"><Info size={13} aria-hidden className="mt-0.5 shrink-0" />{W.stoppedHere}</p>
      )}

      {status.awaiting && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={busy || !ready.ok} onClick={() => void run()}>{W.run}</Button>
          <Button size="sm" disabled={busy} onClick={() => void cancel()}>{W.cancel}</Button>
          {!ready.ok && ready.reason === 'no-window' && card.siteHost && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void openBrowserSite(companyId, card.siteHost as string) }}>{W.openSite}</Button>
          )}
        </div>
      )}
      {status.awaiting && notReady && <p data-not-ready={ready.ok ? '' : ready.reason} className="mt-1 text-small text-text-muted">{notReady}</p>}
      {status.cancelOnly && <div className="mt-3"><Button size="sm" disabled={busy} onClick={() => void cancel()}>{W.cancel}</Button></div>}
      {status.canConfirm && plan.execution && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void confirm('done')}><CheckCircle size={13} aria-hidden />{W.done}</Button>
          <Button size="sm" disabled={busy} onClick={() => void confirm('not_done')}>{W.notDone}</Button>
        </div>
      )}
      {status.confirmFrom && <p className="mt-1 flex items-center gap-1 text-small text-text-muted"><Hourglass size={12} aria-hidden />{status.confirmFrom}</p>}
      {status.noResend && <p className="mt-2 text-small text-text-muted">{W.noResend}</p>}
      {said && <p role="alert" className="mt-2 text-body text-text">{said}</p>}
    </section>
  )
}

