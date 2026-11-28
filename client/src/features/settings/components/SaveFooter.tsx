// The 保存 row under a settings section that keeps a draft (the .env keys, 同期しないファイル): says when
// something is not saved yet, or where it is saved, and shows 保存しました for a moment.
import { useState, type ReactNode } from 'react'
import { Check, SpinnerGap } from '@phosphor-icons/react'
import { Button } from '../../../shared/ui/primitives'

interface Props {
  dirty: boolean
  error: string | null
  /** null = saved; else why not. */
  save: () => Promise<string | null>
  onError: (error: string | null) => void
  /** Shown when nothing is waiting: where the values are kept. */
  where: ReactNode
}

export function SaveFooter({ dirty, error, save, onError, where }: Props) {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const press = async () => {
    setSaving(true)
    onError(null)
    try {
      const failed = await save()
      if (failed) onError(failed)
      else { setSaved(true); setTimeout(() => setSaved(false), 2000) }
    } catch (e) {
      onError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="sticky bottom-0 flex items-center justify-between gap-4 border-t border-[color:var(--color-border)] bg-surface-raised px-8 py-3">
      {error ? (
        <p role="alert" className="text-body text-danger-text">{error}</p>
      ) : dirty ? (
        <p role="status" className="min-w-0 truncate text-small text-warning-text">まだ保存していません。保存すると反映されます。</p>
      ) : (
        <p className="min-w-0 truncate text-small text-text-muted">{where}</p>
      )}
      <Button variant="primary" onClick={() => void press()} disabled={saving} className="shrink-0">
        {saving ? <><SpinnerGap size={14} className="animate-spin" />保存中…</> : saved && !dirty ? <><Check size={14} />保存しました</> : '保存'}
      </Button>
    </div>
  )
}
