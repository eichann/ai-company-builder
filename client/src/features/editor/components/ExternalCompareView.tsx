import { useState } from 'react'
import { Button, Callout } from '../../../shared/ui/primitives'
import type { ReviewFrameSlot } from '../reviewFrameSlot'

interface ExternalCompareViewProps {
  /** The line diff, handed in by the screen (the review frame's: reviewFrameSlot.ts). */
  diff: ReviewFrameSlot['diff']
  /** The version that arrived on disk, as shown here: a press acts on this one only. */
  arrived: string
  /** The tab's edits. */
  mine: string
  /** The file changed again while the member was comparing (the view was redrawn). */
  changedAgain: boolean
  onSaveMine: (compared: string) => Promise<unknown>
  onTakeArrived: (compared: string) => Promise<unknown>
}

/**
 * The version that arrived next to the tab's edits, and the two choices — each
 * done in one press, the version not picked kept in the backups first
 * (files-and-editor.md "External changes to open files").
 */
export function ExternalCompareView({ diff, arrived,mine, changedAgain, onSaveMine, onTakeArrived }: ExternalCompareViewProps) {
  const [busy, setBusy] = useState(false)
  const choose = (pick: (compared: string) => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    void pick(arrived).finally(() => setBusy(false))
  }
  return (
    <div className="h-full flex flex-col" data-testid="external-compare">
      <div className="flex-shrink-0 px-4 py-1.5 border-b border-border text-caption font-normal text-text-muted">
        <span className="text-danger-text">−</span> 届いた版／
        <span className="text-success-text">＋</span> あなたの編集（未保存）
      </div>
      {changedAgain && (
        <Callout tone="warning" role="alert" className="mx-4 mt-3 flex-shrink-0">
          比べている間に、ファイルがまた変わりました。新しい内容で比べ直したので、もう一度選んでください。
        </Callout>
      )}
      <div className="flex-1 min-h-0 overflow-hidden">
        {diff({
          snapshot: arrived,
          current: mine,
          noChangesMessage: '届いた版とあなたの編集に違いはありません',
        })}
      </div>
      <div className="flex-shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-t border-border bg-surface-sunken">
        <p className="min-w-0 flex-1 text-small text-text-muted">どちらにしても、選ばなかった方は［バックアップ履歴］に残ります。</p>
        <div className="flex flex-col items-center gap-1">
          <Button variant="secondary" disabled={busy} onClick={() => choose(onTakeArrived)}>届いた版を採用</Button>
          <span className="text-caption text-text-muted">あなたの編集はバックアップへ</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <Button variant="primary" disabled={busy} onClick={() => choose(onSaveMine)}>自分の版を保存</Button>
          <span className="text-caption text-text-muted">届いた版はバックアップへ</span>
        </div>
      </div>
    </div>
  )
}
