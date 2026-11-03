// 「議事録を確認する」's own parts (新しい画面のデモ F): the meeting's summary, the AI's proposals (案)
// with ［全部足す］［選んで足す］［要らない］, and the decisions the AI left with ［確かめる］. Each press is one
// action at the version shown; the server decides who may.
import { useState } from 'react'
import { CheckCircle, Sparkle } from '@phosphor-icons/react'
import type { MinutesReviewView } from '../../../../shared/task-card'
import type { TaskProposal } from '../../../../shared/tasks'
import { CALM } from '../../../../shared/thing-words'
import { runCommand } from '../../../shared/commands/commands'
import { Chip, MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { useTaskProposals } from '../hooks/useTaskProposals'

const QUIET = 'inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11.5px] text-gray-500 hover:bg-gray-100 hover:text-accent disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800'

const shortDue = (due: string | null) => {
  const m = due?.match(/^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/)
  return m ? `${Number(m[1])}/${Number(m[2])}${m[3] ? ` ${m[3]}` : ''}` : null
}

interface Props {
  companyId: string
  review: MinutesReviewView
  busy: boolean
  /** Runs `action` on record `id` at `version`; null = done, else the reason in words. */
  onAct: (id: string, action: string, version: number) => Promise<string | null>
}

export function MinutesReview({ companyId, review, busy, onAct }: Props) {
  const { result, reload } = useTaskProposals(companyId, review.meetingId)
  const [picking, setPicking] = useState<Set<string> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const proposals = result?.success ? result.proposals : []
  const open = proposals.filter(p => p.state === 'proposed')
  // One by one, each at its own version (the server makes each a task of its own).
  const act = async (items: Array<{ id: string; version: number }>, action: string) => {
    setError(null)
    for (const p of items) {
      const failure = await onAct(p.id, action, p.version)
      if (failure) { setError(failure); break }
    }
    setPicking(null)
    reload()
  }
  const unconfirmed = review.decisions.filter(d => d.mine && d.state === 'unconfirmed')
  return (
    <>
      <section aria-label="要約（AI）" className="rounded-lg bg-gray-50 px-3.5 py-2.5 text-[13px] leading-relaxed dark:bg-zinc-800/50">
        <div className="mb-0.5 text-[11px] text-gray-500">要約（AI）</div>
        <p className="whitespace-pre-wrap">{review.summary ?? 'AI はまだ議事録を読んでいません。'}</p>
        <button type="button" onClick={() => runCommand('record.open', { recordId: review.meetingId })} className="text-[11.5px] text-accent hover:underline">会議の記録を開く</button>
      </section>

      <section aria-label="AI のタスクの案">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Sparkle size={14} weight="fill" className="text-accent" />
          <h2 className="mr-auto text-[13px] font-semibold text-gray-700 dark:text-zinc-200">AI のタスクの案</h2>
          {open.length > 0 && !picking && <>
            <button type="button" disabled={busy} onClick={() => void act(open, 'adopt')} className={MAIN_BUTTON}>全部足す</button>
            <button type="button" disabled={busy} onClick={() => setPicking(new Set(open.map(p => p.id)))} className={SMALL_BUTTON}>選んで足す</button>
            <button type="button" disabled={busy} onClick={() => void act(open, 'dismiss')} className={SMALL_BUTTON}>要らない</button>
          </>}
          {picking && <button type="button" onClick={() => setPicking(null)} className={SMALL_BUTTON}>選ぶのをやめる</button>}
        </div>
        {result === null && <p className="text-[12px] text-gray-400">{CALM.loading}</p>}
        {result && !result.success && <p role="alert" className="text-[12px] text-gray-500">{result.error}</p>}
        {result?.success && proposals.length === 0 && <p className="text-[12px] text-gray-400">案はありません。</p>}
        <ul className="space-y-1.5">
          {proposals.map(p => (
            <ProposalRow key={p.id} p={p} busy={busy} picked={picking?.has(p.id) ?? null}
              onPick={on => setPicking(s => { const next = new Set(s); if (on) next.add(p.id); else next.delete(p.id); return next })}
              onAct={action => void act([p], action)} />
          ))}
        </ul>
        {picking && (
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy || picking.size === 0} onClick={() => void act(open.filter(p => picking.has(p.id)), 'adopt')} className={MAIN_BUTTON}>選んだものを足す</button>
          </div>
        )}
        {error && <p role="alert" className="mt-1 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      </section>

      {review.decisions.length > 0 && (
        <section aria-label="決めたこと（AI が残した）">
          <div className="mb-2 flex items-center gap-1.5">
            <ThingIcon kind="decision" size={14} label="" />
            <h2 className="mr-auto text-[13px] font-semibold text-gray-700 dark:text-zinc-200">決めたこと（AI が残した）</h2>
            {unconfirmed.length > 1 && <button type="button" disabled={busy} onClick={() => void act(unconfirmed, 'confirm')} className={SMALL_BUTTON}>まとめて確かめた</button>}
          </div>
          <ul className="space-y-1 text-[13px]">
            {review.decisions.map(d => (
              <li key={d.id} className="flex items-center gap-2">
                <button type="button" onClick={() => runCommand('record.open', { recordId: d.id })} className="min-w-0 truncate text-left hover:text-accent hover:underline">{d.title}</button>
                {d.state === 'confirmed'
                  ? <Chip tone="green"><CheckCircle size={11} weight="fill" />確かめた</Chip>
                  : d.mine && <button type="button" disabled={busy} onClick={() => void act([d], 'confirm')} className={SMALL_BUTTON}>確かめる</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function ProposalRow({ p, busy, picked, onPick, onAct }: { p: TaskProposal; busy: boolean; picked: boolean | null; onPick: (on: boolean) => void; onAct: (action: string) => void }) {
  const away = p.state === 'dismissed'
  const sub = [p.assigneeName ? `${p.assigneeName}さん` : null, shortDue(p.due)].filter(Boolean).join('・')
  return (
    <li className={`rounded-lg border px-3 py-2 text-[12.5px] ${away ? 'border-gray-100 opacity-60 dark:border-zinc-800' : 'border-gray-200 dark:border-zinc-700'}`}>
      <div className="flex items-center gap-2">
        {picked !== null && !away && <input type="checkbox" aria-label={`${p.title} を選ぶ`} checked={picked} onChange={e => onPick(e.target.checked)} />}
        <ThingIcon kind="task" size={13} label="" />
        <span className={`min-w-0 flex-1 truncate font-medium ${away ? 'line-through' : ''}`}>{p.title}</span>
        {sub && <span className="whitespace-nowrap text-[11px] text-gray-500">{sub}</span>}
        {picked === null && !away && <>
          <button type="button" disabled={busy} onClick={() => onAct('adopt')} className={SMALL_BUTTON}>足す</button>
          <button type="button" disabled={busy} onClick={() => onAct('dismiss')} className={QUIET}>要らない</button>
        </>}
        {away && <><Chip>しまった</Chip><button type="button" disabled={busy} onClick={() => onAct('propose_again')} className={QUIET}>戻す</button></>}
      </div>
    </li>
  )
}
