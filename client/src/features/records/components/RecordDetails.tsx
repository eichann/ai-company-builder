// The own parts of a meeting's and a 来た連絡's screen (新しい画面のデモ F, J): the meeting's summary
// as its body with 決めたこと and 宿題 apart, the documents to open; a 連絡's summary (ACB keeps no
// body) with the original one click away.
import type { ReactNode } from 'react'
import { CalendarBlank, CheckCircle, Microphone, NotePencil } from '@phosphor-icons/react'
import type { IncomingDetailView, MeetingDetailView, OpenLink } from '../../../../shared/record-details'
import type { RecordViewSummary } from '../../../../shared/record-views'
import { runCommand } from '../../../shared/commands/commands'
import { NEXT_STEP } from '../../../../shared/thing-words'
import { MoreMenu } from '../../../shared/ui/MoreMenu'
import { Chip, MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { SourceIcon, ThingIcon } from '../../../shared/ui/ThingIcon'
import { openOutside } from '../api'

function when(at: string | null): string | null {
  if (!at) return null
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const OPEN_ICON: Record<OpenLink['kind'], ReactNode> = {
  transcript: <Microphone size={12} className="text-emerald-600" />,
  notes: <NotePencil size={12} className="text-sky-600" />,
  calendar: <SourceIcon source="calendar" />,
  gmail: <SourceIcon source="gmail" />,
  slack: <SourceIcon source="slack" />,
}

export function OpenButton({ link, quiet }: { link: OpenLink; quiet?: boolean }) {
  return (
    <button type="button" onClick={() => void openOutside(link.url)}
      className={quiet ? 'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-gray-500 hover:bg-gray-100 hover:text-accent dark:text-zinc-400 dark:hover:bg-zinc-800' : SMALL_BUTTON}>
      {OPEN_ICON[link.kind]}{link.label}
    </button>
  )
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

export function MeetingBody({ m, decisions, homework }: { m: MeetingDetailView; decisions: RecordViewSummary[]; homework: RecordViewSummary[] }) {
  return (
    <>
      {m.opens.length > 0 && <div className="flex flex-wrap gap-1.5">{m.opens.map(l => <OpenButton key={l.kind} link={l} quiet />)}</div>}
      <section aria-label="要約" className="text-[14.5px] leading-[1.8]">
        <h2 className="mb-1 text-[13px] font-semibold text-gray-700 dark:text-zinc-200">要約</h2>
        {m.summary
          ? <p className="whitespace-pre-wrap">{m.summary}</p>
          : <p className="text-[13px] text-gray-500">AI はまだ議事録を読んでいません。読み終えると、ここに要約が出ます。</p>}
      </section>
      {decisions.length > 0 && <Section kind="decision" title="決めたこと"><Items records={decisions} /></Section>}
      {homework.length > 0 && <Section kind="task" title="宿題"><Items records={homework} /></Section>}
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
