// The task list's pure rules (tasks-ui.md): where each item and meeting goes by turn or by
// date, which part of the future folds, how a due reads, and the tag filter. "Today" is the
// company's day (Japan time until a company setting exists, calendar.md).
import type { CalendarEvent } from '../../../shared/calendar'
import type { TaskListItem } from '../../../shared/tasks'
import type { TaskCardResult } from '../../../shared/task-card'
import { DEFAULT_COMPANY_TIME_ZONE } from '../../../../shared/core/calendar'
import { weekEndOf } from '../../../../shared/core/turn-timing'
import { isBusinessDay, nextBusinessDay } from '../../../../shared/core/business-days'
import { isPathWithin, normalizePathSeparators } from '../../shared/lib/path'
import { bundleWords } from '../../../shared/thing-words'
import type { BundleKind, BundleKindsResult } from '../../../../shared/types/records'
import { defaultBundleFolder } from '../../../../shared/core/bundle-place'
import { suggestFolderName } from '../../../../shared/core/names'

/** 番ごと ｜ 〇〇ごと (what the items belong to: 案件, プロジェクト…) ｜ 日付ごと. */
export type ListMode = 'turn' | 'bundle' | 'date'

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

/**
 * What the card shows after a read answered (`useTaskCard`): two reads may race and the older
 * answer land last, so an answer with an older version than the one shown is ignored; a failed
 * re-read keeps a shown card (unless the task is gone).
 */
export function nextCard(prev: TaskCardResult | null, next: TaskCardResult): TaskCardResult {
  if (!prev?.success) return next
  if (!next.success) return next.notFound ? next : prev
  return next.card.record.version < prev.card.record.version ? prev : next
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
  return weekEndOf(now.date)
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
  /** 〇〇ごと: the bundle this section is (its title opens it). */
  bundle?: { id: string; title: string; typeLabel?: string }
}

/**
 * The sections of the list. By turn: 引き受け待ち, あなたの番 (today's meetings to come mixed
 * in), AI の番, ほかの人の番・返事待ち, 先のこと (tasks not started due after this week, folded),
 * いつか (tasks not started with no due, folded),
 * 今日終わったこと (with today's meetings that are over). By date: 期限切れ, 今日,
 * 明日, 今週, あとで (folded), 期限なし, 今日終わったこと. By bundle: each one with its open items,
 * then 「〇〇なし」. Empty sections are left out.
 */
/** `bundleWord`: the name of 「〇〇なし」 when nothing in the list belongs to one (the department's kind). */
export function listSections(items: readonly TaskListItem[], events: readonly ListEvent[], mode: ListMode, now: CompanyNow, bundleWord?: string): ListSection[] {
  const open = items.filter(i => i.turn !== 'done')
  const done = items.filter(i => i.turn === 'done').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
  const coming = events.filter(e => !e.past)
  const over = events.filter(e => e.past)
  const sorted = (list: TaskListItem[]) => [...list].sort(byDue)
  const sections: ListSection[] = []
  if (mode === 'turn') {
    // Only a task resting in the member's turn (not started, nothing to press) leaves 「あなたの番」:
    // due after this week → 先のこと, no due → いつか (shared/core/turn-timing.ts; the title bar's
    // count and the morning summary leave out the same ones).
    const mine = open.filter(i => i.turn === 'mine')
    const later = mine.filter(i => i.resting && dueWhen(i.due, now) === 'later')
    const someday = mine.filter(i => i.resting && i.due === null)
    sections.push(
      { key: 'acceptance', title: '引き受け待ち', items: sorted(open.filter(i => i.turn === 'acceptance')), events: [], foldable: false, note: '引き受けるか、受けられないかを決めてください' },
      { key: 'mine', title: 'あなたの番', items: sorted(mine.filter(i => !later.includes(i) && !someday.includes(i))), events: coming, foldable: false },
      { key: 'ai', title: 'AI の番', items: sorted(open.filter(i => i.turn === 'ai')), events: [], foldable: false },
      { key: 'others', title: 'ほかの人の番・返事待ち', items: sorted(open.filter(i => i.turn === 'others')), events: [], foldable: false },
      { key: 'later', title: '先のこと', items: sorted(later), events: [], foldable: true, note: `${dueText(addDays(weekEnd(now), 1), now)}から` },
      { key: 'someday', title: 'いつか', items: sorted(someday), events: [], foldable: true, note: '期限のない、まだ始めていないもの' },
    )
  } else if (mode === 'bundle') {
    // Each bundle with open items, in the order of its earliest due; then those in none.
    const groups = new Map<string, TaskListItem[]>()
    for (const i of sorted(open)) if (i.bundle) groups.set(i.bundle.id, [...(groups.get(i.bundle.id) ?? []), i])
    for (const [id, list] of groups) {
      const b = list[0].bundle!
      sections.push({ key: `bundle:${id}`, title: b.title, items: list, events: [], foldable: false, note: b.typeLabel, bundle: b })
    }
    sections.push({ key: 'no-bundle', title: `${bundleListWord(items, bundleWord)}なし`, items: sorted(open.filter(i => !i.bundle)), events: [], foldable: false })
  } else {
    // 期限切れ・今日・明日・今週・あとで (folded)・期限なし (言葉の決まり 5.).
    const tomorrow = addDays(now.date, 1)
    const at = (w: ReturnType<typeof dueWhen>) => open.filter(i => dueWhen(i.due, now) === w)
    const week = at('week')
    sections.push(
      { key: 'overdue', title: '期限切れ', items: sorted(at('overdue')), events: [], foldable: false },
      { key: 'today', title: '今日', items: sorted(at('today')), events: coming, foldable: false },
      { key: 'tomorrow', title: '明日', items: sorted(week.filter(i => i.due!.slice(0, 10) === tomorrow)), events: [], foldable: false },
      { key: 'week', title: `今週（〜${dueText(weekEnd(now), now)}）`, items: sorted(week.filter(i => i.due!.slice(0, 10) !== tomorrow)), events: [], foldable: false },
      { key: 'later', title: 'あとで', items: sorted(at('later')), events: [], foldable: true, note: `${dueText(addDays(weekEnd(now), 1), now)}から` },
      { key: 'none', title: '期限なし', items: sorted(at('none')), events: [], foldable: false },
    )
  }
  sections.push({ key: 'done', title: '今日終わったこと', items: done, events: over, foldable: false, note: 'あしたの朝に空になります' })
  return sections.filter(s => s.items.length + s.events.length > 0)
}

