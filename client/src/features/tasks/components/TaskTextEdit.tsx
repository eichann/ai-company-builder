/**
 * The task card's 件名 and 目的, corrected where they are shown (task version 16; tasks-ui.md "The card"): the title
 * through RecordPage's `titleEdit`, 目的 as its own line under the title (or a quiet 「目的を書く」). One place decides
 * what is sent (`cardActions.ts` `saveTaskText`): only a changed value (`editSteps`), the title only under the core's title rule; the
 * server decides each and keeps it in 経緯 with ［取り消す］.
 */
import { InlineText } from '../../../shared/ui/InlineText'
import { ACCEPTS_NOTE, saveTaskText, type TaskText, type TextEditSteps } from '../cardActions'

/** 目的 under the title: pressed, it is a field in the same place; empty, a quiet 「目的を書く」 for who may write it. */
export function TaskPurpose({ now, may, busy, accepts, onSave }: { now: TaskText; may: boolean; busy: boolean; accepts: boolean; onSave: (steps: TextEditSteps) => Promise<string | null> }) {
  const { purpose } = now
  const label = <span className="mr-1.5 text-caption font-normal text-text-subtle">目的</span>
  if (!may) return purpose ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-body text-text-muted">{label}{purpose}</p> : null
  return (
    <div data-purpose className="text-body">
      <InlineText value={purpose ?? ''} label={purpose ? '目的を直す' : '目的を書く'} fieldLabel="目的" multiline busy={busy}
        {...(accepts ? { note: ACCEPTS_NOTE } : {})} className={purpose ? 'text-body text-text-muted' : 'text-small text-text-subtle hover:text-link'}
        onSave={draft => saveTaskText(now, 'purpose', draft, may, onSave)}>
        {purpose ? <>{label}{purpose}</> : '目的を書く'}
      </InlineText>
    </div>
  )
}
