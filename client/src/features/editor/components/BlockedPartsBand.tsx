// The band over an HTML document that wanted parts from the internet (doc-frame.md "The band of
// blocked internet parts (A3)"): it only says so — nothing is loaded from here. Hosts only (main
// never hands over an address). Not a `status` / `alert`: the viewer would read it as an overlay.
import { useState } from 'react'
import { GlobeHemisphereWest, X } from '@phosphor-icons/react'
import { DOC_BLOCKED_HOSTS_MAX, DOC_BLOCKED_PARTS_MAX, type DocBlockedParts } from '../../../../shared/doc-frame'

const BAND_BUTTON = 'inline-flex items-center gap-1 h-control-sm px-control-sm-x rounded-control border border-warning-border text-small text-warning-text hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring'

interface BlockedPartsBandProps {
  parts: DocBlockedParts
  onDismiss: () => void
  /** ［AI に直してもらう］: puts a request in the chat's input (absent where no chat can take it). */
  onAskAi?: () => void
}

export function BlockedPartsBand({ parts, onDismiss, onAskAi }: BlockedPartsBandProps) {
  const [open, setOpen] = useState(false)
  const count = parts.count >= DOC_BLOCKED_PARTS_MAX ? `${DOC_BLOCKED_PARTS_MAX} 件以上` : `${parts.count} 件`
  return (
    <div role="region" aria-label="インターネットの部品" data-testid="blocked-parts-band" className="flex-shrink-0 flex items-start gap-2 px-3 py-2 border-b border-warning-border bg-warning-bg text-small text-warning-text">
      <GlobeHemisphereWest size={14} aria-hidden className="mt-0.5 flex-shrink-0 text-warning-icon" />
      <div className="flex-1 min-w-0">
        <p><b>この資料はインターネットから部品を {count}読み込もうとしています。</b>会社の情報が外に出ないよう、読み込まずに表示しています（見た目が少し違うことがあります）。</p>
        {open && (
          <div id="blocked-parts-details" className="mt-1">
            <p>止めたもの（読み込み先）：</p>
            <ul className="mt-0.5 ml-4 list-disc">
              {parts.hosts.map(host => <li key={host}><code className="break-all">{host}</code></li>)}
              {parts.hosts.length >= DOC_BLOCKED_HOSTS_MAX && <li>ほかにもあります</li>}
            </ul>
            <p className="mt-1">AI に「インターネットの部品を使わずに作り直して」と頼むと、そのまま表示できます。いつもそうしたいときは、会社の AI への指示に「HTML は 1 つのファイルにまとめ、インターネットの部品を使わない」と書いておくと、この帯はほとんど出なくなります。</p>
          </div>
        )}
      </div>
      <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
        <button type="button" className={BAND_BUTTON} aria-expanded={open} aria-controls="blocked-parts-details" onClick={() => setOpen(!open)}>止めたもの</button>
        {onAskAi && <button type="button" className={BAND_BUTTON} onClick={onAskAi}>AI に直してもらう</button>}
        <button type="button" className="inline-flex items-center justify-center h-control-sm px-1 rounded-control text-warning-text hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring" aria-label="この帯を閉じる" title="この帯を閉じる" onClick={onDismiss}>
          <X size={14} aria-hidden />
        </button>
      </div>
    </div>
  )
}
