import { useCallback, useMemo, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { useCommandHandler } from '../../../shared/commands/commands'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { saveUnsavedEdits, unsavedPaths } from '../../../shared/lib/unsavedEdits'
import { fileExists, recordStillThere } from '../api'
import type { RecordTabLook } from '../editorTabs'
import type { TabKindGroup } from '../../../../shared/thing-words'
import {
  groupNameKey, namedGroupOf, NO_GROUPING, pruneGrouping, regroup, tabGroupingStore, tabGroupName, tabGroupOf, type ArrangeOptions, type TabGroupingStore,
} from '../tabArrangement'
import type { RestoredTabs } from './useEditorPersistence'
import {
  companyDay, dayLabel, groupsByDay, itemKindName, planTidy, tabKeyOf, tidiedItemOf, tidyStore,
  type TidiedGroup, type TidiedItem, type TidyStore,
} from '../tidyTabs'

interface Options {
  companyId: string | undefined
  rootPath: string | undefined
  openTabs: string[]
  /** The pinned (固定) tabs as saved (useEditorPersistence); one closed meanwhile no longer counts. */
  pinnedTabs: string[]
  setPinnedTabs: Dispatch<SetStateAction<string[]>>
  recordLooks: Readonly<Record<string, RecordTabLook>>
  closeTabs: (keys: readonly string[]) => void
  reopenTabs: (keys: readonly string[]) => void
  store?: TidyStore
  /** The named groups (tabArrangement.ts): a group is tidied as one and made again when reopened. */
  grouping?: TabGroupingStore
  now?: () => number
}

/** What one tidy takes: every tab, one kind group, or one named group (by id or name). */
export interface TidyScope { kind?: TabKindGroup; group?: string }

/** The one-line notice above the tabs: what a tidy did, or the daily tidy's first-time explanation. */
export interface TidyNotice { text: string; at: number }

export const DAILY_TIDY_NOTICE = '毎日、前の日のタブを自動で片づけます（設定でオフにできます）'
const EMPTY: TidiedGroup[] = []

/** A tab as the AI reads it: title and kind; a file also carries its company path, which main removes (shared/app-commands.ts `redactForAI`). */
const entryOf = (item: TidiedItem) => ({ title: item.title, kind: itemKindName(item), ...(item.kind === 'file' ? { path: item.path } : {}) })

/**
 * 「タブを片づける」 (tidyTabs.ts): the commands `tabs.list` / `tabs.tidy` / `tabs.restore` (the
 * button, the AI), the daily tidy when a company's tabs are restored, and 「片づけたタブ」.
 */
export function useTabTidying({ companyId, rootPath, openTabs, pinnedTabs: savedPins, setPinnedTabs, recordLooks, closeTabs, reopenTabs, store = tidyStore, grouping = tabGroupingStore, now = Date.now }: Options) {
  const pinned = useMemo(() => new Set(savedPins.filter(k => openTabs.includes(k))), [savedPins, openTabs])
  const pinnedTabs = useMemo(() => [...pinned], [pinned])
  const togglePinned = useCallback((key: string) => setPinnedTabs(prev => prev.includes(key)
    ? prev.filter(k => k !== key)
    : [...prev.filter(k => openTabs.includes(k)), key]), [setPinnedTabs, openTabs])
  const groups = useSyncExternalStore(store.subscribe, () => companyId ? store.groups(companyId) : EMPTY)
  const dailyOn = useSyncExternalStore(store.subscribe, store.dailyTidyOn)
  const [listOpen, setListOpen] = useState(false)
  const [notice, setNotice] = useState<TidyNotice | null>(null)
  const latest = useLatestRef({ companyId, rootPath: rootPath ?? '', openTabs, pinnedTabs, recordLooks })

  /**
   * Saves every edit first; a tab that still holds unsaved edits stays open (never lost). Each tidied
   * tab keeps its named group (name, colour) so reopening it puts it back in that group.
   */
  const tidy = useCallback(async (source?: { companyId: string; tabs: RestoredTabs; auto: true }, scope: TidyScope = {}) => {
    const left = await saveUnsavedEdits()
    const cur = latest.current
    const cid = source?.companyId ?? cur.companyId
    if (!cid) return null
    const all = source ? source.tabs.openFiles : cur.openTabs
    const pinned = source ? source.tabs.pinned : cur.pinnedTabs
    const looks = source ? { ...source.tabs.records, ...cur.recordLooks } : cur.recordLooks
    const arrange: ArrangeOptions = { pinned: new Set(pinned), looks, grouping: pruneGrouping(grouping.get(cid), all) }
    const groups = arrange.grouping.groups
    // One named group (by id, or by the name the AI read), or one kind: only the tabs under that kind's
    // chip — a tab in a named group stands under the group's chip, so a kind tidy leaves it.
    const tabGroup = scope.group ? groups.find(g => g.id === scope.group) ?? groups.find(g => groupNameKey(g.name) === groupNameKey(scope.group!)) : undefined
    if (scope.group && !tabGroup) return { error: 'そのまとまりは見つかりません。tabs_list で確かめてください。' as const }
    const tabs = tabGroup ? all.filter(k => namedGroupOf(k, arrange)?.id === tabGroup.id)
      : scope.kind ? all.filter(k => !namedGroupOf(k, arrange) && tabGroupOf(k, looks) === scope.kind) : all
    const plan = planTidy(tabs, pinned, [...left, ...unsavedPaths()])
    const items = plan.close.map(key => tidiedItemOf(key, cur.rootPath, looks, namedGroupOf(key, arrange)))
    const at = now()
    const dropped = items.length > 0
      ? store.add(cid, { id: `g${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date(at).toISOString(), day: companyDay(at), auto: !!source, items })
      : 0
    if (plan.close.length > 0) {
      closeTabs(plan.close)
      // A group left with no tab goes (its tabs carry its name into 「片づけたタブ」).
      const closed = new Set(plan.close)
      grouping.update(cid, g => pruneGrouping(g, all.filter(k => !closed.has(k))))
    }
    const keptUnsaved = plan.unsaved.map(key => entryOf(tidiedItemOf(key, cur.rootPath, looks)))
    const what = tabGroup ? `まとまり「${tabGroup.name}」の` : scope.kind ? `「${tabGroupName(scope.kind, tabs, looks)}」の` : ''
    return { tidied: items.length, keptPinned: plan.pinned.length, keptUnsaved, dropped, group: items.length > 0 ? companyDay(at) : null, what }
  }, [latest, store, grouping, now, closeTabs])
  const tidyByHand = useCallback(async (scope: TidyScope = {}) => {
    const r = await tidy(undefined, scope)
    if (!r || 'error' in r) return r
    const parts = [r.tidied > 0 ? `${r.what}タブを ${r.tidied} 件片づけました。` : `片づける${r.what}タブはありませんでした。`]
    if (r.keptPinned > 0) parts.push(`固定した ${r.keptPinned} 件は残しました。`)
    if (r.keptUnsaved.length > 0) parts.push(`保存できなかった「${r.keptUnsaved.map(e => e.title).join('」「')}」は開いたままにしました。`)
    if (r.dropped > 0) parts.push(`古い片づけたタブ ${r.dropped} 件は消えました。`)
    setNotice({ text: parts.join(''), at: now() })
    return r
  }, [tidy, now])

  /** On a company's first open of a day: the earlier day's tabs (not the pinned ones) are tidied. */
  const onTabsRestored = useCallback((cid: string, tabs: RestoredTabs) => {
    if (!store.dailyTidyDue(cid, companyDay(now()))) return
    void tidy({ companyId: cid, tabs, auto: true }).then(r => {
      if (!r || 'error' in r || r.tidied === 0 || store.noticeShown()) return
      store.markNoticeShown()
      setNotice({ text: DAILY_TIDY_NOTICE, at: now() })
    })
  }, [store, now, tidy])

  /** Reopens items; files gone from the disk stay listed (「見つかりません」). Reopened ones leave the list. */
  const restore = useCallback(async (items: readonly TidiedItem[]) => {
    const cur = latest.current
    if (!cur.companyId) return { opened: [] as TidiedItem[], missing: [] as TidiedItem[] }
    const checks = await Promise.all(items.map(i => i.kind === 'file' ? fileExists(tabKeyOf(i, cur.rootPath)).catch(() => false) : Promise.resolve(true)))
    const opened = items.filter((_, n) => checks[n])
    const missing = items.filter((_, n) => !checks[n])
    reopenTabs(opened.map(i => tabKeyOf(i, cur.rootPath)))
    // Back in the named groups they were in (a group of that name, or a new one).
    const back = opened.flatMap(i => i.tabGroup ? [{ key: tabKeyOf(i, cur.rootPath), group: i.tabGroup }] : [])
    if (back.length > 0) grouping.update(cur.companyId, g => regroup(g, back))
    store.removeItems(cur.companyId, opened.map(i => i.id))
    return { opened, missing }
  }, [latest, store, grouping, reopenTabs])

  const itemsOf = (query: { group?: string; items?: string[] }): TidiedItem[] => {
    const all = (companyId ? store.groups(companyId) : []).filter(g => !query.group || g.day === query.group)
    const items = all.flatMap(g => g.items)
    return query.items ? items.filter(i => query.items!.includes(i.id)) : (query.group ? items : [])
  }

  useCommandHandler('tabs.tidy', async ({ kind, group }) => {
    const r = await tidyByHand({ kind, group })
    if (!r) return { tidied: 0 }
    if ('error' in r) return { error: r.error }
    return { tidied: r.tidied, keptPinned: r.keptPinned, keptUnsaved: r.keptUnsaved, dropped: r.dropped, group: r.group }
  })
  useCommandHandler('tabs.list', () => {
    const cur = latest.current
    const pins = new Set(cur.pinnedTabs)
    const arrange: ArrangeOptions = { pinned: pins, looks: cur.recordLooks, grouping: pruneGrouping(companyId ? grouping.get(companyId) : NO_GROUPING, cur.openTabs) }
    return {
      openTabs: cur.openTabs.map(key => {
        const tabGroup = namedGroupOf(key, arrange)?.name
        return {
          ...entryOf(tidiedItemOf(key, cur.rootPath, cur.recordLooks)), kindId: tabGroupOf(key, cur.recordLooks),
          ...(pins.has(key) ? { pinned: true } : {}), ...(tabGroup ? { tabGroup } : {}),
        }
      }),
      tidied: groupsByDay(companyId ? store.groups(companyId) : []).map(d => ({
        group: d.day, label: dayLabel(d.day),
        items: d.groups.flatMap(g => g.items.map(i => ({ id: i.id, ...entryOf(i), ...(i.tabGroup ? { tabGroup: i.tabGroup.name } : {}) }))),
      })),
    }
  })
  useCommandHandler('tabs.restore', async ({ group, items }) => {
    if (!group && !items) return { error: 'group（日付）か items（項目の id）を指定してください。' }
    const chosen = itemsOf({ group, items })
    if (chosen.length === 0) return { error: '指定の片づけたタブは見つかりません。tabs_list で確かめてください。' }
    const r = await restore(chosen)
    return { opened: r.opened.map(entryOf), notFound: r.missing.map(entryOf) }
  })

  return {
    pinned, togglePinned,
    groups, dailyOn, setDailyTidy: store.setDailyTidy,
    listOpen, openList: () => setListOpen(true), closeList: () => setListOpen(false),
    notice, dismissNotice: () => setNotice(null),
    tidyByHand, onTabsRestored, restore,
    removeItems: (ids: readonly string[]) => { if (companyId) store.removeItems(companyId, ids) },
    removeDay: (day: string) => { if (companyId) store.removeDay(companyId, day) },
    /** Which items are gone (files on this computer; records the server no longer shows). */
    checkMissing: async (items: readonly TidiedItem[]): Promise<Set<string>> => {
      const cur = latest.current
      const gone = new Set<string>()
      // Records ask the server: only the first 60, a few at a time.
      const records = items.filter(i => i.kind === 'record').slice(0, 60)
      const files = items.filter(i => i.kind === 'file')
      await Promise.all(files.map(async i => { if (!await fileExists(tabKeyOf(i, cur.rootPath)).catch(() => true)) gone.add(i.id) }))
      for (let n = 0; n < records.length && cur.companyId; n += 6) {
        await Promise.all(records.slice(n, n + 6).map(async i => {
          if (i.kind === 'record' && !await recordStillThere(cur.companyId!, i.recordId)) gone.add(i.id)
        }))
      }
      return gone
    },
  }
}
