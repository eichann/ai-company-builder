// The task list's pure rules (tasks-ui.md): where each item and meeting goes by turn or by
// date, which part of the future folds, how a due reads, and the tag filter. "Today" is the
// company's day (Japan time until a company setting exists, calendar.md).
import type { CalendarEvent } from '../../../shared/calendar'
import type { TaskListItem } from '../../../shared/tasks'
import { DEFAULT_COMPANY_TIME_ZONE } from '../../../../shared/core/calendar'

export type ListMode = 'turn' | 'date'

/** The company's clock now: its date, time and day of the week (0 = Sunday). */
export interface CompanyNow {
  date: string
  time: string
  weekday: number
  ms: number
}

export function companyNow(ms: number, timeZone = DEFAULT_COMPANY_TIME_ZONE): CompanyNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms))
  const p = (t: Intl.DateTimeFormatPartTypes) => parts.find(x => x.type === t)?.value ?? ''
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p('weekday'))
  return { date: `${p('year')}-${p('month')}-${p('day')}`, time: `${p('hour')}:${p('minute')}`, weekday, ms }
}

/** `YYYY-MM-DD` plus `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

/**
 * The last day of "this week" (a Sunday): after it, a due is 「先のこと」. On a Saturday or
 * Sunday it is next week's Sunday, so tomorrow's work never folds away.
 */
export function weekEnd(now: CompanyNow): string {
  const toSunday = (7 - now.weekday) % 7
  return addDays(now.date, toSunday < 2 ? toSunday + 7 : toSunday)
}

export type DueWhen = 'overdue' | 'today' | 'week' | 'later' | 'none'

/** Where a due falls from today: a time today that has passed is overdue too. */
export function dueWhen(due: string | null, now: CompanyNow): DueWhen {
  if (!due) return 'none'
  const day = due.slice(0, 10)
  if (day < now.date) return 'overdue'
  if (day === now.date) return due.length > 10 && due.slice(11, 16) < now.time ? 'overdue' : 'today'
  return day <= weekEnd(now) ? 'week' : 'later'
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

/** A due in members' words: 今日 15:00 / 明日 / 11/7（金） / 2027/1/15. */
export function dueText(due: string, now: CompanyNow): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/.exec(due)
  if (!m) return due
  const day = `${m[1]}-${m[2]}-${m[3]}`
  const time = m[4] ? ` ${m[4]}` : ''
  if (day === now.date) return `今日${time}`
  if (day === addDays(now.date, 1)) return `明日${time}`
  if (day === addDays(now.date, -1)) return `昨日${time}`
  const weekday = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()
  const md = `${Number(m[2])}/${Number(m[3])}（${WEEKDAYS[weekday]}）`
  return `${m[1] === now.date.slice(0, 4) ? md : `${m[1]}/${md}`}${time}`
}

/** Earliest due first (a day before its own times), no due last; then by title. */
export function byDue(a: TaskListItem, b: TaskListItem): number {
  if (a.due !== b.due) {
    if (a.due === null) return 1
    if (b.due === null) return -1
    return a.due < b.due ? -1 : 1
  }
  return a.title.localeCompare(b.title, 'ja')
}

/** A meeting of today in the list: still to come, or over (it then goes to 「今日終わったこと」). */
export interface ListEvent {
  event: CalendarEvent
  /** Its start and end in company time (HH:MM; all-day: null). */
  start: string | null
  end: string | null
  past: boolean
}

export function listEvents(events: readonly CalendarEvent[], now: CompanyNow): ListEvent[] {
  return events.map(event => {
    const s = event.allDay ? null : companyNow(Date.parse(event.start)).time
    const e = event.allDay ? null : companyNow(Date.parse(event.end)).time
    return { event, start: s, end: e, past: !event.allDay && Date.parse(event.end) <= now.ms }
  })
}

export interface ListSection {
  key: string
  title: string
  items: TaskListItem[]
  events: ListEvent[]
  /** Folded until the member opens it (the far future). */
  foldable: boolean
  /** A small note at the right of its title. */
  note?: string
}