/**
 * The word of 「〇〇ごと」: the member's list crosses departments, so it is the kinds actually in
 * it (「案件」, 「案件・プロジェクト」); with none, the company's name for its own kind.
 */
export function bundleListWord(items: readonly TaskListItem[], companyWord = 'プロジェクト'): string {
  return bundleWords(items.map(i => i.bundle?.typeLabel), companyWord)
}

/**
 * What the department on screen makes (`folder`; 全社 = none → the company's own kind), null until
 * the kinds are read. Its name is the word of ［〇〇につなぐ］ and 「〇〇を選ぶ」.
 */
export function departmentBundleKind(kinds: BundleKindsResult | null | undefined, folder: string | null | undefined): BundleKind | null {
  if (!kinds) return null
  const kind = kinds.departments.find(d => d.folder === folder)?.kind ?? kinds.core
  // プロジェクト turned off (「使う機能」, `coreOff`): the core's kind is made nowhere, so nothing is offered to make.
  return kinds.coreOff && kind.source === 'core' ? null : kind
}

/** A department a new 案件・プロジェクト may belong to (null folder = 全社), with what it makes there. */
export interface BundlePlace {
  folder: string | null
  name: string
  kind: BundleKind | null
  /** The department's id (null = 全社): who may make a 非公開 one there. */
  departmentId: string | null
}

/**
 * Who may make a 非公開 案件・プロジェクト (records.md "Private 案件・プロジェクト"): exactly who may create a
 * private folder there today — owners / admins anywhere, a department's managers inside it.
 */
export function mayMakePrivateBundle(place: BundlePlace, rights: { role: string; managedDepartmentIds: readonly string[] }): boolean {
  if (rights.role === 'owner' || rights.role === 'admin') return true
  return place.departmentId !== null && rights.managedDepartmentIds.includes(place.departmentId)
}

/** The private folder's name for a 非公開 one: its name as a folder name, then -2, -3… when that is taken. */
export function privateBundleFolderNames(title: string, word: string): string[] {
  const base = suggestFolderName(title).slice(0, 80) || suggestFolderName(word) || 'project'
  return [base, ...[2, 3, 4, 5].map(n => `${base}-${n}`)]
}

/**
 * Where 「新しい〇〇にする」 puts a new one (records.md "A task and its 案件・プロジェクト"): the
 * departments in the tabs' order — plus 全社 when that is the default — and the default, the
 * creator's own department (`defaultBundleFolder`, the server's rule for the AI too).
 */
