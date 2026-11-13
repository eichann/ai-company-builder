// A 案件・プロジェクト's own buttons beside its title (owner FB #30): the main one (［終える］, or
// ［もう一度始める］ once it is finished) and the rest in 「…」 (［やめる］, 責任者を替える, 期限を変える,
// なんのためを書く …), each from its type and only where the member's place allows it
// (`bundleActionsOf`, decided in main). The server decides every press.
import { useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { BUNDLE_ENDS_HINT, type BundleAction, type BundleActions as Actions } from '../../../../shared/record-details'
import { MoreMenu } from '../../../shared/ui/MoreMenu'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'

const FIELD = 'w-full rounded border border-gray-300 bg-transparent px-2 py-1 text-[12.5px] dark:border-zinc-600'

export interface BundleActInput { note?: string; args?: Record<string, string> }

interface Props {
  actions: Actions
  busy: boolean
  /** Runs one action at the card's version; null = done, else the refusal in words. */
  onAct: (action: BundleAction, input: BundleActInput) => Promise<string | null>
  /** More entries of 「…」 that are not the type's actions (「非公開にする」), after them. */
  extra?: Array<{ label: string; hint?: string; onClick: () => void }>
}

export function BundleActions({ actions, busy, onAct, extra = [] }: Props) {
  const [open, setOpen] = useState<BundleAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const press = async (a: BundleAction) => {
    if (busy) return
    setError(null)
    // A window when there is something to fill in or a reason to offer; else one press.
    if (a.args.length > 0 || a.noteRequired || a.noteOffered) setOpen(a)
    else setError(await onAct(a, {}))
  }
  const { main, more } = actions
  return <>
    {main && <button type="button" disabled={busy} onClick={() => void press(main)} className={MAIN_BUTTON}>{main.ends && <CheckCircle size={13} weight="fill" />}{main.title}</button>}
    <MoreMenu compact items={[...more.map(a => ({ label: a.title, ...(a.ends ? { hint: BUNDLE_ENDS_HINT } : {}), onClick: () => { void press(a) } })), ...extra]} />
    {error && <p role="alert" className="basis-full text-[12px] text-red-600 dark:text-red-400">{error}</p>}
    {open && <BundleActionDialog action={open} people={actions.people} busy={busy} onClose={() => setOpen(null)} onAct={onAct} />}
  </>
}

/** What an action asks for: its values (prefilled with what the record holds now) and a reason where the type offers one. */
function BundleActionDialog({ action, people, busy, onClose, onAct }: { action: BundleAction; people: Actions['people']; busy: boolean; onClose: () => void; onAct: Props['onAct'] }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(action.args.map(x => [x.name, x.kind === 'date' ? (x.value ?? '').slice(0, 10) : x.value ?? ''])))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ready = action.args.every(x => (values[x.name] ?? '').trim() !== '') && !(action.noteRequired && !note.trim())
  const run = async () => {
    const input: BundleActInput = {
      ...(action.args.length > 0 ? { args: Object.fromEntries(action.args.map(x => [x.name, values[x.name].trim()])) } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    }
    const failure = await onAct(action, input)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/25" onClick={onClose}>
      <div role="dialog" aria-label={action.title} onClick={e => e.stopPropagation()} className="w-[420px] space-y-3 rounded-xl bg-white p-4 text-[13px] text-gray-800 shadow-2xl dark:bg-zinc-800 dark:text-zinc-100">
        <div className="text-[14px] font-semibold">{action.title}</div>
        {action.ends && <p className="text-[12.5px] text-gray-600 dark:text-zinc-300">{BUNDLE_ENDS_HINT}</p>}
        {action.args.map(x => (
          <label key={x.name} className="block space-y-1">
            <span className="text-[12px] text-gray-600 dark:text-zinc-300">{x.label}</span>
            {x.kind === 'person' ? (
              <select aria-label={x.label} value={values[x.name] ?? ''} onChange={e => setValues(v => ({ ...v, [x.name]: e.target.value }))} className={FIELD}>
                <option value="">選んでください</option>
                {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : (
              <input aria-label={x.label} type={x.kind === 'date' ? 'date' : 'text'} value={values[x.name] ?? ''} onChange={e => setValues(v => ({ ...v, [x.name]: e.target.value }))} className={FIELD} />
            )}
          </label>
        ))}
        {(action.noteRequired || action.noteOffered) && (
          <textarea aria-label="理由" value={note} onChange={e => setNote(e.target.value)} rows={2}
            placeholder={action.noteRequired ? '理由（経緯に残ります）' : '理由（なくてもかまいません。経緯に残ります）'} className={FIELD} />
        )}
        {error && <p role="alert" className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={SMALL_BUTTON}>やめておく</button>
          <button type="button" disabled={busy || !ready} onClick={() => void run()} className={MAIN_BUTTON}>{action.title}</button>
        </div>
      </div>
    </div>
  )
}
