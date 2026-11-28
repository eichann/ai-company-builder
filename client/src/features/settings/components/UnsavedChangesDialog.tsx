// 「まだ保存していない変更があります」: asked before the settings close (or a section that would drop
// its input is left). Names what is unsaved, never a value; ［戻る］ is where focus starts.
import { useRef } from 'react'
import { SpinnerGap } from '@phosphor-icons/react'
import { Dialog, DialogFooter, DialogTitle } from '../../../shared/ui/Dialog'
import { Button } from '../../../shared/ui/primitives'

export function UnsavedChangesDialog({ what, verb, saving, onSave, onDiscard, onBack }: {
  /** Each unsaved part, in the member's words. */
  what: readonly string[]
  /** 「閉じる」 or 「移る」. */
  verb: string
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onBack: () => void
}) {
  const backRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog onClose={onBack} dismissible={!saving} labelledBy="unsaved-title" describedBy="unsaved-body" initialFocus={backRef} size="md">
      <DialogTitle id="unsaved-title">まだ保存していない変更があります</DialogTitle>
      <div id="unsaved-body" className="mt-2 space-y-2 text-body leading-relaxed text-text-muted">
        <ul className="list-disc space-y-0.5 pl-5">{what.map(w => <li key={w}>{w}</li>)}</ul>
        <p>保存しないで{verb}と、入力した内容は消えます。</p>
      </div>
      <DialogFooter>
        <Button ref={backRef} onClick={onBack} disabled={saving}>戻る</Button>
        <Button onClick={onDiscard} disabled={saving}>保存しないで{verb}</Button>
        <Button variant="primary" onClick={onSave} disabled={saving}>
          {saving && <SpinnerGap size={14} className="animate-spin" />}保存して{verb}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
