// The four plugin slots composed into the screen (stage 4b, plan A6, plugin-frame.md "The four
// slots"): ① left tabs with ② their peek, ③ record card sections, ④ file menu items. The plugins
// feature draws the frames; the workspace, records, tasks and files features only offer a slot.
import type { ReactNode } from 'react'
import type { BridgeUiOpenArgs, PluginBridgeAnswer } from '../../shared/plugin-bridge-ops'
import type { TaskListItem } from '../../shared/tasks'
import { runCommand } from '../shared/commands/commands'
import type { LeftPanel } from '../features/workspace/leftPanels'
import type { FileMenuExtraItem } from '../features/files/contextMenuItems'
import type { PluginScreensState } from '../features/plugins/hooks/usePluginScreens'
import { fileActionsFor, peekItems, pluginTabId, pluginTabs, recordSectionsFor, type FileActionSlot } from '../features/plugins/model'
import { pluginIcon } from '../features/plugins/pluginIcons'
import { PluginPeek, PluginRecordSections, PluginTabPanel } from '../features/plugins/components/PluginSlots'
import { companyPathOf } from '../features/tasks/model'

/** A file action the member chose: shown in a dialog with the plugin's frame. */
export interface FileActionOpen {
  action: FileActionSlot
  companyPath: string
  isFolder: boolean
}

interface Args {
  companyId: string | undefined
  rootPath: string | null | undefined
  plugins: PluginScreensState
  /** The member's task list (the peek lists from it). */
  taskItems: readonly TaskListItem[]
  onFileAction: (open: FileActionOpen) => void
  /** Preview pages only: where `acb-plugin://` is served (Chromium there cannot load the scheme). */
  frameUrl?: (src: string) => string
}

const OK: PluginBridgeAnswer = { ok: true, data: null }
const refuse = (message: string): PluginBridgeAnswer => ({ ok: false, error: { code: 'NOT_AVAILABLE', message } })

export function pluginSlots({ companyId, rootPath, plugins, taskItems, onFileAction, frameUrl }: Args) {
  // `ui.open` from a frame: the core opens it where it would open it anyway, with the member's own rights.
  const openFromPlugin = (target: BridgeUiOpenArgs): PluginBridgeAnswer => {
    if (target.target === 'record') {
      void runCommand('record.open', { recordId: target.recordId }).catch(() => {})
      return OK
    }
    if (target.target === 'consultation') {
      const title = taskItems.find(i => i.id === target.recordId)?.title
      void (title
        ? runCommand('chat.consultAbout', { recordId: target.recordId, title })
        : runCommand('record.open', { recordId: target.recordId })).catch(() => {})
      return OK
    }
    if (!rootPath) return refuse('いまは開けません。')
    void runCommand('file.open', { path: `${rootPath}/${target.path}` }).catch(() => {})
    return OK
  }

  const tabs: LeftPanel[] = !companyId ? [] : pluginTabs(plugins.screens).map(screen => {
    const peeked = screen.peek ? peekItems(screen.peek, taskItems) : null
    return {
      id: pluginTabId(screen.plugin),
      title: screen.tab.label,
      icon: pluginIcon(screen.tab.icon),
      mount: 'once-opened',
      className: 'flex',
      badgeCount: peeked && screen.peek?.stateGroup === 'mine' ? peeked.length : null,
      render: () => <PluginTabPanel companyId={companyId} screen={screen} failed={plugins.failed} onOpen={openFromPlugin} frameUrl={frameUrl} />,
      peek: peeked ? () => <PluginPeek screen={screen} items={peeked} onOpenRecord={recordId => { void runCommand('record.open', { recordId }).catch(() => {}) }} /> : undefined,
    }
  })

  const renderSections = (record: { id: string; type: string }): ReactNode => {
    if (!companyId) return null
    const sections = recordSectionsFor(plugins.screens, record.type)
    return sections.length > 0 ? <PluginRecordSections companyId={companyId} recordId={record.id} sections={sections} onOpen={openFromPlugin} frameUrl={frameUrl} /> : null
  }

  const fileMenuItems = (entry: { path: string; isDirectory: boolean; notDownloaded?: boolean }): FileMenuExtraItem[] => {
    const companyPath = rootPath ? companyPathOf(entry.path, rootPath) : null
    if (!companyPath) return []
    return fileActionsFor(plugins.screens, { companyPath, isDirectory: entry.isDirectory, notDownloaded: entry.notDownloaded })
      .map(action => ({ label: action.label, run: () => onFileAction({ action, companyPath, isFolder: entry.isDirectory }) }))
  }

  return { tabs, renderSections, fileMenuItems, openFromPlugin }
}
