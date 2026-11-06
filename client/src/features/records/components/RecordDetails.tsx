// The own parts of a meeting's and a 来た連絡's screen (新しい画面のデモ F, J): the meeting's summary
// as its body with 決めたこと and やること apart, the documents to open as rows of 「つながっているもの」;
// a 連絡's summary (ACB keeps no body) with the original one click away.
import type { ReactNode } from 'react'
import { CalendarBlank, CheckCircle } from '@phosphor-icons/react'
import type { IncomingDetailView, MeetingDetailView, OpenLink, ReplyRequestDetailView } from '../../../../shared/record-details'
import type { RecordViewSummary } from '../../../../shared/record-views'
import { runCommand } from '../../../shared/commands/commands'
import { DECISION_PROPOSAL_NAME, NEXT_STEP } from '../../../../shared/thing-words'
import { MoreMenu } from '../../../shared/ui/MoreMenu'
import { Chip, MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { SourceIcon, ThingIcon } from '../../../shared/ui/ThingIcon'
import { openOutside } from '../api'
import { OPEN_ICON } from './linkRows'

function when(at: string | null): string | null {
  if (!at) return null
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function OpenButton({ link }: { link: OpenLink }) {
  return <button type="button" onClick={() => void openOutside(link.url)} className={SMALL_BUTTON}>{OPEN_ICON[link.kind]}{link.label}</button>
}

function Section({ kind, title, children }: { kind?: 'decision' | 'task'; title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-gray-700 dark:text-zinc-200">{kind && <ThingIcon kind={kind} size={14} label="" />}{title}</h2>
      {children}
    </section>
  )
}

function Items({ records }: { records: RecordViewSummary[] }) {
  return (
    <ul className="space-y-1 text-[13.5px]">
      {records.map(r => (
        <li key={r.id}>
          <button type="button" onClick={() => runCommand('record.open', { recordId: r.id })}
            className={`text-left hover:text-accent hover:underline ${r.finished ? 'text-gray-400 line-through' : ''}`}>{r.title}</button>
        </li>
      ))}
    </ul>
  )
}

/** The thin line under a meeting's title: when, who attended, whose it is. */
export function MeetingLine({ m }: { m: MeetingDetailView }) {
  const at = when(m.at)
  const people = [...m.attendees, ...(m.externalCount > 0 ? [`社外 ${m.externalCount}人`] : [])]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-gray-500 dark:text-zinc-400">
      {at && <span className="inline-flex items-center gap-1"><CalendarBlank size={12} className="text-sky-500" />{at}</span>}
      {people.length > 0 && <span>参加 {people.join('・')}</span>}
      {m.assignee && <span>担当 {m.assignee}さん</span>}
    </div>
  )
}

export function MeetingSummary({ m }: { m: MeetingDetailView }) {
  return (
    <section aria-label="要約" className="text-[14.5px] leading-[1.8]">
      <h2 className="mb-1 text-[13px] font-semibold text-gray-700 dark:text-zinc-200">要約</h2>
      {m.summary
        ? <p className="whitespace-pre-wrap">{m.summary}</p>
        : <p className="text-[13px] text-gray-500">AI はまだ議事録を読んでいません。読み終えると、ここに要約が出ます。</p>}
    </section>
  )
}

/** What a meeting's links hold, as plain lists: until the screen has its proposals (or never, on an older server). */
export function MeetingOutputs({ decisions, tasks }: { decisions: RecordViewSummary[]; tasks: RecordViewSummary[] }) {
  // 決めたことの案 (not confirmed yet, decision version 6) apart from the confirmed ones.
  const proposed = decisions.filter(d => d.typeLabel === DECISION_PROPOSAL_NAME)
  const decided = decisions.filter(d => d.typeLabel !== DECISION_PROPOSAL_NAME)
  return (
    <>
      {proposed.length > 0 && <Section kind="decision" title={DECISION_PROPOSAL_NAME}><Items records={proposed} /></Section>}
      {decided.length > 0 && <Section kind="decision" title="決めたこと"><Items records={decided} /></Section>}
      {tasks.length > 0 && <Section kind="task" title="やること"><Items records={tasks} /></Section>}
    </>
  )
}

/** 「鈴木様 から・11/4 18:20」 with the service's mark. */
export function IncomingLine({ m }: { m: IncomingDetailView }) {
  const at = when(m.at)
  const service = m.channel === 'slack' ? 'Slack' : m.channel === 'email' ? 'メール' : null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-gray-500 dark:text-zinc-400">
      {m.channel === 'slack' ? <SourceIcon source="slack" /> : m.channel === 'email' ? <SourceIcon source="gmail" /> : null}
      {[m.from ? `${m.from} から` : null, service, at].filter(Boolean).join('・')}
    </div>
  )
}

