// The parts of a task's card under its title (新しい画面のデモ C): where it came from, 「終わったら」,
// its 案件, the due (pressed to change it in place) and the tags, and the notices of the member's last press
// (「〇〇さんに返しました［取り消す］」, 「〇〇さんが先に変えました…」).
import { useState, type ReactNode } from 'react'
import { CalendarBlank, Warning } from '@phosphor-icons/react'
import type { RecordCardHistoryLine } from '../../../../shared/record-views'
import type { TaskCardData, TaskCardOrigin } from '../../../../shared/task-card'
import { CALM } from '../../../../shared/thing-words'
import { runCommand } from '../../../shared/commands/commands'
import { InlineDate } from '../../../shared/ui/InlineDate'
import { ThingIcon } from '../../../shared/ui/ThingIcon'
import { dueText, dueWhen, postponeChoices, type CompanyNow } from '../model'

const day = (at: string | null) => {
  const m = at?.match(/^\d{4}-(\d{2})-(\d{2})/)
  return m ? `${Number(m[1])}/${Number(m[2])}` : null
}

/** 「会議『〇〇』（11/5）から AI が作りました・佐藤さんが足しました」 + ［根拠を見る］ (言葉の決まり 7.). */
export function OriginLine({ origin }: { origin: TaskCardOrigin }) {
  const [open, setOpen] = useState(false)
  const when = day(origin.at)
  const what = origin.kind === 'meeting' ? `会議「${origin.title}」${when ? `（${when}）` : ''}から` : `連絡「${origin.title}」${when ? `（${when}）` : ''}から`
  // A space before 「AI」 after Japanese (the app's spacing: 「から AI が」), none before a person's name.
  const how = origin.byAi ? ' AI が作りました' : `${origin.addedBy ? `${origin.addedBy}さんが` : ''}作りました`
  return (
    <div className="text-small text-gray-500 dark:text-zinc-400">
      <span className="mr-1.5 inline-block align-[-2px]"><ThingIcon kind={origin.kind === 'meeting' ? 'meeting' : 'incoming'} size={12} label="" /></span>
      <button type="button" onClick={() => runCommand('record.open', { recordId: origin.recordId })} className="hover:text-link hover:underline">{what}</button>
      {how}{origin.byAi && origin.addedBy && `・${origin.addedBy}さんが足しました`}
      {origin.basis && <button type="button" onClick={() => setOpen(o => !o)} className="ml-1.5 text-link hover:underline">{open ? '根拠をたたむ' : '根拠を見る'}</button>}
      {open && origin.basis && <blockquote className="ml-[18px] mt-1 whitespace-pre-wrap border-l-2 border-gray-200 pl-2 text-gray-600 dark:border-zinc-700 dark:text-zinc-300">{origin.basis}</blockquote>}
    </div>
  )
}

/**
 * 期限 and the tags (`tagField`, `TagField.tsx`). The date itself is pressed to change it in place (owner 2026-11-27: no
 * box apart): the chooser holds the due now, 「延ばす」's choices (`postponeChoices`), a calendar and typing — an earlier
 * day or a time too, which `set_due` takes. `onSetDue` null (the type does not let the member) = plain text.
 */
export function DueAndTags({ card, now, busy, onSetDue, tagField }: { card: TaskCardData; now: CompanyNow; busy: boolean; onSetDue: ((due: string) => Promise<string | null>) | null; tagField: ReactNode }) {
  const overdue = card.due ? dueWhen(card.due, now) === 'overdue' : false
  const shown = <span className={`text-title font-bold tabular-nums ${overdue ? 'text-danger-text' : ''}`}>{card.due ? dueText(card.due, now) : <span className="text-body font-normal text-text-subtle">なし</span>}</span>
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-control bg-surface-sunken px-3 py-2">
        <div className="flex items-center gap-1 text-caption font-normal text-text-muted"><CalendarBlank size={11} />{overdue ? '期限切れ' : '期限'}</div>
        {onSetDue
          ? <InlineDate value={card.due} label={card.due ? '期限を変える' : '期限を決める'} busy={busy} onSave={onSetDue} choicesLabel="延ばす"
              choices={postponeChoices(now, card.holidays).map(c => ({ label: c.label, due: c.due, shown: dueText(c.due, now) }))}
              {...(card.names.requester && !card.roles.requester ? { note: `変えると、頼んだ${card.names.requester}さんに知らせます` } : {})}>
              {shown}
            </InlineDate>
          : <div>{shown}</div>}
      </div>
      {tagField}
    </div>
  )
}

/** After the member's press: 「〇〇さんに返しました［取り消す］」. */
export function DoneNotice({ text, busy, onUndo }: { text: string; busy: boolean; onUndo: (() => void) | null }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 rounded-control bg-gray-100 px-3 py-2 text-small dark:bg-zinc-800">
      {text}
      {onUndo && <button type="button" disabled={busy} onClick={onUndo} className="text-link hover:underline">取り消す</button>}
    </p>
  )
}

/** 「阿部さんが先に変えました。最新を読み込みました。もう一度押してください」 + what changed (plan H). */
export function ConflictNotice({ lines }: { lines: RecordCardHistoryLine[] }) {
  const who = lines.find(l => l.who && l.who !== 'AI')?.who ?? (lines.some(l => l.ai) ? 'AI' : undefined)
  return (
    <div role="alert" className="space-y-1.5 rounded-card border border-amber-500/40 bg-amber-500/[0.06] p-3 text-small">
      <p className="flex items-center gap-1.5 text-body font-semibold"><Warning size={14} weight="fill" className="text-amber-500" />{CALM.changedFirst(who === 'AI' ? undefined : who)}</p>
      {lines.length > 0 && <ul className="text-gray-600 dark:text-zinc-300">{lines.map((l, i) => <li key={i}>変わったところ：{l.text}</li>)}</ul>}
      <p className="text-caption font-normal text-gray-500">あなたが押したものは、まだ行っていません。</p>
    </div>
  )
}

