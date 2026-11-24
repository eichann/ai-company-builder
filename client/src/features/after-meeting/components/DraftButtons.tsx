// The proposal draft's buttons (S4 P2–P4): ［作り直す］ with a hint, ［共有に出す］ (who sees it is asked first, in the consultation),
// ［いらない］ (folds these buttons on this PC; no correction is recorded — 「早すぎた」 is the common part's ［まだ早かった］).
import { useState } from 'react'
import { Button } from '../../../shared/ui/primitives'
import { InputDialog } from '../../../shared/ui/InputDialog'

export function DraftButtons({ disabled, onRedo, onShare, onDismiss }: { disabled: boolean; onRedo: (hint: string) => void; onShare: () => void; onDismiss: () => Promise<void> }) {
  const [asking, setAsking] = useState(false)
  return (
    <div role="group" aria-label="提案書のたたき台" className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
      <span className="text-text-muted">提案書のたたき台：</span>
      <Button size="sm" disabled={disabled} onClick={() => setAsking(true)}>作り直す</Button>
      <Button size="sm" disabled={disabled} onClick={onShare}>共有に出す</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void onDismiss()}>いらない</Button>
      {asking && (
        <InputDialog isOpen title="作り直すときのヒント（例：価格は月額で）" placeholder="例：価格は月額で" confirmText="作り直す"
          onCancel={() => setAsking(false)} onConfirm={hint => { setAsking(false); onRedo(hint) }} />
      )}
    </div>
  )
}
