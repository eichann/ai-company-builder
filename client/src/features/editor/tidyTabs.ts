// 「タブを片づける」 (owner decision 2026-11-04, OneTab-style): what a tidy closes, the saved
// 「片づけたタブ」 and their cap, the daily automatic tidy's day check, and the per company store on
// this Mac (localStorage, never the server). Pure except the store, whose Storage is injected.
import { dayWindow, DEFAULT_COMPANY_TIME_ZONE } from '../../../../shared/core/calendar'
import { thingName } from '../../../shared/thing-words'
import { recordIdOfTab, recordTabKey, type RecordTabLook } from './editorTabs'
import { GROUP_COLORS, type GroupColor } from './tabArrangement'

/** One tidied tab: a file by its company path, or a record with the look its tab had. */
export type TidiedItem =
  | { id: string; kind: 'file'; path: string; title: string }
  | { id: string; kind: 'record'; recordId: string; title: string; look?: RecordTabLook }

/** One tidy: when, on which company day, by hand or the daily automatic one. */
export interface TidiedGroup {
  id: string
  at: string
  day: string
  auto: boolean
  items: TidiedItem[]
  /** A named group tidied as one (「このまとまりを片づける」): reopening its tabs makes the group again. */
  tabGroup?: { name: string; color: GroupColor }
}

/** Kept on this Mac: the last 30 tidies and 500 tabs; older ones drop (the list says so). */
export const TIDY_LIMITS = { groups: 30, items: 500 } as const

/** The company's day (`2026-11-04`), the same "today" as 今日のフォルダ and the task list. */
export const companyDay = (nowMs: number): string => dayWindow(nowMs, DEFAULT_COMPANY_TIME_ZONE).date

export interface TidyPlan {
  /** Tabs to close and save, in the strip's order. */
  close: string[]
  /** Pinned tabs that stay open. */
  pinned: string[]
  /** Tabs with edits that could not be saved: they stay open and the member is told. */
  unsaved: string[]
}

/** Every open tab but the pinned ones and the ones still holding unsaved edits. */
export function planTidy(openTabs: readonly string[], pinned: readonly string[], unsaved: readonly string[]): TidyPlan {
  const pin = new Set(pinned)
  const dirty = new Set(unsaved)
  const plan: TidyPlan = { close: [], pinned: [], unsaved: [] }
  for (const key of openTabs) {
    if (pin.has(key)) plan.pinned.push(key)
    else if (dirty.has(key)) plan.unsaved.push(key)
    else plan.close.push(key)
  }
  return plan
}

const shortId = () => Math.random().toString(36).slice(2, 10)

/** The tab's company path (a file outside the company folder keeps its absolute path). */
function companyPathOf(key: string, rootPath: string): string {
  const root = rootPath.replace(/\/+$/, '')
  return root && key.startsWith(`${root}/`) ? key.slice(root.length + 1) : key
}

/** A tab as a tidied item: a file by its company path, a record with its look (title, icon). */
export function tidiedItemOf(key: string, rootPath: string, looks: Readonly<Record<string, RecordTabLook>>): TidiedItem {
  const recordId = recordIdOfTab(key)
  if (recordId) {
    const look = looks[recordId]
    return { id: shortId(), kind: 'record', recordId, title: look?.title ?? '記録', ...(look ? { look } : {}) }
  }
  const path = companyPathOf(key, rootPath)
  return { id: shortId(), kind: 'file', path, title: path.split('/').pop() || path }
}

/** The tab key to open an item again (files under today's company folder). */
export function tabKeyOf(item: TidiedItem, rootPath: string): string {
  if (item.kind === 'record') return recordTabKey(item.recordId)
  return item.path.startsWith('/') ? item.path : `${rootPath.replace(/\/+$/, '')}/${item.path}`
}

/** What the member reads as the item's kind (ファイル, やること, 案件…). */
export const itemKindName = (item: TidiedItem): string =>
  item.kind === 'file' ? 'ファイル' : item.look ? thingName(item.look) : '記録'

/** Adds a tidy (newest first) and drops the oldest past the cap; `dropped` = items no longer kept. */
export function addGroup(groups: readonly TidiedGroup[], group: TidiedGroup, limits = TIDY_LIMITS): { groups: TidiedGroup[]; dropped: number } {
  const before = groups.reduce((n, g) => n + g.items.length, 0) + group.items.length
  let next = [{ ...group, items: group.items.slice(0, limits.items) }, ...groups].slice(0, limits.groups)
  let total = next.reduce((n, g) => n + g.items.length, 0)
  // Past the item cap: the oldest tidies' items go first.
  while (total > limits.items && next.length > 1) {
    const last = next[next.length - 1]
    const over = total - limits.items
    if (last.items.length <= over) { next = next.slice(0, -1); total -= last.items.length }
    else { next = [...next.slice(0, -1), { ...last, items: last.items.slice(over) }]; total -= over }
  }
  return { groups: next, dropped: before - total }
}

/** Removes items (by id) from every group; a group left empty goes. */
export function removeItems(groups: readonly TidiedGroup[], itemIds: readonly string[]): TidiedGroup[] {
  const ids = new Set(itemIds)
  return groups
    .map(g => g.items.some(i => ids.has(i.id)) ? { ...g, items: g.items.filter(i => !ids.has(i.id)) } : g)
    .filter(g => g.items.length > 0)
}

/** Every tidy of one company day. */
export const removeDay = (groups: readonly TidiedGroup[], day: string): TidiedGroup[] => groups.filter(g => g.day !== day)

