// The card's one main action and its 「…」 (新しい画面のデモ C): the open form (whose OK, a
// reason, a person) stays in this component, one at a time, each sending the version the card shows.
import { useState } from 'react'
import { CheckCircle, Eye } from '@phosphor-icons/react'
import type { TaskCardAction, TaskCardData } from '../../../../shared/task-card'
import type { TaskActInput } from '../../../../shared/tasks'
import { MoreMenu } from '../../../shared/ui/MoreMenu'
import { Chip, MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { actionHint, actionText, doneWords, leavingWords, LEAVING_ACTIONS, placeActions } from '../cardActions'
import { WaitDialog } from './WaitParts'

const FIELD = 'w-full rounded border border-gray-300 bg-transparent px-2 py-1 text-[12.5px] dark:border-zinc-600'

interface Props {
  card: TaskCardData
  busy: boolean
  /** チームの進め方 (off: one's own steps only). */
  team: boolean
  /** The company's today (`YYYY-MM-DD`): 返事待ち's chips count from it. */
  today: string
  /** Runs the steps in order; null = done, else the reason in words. `done` is said afterwards with 取り消す. */
  onRun: (steps: Array<Omit<TaskActInput, 'expectedVersion'>>, done?: string) => Promise<string | null>
}

export function TaskActions({ card, busy, team, today, onRun }: Props) {
  const [open, setOpen] = useState<TaskCardAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { main, status, more } = placeActions(card, team)

  const needsForm = (a: TaskCardAction) => a.noteRequired || a.needsOk || LEAVING_ACTIONS.has(a.action) || a.args.some(x => !(a.action === 'request_review' && x.name === 'reviewer' && card.names.reviewer))
  const press = async (a: TaskCardAction) => {
    if (needsForm(a)) { setOpen(a); return }
    setError(await onRun(steps(a, {}), doneWords(a, card)))
  }
  const mainIcon = main?.action === 'request_review' ? <Eye size={13} /> : main?.action === 'complete' || main?.action === 'accept' ? <CheckCircle size={13} weight="fill" /> : null

  return (
    <>
      {status && <Chip tone={status === '完了' ? 'green' : 'amber'}>{status === '完了' && <CheckCircle size={11} weight="fill" />}{status}</Chip>}
      {main && <button type="button" disabled={busy} onClick={() => void press(main)} className={MAIN_BUTTON}>{mainIcon}{actionText(main, card)}</button>}
      <MoreMenu compact items={more.map(a => ({
        label: actionText(a, card), hint: actionHint(a, card), danger: a.action === 'decline' || a.action === 'cancel',
        onClick: () => { if (!busy) void press(a) },
      }))} />
      {error && <p role="alert" className="basis-full text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      {open && (open.action === 'wait'
        // 返事待ち says until when too (task version 12): its own window with the chips.
        ? <WaitDialog card={card} today={today} again={false} busy={busy} onClose={() => setOpen(null)} onRun={onRun} />
        : <ActionDialog card={card} action={open} busy={busy} onClose={() => setOpen(null)} onRun={onRun} />)}
    </>
  )
}

/** The steps an action runs: 着手 first where the type completes only what was started (task v8). */
function steps(a: TaskCardAction, extra: Partial<TaskActInput>): Array<Omit<TaskActInput, 'expectedVersion'>> {
  const step = { action: a.action, ...extra }
  return a.startFirst ? [{ action: 'start' }, step] : [step]
}

