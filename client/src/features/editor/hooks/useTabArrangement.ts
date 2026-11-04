import { useCallback, useMemo, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import type { RecordTabLook } from '../editorTabs'
import {
  addToGroup, arrangeTabs, canMoveTab, groupNameTaken, moveTab, namedGroupOf, newGroupId, nextGroupColor, nextGroupName, NO_GROUPING, pruneGrouping,
  tabGroupingStore, withoutGroup,
  type ArrangeOptions, type GroupColor, type NamedTabGroup, type TabGrouping, type TabGroupingStore, type TabSection, type TabSectionId,
} from '../tabArrangement'

interface Options {
  companyId: string | undefined
  openTabs: string[]
  setOpenTabs: Dispatch<SetStateAction<string[]>>
  pinned: ReadonlySet<string>
  recordLooks: Readonly<Record<string, RecordTabLook>>
  store?: TabGroupingStore
}

/** The name-and-colour dialog: a new group for a tab, or an existing group's; `error` = why the last name was refused. */
export type GroupDialog = ({ kind: 'new'; tabKey: string; name: string; color: GroupColor } | { kind: 'edit'; group: NamedTabGroup }) & { error?: string }

export const GROUP_NAME_TAKEN = '同じ名前のまとまりがあります。別の名前にしてください。'

/**
 * How the middle's tabs stand (tabArrangement.ts): their order by drag, the member's named groups
 * and 「種類ごとにまとめる」, kept per company on this Mac.
 */
export function useTabArrangement({ companyId, openTabs, setOpenTabs, pinned, recordLooks, store = tabGroupingStore }: Options) {
  const saved = useSyncExternalStore(store.subscribe, () => companyId ? store.get(companyId) : NO_GROUPING)
  // Only open tabs count: a closed tab is in no group, a group with none left is not shown.
  const grouping = useMemo(() => pruneGrouping(saved, openTabs), [saved, openTabs])
  const options: ArrangeOptions = useMemo(() => ({ pinned, looks: recordLooks, grouping }), [pinned, recordLooks, grouping])
  const sections = useMemo(() => arrangeTabs(openTabs, options), [openTabs, options])
  const [dialog, setDialog] = useState<GroupDialog | null>(null)
  const latest = useLatestRef({ companyId, openTabs, options })

  const update = useCallback((change: (cur: TabGrouping) => TabGrouping) => {
    const cur = latest.current
    if (cur.companyId) store.update(cur.companyId, g => change(pruneGrouping(g, cur.openTabs)))
  }, [latest, store])
  const applyMove = useCallback((move: (o: ArrangeOptions, order: string[]) => { order: string[]; members: Record<string, string> }) => {
    const cur = latest.current
    const r = move(cur.options, cur.openTabs)
    setOpenTabs(r.order)
    update(g => ({ ...g, members: r.members }))
  }, [latest, setOpenTabs, update])

  /** A section's tabs folded behind its chip (a kind group or a named group). */
  const isCollapsed = (s: TabSection): boolean => s.group ? !!s.group.collapsed : !!s.kind && grouping.collapsedKinds.includes(s.kind)
  const toggleCollapsed = (id: TabSectionId) => update(g => {
    if (id.startsWith('group:')) return { ...g, groups: g.groups.map(x => `group:${x.id}` === id ? { ...x, collapsed: !x.collapsed || undefined } : x) }
    const kind = id as TabGrouping['collapsedKinds'][number]
    return { ...g, collapsedKinds: g.collapsedKinds.includes(kind) ? g.collapsedKinds.filter(k => k !== kind) : [...g.collapsedKinds, kind] }
  })

  return {
    sections, grouping, isCollapsed, toggleCollapsed,
    byKind: grouping.byKind,
    setByKind: (on: boolean) => update(g => ({ ...g, byKind: on })),
    canDrop: (key: string, target: string) => canMoveTab(key, target, options),
    reorder: (key: string, target: string, place: 'before' | 'after') => applyMove((o, order) => moveTab(order, key, target, place, o)),
    addToGroup: (key: string, groupId: string) => applyMove((o, order) => addToGroup(order, key, groupId, o)),
    removeFromGroup: (key: string) => update(g => { const members = { ...g.members }; delete members[key]; return { ...g, members } }),
    groupOf: (key: string): NamedTabGroup | null => namedGroupOf(key, options),
    /** 「まとまりを解く」: the tabs stay open, outside any group. */
    ungroup: (groupId: string) => update(g => withoutGroup(g, groupId)),
    dialog,
    askNewGroup: (tabKey: string) => setDialog({ kind: 'new', tabKey, name: nextGroupName(grouping.groups), color: nextGroupColor(grouping.groups) }),
    askEditGroup: (group: NamedTabGroup) => setDialog({ kind: 'edit', group }),
    closeDialog: () => setDialog(null),
    /** The dialog's answer: a new group with its first tab, or the group renamed / recoloured; a name taken keeps the dialog open. */
    saveDialog: (typed: string, color: GroupColor) => {
      const d = dialog
      const name = typed.trim().slice(0, 40)
      if (!d || !name) return
      if (groupNameTaken(latest.current.options.grouping.groups, name, d.kind === 'edit' ? d.group.id : undefined)) {
        setDialog(d.kind === 'new' ? { ...d, name: typed, color, error: GROUP_NAME_TAKEN } : { ...d, group: { ...d.group, name: typed, color }, error: GROUP_NAME_TAKEN })
        return
      }
      setDialog(null)
      if (d.kind === 'edit') { update(g => ({ ...g, groups: g.groups.map(x => x.id === d.group.id ? { ...x, name, color } : x) })); return }
      if (latest.current.options.pinned.has(d.tabKey)) return
      const id = newGroupId()
      update(g => ({ ...g, groups: [...g.groups, { id, name, color }], members: { ...g.members, [d.tabKey]: id } }))
    },
  }
}

export type TabArrangement = ReturnType<typeof useTabArrangement>
