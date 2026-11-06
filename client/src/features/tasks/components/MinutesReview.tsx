// 「議事録を確認する」's own parts (新しい画面のデモ F): the meeting's summary, the AI's proposals (案)
// with ［全部足す］［選んで足す］［要らない］, and the decisions the AI left: 「決めたことの案」 with ［そうです］［違う］
// (decision version 6: shown only to whom the server says may — the まとまり's 責任者, else the meeting's
// readers) apart from the confirmed 「決めたこと」. Each press is one
// action at the version shown; the server decides who may, and a button shows only where its `who`
// lets the member (task version 13: everyone who reads the meeting, `proposalMay`). Each proposal
// shows the minutes text it rests on, whose AI added it, and 「似ている案があります」 with ［同じ］ (the
// newer put away) / ［別のもの］. On the meeting's own card: 決めたこと first, the tasks already made
// from the meeting join the proposals in one list, and 「やることを足す」 makes one by hand.
import { useState } from 'react'
import { CheckCircle, Sparkle } from '@phosphor-icons/react'
import type { RecordViewSummary } from '../../../../shared/record-views'
import { cannotReadLine, type MinutesReviewView } from '../../../../shared/task-card'
import { proposalsHeadline, type TaskProposal, type TaskWriteResult } from '../../../../shared/tasks'
import { slotSameAsNote } from '../../../../../shared/core/source-slot-candidates'
import { CALM, DECISION_PROPOSAL_NAME } from '../../../../shared/thing-words'
import { runCommand } from '../../../shared/commands/commands'
import { Chip, MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { useTaskProposals } from '../hooks/useTaskProposals'
import { MeetingTaskAdd } from './MeetingTaskAdd'

const QUIET = 'inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11.5px] text-gray-500 hover:bg-gray-100 hover:text-accent disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800'

const shortDue = (due: string | null) => {
  const m = due?.match(/^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/)
  return m ? `${Number(m[1])}/${Number(m[2])}${m[3] ? ` ${m[3]}` : ''}` : null
}

interface Props {
  companyId: string
  review: MinutesReviewView
  busy: boolean
  /** Runs `action` on record `id` at `version` (with a note); null = done, else the reason in words. */
  onAct: (id: string, action: string, version: number, note?: string) => Promise<string | null>
  /** The meeting's own card shows its summary already: only the proposals and decisions here. */
  onMeetingCard?: boolean
  /** The meeting's own card: its linked tasks, among them the proposals, each listed once. */
  made?: readonly RecordViewSummary[]
  /** The meeting's own card: 「やることを足す」 (a task of this meeting by the member, `MeetingTaskAdd`). */
  onCreate?: (title: string) => Promise<TaskWriteResult>
  /** 元に戻す after ［まとめる］ there: the entry at `version` undone; null = done. */
  onUndo?: (id: string, version: number) => Promise<string | null>
}

export function MinutesReview({ companyId, review, busy, onAct, onMeetingCard = false, made = [], onCreate, onUndo }: Props) {
  const { result, reload } = useTaskProposals(companyId, review.meetingId)
  const [picking, setPicking] = useState<Set<string> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const proposals = result?.success ? result.proposals : []
  const open = proposals.filter(p => p.state === 'proposed')
  const addable = open.filter(p => p.may.adopt)
  const removable = open.filter(p => p.may.dismiss)
  const readerId = result?.success ? result.readerId ?? null : null
  const readerName = result?.success ? result.readerName ?? null : null
  // Until the proposals are read nothing tells which linked task is one.
  const others = result === null ? [] : made.filter(t => !proposals.some(p => p.id === t.id))
  const listTitle = !onMeetingCard ? 'AI のタスクの案' : proposals.length > 0 ? 'やることの案' : 'やること'
  const decisionsTitle = '決めたこと'
  // One by one, each at its own version (the server makes each a task of its own).
  const act = async (items: Array<{ id: string; version: number }>, action: string, note?: string) => {
    setError(null)
    for (const p of items) {
      const failure = await onAct(p.id, action, p.version, note)
      if (failure) { setError(failure); break }
    }
    setPicking(null)
    reload()
  }
  // 決めたことの案 (decision version 6): not a decision until the person who decides says 「そうです」.
  const proposed = review.decisions.filter(d => d.state === 'unconfirmed')
  const decided = review.decisions.filter(d => d.state === 'confirmed')
  const confirmable = proposed.filter(d => d.may.confirm)
  const cannotRead = cannotReadLine(proposed.flatMap(d => d.cannotRead))
  const proposalList = (
    <section aria-label={listTitle}>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Sparkle size={14} weight="fill" className="text-accent" />
        <h2 className="mr-auto text-[13px] font-semibold text-gray-700 dark:text-zinc-200">{listTitle}</h2>
        {!picking && <>
          {addable.length > 0 && <button type="button" disabled={busy} onClick={() => void act(addable, 'adopt')} className={MAIN_BUTTON}>全部足す</button>}
          {addable.length > 0 && <button type="button" disabled={busy} onClick={() => setPicking(new Set(addable.map(p => p.id)))} className={SMALL_BUTTON}>選んで足す</button>}
          {removable.length > 0 && <button type="button" disabled={busy} onClick={() => void act(removable, 'dismiss')} className={SMALL_BUTTON}>要らない</button>}
        </>}
        {picking && <button type="button" onClick={() => setPicking(null)} className={SMALL_BUTTON}>選ぶのをやめる</button>}
      </div>
      {result?.success && proposals.length > 0 && <p className="mb-1.5 text-[11.5px] text-gray-500">{proposalsHeadline(readerName, open.length)}</p>}
      {result === null && <p className="text-[12px] text-gray-400">{CALM.loading}</p>}
      {result && !result.success && <p role="alert" className="text-[12px] text-gray-500">{result.error}</p>}
      {result?.success && proposals.length === 0 && others.length === 0 && <p className="text-[12px] text-gray-400">案はありません。</p>}
      <ul className="space-y-1.5">
        {proposals.map(p => (
          <ProposalRow key={p.id} p={p} busy={busy} picked={picking?.has(p.id) ?? null} readerId={readerId}
            onPick={on => setPicking(s => { const next = new Set(s); if (on) next.add(p.id); else next.delete(p.id); return next })}
            onAct={(action, note) => void act([p], action, note)} />
        ))}
        {others.map(t => <MadeRow key={t.id} t={t} />)}
      </ul>
      {picking && (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy || picking.size === 0} onClick={() => void act(addable.filter(p => picking.has(p.id)), 'adopt')} className={MAIN_BUTTON}>選んだものを足す</button>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      {onCreate && onUndo && (
        <MeetingTaskAdd busy={busy}
          onCreate={async title => { const r = await onCreate(title); reload(); return r }}
          onAct={async (id, action, at, note) => { const failure = await onAct(id, action, at, note); reload(); return failure }}
          onUndo={async (id, at) => { const failure = await onUndo(id, at); reload(); return failure }} />
      )}
    </section>
  )
  const decisionList = (
    <>
      {proposed.length > 0 && (
        <section aria-label={DECISION_PROPOSAL_NAME}>
          <div className="mb-1 flex items-center gap-1.5">
            <ThingIcon kind="decision" size={14} label="" />
            <h2 className="mr-auto text-[13px] font-semibold text-gray-700 dark:text-zinc-200">{DECISION_PROPOSAL_NAME}</h2>
            {confirmable.length > 1 && <button type="button" disabled={busy} onClick={() => void act(confirmable, 'confirm')} className={SMALL_BUTTON}>まとめてそうです</button>}
          </div>
          <p className="mb-1.5 text-[11.5px] text-gray-500">AI が議事録から拾った案です。決める立場の人が「そうです」と確かめると、決めたことになります。</p>
          {cannotRead && <p className="mb-1.5 text-[11.5px] text-gray-500">{cannotRead}</p>}
          <ul className="space-y-1 text-[13px]">
            {proposed.map(d => (
              <li key={d.id} className="flex items-center gap-2">
                <button type="button" onClick={() => runCommand('record.open', { recordId: d.id })} className="min-w-0 truncate text-left hover:text-accent hover:underline">{d.title}</button>
                {d.may.confirm && <button type="button" disabled={busy} onClick={() => void act([d], 'confirm')} className={SMALL_BUTTON}>そうです</button>}
                {d.may.reject && <button type="button" disabled={busy} onClick={() => void act([d], 'reject')} className={QUIET}>違う</button>}
                {!d.may.confirm && <Chip>責任者の確認待ち</Chip>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {decided.length > 0 && (
        <section aria-label={decisionsTitle}>
          <div className="mb-2 flex items-center gap-1.5">
            <ThingIcon kind="decision" size={14} label="" />
            <h2 className="mr-auto text-[13px] font-semibold text-gray-700 dark:text-zinc-200">{decisionsTitle}</h2>
          </div>
          <ul className="space-y-1 text-[13px]">
            {decided.map(d => (
              <li key={d.id} className="flex items-center gap-2">
                <button type="button" onClick={() => runCommand('record.open', { recordId: d.id })} className="min-w-0 truncate text-left hover:text-accent hover:underline">{d.title}</button>
                <Chip tone="green"><CheckCircle size={11} weight="fill" />決まった</Chip>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
  const hasDecisions = review.decisions.length > 0
  return (
    <>
      {!onMeetingCard && <section aria-label="要約（AI）" className="rounded-lg bg-gray-50 px-3.5 py-2.5 text-[13px] leading-relaxed dark:bg-zinc-800/50">
        <div className="mb-0.5 text-[11px] text-gray-500">要約（AI）</div>
        <p className="whitespace-pre-wrap">{review.summary ?? 'AI はまだ議事録を読んでいません。'}</p>
        <button type="button" onClick={() => runCommand('record.open', { recordId: review.meetingId })} className="text-[11.5px] text-accent hover:underline">会議の記録を開く</button>
      </section>}
      {onMeetingCard && hasDecisions && decisionList}
      {proposalList}
      {!onMeetingCard && hasDecisions && decisionList}
    </>
  )
}

function MadeRow({ t }: { t: RecordViewSummary }) {
  return (
    <li className="rounded-lg border border-gray-200 px-3 py-2 text-[12.5px] dark:border-zinc-700">
      <button type="button" onClick={() => runCommand('record.open', { recordId: t.id })} className="flex w-full min-w-0 items-center gap-2 text-left hover:text-accent">
        <ThingIcon kind="task" size={13} label="" />
        <span className={`min-w-0 flex-1 truncate font-medium ${t.finished ? 'text-gray-400 line-through' : ''}`}>{t.title}</span>
      </button>
    </li>
  )
}

function ProposalRow({ p, busy, picked, readerId, onPick, onAct }: {
  p: TaskProposal; busy: boolean; picked: boolean | null; readerId: string | null
  onPick: (on: boolean) => void; onAct: (action: string, note?: string) => void
}) {
  const away = p.state === 'dismissed'
  const sub = [p.assigneeName ? `${p.assigneeName}さん` : null, shortDue(p.due)].filter(Boolean).join('・')
  // Whose AI added it, when not the one that read the meeting (another attendee's consultation).
  const origin = p.addedBy && p.addedBy !== readerId ? `${p.addedByName ?? 'メンバー'}さんの AI が追加` : null
  return (
    <li className={`rounded-lg border px-3 py-2 text-[12.5px] ${away ? 'border-gray-100 opacity-60 dark:border-zinc-800' : 'border-gray-200 dark:border-zinc-700'}`}>
      <div className="flex items-center gap-2">
        {picked !== null && !away && p.may.adopt && <input type="checkbox" aria-label={`${p.title} を選ぶ`} checked={picked} onChange={e => onPick(e.target.checked)} />}
        <ThingIcon kind="task" size={13} label="" />
        <span className={`min-w-0 flex-1 truncate font-medium ${away ? 'line-through' : ''}`}>{p.title}</span>
        {sub && <span className="whitespace-nowrap text-[11px] text-gray-500">{sub}</span>}
        {picked === null && !away && <>
          {p.may.adopt && <button type="button" disabled={busy} onClick={() => onAct('adopt')} className={SMALL_BUTTON}>足す</button>}
          {p.may.dismiss && <button type="button" disabled={busy} onClick={() => onAct('dismiss')} className={QUIET}>要らない</button>}
        </>}
        {away && <><Chip>しまった</Chip>{p.may.proposeAgain && <button type="button" disabled={busy} onClick={() => onAct('propose_again')} className={QUIET}>戻す</button>}</>}
      </div>
      {(p.basis || origin) && (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 pl-5 text-[11px] text-gray-500 dark:text-zinc-400">
          {p.basis && <span className="min-w-0 truncate" title={p.basis}>「{p.basis}」</span>}
          {origin && <span className="whitespace-nowrap">{origin}</span>}
        </div>
      )}
      {p.similarTo && !away && (
        <div role="note" className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2 py-1 pl-5 text-[11.5px] text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <span className="min-w-0 flex-1">似ている案があります：「{p.similarTo.title}」</span>
          {p.may.dismiss && <button type="button" disabled={busy} onClick={() => onAct('dismiss', slotSameAsNote(p.similarTo?.title ?? ''))} className={QUIET}>同じ</button>}
          {p.may.keepApart && <button type="button" disabled={busy} onClick={() => onAct('keep_apart')} className={QUIET}>別のもの</button>}
        </div>
      )}
    </li>
  )
}