/** Before an action that needs words or takes the task off the member's list: what happens, who is told. */
function ActionDialog({ card, action, busy, onClose, onRun }: { card: TaskCardData; action: TaskCardAction; busy: boolean; onClose: () => void; onRun: Props['onRun'] }) {
  const [note, setNote] = useState('')
  const [okBy, setOkBy] = useState('')
  const [okNote, setOkNote] = useState('')
  const [args, setArgs] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  // 「終わったので見てもらう」 goes to the checker already named on the task.
  const shownArgs = action.args.filter(x => !(action.action === 'request_review' && x.name === 'reviewer' && card.names.reviewer))
  const person = shownArgs.find(x => x.kind === 'person')
  const chosen = person ? card.people.find(p => p.id === args[person.name])?.name ?? null : action.action === 'request_review' ? card.names.reviewer : null
  const words = LEAVING_ACTIONS.has(action.action) ? leavingWords(action, card, chosen) : null
  const reasonNeeded = action.noteRequired || action.action === 'decline'
  const ready = !(reasonNeeded && !note.trim()) && !(action.needsOk && !okBy && !okNote.trim()) && !shownArgs.some(x => x.kind === 'person' && !args[x.name])
  const run = async () => {
    const values: Record<string, string | null> = Object.fromEntries(shownArgs.map(x => [x.name, (args[x.name] ?? '').trim() || null]))
    if (action.action === 'request_review' && !values.reviewer && card.reviewerId) values.reviewer = card.reviewerId
    const extra: Partial<TaskActInput> = {
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(Object.keys(values).length > 0 ? { args: values } : {}),
      ...(action.needsOk ? { ok: { ...(okBy ? { by: okBy } : {}), ...(okNote.trim() ? { note: okNote.trim() } : {}) } } : {}),
    }
    const failure = await onRun(steps(action, extra), words?.done ?? doneWords(action, card))
    if (failure) setError(failure)
    else onClose()
  }
  const title = words?.title ?? actionText(action, card)
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/25" onClick={onClose}>
      <div role="dialog" aria-label={title} onClick={e => e.stopPropagation()} className="w-[420px] space-y-3 rounded-xl bg-white p-4 text-[13px] text-gray-800 shadow-2xl dark:bg-zinc-800 dark:text-zinc-100">
        <div className="text-[14px] font-semibold">{title}</div>
        {words && (
          <dl className="space-y-1.5 text-[12.5px]">
            <div className="flex gap-2"><dt className="w-[84px] shrink-0 text-gray-500">何が起きるか</dt><dd>{words.what}</dd></div>
            <div className="flex gap-2"><dt className="w-[84px] shrink-0 text-gray-500">知らせる人</dt><dd>{words.tell}</dd></div>
          </dl>
        )}
        {action.needsOk && (
          <div className="space-y-1.5">
            <p className="font-medium">誰の OK で完了にしますか？</p>
            <select aria-label="OK をくれた人" value={okBy} onChange={e => setOkBy(e.target.value)} className={FIELD}>
              <option value="">ACB にいない人（下にひとこと）</option>
              {card.people.map(p => <option key={p.id} value={p.id}>{p.name}さん</option>)}
            </select>
            <input aria-label="OK のいきさつ" value={okNote} onChange={e => setOkNote(e.target.value)} placeholder="例：先方からメールで了承" className={FIELD} />
            <p className="text-[11px] text-gray-500">OK をくれた人に「あなたの OK で完了にしました」と届き、その人は取り消せます。</p>
          </div>
        )}
        {shownArgs.map(x => (
          <label key={x.name} className="block space-y-1">
            <span className="text-[12px] text-gray-600 dark:text-zinc-300">{x.label}</span>
            {x.kind === 'person' ? (
              <select aria-label={x.label} value={args[x.name] ?? ''} onChange={e => setArgs(v => ({ ...v, [x.name]: e.target.value }))} className={FIELD}>
                <option value="">選んでください</option>
                {card.people.map(p => <option key={p.id} value={p.id}>{p.name}さん</option>)}
              </select>
            ) : (
              <input aria-label={x.label} value={args[x.name] ?? ''} onChange={e => setArgs(v => ({ ...v, [x.name]: e.target.value }))} className={FIELD} />
            )}
          </label>
        ))}
        {(reasonNeeded || action.action === 'reopen') && (
          <textarea aria-label="理由" value={note} onChange={e => setNote(e.target.value)} rows={2}
            placeholder={action.action === 'decline' ? '受けられない理由（頼んだ人に届きます）' : reasonNeeded ? '理由（経緯に残ります）' : 'ひとこと（なくてもかまいません）'} className={FIELD} />
        )}
        {error && <p role="alert" className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={SMALL_BUTTON}>やめておく</button>
          <button type="button" disabled={busy || !ready} onClick={() => void run()} className={MAIN_BUTTON}>{actionText(action, card)}</button>
        </div>
      </div>
    </div>
  )
}
