// 探す with nothing typed: the member's own, recent things — what they opened last, their 案件 in
// progress (やること and the next meeting) and this week's meetings. Props in, JSX out.
import type { ReactNode } from 'react'
import { ClockCounterClockwise } from '@phosphor-icons/react'
import type { FindHitView } from '../../../../shared/record-views'
import type { RecordFindHub } from '../../../../../shared/types/records'
import { thingName, THING_NAMES } from '../../../../shared/thing-words'
import { RecordIcon, ThingIcon } from '../../../shared/ui/ThingIcon'
import { getFileIcon } from '../../../shared/ui/fileIcon'
import { daysAgo, dateWords, shortDate } from '../find'
import type { PaletteRecent } from '../model'

const MAX = 5

function ListTitle({ children }: { children: ReactNode }) {
  return <h3 className="px-3 pt-3 pb-1 text-[11px] font-semibold text-gray-500 dark:text-zinc-400">{children}</h3>
}

function Row({ children, active, onClick, top, data }: { children: ReactNode; active: boolean; onClick: () => void; top?: boolean; data?: string }) {
  return (
    <button type="button" onClick={onClick} data-home-row={data}
      className={`w-full text-left flex ${top ? 'items-start' : 'items-center'} gap-2 px-3 py-1 ${active ? 'bg-accent/10' : 'hover:bg-gray-100 dark:hover:bg-white/[0.04]'}`}>
      {children}
    </button>
  )
}

export function FindEmpty({ recent, bundles, meetings, bundleWord, today, activeRecordId, onOpenRecord, onOpenFile }: {
  recent: readonly PaletteRecent[]
  bundles: ReadonlyArray<FindHitView & { hub: RecordFindHub }> | null
  meetings: readonly FindHitView[] | null
  bundleWord: string
  today: string
  activeRecordId?: string | null
  onOpenRecord: (recordId: string) => void
  onOpenFile: (path: string) => void
}) {
  return (
    <div className="pb-3" data-empty-state>
      {recent.length > 0 && <>
        <ListTitle><span className="inline-flex items-center gap-1"><ClockCounterClockwise size={12} />最近開いたもの</span></ListTitle>
        {recent.slice(0, MAX).map(r => {
          if ('path' in r) {
            const name = r.path.split('/').pop() ?? r.path
            const I = getFileIcon(name, false)
            return (
              <Row key={r.key} active={false} onClick={() => onOpenFile(r.path)} data={r.key}>
                <I size={14} className="shrink-0" />
                <span className="flex-1 min-w-0 truncate text-[12px] text-gray-700 dark:text-zinc-300" title={r.path}>{name}</span>
              </Row>
            )
          }
          return (
            <Row key={r.key} active={activeRecordId === r.recordId} onClick={() => onOpenRecord(r.recordId)} data={r.key}>
              <RecordIcon record={r.record} />
              <span className="flex-1 min-w-0 truncate text-[12px] text-gray-700 dark:text-zinc-300">{r.record.title}</span>
              <span className="text-[10px] text-gray-400 shrink-0">{thingName(r.record)}</span>
            </Row>
          )
        })}
      </>}
      {bundles && bundles.length > 0 && <>
        <ListTitle>自分が関わっている進行中の{bundleWord}</ListTitle>
        {bundles.map(b => {
          const line = [
            b.hub.counts.openTasks > 0 && `${THING_NAMES.task} ${b.hub.counts.openTasks}`,
            b.hub.nextMeetingAt && `次の会議 ${dateWords(b.hub.nextMeetingAt)}`,
          ].filter(Boolean).join('・') || (b.hub.lastMovedAt ? `最後の動き ${shortDate(b.hub.lastMovedAt, today)}` : '')
          return (
            <Row key={b.record.id} active={activeRecordId === b.record.id} onClick={() => onOpenRecord(b.record.id)} top data={b.record.id}>
              <span className="pt-px"><ThingIcon kind={b.record.thing} typeLabel={b.record.typeLabel} /></span>
              <span className="flex-1 min-w-0">
                <span className="block truncate text-[12px] text-gray-700 dark:text-zinc-300">{b.record.title}</span>
                {line && <span className="block truncate text-[10px] text-gray-400 dark:text-zinc-500">{line}</span>}
              </span>
            </Row>
          )
        })}
      </>}
      {meetings && meetings.length > 0 && <>
        <ListTitle>この1週間の会議</ListTitle>
        {meetings.map(m => {
          const at = m.meetingAt ?? ''
          const ago = at ? daysAgo(at, today) : 1
          return (
            <Row key={m.record.id} active={activeRecordId === m.record.id} onClick={() => onOpenRecord(m.record.id)} data={m.record.id}>
              <ThingIcon kind="meeting" />
              <span className={`flex-1 min-w-0 truncate text-[12px] ${ago > 0 ? 'text-gray-500 dark:text-zinc-400' : 'text-gray-700 dark:text-zinc-300'}`}>{m.record.title}</span>
              <span className={`text-[10px] shrink-0 tabular-nums ${ago === 0 ? 'text-accent font-medium' : 'text-gray-400'}`}>{dateWords(at)}</span>
            </Row>
          )
        })}
      </>}
    </div>
  )
}
