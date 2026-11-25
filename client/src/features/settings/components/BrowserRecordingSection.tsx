// Settings › 「ブラウザ操作」 › 「記録する」 (agent-browser.md "Recording"): record the work once in a site's window, then look
// through the lines (ページ → 押した → 入力した → 送った), delete what is not wanted and send it to the company.
import { Button, Callout, Card } from '../../../shared/ui/primitives'
import { BROWSER_RECORDING_APP_WORDS as W, type BrowserRecordingView } from '../../../../shared/browser-recorder'
import type { BrowserSiteView } from '../../../../shared/browser-operation'
import { useBrowserRecording } from '../hooks/useBrowserRecording'

export function BrowserRecordingSection({ companyId, sites }: { companyId: string; sites: BrowserSiteView[] }) {
  const rec = useBrowserRecording(companyId)
  const view = rec.view

  return (
    <section ref={rec.loadRef} aria-label={W.record}>
      <Card className="space-y-3 p-5">
        <p className="font-strong text-body text-text">{W.record}</p>
        {(!view || view.state === 'none') && (
          <>
            <p className="text-small text-text-muted">{W.recordNote}</p>
            <div className="flex flex-wrap gap-2">
              {sites.map(site => (
                <Button key={site.host} size="sm" variant="secondary" disabled={rec.busy || !view} onClick={() => void rec.start(site.host)}>
                  {`${W.record}：${site.host}`}
                </Button>
              ))}
            </div>
            {view?.message && <p role="status" className="text-small text-text-muted">{view.message}</p>}
          </>
        )}
        {view?.state === 'recording' && (
          <>
            <p role="status" className="text-body text-text">{W.recording(view.host, view.lines)}</p>
            {view.full && <Callout tone="warning">{W.full}</Callout>}
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={rec.busy} onClick={() => void rec.stop()}>{W.stop}</Button>
              <Button size="sm" variant="ghost" disabled={rec.busy} onClick={() => void rec.discard()}>{W.discard}</Button>
            </div>
          </>
        )}
        {view?.state === 'review' && <Review view={view} busy={rec.busy} onRemove={rec.removeLine} onSend={rec.send} onDiscard={rec.discard} />}
        {rec.message && <Callout tone="danger">{rec.message}</Callout>}
      </Card>
    </section>
  )
}

function Review({ view, busy, onRemove, onSend, onDiscard }: {
  view: Extract<BrowserRecordingView, { state: 'review' }>
  busy: boolean
  onRemove: (id: number) => void
  onSend: () => void
  onDiscard: () => void
}) {
  return (
    <>
      <p className="font-strong text-body text-text">{`${W.reviewTitle}（${view.host}）`}</p>
      <p className="text-small text-text-muted">{W.reviewNote}</p>
      {view.full && <Callout tone="warning">{W.full}</Callout>}
      <ol className="max-h-96 divide-y divide-border overflow-y-auto rounded-control border border-border" aria-label={W.reviewTitle}>
        {view.lines.map(line => (
          <li key={line.id} className="flex items-start gap-3 px-3 py-2">
            <span className="w-8 shrink-0 text-small text-text-muted">{line.id}</span>
            <span className="w-16 shrink-0 text-small font-strong text-text">{line.kind}</span>
            <span className="min-w-0 flex-1 break-all text-small text-text">
              {line.text}
              {line.estimated && <span className="block text-text-muted">{`（推定）${line.estimated}`}</span>}
            </span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemove(line.id)} aria-label={`${W.deleteLine} ${line.id}`}>{W.deleteLine}</Button>
          </li>
        ))}
      </ol>
      {view.message && <Callout tone="danger">{view.message}</Callout>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={onSend}>{W.send}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>{W.discard}</Button>
      </div>
    </>
  )
}