/**
 * The sections of the list. By turn: 引き受け待ち, あなたの番 (today's meetings to come mixed
 * in), AI の番, ほかの人の番・返事待ち, 先のこと (the member's own far-future items, folded),
 * 今日終わったこと (with today's meetings that are over). By date: 期限切れ, 今日まで, 今週,
 * 来週以降 (folded), 期限なし, 今日終わったこと. Empty sections are left out.
 */
export function listSections(items: readonly TaskListItem[], events: readonly ListEvent[], mode: ListMode, now: CompanyNow): ListSection[] {
  const open = items.filter(i => i.turn !== 'done')
  const done = items.filter(i => i.turn === 'done').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
  const coming = events.filter(e => !e.past)
  const over = events.filter(e => e.past)
  const sorted = (list: TaskListItem[]) => [...list].sort(byDue)
  const sections: ListSection[] = []
  if (mode === 'turn') {
    const mine = open.filter(i => i.turn === 'mine')
    const later = mine.filter(i => dueWhen(i.due, now) === 'later')
    sections.push(
      { key: 'acceptance', title: '引き受け待ち', items: sorted(open.filter(i => i.turn === 'acceptance')), events: [], foldable: false, note: '引き受けるか、受けられないかを決めてください' },
      { key: 'mine', title: 'あなたの番', items: sorted(mine.filter(i => !later.includes(i))), events: coming, foldable: false },
      { key: 'ai', title: 'AI の番', items: sorted(open.filter(i => i.turn === 'ai')), events: [], foldable: false },
      { key: 'others', title: 'ほかの人の番・返事待ち', items: sorted(open.filter(i => i.turn === 'others')), events: [], foldable: false },
      { key: 'later', title: '先のこと', items: sorted(later), events: [], foldable: true, note: `${dueText(addDays(weekEnd(now), 1), now)}から` },
    )
  } else {
    const at = (w: ReturnType<typeof dueWhen>) => sorted(open.filter(i => dueWhen(i.due, now) === w))
    sections.push(
      { key: 'overdue', title: '期限切れ', items: at('overdue'), events: [], foldable: false },
      { key: 'today', title: '今日まで', items: at('today'), events: coming, foldable: false },
      { key: 'week', title: `今週（〜${dueText(weekEnd(now), now)}）`, items: at('week'), events: [], foldable: false },
      { key: 'later', title: `${dueText(addDays(weekEnd(now), 1), now)}から`, items: at('later'), events: [], foldable: true },
      { key: 'none', title: '期限なし', items: at('none'), events: [], foldable: false },
    )
  }
  sections.push({ key: 'done', title: '今日終わったこと', items: done, events: over, foldable: false, note: 'あしたの朝に空になります' })
  return sections.filter(s => s.items.length + s.events.length > 0)
}

/** Tags in use, most used first, with how many items carry each. */
export function tagCounts(items: readonly TaskListItem[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const i of items) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja'))
}

/** Only items carrying `tag` (null = all); meetings carry no tags, so a tag hides them. */
export function filterByTag(items: readonly TaskListItem[], tag: string | null): TaskListItem[] {
  return tag === null ? [...items] : items.filter(i => i.tags.includes(tag))
}

/** Whether the list shows for the department on screen (the company setting; 全社 = any department shows it). */
export function listShownFor(departmentId: string | null, listDepartmentIds: readonly string[] | null): boolean {
  if (listDepartmentIds === null) return true
  return departmentId === null ? listDepartmentIds.length > 0 : listDepartmentIds.includes(departmentId)
}

/** 「延ばす」's quick choices from now, in company time (a passed one is left out). */
export function postponeChoices(now: CompanyNow): Array<{ label: string; due: string }> {
  const [h, m] = now.time.split(':').map(Number)
  const nextHour = h + (m > 0 ? 2 : 1)
  const out: Array<{ label: string; due: string }> = []
  if (nextHour <= 23) out.push({ label: '1時間あと', due: `${now.date}T${String(nextHour).padStart(2, '0')}:00` })
  if (now.time < '17:00') out.push({ label: '今日の夕方', due: `${now.date}T17:00` })
  out.push({ label: 'あしたの朝', due: `${addDays(now.date, 1)}T09:00` })
  out.push({ label: '来週の月曜', due: `${addDays(now.date, ((8 - now.weekday) % 7) || 7)}T09:00` })
  return out
}