export function IncomingBody({ m }: { m: IncomingDetailView }) {
  const where = m.channel === 'slack' ? 'Slack' : m.channel === 'email' ? 'メール' : '元のサービス'
  return (
    <section aria-label="要約" className="rounded-lg bg-gray-50 px-3.5 py-2.5 text-[13.5px] leading-relaxed dark:bg-zinc-800/50">
      <div className="mb-0.5 text-[11px] text-gray-500">要約（本文は {where} にあります）</div>
      <p className="whitespace-pre-wrap">{m.summary || '（要約はまだありません）'}</p>
    </section>
  )
}

/**
 * A 返事のお願い's actions (owner report 2026-11-05: one sat in 「AI が確かめている」 after the member's
 * reply, with nothing to press): ［終わりにする］ as the main button whenever its person may end it —
 * the AI's turn included — and ［もう返した］ in 「…」. Each at the card's version; 取り消す follows.
 */
export function ReplyRequestActions({ m, busy, onAct }: {
  m: ReplyRequestDetailView
  busy: boolean
  onAct: (action: 'close' | 'replied_elsewhere') => void
}) {
  if (!m.close && !m.repliedElsewhere) return null
  return <>
    {m.close && <button type="button" disabled={busy} onClick={() => onAct('close')} className={MAIN_BUTTON}><CheckCircle size={13} weight="fill" />{NEXT_STEP.endReply}</button>}
    {m.repliedElsewhere && <MoreMenu compact items={[{
      label: NEXT_STEP.repliedElsewhere, hint: '電話やほかの経路で返したとき。終わりにして、AI の下書きは送らずに片づけます',
      onClick: () => { if (!busy) onAct('replied_elsewhere') },
    }]} />}
  </>
}

/**
 * A 来た連絡's actions (owner FB #20), where a task has its 完了: ［済んだ］ as the one main button and
 * ［取り込まない］ in 「…」 on a 確認待ち message that is the member's; once they closed it, 「済んだ」 and
 * ［元に戻す］. An open 返事のお願い of it is its own record: the member is told to end it there.
 */
export function IncomingActions({ m, busy, openReplies, onAct, onUndo }: {
  m: IncomingDetailView
  busy: boolean
  /** Its 返事のお願い still open (each ends with its own ［もう返した］). */
  openReplies: number
  onAct: (action: 'settle' | 'drop') => void
  onUndo: () => void
}) {
  if (m.close === 'settled') {
    return <>
      <Chip tone="green"><CheckCircle size={11} weight="fill" />{NEXT_STEP.settle}</Chip>
      <button type="button" disabled={busy} onClick={onUndo} className={SMALL_BUTTON}>{NEXT_STEP.unsettle}</button>
    </>
  }
  if (m.close !== 'settle') return null
  return <>
    <button type="button" disabled={busy} onClick={() => onAct('settle')} className={MAIN_BUTTON}><CheckCircle size={13} weight="fill" />{NEXT_STEP.settle}</button>
    <MoreMenu compact items={[{
      label: NEXT_STEP.dropMessage, hint: 'やることにしなかった一覧に移します。消しません',
      onClick: () => { if (!busy) onAct('drop') },
    }]} />
    {openReplies > 0 && (
      <p role="note" className="basis-full text-[11.5px] text-amber-700 dark:text-amber-300">
        この連絡の返事のお願いが残っています。返事が済んでいれば、そちらで［もう返した］を押してください。
      </p>
    )}
  </>
}
