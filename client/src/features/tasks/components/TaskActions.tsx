// The card's actions keep their open form (note, whose OK, a new due) in one component: only one
// form is open at a time and each sends the version the card shows.
import { useState } from 'react'
import type { TaskCardAction, TaskCardData } from '../../../../shared/task-card'
import type { TaskActInput } from '../../../../shared/tasks'
import { postponeChoices, dueText, type CompanyNow } from '../model'

const BUTTON = 'rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800'
const PRIMARY = 'rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50'
/** The order members meet them in; anything else follows in the type's order. */
const ORDER = ['accept', 'take_over', 'start', 'complete', 'set_due', 'wait', 'request_review', 'decline', 'assign', 'cancel', 'reopen', 'send_back']
const PRIMARY_ACTIONS = new Set(['accept', 'complete', 'take_over'])

/** Words that say what a button will do, where the type's label alone would not. */
function buttonText(a: TaskCardAction): string {
  if (a.action === 'set_due') return '延ばす'
  if (a.action === 'complete' && a.needsOk) return '完了にする（OK をもらった）'
  return a.title
}

interface Props {
  card: TaskCardData
  now: CompanyNow
  busy: boolean
  /** Runs the steps in order (each at the version the one before moved it to); null = done, else the reason. */
  onRun: (steps: Array<Omit<TaskActInput, 'expectedVersion'>>) => Promise<string | null>
}

export function TaskActions({ card, now, busy, onRun }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [okBy, setOkBy] = useState('')
  const [okNote, setOkNote] = useState('')
  const [args, setArgs] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const actions = [...card.actions].sort((a, b) => (ORDER.indexOf(a.action) + 1 || 99) - (ORDER.indexOf(b.action) + 1 || 99))
  if (actions.length === 0) return null

  const close = () => { setOpen(null); setNote(''); setOkBy(''); setOkNote(''); setArgs({}); setError(null) }
  const run = async (a: TaskCardAction, extra: Partial<TaskActInput> = {}) => {
    setError(null)
    const step: Omit<TaskActInput, 'expectedVersion'> = { action: a.action, ...(note.trim() ? { note: note.trim() } : {}), ...extra }
    const failure = await onRun(a.startFirst ? [{ action: 'start' }, step] : [step])
    if (failure) setError(failure)
    else close()
  }
  const needsForm = (a: TaskCardAction) => a.noteRequired || a.needsOk || a.args.length > 0
  const current = actions.find(a => a.action === open) ?? null
  const argValue = (a: TaskCardAction) => Object.fromEntries(a.args.map(x => [x.name, x.kind === 'tags'
    ? (args[x.name] ?? '').split(/[、,\s]+/).filter(Boolean)
    : x.kind === 'date' ? (args[x.name] ?? '').slice(0, 16) || null : (args[x.name] ?? '') || null]))

  return (
    <section aria-label="操作" className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.map(a => (
          <button
            key={a.action} type="button" disabled={busy} aria-expanded={needsForm(a) ? open === a.action : undefined}
            onClick={() => (needsForm(a) ? (open === a.action ? close() : (close(), setOpen(a.action))) : void run(a))}
            className={PRIMARY_ACTIONS.has(a.action) ? PRIMARY : BUTTON}
          >
            {buttonText(a)}
          </button>
        ))}
      </div>
      {current && (
        <div className="space-y-2 rounded-lg border border-gray-200 p-3 text-[12px] dark:border-zinc-700" role="group" aria-label={buttonText(current)}>
          {current.action === 'set_due' && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                {postponeChoices(now).map(c => (
                  <button key={c.label} type="button" disabled={busy} onClick={() => void run(current, { args: { due: c.due } })} className={BUTTON}>
                    {c.label}（{dueText(c.due, now)}）
                  </button>
                ))}
              </div>
              {card.roles.assignee && !card.roles.requester && <p className="text-[11px] text-gray-500">頼んだ人に知らせます。前の期限は経緯に残ります。</p>}
            </div>
          )}
          {current.needsOk && (
            <div className="space-y-1.5">
              <p className="font-medium">誰の OK で完了にしますか？</p>
              <select aria-label="OK をくれた人" value={okBy} onChange={e => setOkBy(e.target.value)} className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-zinc-600">
                <option value="">ACB にいない人（下にひとこと）</option>
                {card.people.map(p => <option key={p.id} value={p.id}>{p.name}さん</option>)}
              </select>
              <input aria-label="OK のいきさつ" value={okNote} onChange={e => setOkNote(e.target.value)} placeholder="例：先方からメールで了承" className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-zinc-600" />
              <p className="text-[11px] text-gray-500">OK をくれた人に「あなたの OK で完了にしました」と届き、その人は取り消せます。</p>
            </div>
          )}
          {current.args.map(x => (
            <label key={x.name} className="block space-y-1">
              <span className="text-gray-600 dark:text-zinc-300">{x.label}</span>
              {x.kind === 'person' ? (
                <select value={args[x.name] ?? ''} onChange={e => setArgs(v => ({ ...v, [x.name]: e.target.value }))} className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-zinc-600">
                  <option value="">選んでください</option>
                  {card.people.map(p => <option key={p.id} value={p.id}>{p.name}さん</option>)}
                </select>
              ) : (
                <input
                  type={x.kind === 'date' ? 'datetime-local' : 'text'} value={args[x.name] ?? ''}
                  onChange={e => setArgs(v => ({ ...v, [x.name]: e.target.value }))}
                  className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-zinc-600"
                />
              )}
            </label>
          ))}
          {(current.noteRequired || current.action === 'decline') && (
            <textarea
              aria-label="理由" value={note} onChange={e => setNote(e.target.value)} rows={2}
              placeholder={current.action === 'decline' ? '受けられない理由（頼んだ人に届きます）' : '理由（経緯に残ります）'}
              className="w-full rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-zinc-600"
            />
          )}
          {(
            <div className="flex gap-2">
              <button
                type="button" className={PRIMARY}
                disabled={busy || (current.noteRequired && !note.trim()) || (current.needsOk && !okBy && !okNote.trim())
                  || current.args.some(x => x.kind === 'person' && !args[x.name])}
                onClick={() => void run(current, {
                  ...(current.args.length > 0 ? { args: argValue(current) } : {}),
                  ...(current.needsOk ? { ok: { ...(okBy ? { by: okBy } : {}), ...(okNote.trim() ? { note: okNote.trim() } : {}) } } : {}),
                })}
              >
                {buttonText(current)}
              </button>
              <button type="button" className={BUTTON} onClick={close}>やめる</button>
            </div>
          )}
          {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
      {!current && error && <p role="alert" className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
    </section>
  )
}