/** The list's sections: one per company day, newest first, its tidies newest first. */
export function groupsByDay(groups: readonly TidiedGroup[]): Array<{ day: string; groups: TidiedGroup[] }> {
  const days = new Map<string, TidiedGroup[]>()
  for (const g of [...groups].sort((a, b) => b.at.localeCompare(a.at))) days.set(g.day, [...(days.get(g.day) ?? []), g])
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, gs]) => ({ day, groups: gs }))
}

/** `2026-11-03` → 「11月3日（月）」. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const weekday = '日月火水木金土'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${m}月${d}日（${weekday}）`
}

/**
 * The daily automatic tidy is due on the first open of a company day after an earlier one. No
 * day remembered (the first open after the update, a new company here) → not due: nobody knows
 * when those tabs were opened, and nothing is closed by surprise.
 */
export function dueForDailyTidy(lastDay: string | null, today: string): boolean {
  return !!lastDay && lastDay < today
}

function parseItem(raw: unknown): TidiedItem | null {
  const i = raw as Partial<TidiedItem> & { path?: unknown; recordId?: unknown; look?: RecordTabLook } | null
  if (!i || typeof i.id !== 'string' || typeof i.title !== 'string') return null
  if (i.kind === 'file' && typeof i.path === 'string') return { id: i.id, kind: 'file', path: i.path, title: i.title.slice(0, 300) }
  if (i.kind === 'record' && typeof i.recordId === 'string') {
    const look = i.look && typeof i.look.title === 'string' && typeof i.look.type === 'string' ? i.look : undefined
    return { id: i.id, kind: 'record', recordId: i.recordId, title: i.title.slice(0, 300), ...(look ? { look } : {}) }
  }
  return null
}

/** Saved groups, each kept only when it has the shape (a hand-edited or older entry is dropped). */
export function parseGroups(raw: unknown): TidiedGroup[] {
  if (!Array.isArray(raw)) return []
  const out: TidiedGroup[] = []
  for (const g of raw as Array<Partial<TidiedGroup> | null>) {
    if (!g || typeof g.id !== 'string' || typeof g.at !== 'string' || typeof g.day !== 'string' || !Array.isArray(g.items)) continue
    const items = g.items.map(parseItem).filter((i): i is TidiedItem => i !== null)
    const tg = g.tabGroup
    const tabGroup = tg && typeof tg.name === 'string' && tg.name.trim() && GROUP_COLORS.includes(tg.color) ? { name: tg.name.slice(0, 40), color: tg.color } : null
    if (items.length > 0) out.push({ id: g.id, at: g.at, day: g.day, auto: g.auto === true, items, ...(tabGroup ? { tabGroup } : {}) })
  }
  return out
}

// --- The store: per company on this Mac --------------------------------------------------

const GROUPS_KEY = (companyId: string) => `tidiedTabs:${companyId}`
const DAY_KEY = (companyId: string) => `tidiedTabs:lastDay:${companyId}`
const AUTO_KEY = 'acb.tabs.dailyTidy'
const NOTICE_KEY = 'acb.tabs.dailyTidyNoticeShown'

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** 片づけたタブ and the daily tidy's memory, in `storage` only (localStorage in the app). */
export function createTidyStore(storage: () => KeyValue | null) {
  const listeners = new Set<() => void>()
  const cache = new Map<string, TidiedGroup[]>()
  const read = (key: string): string | null => { try { return storage()?.getItem(key) ?? null } catch { return null } }
  const write = (key: string, value: string | null) => {
    try { if (value === null) storage()?.removeItem(key); else storage()?.setItem(key, value) } catch { /* full or unavailable: kept in memory */ }
  }
  const notify = () => { for (const l of [...listeners]) l() }
  const groups = (companyId: string): TidiedGroup[] => {
    let g = cache.get(companyId)
    if (!g) {
      try { g = parseGroups(JSON.parse(read(GROUPS_KEY(companyId)) ?? '[]')) } catch { g = [] }
      cache.set(companyId, g)
    }
    return g
  }
  const setGroups = (companyId: string, next: TidiedGroup[]) => {
    cache.set(companyId, next)
    write(GROUPS_KEY(companyId), next.length > 0 ? JSON.stringify(next) : null)
    notify()
  }
  return {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    groups,
    /** Saves a tidy; answers how many older items dropped past the cap. */
    add(companyId: string, group: TidiedGroup): number {
      const r = addGroup(groups(companyId), group)
      setGroups(companyId, r.groups)
      return r.dropped
    },
    removeItems: (companyId: string, ids: readonly string[]) => setGroups(companyId, removeItems(groups(companyId), ids)),
    removeDay: (companyId: string, day: string) => setGroups(companyId, removeDay(groups(companyId), day)),
    /**
     * A company's tabs were restored on `today`: remembers the day and answers whether the daily
     * tidy runs now (switch on, and an earlier day was remembered). Once per company day.
     */
    dailyTidyDue(companyId: string, today: string): boolean {
      const last = read(DAY_KEY(companyId))
      write(DAY_KEY(companyId), today)
      return read(AUTO_KEY) !== 'off' && dueForDailyTidy(last, today)
    },
    /** The daily tidy's switch (自分の設定), per Mac; on unless turned off. */
    dailyTidyOn: () => read(AUTO_KEY) !== 'off',
    setDailyTidy: (on: boolean) => { write(AUTO_KEY, on ? null : 'off'); notify() },
    noticeShown: () => read(NOTICE_KEY) === '1',
    markNoticeShown: () => write(NOTICE_KEY, '1'),
  }
}

export type TidyStore = ReturnType<typeof createTidyStore>

/** The app's store (this Mac's localStorage). */
export const tidyStore: TidyStore = createTidyStore(() => (typeof localStorage === 'undefined' ? null : localStorage))
