/**
 * Which plugin screen goes in which of the four slots (stage 4b, plan A6,
 * `.claude/rules/plugin-frame.md` "The four slots"). Pure. Main answers only
 * the screens of plugins the company lists now from verified packages
 * (`plugins:screens`), so a plugin turned off, stopped or not matching its
 * fingerprint is simply absent here and every slot hides it.
 */
import { fileActionApplies } from '../../../../shared/core/plugin-file-kinds'
import type { PluginPackageRef } from '../../../shared/plugin-bridge'
import type { PluginScreens } from '../../../shared/plugin-screens'
import type { TaskListItem, TaskTurn } from '../../../shared/tasks'

/** The left tab's panel id of a plugin (one tab per plugin; the version is not part of it, so an upgrade keeps the tab chosen). */
export const pluginTabId = (plugin: Pick<PluginPackageRef, 'id'>): string => `plugin:${plugin.id}`

/** ① Left tabs: the plugins that declare `ui.tab`, in the order main listed them. */
export function pluginTabs(screens: readonly PluginScreens[]): Array<PluginScreens & { tab: NonNullable<PluginScreens['tab']> }> {
  return screens.filter((s): s is PluginScreens & { tab: NonNullable<PluginScreens['tab']> } => s.tab !== null)
}

/** The 「あなたの番」 list's places each peek group stands for (design 節目5 §2-1 ②). */
const PEEK_TURNS: Record<string, readonly TaskTurn[]> = {
  mine: ['mine', 'acceptance'],
  waiting: ['others'],
  ai_turn: ['ai'],
}

/** The peek's heading for its group (the core's words, the same for every plugin). */
export const PEEK_GROUP_LABELS: Record<string, string> = {
  mine: 'あなたの番',
  waiting: 'ほかの人の番・返事待ち',
  ai_turn: 'AI の番',
}

/**
 * ② The peek over a plugin's tab, drawn by the core: the member's task-list
 * items whose type implements the declared interface, in the declared group.
 * The list is the core's (the server already left out what the member may not read).
 */
export function peekItems(peek: PluginScreens['peek'], items: readonly TaskListItem[]): TaskListItem[] {
  if (!peek) return []
  const turns = PEEK_TURNS[peek.stateGroup] ?? []
  return items.filter(i => turns.includes(i.turn) && (i.implements ?? []).includes(peek.implements))
}

export interface RecordSectionSlot {
  plugin: PluginPackageRef
  label: string
  entry: string
}

/** ③ The sections a record card of `recordType` shows, plugin by plugin. */
export function recordSectionsFor(screens: readonly PluginScreens[], recordType: string): RecordSectionSlot[] {
  return screens.flatMap(s => s.recordSections.filter(r => r.type === recordType).map(r => ({ plugin: s.plugin, label: r.label, entry: r.entry })))
}

export interface FileActionSlot {
  plugin: PluginPackageRef
  /** The plugin's name, for the dialog's title. */
  pluginLabel: string
  label: string
  entry: string
}

/**
 * ④ The plugin items of the file list's right-click menu for one entry.
 * `companyPath` is the entry's company-relative path (null outside the company
 * folder: nothing). None on a folder left out of this computer (not downloaded:
 * nothing may be done there) or on the app's own folders.
 */
export function fileActionsFor(
  screens: readonly PluginScreens[],
  entry: { companyPath: string | null; isDirectory: boolean; notDownloaded?: boolean },
): FileActionSlot[] {
  const p = entry.companyPath
  if (!p || entry.notDownloaded || p.startsWith('/') || p.split('/').some(seg => seg === '' || seg === '.' || seg === '..' || seg === '.git' || seg === '.backups')) return []
  return screens.flatMap(s => s.fileActions
    .filter(a => fileActionApplies(a.kinds, p, entry.isDirectory))
    .map(a => ({ plugin: s.plugin, pluginLabel: s.label, label: a.label, entry: a.entry })))
}