export function bundlePlacesOf(
  departments: ReadonlyArray<{ id: string; name: string; folder: string }>,
  kinds: BundleKindsResult | null | undefined,
  mine: readonly string[] | null,
  onScreen: string | null,
): { choices: BundlePlace[]; defaultFolder: string | null } {
  const listed = departments.filter(d => d.folder)
  const defaultFolder = defaultBundleFolder({ departments: listed, mine, onScreen: onScreen || null })
  const choices: BundlePlace[] = listed.map(d => ({ folder: d.folder, name: d.name, kind: departmentBundleKind(kinds, d.folder), departmentId: d.id }))
  if (defaultFolder === null) choices.push({ folder: null, name: '全社', kind: kinds?.core ?? null, departmentId: null })
  return { choices, defaultFolder }
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

/**
 * 「延ばす」's choices from now, in company time (owner 2026-11-03, 使い心地のメモ #7: more of them, no
 * date picker): 1時間あと, 今日の夕方, あしたの朝, あさって, 今週の金曜, 来週の月曜, 来週の金曜, 2週間後,
 * 来月のはじめ. A day that is a weekend or a holiday (Japan's and the company's, `holidays`) moves to
 * the next business day; one already past (today or before) or on the same day as an earlier
 * choice is left out, so each row is a different day.
 */
export function postponeChoices(now: CompanyNow, holidays: readonly string[] = []): Array<{ label: string; due: string }> {
  const [h, m] = now.time.split(':').map(Number)
  const nextHour = h + (m > 0 ? 2 : 1)
  const out: Array<{ label: string; due: string }> = []
  if (nextHour <= 23) out.push({ label: '1時間あと', due: `${now.date}T${String(nextHour).padStart(2, '0')}:00` })
  // 今日の夕方 only while it is later than 1時間あと (never the same time twice).
  if (nextHour < 17) out.push({ label: '今日の夕方', due: `${now.date}T17:00` })
  const business = (day: string) => (isBusinessDay(day, holidays) ? day : nextBusinessDay(day, holidays))
  const nextMonday = addDays(now.date, ((8 - now.weekday) % 7) || 7)
  const [y, mo] = now.date.split('-').map(Number)
  const nextMonth = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-01`
  const days: Array<{ label: string; day: string; time?: string }> = [
    { label: 'あしたの朝', day: addDays(now.date, 1), time: '09:00' },
    { label: 'あさって', day: addDays(now.date, 2) },
    // The week runs Monday to Sunday: on a Saturday or Sunday this week's Friday is past.
    { label: '今週の金曜', day: addDays(now.date, now.weekday === 0 ? -2 : 5 - now.weekday) },
    { label: '来週の月曜', day: nextMonday, time: '09:00' },
    { label: '来週の金曜', day: addDays(nextMonday, 4) },
    { label: '2週間後', day: addDays(now.date, 14) },
    { label: '来月のはじめ', day: nextMonth },
  ]
  const taken = new Set<string>()
  for (const c of days) {
    const day = business(c.day)
    if (day <= now.date || taken.has(day)) continue
    taken.add(day)
    out.push({ label: c.label, due: c.time ? `${day}T${c.time}` : day })
  }
  return out
}

/** A local path inside the company folder as the server names it (`営業/見積.xlsx`); null outside it or the folder itself. */
export function companyPathOf(path: string, rootPath: string): string | null {
  const p = normalizePathSeparators(path)
  const root = normalizePathSeparators(rootPath).replace(/\/+$/, '')
  return root && isPathWithin(p, root) && p !== root ? p.slice(root.length + 1) : null
}

/** The open tasks a file may be linked to from the list (finished ones and other kinds are not offered). */
export function linkableTasks(items: readonly TaskListItem[]): TaskListItem[] {
  return items.filter(i => i.type === 'task' && i.turn !== 'done')
}

/** A row of a section: one item, or 「まとまりを選ぶ会議 n件」 holding the meetings of one 相手 or series. */
export type ListRow =
  | { kind: 'item'; item: TaskListItem }
  | { kind: 'bundle-group'; key: string; label: string; items: TaskListItem[] }

/**
 * Meetings asking 「どのまとまりの会議ですか？」 that the server put in one group (same 相手 or
 * series) become one row where the first of them stands, when there are two or more; everything
 * else stays one row per item, in order.
 */
export function listRows(items: readonly TaskListItem[]): ListRow[] {
  const groups = new Map<string, TaskListItem[]>()
  for (const i of items) {
    if (!i.needsBundle || !i.bundleGroup) continue
    groups.set(i.bundleGroup.key, [...(groups.get(i.bundleGroup.key) ?? []), i])
  }
  const out: ListRow[] = []
  const placed = new Set<string>()
  for (const i of items) {
    const g = i.needsBundle && i.bundleGroup ? groups.get(i.bundleGroup.key) : undefined
    if (!g || g.length < 2 || !i.bundleGroup) { out.push({ kind: 'item', item: i }); continue }
    if (placed.has(i.bundleGroup.key)) continue
    placed.add(i.bundleGroup.key)
    out.push({ kind: 'bundle-group', key: i.bundleGroup.key, label: i.bundleGroup.label, items: g })
  }
  return out
}

/**
 * What 「＋ファイル・フォルダをつなぐ」 offers: the company's files and every folder above them
 * (a folder can be linked too, owner decision 2026-11-03), each folder once, folders first.
 */
export function linkCandidates(files: readonly string[]): Array<{ path: string; folder: boolean }> {
  const folders = new Set<string>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  return [...[...folders].sort().map(path => ({ path, folder: true })), ...files.map(path => ({ path, folder: false }))]
}
