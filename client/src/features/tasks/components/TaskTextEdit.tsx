/**
 * 「件名・目的を直す」 on the task card (task version 16; tasks-ui.md "The card"): the 目的 line, and — for the
 * requester or the assignee of an open task — the title and 目的 edited in place. Saving sends only what
 * changed (`retitle`, `set_purpose`); the server decides each and keeps both in 経緯 with ［取り消す］.
 */
import { useState, type KeyboardEvent } from 'react'
import { PencilSimpleLine } from '@phosphor-icons/react'
import { normalizeRecordTitle, RECORD_TITLE_MAX } from '../../../../../shared/core/record-types'
import { Button } from '../../../shared/ui/primitives'
import { editSteps, type TextEditSteps } from '../cardActions'

const FIELD = 'w-full rounded-control border border-border-control bg-bg px-2 py-1 text-body text-text focus:border-focus-border focus:outline-none'

interface Props {
  title: string
  purpose: string | null
  canEdit: { title: boolean; purpose: boolean }
  busy: boolean
  /**
   * The member is the assignee of a request still 引き受け待ち: saving accepts it (every action of the assignee does,
   * records.md "Acceptance"), so the form says so before the press.
   */
  accepts: boolean
  /** The changes to send; a refusal's words, or null when saved. */
  onSave: (steps: TextEditSteps) => Promise<string | null>
}

export function TaskTextEdit({ title, purpose, canEdit, busy, accepts, onSave }: Props) {
  const [draft, setDraft] = useState<{ title: string; purpose: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const may = canEdit.title || canEdit.purpose
  const close = () => { setDraft(null); setError(null) }
  const save = async () => {
    if (!draft) return
    const steps = editSteps({ title, purpose }, draft, canEdit)
    if (steps.length === 0) { close(); return }
    // The title rule only when the title is sent: a 目的 alone saves under a title stored before the rule.
    const renamed = steps.find(s => s.action === 'retitle')
    if (renamed && 'error' in normalizeRecordTitle(renamed.args.title)) { setError(`件名は1行・${RECORD_TITLE_MAX}文字までで書いてください`); return }
    const failure = await onSave(steps)
    if (failure === null) close()
    else setError(failure)
  }
  // Enter saves the title (never while an IME is converting); Esc leaves without saving.
  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save() }
    if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  if (!draft) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {purpose && <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-body text-text-muted"><span className="mr-1.5 text-caption font-normal text-text-subtle">目的</span>{purpose}</p>}
        {may && (
          <button type="button" disabled={busy} data-edit-text onClick={() => setDraft({ title, purpose: purpose ?? '' })}
            className="inline-flex items-center gap-0.5 rounded-small text-small text-link hover:underline disabled:opacity-disabled">
            <PencilSimpleLine size={12} />件名・目的を直す
          </button>
        )}
      </div>
    )
  }
  return (
    <form data-text-edit aria-label="件名・目的を直す" className="space-y-2 rounded-card border border-[color:var(--color-border)] bg-surface-raised p-3"
      onSubmit={e => { e.preventDefault(); void save() }}>
      {canEdit.title && (
        <label className="block space-y-1">
          <span className="text-caption font-normal text-text-muted">件名</span>
          <input aria-label="件名" autoFocus value={draft.title} maxLength={RECORD_TITLE_MAX} onKeyDown={onTitleKey}
            onChange={e => setDraft({ ...draft, title: e.target.value.replace(/[\r\n]+/g, ' ') })} className={FIELD} />
        </label>
      )}
      {canEdit.purpose && (
        <label className="block space-y-1">
          <span className="text-caption font-normal text-text-muted">目的</span>
          <textarea aria-label="目的" rows={3} value={draft.purpose} autoFocus={!canEdit.title}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close() } }}
            onChange={e => setDraft({ ...draft, purpose: e.target.value })} className={FIELD} />
        </label>
      )}
      {accepts && <p data-edit-accepts className="text-small text-text-muted">保存すると、このやることを引き受けたことになります。</p>}
      {error && <p role="alert" className="text-small text-danger-text">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={close}>やめる</Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>保存</Button>
      </div>
    </form>
  )
}
