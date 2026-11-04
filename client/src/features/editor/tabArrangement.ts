// How the middle's tabs stand (owner 2026-11-04, after 「タブを片づける」): pinned (固定) tabs first,
// then the member's own named groups (まとまり, Chrome tab-group style), then the rest — in one run,
// or by kind when 「種類ごとにまとめる」 is on (ファイル, やること, 案件…, 会議の記録, 決めたこと, その他).
// The open tabs' one order (`openFiles`) stays the truth: what is shown is a stable split of it, so a
// new tab lands at the end of its run. Pure except the per company store on this Mac.
import { nameKey } from '../../../../shared/core/paths'
import { TAB_KIND_GROUPS, tabKindGroupName, tabKindGroupOf, type TabKindGroup } from '../../../shared/thing-words'
import { recordIdOfTab, type RecordTabLook } from './editorTabs'

type Looks = Readonly<Record<string, RecordTabLook>>

/** The kind group of a tab: a file's is `file`; a record's comes from its look (`other` until read). */
export function tabGroupOf(key: string, looks: Looks): TabKindGroup {
  const id = recordIdOfTab(key)
  return id ? tabKindGroupOf(looks[id]) : 'file'
}

/** A kind group's name for the tabs in it (bundles by the labels of the ones open: 「案件・プロジェクト」). */
export const tabGroupName = (group: TabKindGroup, keys: readonly string[], looks: Looks): string =>
  tabKindGroupName(group, keys.map(k => looks[recordIdOfTab(k) ?? '']?.typeLabel))

