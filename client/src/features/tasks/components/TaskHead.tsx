// The parts of a task's card under its title (新しい画面のデモ C): where it came from, 「終わったら」,
// its 案件, the due with 「延ばす」 and the tags, and the notices of the member's last press
// (「〇〇さんに返しました［取り消す］」, 「〇〇さんが先に変えました…」).
import { useState } from 'react'
import { CalendarBlank, Hash, Warning } from '@phosphor-icons/react'
import type { RecordCardHistoryLine } from '../../../../shared/record-views'
import type { TaskCardData, TaskCardOrigin } from '../../../../shared/task-card'
import { CALM } from '../../../../shared/thing-words'
import { runCommand } from '../../../shared/commands/commands'
import { SMALL_BUTTON } from '../../../shared/ui/RecordPage'
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
  const how = origin.byAi ? 'AI が作りました' : `${origin.addedBy ? `${origin.addedBy}さんが` : ''}作りました`
  return (
    <div className="text-[11.5px] text-gray-500 dark:text-zinc-400">
      <span className="mr-1.5 inline-block align-[-2px]"><ThingIcon kind={origin.kind === 'meeting' ? 'meeting' : 'incoming'} size={12} label="" /></span>
      <button type="button" onClick={() => runCommand('record.open', { recordId: origin.recordId })} className="hover:text-accent hover:underline">{what}</button>
      {how}{origin.byAi && origin.addedBy && `・${origin.addedBy}さんが足しました`}
      {origin.basis && <button type="button" onClick={() => setOpen(o => !o)} className="ml-1.5 text-accent hover:underline">{open ? '根拠をたたむ' : '根拠を見る'}</button>}
      {open && origin.basis && <blockquote className="ml-[18px] mt-1 whitespace-pre-wrap border-l-2 border-gray-200 pl-2 text-gray-600 dark:border-zinc-700 dark:text-zinc-300">{origin.basis}</blockquote>}
    </div>
  )
}

/** 期限 with 「延ばす」, and the tags. */
export function DueAndTags({ card, now, busy, onPostpone }: { card: TaskCardData; now: CompanyNow; busy: boolean; onPostpone: ((due: string) => void) | null }) {
  const [open, setOpen] = useState(false)
  const overdue = card.due ? dueWhen(card.due, now) === 'overdue' : false
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="relative rounded-lg bg-gray-50 px-3 py-2 dark:bg-zinc-800/60">
        <div className="flex items-center gap-1 text-[11px] text-gray-500"><CalendarBlank size={11} />{overdue ? '期限切れ' : '期限'}</div>
        <div className="flex items-center gap-2">
          <span className={`text-[15px] font-bold tabular-nums ${overdue ? 'text-red-600 dark:text-red-400' : ''}`}>{card.due ? dueText(card.due, now) : <span className="text-[13px] font-normal text-gray-400">なし</span>}</span>
          {onPostpone && <button type="button" disabled={busy} aria-expanded={open} onClick={() => setOpen(o => !o)} className={SMALL_BUTTON}>延ばす</button>}
        </div>
        {open && onPostpone && (
          <div role="group" aria-label="延ばす" className="absolute left-0 top-full z-30 mt-1 w-[250px] rounded-lg border border-gray-200 bg-white p-1 text-[12px] shadow-xl dark:border-zinc-700 dark:bg-zinc-800">
            {postponeChoices(now).map(c => (
              <button key={c.label} type="button" onClick={() => { setOpen(false); onPostpone(c.due) }} className="flex w-full justify-between rounded px-2 py-1 hover:bg-gray-100 dark:hover:bg-zinc-700">
                <span>{c.label}</span><span className="tabular-nums text-gray-400">{dueText(c.due, now)}</span>
              </button>
            ))}
            {card.names.requester && !card.roles.requester && <p className="px-2 pt-1 text-[10px] text-gray-400">延ばすと、頼んだ{card.names.requester}さんに知らせます</p>}
          </div>
        )}
      </div>
      <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-zinc-800/60">
        <div className="flex items-center gap-1 text-[11px] text-gray-500"><Hash size={11} />タグ</div>
        <div className="text-[13.5px] font-medium">{card.tags.length ? card.tags.map(t => `#${t}`).join(' ') : <span className="font-normal text-gray-400">なし</span>}</div>
      </div>
    </div>
  )
}

/** After the member's press: 「〇〇さんに返しました［取り消す］」. */
export function DoneNotice({ text, busy, onUndo }: { text: string; busy: boolean; onUndo: (() => void) | null }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-[12.5px] dark:bg-zinc-800">
      {text}
      {onUndo && <button type="button" disabled={busy} onClick={onUndo} className="text-accent hover:underline">取り消す</button>}
    </p>
  )
}

/** 「阿部さんが先に変えました。最新を読み込みました。もう一度押してください」 + what changed (plan H). */
export function ConflictNotice({ lines }: { lines: RecordCardHistoryLine[] }) {
  const who = lines.find(l => l.who && l.who !== 'AI')?.who ?? (lines.some(l => l.ai) ? 'AI' : undefined)
  return (
    <div role="alert" className="space-y-1.5 rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-3 text-[12.5px]">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold"><Warning size={14} weight="fill" className="text-amber-500" />{CALM.changedFirst(who === 'AI' ? undefined : who)}</p>
      {lines.length > 0 && <ul className="text-gray-600 dark:text-zinc-300">{lines.map((l, i) => <li key={i}>変わったところ：{l.text}</li>)}</ul>}
      <p className="text-[11px] text-gray-500">あなたが押したものは、まだ行っていません。</p>
    </div>
  )
}

