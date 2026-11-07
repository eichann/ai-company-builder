// 「確かめること」 (owner decision 2026-11-07, records.md "Features on and off"): with the company's
// task list turned off, the small list of what only ACB can act on — approvals waiting for the
// member, what the AI prepared for them to check, 決めたこと to confirm (［そうです］ on its card) and,
// given by the screen, arrived minutes (［AI に読ませる］). 「今日の予定」 (会議と議事録) sits above it.
// Each row opens its card in the middle, where the press happens; the server decides each press.
import { useMemo, useState, type ReactNode } from 'react'
import { useInterval } from '../../../shared/hooks/useInterval'
import { RecordIcon, ThingIcon } from '../../../shared/ui/ThingIcon'
import { corePressItems, type TaskListData, type TaskListItem } from '../../../../shared/tasks'
import { useCalendarToday } from '../hooks/useCalendarToday'
import { companyNow, listEvents } from '../model'
import { EventRow } from './TaskRow'

interface Props {
  companyId: string
  data: TaskListData | null
  /** 「今日の予定」 belongs to 会議と議事録: shown only while that feature is on. */
  showCalendar: boolean
  /** The arrived minutes block (AppShell gives the minutes feature's banners), shown under 今日の予定. */
  meetings?: ReactNode
  onOpen: (recordId: string) => void
}

const HEAD = 'px-2.5 pb-1 pt-2 text-[11px] font-medium text-gray-500 dark:text-zinc-400'
const ROW = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-gray-800 hover:bg-gray-100 dark:text-zinc-100 dark:hover:bg-zinc-800'

export function CorePressPanel({ companyId, data, showCalendar, meetings, onOpen }: Props) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useInterval(() => setNowMs(Date.now()), 60_000)
  const now = useMemo(() => companyNow(nowMs), [nowMs])
  // Read only while 会議と議事録 is on.
  const calendar = useCalendarToday(showCalendar ? companyId : undefined)
  const events = useMemo(() => listEvents(calendar?.events ?? [], now), [calendar, now])
  const { approvals, prepared } = useMemo(() => corePressItems(data?.items ?? []), [data])
  const decisions = data?.decisionsToConfirm ?? []
  const nothing = approvals.length === 0 && prepared.length === 0 && decisions.length === 0

  const row = (i: TaskListItem) => (
    <button key={i.id} type="button" data-testid="press-row" className={ROW} onClick={() => onOpen(i.id)}>
      <RecordIcon record={{ type: i.type, typeLabel: i.typeLabel }} />
      <span className="min-w-0 flex-1 truncate">{i.title}</span>
    </button>
  )
  return (
    <section aria-label="確かめること" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-1">
        {showCalendar && events.length > 0 && (
          <div data-testid="press-calendar" className="mb-2">
            <p className={HEAD}>今日の予定</p>
            <div className="space-y-0.5">{events.map(e => <EventRow key={e.event.id} e={e} />)}</div>
          </div>
        )}
        {meetings}
        <p className="px-2.5 pt-2 text-[13px] font-medium text-gray-800 dark:text-zinc-100">確かめること</p>
        <p className="px-2.5 pb-1 text-[11px] leading-relaxed text-gray-500 dark:text-zinc-400">承認や AI が用意したものなど、ACB の中でしか押せないものです。開くと押すボタンがあります。</p>
        {approvals.length > 0 && <><p className={HEAD}>承認のお願い</p>{approvals.map(row)}</>}
        {prepared.length > 0 && <><p className={HEAD}>AI が用意したもの（確かめてください）</p>{prepared.map(row)}</>}
        {decisions.length > 0 && (
          <>
            <p className={HEAD}>決めたこと（合っているか確かめてください）</p>
            {decisions.map(d => (
              <button key={d.id} type="button" data-testid="press-row" className={ROW} onClick={() => onOpen(d.id)}>
                <ThingIcon kind="decision" />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
              </button>
            ))}
          </>
        )}
        {data && nothing && <p className="px-2.5 py-3 text-[12px] text-gray-500 dark:text-zinc-400">今は確かめることはありません。</p>}
      </div>
    </section>
  )
}
