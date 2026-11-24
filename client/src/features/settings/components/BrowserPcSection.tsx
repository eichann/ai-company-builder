// Settings › 「ブラウザ操作」 › 「この PC」 (agent-browser.md "This PC's registration"; design memo v2 §7-1): register this PC,
// see 確認待ち／使える／止めた with what to do next, and the combinations the member may use. A registration is always
// shown with its 「やめる」, also when no combination is left, so the member can stop it.
import { useState } from 'react'
import { Button, Callout, Card, StatusBadge, type StatusBadgeVariant } from '../../../shared/ui/primitives'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { BROWSER_PC_WORDS as W, type BrowserPcView } from '../../../../shared/browser-device'
import { useBrowserPc } from '../hooks/useBrowserPc'

const BADGE: Record<'pending' | 'enabled' | 'revoked', StatusBadgeVariant> = { pending: 'awaiting', enabled: 'success', revoked: 'paused' }

export function BrowserPcSection({ companyId }: { companyId: string }) {
  const pc = useBrowserPc(companyId)
  const [label, setLabel] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const view = pc.view
  const state = view?.state

  return (
    <section ref={pc.loadRef} aria-label={W.heading}>
      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-strong text-body text-text">{W.heading}</p>
          {view?.label && <p className="text-body text-text-muted">{view.label}</p>}
          {(state === 'pending' || state === 'enabled' || state === 'revoked') && <StatusBadge variant={BADGE[state]}>{W.states[state]}</StatusBadge>}
        </div>
        {view && <PcText view={view} />}
        {(state === 'none' || state === 'revoked') && view && (
          <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); void pc.register(label ?? view.suggestedLabel) }}>
            <label className="flex items-center gap-2 text-small text-text-muted">
              {W.labelField}
              <input value={label ?? view.suggestedLabel} maxLength={60} onChange={e => setLabel(e.target.value)}
                className="h-control rounded-control border border-border-control bg-bg px-2 text-body text-text focus:border-focus-border focus:outline-none" />
            </label>
            <Button size="sm" variant="primary" type="submit" disabled={pc.busy}>{state === 'revoked' ? W.registerAgain : W.register}</Button>
          </form>
        )}
        {(state === 'pending' || state === 'enabled') && (
          <Button size="sm" variant="secondary" disabled={pc.busy} onClick={() => setConfirming(true)}>{state === 'pending' ? W.withdraw : W.stop}</Button>
        )}
        {pc.message && <Callout tone="danger">{pc.message}</Callout>}
        <ConfirmDialog
          isOpen={confirming}
          danger
          title={state === 'pending' ? W.withdrawConfirmTitle : W.stopConfirmTitle}
          message={state === 'pending' ? W.withdrawConfirmMessage : W.stopConfirmMessage}
          confirmText={state === 'pending' ? W.withdraw : W.stop}
          cancelText={W.cancel}
          onConfirm={() => { setConfirming(false); void pc.withdraw() }}
          onCancel={() => setConfirming(false)}
        />
      </Card>
    </section>
  )
}

function PcText({ view }: { view: BrowserPcView }) {
  if (view.state === 'unavailable') return <Callout tone="warning">{W.unavailable}</Callout>
  if (view.state === 'unknown') return <Callout tone="offline">{W.unknown}</Callout>
  const sentence = view.state === 'none' ? W.none : view.state === 'pending' ? W.pending : view.state === 'enabled' ? W.enabled : W.revoked
  return (
    <div className="space-y-2">
      <p data-pc-sentence className="text-body text-text">{sentence}</p>
      <div>
        <p className="text-small text-text-muted">{W.linesHeading}</p>
        {view.lines.length === 0
          ? <p className="text-small text-text-muted">{W.noLines}</p>
          : (
            <ul className="list-disc pl-5 text-body text-text">
              {view.lines.map(l => <li key={l.label}>{l.label}{l.writes ? W.writes : W.readOnly}</li>)}
            </ul>
          )}
      </div>
    </div>
  )
}
