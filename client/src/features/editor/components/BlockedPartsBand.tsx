// The band over an HTML document that wanted parts from the internet (doc-frame.md "The band of
// blocked internet parts (A3)"): it only says so — nothing is loaded from here. Hosts only (main
// never hands over an address). Its Google Drive videos are listed too, each opened in the member's
// browser by main (counts only here). Not a `status` / `alert`: the viewer would read it as an overlay.
import { useState } from 'react'
import { ArrowSquareOut, GlobeHemisphereWest, VideoCamera, X } from '@phosphor-icons/react'
import { DOC_BLOCKED_HOSTS_MAX, DOC_BLOCKED_PARTS_MAX, type DocBlockedParts, type DocDriveVideos } from '../../../../shared/doc-frame'

const BAND_BUTTON = 'inline-flex items-center gap-1 h-control-sm px-control-sm-x rounded-control border border-warning-border text-small text-warning-text hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring'

interface BlockedPartsBandProps {
  /** What the page wanted from the internet; its sentence shows only when something was (`count` > 0). */
  parts: DocBlockedParts | null
  /** The Google Drive videos its document embeds; their part shows only when there are some. */
  driveVideos?: DocDriveVideos | null
  /** ［ブラウザで開く］ on the `index`-th video (main opens Drive's own page for it). */
  onOpenDriveVideo?: (index: number) => void
  onDismiss: () => void
  /** ［AI に直してもらう］: puts a request in the chat's input (absent where no chat can take it). */
  onAskAi?: () => void
}

export function BlockedPartsBand({ parts, driveVideos = null, onOpenDriveVideo, onDismiss, onAskAi }: BlockedPartsBandProps) {
  const [open, setOpen] = useState(false)
  const showParts = parts !== null && parts.count > 0
  const videoRows = driveVideos && driveVideos.count > 0 ? Array.from({ length: driveVideos.count }, (_, i) => i) : []
  return (
    <div role="region" aria-label={showParts ? 'インターネットの部品' : '資料の中の動画'} data-testid="blocked-parts-band" className="flex-shrink-0 flex items-start gap-2 px-3 py-2 border-b border-warning-border bg-warning-bg text-small text-warning-text">
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        {showParts && (
          <div className="flex items-start gap-2">
            <GlobeHemisphereWest size={14} aria-hidden className="mt-0.5 flex-shrink-0 text-warning-icon" />
            <div className="flex-1 min-w-0">
              <p><b>この資料はインターネットから部品を {parts.count >= DOC_BLOCKED_PARTS_MAX ? `${DOC_BLOCKED_PARTS_MAX} 件以上` : `${parts.count} 件`}読み込もうとしています。</b>会社の情報が外に出ないよう、読み込まずに表示しています（見た目が少し違うことがあります）。</p>
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
            </div>
          </div>
        )}
        {driveVideos && videoRows.length > 0 && (
          <div data-testid="drive-videos" className="flex items-start gap-2">
            <VideoCamera size={14} aria-hidden className="mt-0.5 flex-shrink-0 text-warning-icon" />
            <div className="flex-1 min-w-0">
              <p><b>この資料には Google Drive の動画が {Math.max(driveVideos.total, driveVideos.count)} 本あります。</b>資料の中では再生できないので、ブラウザで開いて見てください。</p>
              <ul aria-label="Google Drive の動画" className="mt-1 flex flex-col gap-1">
                {videoRows.map(index => (
                  <li key={index} className="flex items-center gap-2">
                    <span>動画 {index + 1}</span>
                    <button type="button" className={BAND_BUTTON} aria-label={`動画 ${index + 1} をブラウザで開く`} onClick={() => onOpenDriveVideo?.(index)}>
                      <ArrowSquareOut size={12} aria-hidden />ブラウザで開く
                    </button>
                  </li>
                ))}
                {driveVideos.total > driveVideos.count && <li>ほかにもあります</li>}
              </ul>
            </div>
          </div>
        )}
      </div>
      <button type="button" className="inline-flex flex-shrink-0 items-center justify-center h-control-sm px-1 rounded-control text-warning-text hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring" aria-label="この帯を閉じる" title="この帯を閉じる" onClick={onDismiss}>
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}
