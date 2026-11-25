// Settings › 「ブラウザ操作」 › 「記録する」 (agent-browser.md "Recording"): record the work once in a site's window, then look
// through the lines (ページ → 押した → 入力した → 送った), hide names, delete what is not wanted and send it to the company.
// The sentences come from main (`notes`); this screen holds only its button words.
import { Button, Callout, Card } from '../../../shared/ui/primitives'
import { BROWSER_RECORDING_APP_WORDS as W, type BrowserRecordingEdit, type BrowserRecordingView } from '../../../../shared/browser-recorder'
import type { BrowserSiteView } from '../../../../shared/browser-operation'
import { useBrowserRecording } from '../hooks/useBrowserRecording'

const Notes = ({ notes }: { notes: string[] }) => <>{notes.map(n => <p key={n} className="text-small text-text-muted">{n}</p>)}</>

export function BrowserRecordingSection({ companyId, sites }: { companyId: string; sites: BrowserSiteView[] }) {
  const rec = useBrowserRecording(companyId)
  const view = rec.view

  return (
    <section ref={rec.loadRef} aria-label={W.record}>
      <Card className="space-y-3 p-5">
        <p className="font-strong text-body text-text">{W.record}</p>
        {(!view || view.state === 'none') && (
          <>
            {view && <Notes notes={view.notes} />}
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
            <div role="status"><Notes notes={view.notes} /></div>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={rec.busy} onClick={() => void rec.stop()}>{W.stop}</Button>
              <Button size="sm" variant="ghost" disabled={rec.busy} onClick={() => void rec.discard()}>{W.discard}</Button>
            </div>
          </>
        )}
        {view?.state === 'review' && <Review view={view} busy={rec.busy} onEdit={rec.edit} onSend={rec.send} onDiscard={rec.discard} />}
        {rec.message && <Callout tone="danger">{rec.message}</Callout>}
      </Card>
    </section>
  )
}

function Review({ view, busy, onEdit, onSend, onDiscard }: {
  view: Extract<BrowserRecordingView, { state: 'review' }>
  busy: boolean
  onEdit: (change: BrowserRecordingEdit) => void
  onSend: () => void
  onDiscard: () => void
}) {
  return (
    <>
      <p className="font-strong text-body text-text">{view.titles.lines}</p>
      <Callout tone="warning">{view.notes[0]}</Callout>
      <Notes notes={view.notes.slice(1)} />
      <ol className="max-h-96 divide-y divide-border overflow-y-auto rounded-control border border-border" aria-label={view.titles.lines}>
        {view.lines.map(line => (
          <li key={line.id} className="flex items-start gap-3 px-3 py-2">
            <span className="w-8 shrink-0 text-small text-text-muted">{line.id}</span>
            <span className="w-16 shrink-0 text-small font-strong text-text">{line.kind}</span>
            <span className="min-w-0 flex-1 break-all text-small text-text">
              {line.text}
              {line.estimated && <span className="block text-text-muted">{line.estimated}</span>}
            </span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onEdit({ kind: 'line', id: line.id })} aria-label={`${W.deleteLine} ${line.id}`}>{W.deleteLine}</Button>
          </li>
        ))}
      </ol>
      {view.words.length > 0 && (
        <div>
          <p className="text-small font-strong text-text">{view.titles.words}</p>
          <ul aria-label={view.titles.words} className="flex flex-wrap gap-2">
            {view.words.map(w => (
              <li key={w.word}>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => onEdit({ kind: 'word', word: w.word })} aria-label={`${W.hide} ${w.word}`}>
                  {w.word}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.hosts.length > 0 && (
        <div>
          <p className="text-small font-strong text-text">{view.titles.hosts}</p>
          <ul aria-label={view.titles.hosts} className="space-y-1">
            {view.hosts.map(h => (
              <li key={h.host} className="flex items-center gap-2 text-small text-text">
                <span className="min-w-0 flex-1 break-all">{h.host}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onEdit({ kind: 'host', host: h.host })} aria-label={`${W.deleteLine} ${h.host}`}>{W.deleteLine}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.message && <Callout tone="danger">{view.message}</Callout>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={onSend}>{W.send}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>{W.discard}</Button>
      </div>
    </>
  )
}