/** The colours a named group can have (one small palette, readable in light and dark). */
export const GROUP_COLORS = ['blue', 'green', 'amber', 'rose', 'violet', 'teal'] as const
export type GroupColor = typeof GROUP_COLORS[number]
export const GROUP_COLOR_NAMES: Readonly<Record<GroupColor, string>> = { blue: '青', green: '緑', amber: '黄', rose: '赤', violet: '紫', teal: '水色' }
/** Each colour's classes (whole strings, so Tailwind finds them): the chip, the line under its tabs, the swatch. */
export const GROUP_COLOR_CLASSES: Readonly<Record<GroupColor, { chip: string; line: string; swatch: string }>> = {
  blue: { chip: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200', line: 'border-b-blue-500', swatch: 'bg-blue-500' },
  green: { chip: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200', line: 'border-b-green-500', swatch: 'bg-green-500' },
  amber: { chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200', line: 'border-b-amber-500', swatch: 'bg-amber-500' },
  rose: { chip: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200', line: 'border-b-rose-500', swatch: 'bg-rose-500' },
  violet: { chip: 'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200', line: 'border-b-violet-500', swatch: 'bg-violet-500' },
  teal: { chip: 'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200', line: 'border-b-teal-500', swatch: 'bg-teal-500' },
}

/** A member's named group of tabs (まとまり). */
export interface NamedTabGroup { id: string; name: string; color: GroupColor; collapsed?: boolean }

/** What is kept per company: the kind switch, the folded kind groups, the named groups and who is in them. */
export interface TabGrouping {
  byKind: boolean
  collapsedKinds: TabKindGroup[]
  groups: NamedTabGroup[]
  /** Tab key → named group id. */
  members: Record<string, string>
}
export const NO_GROUPING: TabGrouping = { byKind: false, collapsedKinds: [], groups: [], members: {} }

/** A run of tabs: the pinned ones, one named group (`group:<id>`), the rest (`all`), or one kind group. */
export type TabSectionId = 'pinned' | 'all' | TabKindGroup | `group:${string}`
export interface TabSection { id: TabSectionId; keys: string[]; group?: NamedTabGroup; kind?: TabKindGroup }

export interface ArrangeOptions {
  pinned: ReadonlySet<string>
  looks: Looks
  grouping: TabGrouping
}

/** The named group a tab is in (none when pinned: a pinned tab stands with the pinned ones). */
export function namedGroupOf(key: string, o: ArrangeOptions): NamedTabGroup | null {
  if (o.pinned.has(key)) return null
  const id = o.grouping.members[key]
  return id ? o.grouping.groups.find(g => g.id === id) ?? null : null
}

export function sectionOf(key: string, o: ArrangeOptions): TabSectionId {
  if (o.pinned.has(key)) return 'pinned'
  const named = namedGroupOf(key, o)
  if (named) return `group:${named.id}`
  return o.grouping.byKind ? tabGroupOf(key, o.looks) : 'all'
}

/** The runs as shown, each in `order`'s order; empty runs left out. */
export function arrangeTabs(order: readonly string[], o: ArrangeOptions): TabSection[] {
  const sections: TabSection[] = [
    { id: 'pinned', keys: [] },
    ...o.grouping.groups.map(g => ({ id: `group:${g.id}` as const, keys: [], group: g })),
    ...(o.grouping.byKind ? TAB_KIND_GROUPS.map(kind => ({ id: kind, keys: [], kind })) : [{ id: 'all' as const, keys: [] }]),
  ]
  const byId = new Map<TabSectionId, TabSection>(sections.map(s => [s.id, s]))
  for (const key of order) byId.get(sectionOf(key, o))?.keys.push(key)
  return sections.filter(s => s.keys.length > 0)
}

/**
 * Whether `key` may be dropped beside `target`. A pinned tab moves among the pinned ones only; any
 * other tab may join a named group (or leave one) by its place, but a kind group takes its own kind only.
 */
export function canMoveTab(key: string, target: string, o: ArrangeOptions): boolean {
  if (key === target) return false
  const pinnedKey = o.pinned.has(key)
  if (pinnedKey || o.pinned.has(target)) return pinnedKey && o.pinned.has(target)
  if (namedGroupOf(target, o) || !o.grouping.byKind) return true
  return tabGroupOf(key, o.looks) === tabGroupOf(target, o.looks)
}

export interface TabMove { order: string[]; members: Record<string, string> }

/** `key` moved just before or after `target`, in `target`'s named group (or none); unchanged when not allowed. */
export function moveTab(order: readonly string[], key: string, target: string, place: 'before' | 'after', o: ArrangeOptions): TabMove {
  const members = { ...o.grouping.members }
  if (!canMoveTab(key, target, o) || !order.includes(key) || !order.includes(target)) return { order: [...order], members }
  const rest = order.filter(k => k !== key)
  const at = rest.indexOf(target) + (place === 'after' ? 1 : 0)
  if (!o.pinned.has(key)) {
    const into = namedGroupOf(target, o)
    if (into) members[key] = into.id
    else delete members[key]
  }
  return { order: [...rest.slice(0, at), key, ...rest.slice(at)], members }
}

/** `key` put at the end of a named group (dropped on its chip, 「〇〇に入れる」). */
export function addToGroup(order: readonly string[], key: string, groupId: string, o: ArrangeOptions): TabMove {
  const members = { ...o.grouping.members }
  if (o.pinned.has(key) || !order.includes(key) || !o.grouping.groups.some(g => g.id === groupId)) return { order: [...order], members }
  const last = [...order].reverse().find(k => k !== key && members[k] === groupId && !o.pinned.has(k))
  members[key] = groupId
  if (!last) return { order: [...order], members }
  const rest = order.filter(k => k !== key)
  const at = rest.indexOf(last) + 1
  return { order: [...rest.slice(0, at), key, ...rest.slice(at)], members }
}

/** Named groups and memberships of tabs still open only: a group left with no tab goes. */
export function pruneGrouping(grouping: TabGrouping, openTabs: readonly string[]): TabGrouping {
  const open = new Set(openTabs)
  const members = Object.fromEntries(Object.entries(grouping.members).filter(([k, g]) => open.has(k) && grouping.groups.some(x => x.id === g)))
  const used = new Set(Object.values(members))
  return { ...grouping, groups: grouping.groups.filter(g => used.has(g.id)), members }
}

/** A new named group's id (made by hand or when a tidied group is reopened). */
export const newGroupId = (): string => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Group names compare as the member reads them: width (NFKC), A–Z case and outer spaces ignored. */
export const groupNameKey = (name: string): string => nameKey(name.normalize('NFKC').trim())

/** Whether another group (not `exceptId`) already has this name. */
export const groupNameTaken = (groups: readonly NamedTabGroup[], name: string, exceptId?: string): boolean =>
  groups.some(g => g.id !== exceptId && groupNameKey(g.name) === groupNameKey(name))

/** A short, unused name for a new group (「まとまり 2」). */
export function nextGroupName(groups: readonly NamedTabGroup[]): string {
  for (let n = 1; ; n++) if (!groupNameTaken(groups, `まとまり ${n}`)) return `まとまり ${n}`
}

/** The grouping without one named group: its tabs stay open, outside any group. */
export const withoutGroup = (g: TabGrouping, groupId: string): TabGrouping => ({
  ...g, groups: g.groups.filter(x => x.id !== groupId), members: Object.fromEntries(Object.entries(g.members).filter(([, id]) => id !== groupId)),
})

/** A tab's named group as a tidy keeps it (name and colour; the id is not kept). */
export interface TidiedTabGroup { name: string; color: GroupColor }

/**
 * Reopened tabs back in the named groups they were tidied from: into the group of that name when
 * there is one (names are unique), otherwise a new group with the name and colour they had.
 */
export function regroup(g: TabGrouping, tabs: ReadonlyArray<{ key: string; group: TidiedTabGroup }>): TabGrouping {
  let next = g
  for (const { key, group } of tabs) {
    let target = next.groups.find(x => groupNameKey(x.name) === groupNameKey(group.name))
    if (!target) {
      target = { id: newGroupId(), name: group.name, color: group.color }
      next = { ...next, groups: [...next.groups, target] }
    }
    next = { ...next, members: { ...next.members, [key]: target.id } }
  }
  return next
}

/** A colour no open group has yet, or the palette's next one. */
export const nextGroupColor = (groups: readonly NamedTabGroup[]): GroupColor =>
  GROUP_COLORS.find(c => !groups.some(g => g.color === c)) ?? GROUP_COLORS[groups.length % GROUP_COLORS.length]

/** A saved entry, each part kept only when it has the shape (a hand-edited or older entry reads as nothing). */
export function parseGrouping(raw: unknown): TabGrouping {
  const v = raw as Partial<TabGrouping> | null
  if (!v || typeof v !== 'object') return NO_GROUPING
  const collapsedKinds = Array.isArray(v.collapsedKinds) ? TAB_KIND_GROUPS.filter(g => (v.collapsedKinds as unknown[]).includes(g)) : []
  const groups: NamedTabGroup[] = []
  for (const g of Array.isArray(v.groups) ? v.groups as Array<Partial<NamedTabGroup> | null> : []) {
    if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || !g.name.trim()) continue
    groups.push({ id: g.id, name: g.name.slice(0, 40), color: GROUP_COLORS.includes(g.color as GroupColor) ? g.color as GroupColor : 'blue', ...(g.collapsed === true ? { collapsed: true } : {}) })
  }
  const members: Record<string, string> = {}
  if (v.members && typeof v.members === 'object') {
    for (const [k, id] of Object.entries(v.members)) if (typeof id === 'string' && groups.some(g => g.id === id)) members[k] = id
  }
  return { byKind: v.byKind === true, collapsedKinds, groups, members }
}

// --- The store: per company on this Mac ------------------------------------------------------

const KEY = (companyId: string) => `tabGroups:${companyId}`
type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** `tabGroups:<company id>` in `storage` only (localStorage in the app); never the server. */
export function createTabGroupingStore(storage: () => KeyValue | null) {
  const listeners = new Set<() => void>()
  const cache = new Map<string, TabGrouping>()
  const get = (companyId: string): TabGrouping => {
    let g = cache.get(companyId)
    if (!g) {
      try { g = parseGrouping(JSON.parse(storage()?.getItem(KEY(companyId)) ?? 'null')) } catch { g = NO_GROUPING }
      cache.set(companyId, g)
    }
    return g
  }
  return {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    get,
    /** Changes a company's entry; an entry back to nothing is removed. */
    update(companyId: string, change: (cur: TabGrouping) => TabGrouping) {
      const next = change(get(companyId))
      cache.set(companyId, next)
      try {
        if (!next.byKind && next.collapsedKinds.length === 0 && next.groups.length === 0) storage()?.removeItem(KEY(companyId))
        else storage()?.setItem(KEY(companyId), JSON.stringify(next))
      } catch { /* full or unavailable: kept in memory */ }
      for (const l of [...listeners]) l()
    },
  }
}

export type TabGroupingStore = ReturnType<typeof createTabGroupingStore>

/** The app's store (this Mac's localStorage). */
export const tabGroupingStore: TabGroupingStore = createTabGroupingStore(() => (typeof localStorage === 'undefined' ? null : localStorage))
