// The four slots' parts (stage 4b, plan A6, plugin-frame.md "The four slots"): the core draws the
// frame's place, its label and the peek; the plugin's own content only ever runs in `PluginFrame`.
// Styling is kept to the existing tabs and cards (the visual pass comes later).
import { PuzzlePiece, X } from '@phosphor-icons/react'
import type { BridgeUiOpenArgs, PluginBridgeAnswer } from '../../../../shared/plugin-bridge-ops'
import type { PluginScreens } from '../../../../shared/plugin-screens'
import { PLUGIN_SCREENS_OFFLINE_TEXT } from '../../../../shared/plugin-screens'
import type { TaskListItem } from '../../../../shared/tasks'
import type { PluginBridgePort } from '../api'
import { PEEK_GROUP_LABELS, type FileActionSlot, type RecordSectionSlot } from '../model'
import { PluginFrame } from './PluginFrame'

type OpenFromPlugin = (target: BridgeUiOpenArgs) => PluginBridgeAnswer | Promise<PluginBridgeAnswer>

/** A calm line where a plugin's screen cannot be shown (no alarm: the rest of the app works). */
export function PluginCalmMessage({ text }: { text: string }) {
  return (
    <div role="status" className="flex h-full min-h-[80px] items-center justify-center gap-2 px-6 text-center text-[12.5px] text-gray-500 dark:text-zinc-400">
      <PuzzlePiece size={14} />{text}
    </div>
  )
}

/** ① A plugin's left tab: its `ui.tab.entry` in the frame, filling the panel. */
export function PluginTabPanel({ companyId, screen, failed, onOpen, frameUrl, port }: {
  companyId: string
  /** null: the plugin is no longer listed (turned off, stopped) or its list could not be read. */
  screen: PluginScreens | null
  failed?: boolean
  onOpen: OpenFromPlugin
  frameUrl?: (src: string) => string
  port?: PluginBridgePort
}) {
  if (!screen?.tab) return <PluginCalmMessage text={failed ? PLUGIN_SCREENS_OFFLINE_TEXT : 'この画面は、いまは使えません。'} />
  return (
    <PluginFrame
      companyId={companyId} plugin={screen.plugin} entry={screen.tab.entry} title={screen.tab.label}
      context={{ slot: 'tab' }} onOpen={onOpen} frameUrl={frameUrl} port={port}
      className="block h-full w-full border-0 bg-white dark:bg-zinc-900"
    />
  )
}

/** ② The peek over a plugin's tab, drawn by the core from the task list (no frame: it shows at once). */
export function PluginPeek({ screen, items, onOpenRecord }: {
  screen: PluginScreens
  items: readonly TaskListItem[]
  onOpenRecord: (recordId: string) => void
}) {
  const group = screen.peek ? PEEK_GROUP_LABELS[screen.peek.stateGroup] ?? '' : ''
  const shown = items.slice(0, 8)
  return (
    <div role="dialog" aria-label={`${screen.tab?.label ?? screen.label}：${group}`}
      className="w-72 overflow-hidden rounded-lg border border-gray-200 bg-white text-gray-800 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
      <p className="border-b border-gray-100 px-3 py-1.5 text-[11.5px] font-semibold text-gray-500 dark:border-zinc-700 dark:text-zinc-400">
        {group}（{items.length}）
      </p>
      {shown.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-gray-400">いまはありません</p>
      ) : (
        <ul className="max-h-72 overflow-y-auto py-1">
          {shown.map(i => (
            <li key={i.id}>
              <button type="button" onClick={() => onOpenRecord(i.id)} className="block w-full px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-zinc-700/60">
                <span className="block truncate text-[12.5px]">{i.title}</span>
                <span className="block truncate text-[11px] text-gray-500 dark:text-zinc-400">{i.waitingFor ?? i.typeLabel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {items.length > shown.length && <p className="px-3 pb-1.5 text-[11px] text-gray-400">ほか {items.length - shown.length} 件</p>}
    </div>
  )
}

/** ③ A record card's plugin sections: each its own frame, given only the record's id. */
export function PluginRecordSections({ companyId, recordId, sections, onOpen, frameUrl, port }: {
  companyId: string
  recordId: string
  sections: readonly RecordSectionSlot[]
  onOpen: OpenFromPlugin
  frameUrl?: (src: string) => string
  port?: PluginBridgePort
}) {
  if (sections.length === 0) return null
  return (
    <>
      {sections.map(s => (
        <section key={`${s.plugin.id}:${s.entry}`} aria-label={s.label} data-slot="plugin-record-section">
          <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold"><PuzzlePiece size={13} className="text-accent" />{s.label}</h2>
          <PluginFrame
            companyId={companyId} plugin={s.plugin} entry={s.entry} title={s.label}
            context={{ slot: 'record_section', recordId }} onOpen={onOpen} frameUrl={frameUrl} port={port}
            className="block h-56 w-full rounded-md border border-gray-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
          />
        </section>
      ))}
    </>
  )
}

/** ④ A file action chosen in the file list: the plugin's frame in a dialog, given only the chosen company path. */
export function PluginFileActionDialog({ companyId, action, companyPath, isFolder, onOpen, onClose, frameUrl, port }: {
  companyId: string
  action: FileActionSlot
  companyPath: string
  isFolder: boolean
  onOpen: OpenFromPlugin
  onClose: () => void
  frameUrl?: (src: string) => string
  port?: PluginBridgePort
}) {
  const name = companyPath.split('/').pop() ?? companyPath
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-label={action.label} onKeyDown={e => { if (e.key === 'Escape') onClose() }}
        className="flex h-[480px] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-800 shadow-xl dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 text-[12px] text-gray-500 dark:border-zinc-700 dark:text-zinc-400">
          <PuzzlePiece size={13} />
          <span className="min-w-0 flex-1 truncate">{action.label}：「{name}」<span className="ml-1 text-gray-400">（{action.pluginLabel}）</span></span>
          <button type="button" onClick={onClose} aria-label="閉じる" className="rounded p-0.5 hover:bg-gray-100 dark:hover:bg-zinc-700"><X size={12} /></button>
        </div>
        <PluginFrame
          companyId={companyId} plugin={action.plugin} entry={action.entry} title={action.label}
          context={{ slot: 'file_action', path: companyPath, isFolder }} onOpen={onOpen} frameUrl={frameUrl} port={port}
          className="block min-h-0 w-full flex-1 border-0 bg-white dark:bg-zinc-900"
        />
      </div>
    </div>
  )
}
