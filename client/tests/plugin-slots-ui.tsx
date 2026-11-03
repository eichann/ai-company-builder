/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for a business plugin's four slots (plugin-frame.md "The four slots"): the real
// composition (app/pluginSlots.tsx) with the real left tabs, record card and file menu. The
// screens come from the test package's own plugin.yaml (tests/fixtures/plugins/slots-sample),
// read with the app's parser; its ui/ files are answered by the spec under /__plugin/ with the
// CSP acb-plugin:// gives. `window.__acbPlugins.turnOff()` = the company turned it off.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FolderSimple } from '@phosphor-icons/react'
import '../src/index.css'
import { pluginSlots, type FileActionOpen } from '../src/app/pluginSlots'
import { LeftPanelTabs } from '../src/features/workspace/components/LeftPanelTabs'
import { RecordCard } from '../src/features/records/components/RecordCard'
import { treeMenuItems } from '../src/features/files/contextMenuItems'
import { ContextMenu } from '../src/shared/ui/ContextMenu'
import { PluginFileActionDialog } from '../src/features/plugins/components/PluginSlots'
import { usePluginScreens } from '../src/features/plugins/hooks/usePluginScreens'
import { useCommandHandler } from '../src/shared/commands/commands'
import type { PluginScreens } from '../shared/plugin-screens'
import { screensOfPackage } from '../electron/features/plugins/screens'
import type { TaskListItem } from '../shared/tasks'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'

const COMPANY = 'co-preview'
const ROOT = '/Users/me/会社'
const REF = { id: 'slots-sample', version: '0.1.0' }
const PACKAGE_FILES = new Set(['plugin.yaml', 'ui/index.html', 'ui/plan.html', 'ui/attach.html', 'ui/app.js', 'ui/app.css'])

let report: (line: string) => void = () => {}
let listed = true
const changed = emitter<{ companyId: string }>()
installElectronAPI({
  getPluginScreens: async () => {
    if (!listed) return { success: true, screens: [] }
    const manifest = await (await fetch('/__fixture/slots-sample/plugin.yaml')).text()
    const s = screensOfPackage(REF, manifest, PACKAGE_FILES)
    return { success: true, screens: s ? [s] : [] as PluginScreens[] }
  },
  onPluginsChanged: changed.subscribe,
  callPluginBridge: async (companyId, plugin, op, args) => {
    report(`main ${companyId} ${plugin.id}@${plugin.version} ${op} ${JSON.stringify(args)}`)
    if (op === 'records.get') return { ok: true, data: { record: { id: 'program_plan-abc123', title: '春の特番' } } }
    return { ok: true, data: { total: 3, records: [] } }
  },
  getRecordCard: async (_companyId, recordId) => ({
    success: true,
    card: {
      record: { id: recordId, type: 'program_plan', typeLabel: '企画', kind: 'bundle', thing: 'bundle', title: '春の特番', summary: '', stateLabel: '作成中', updatedAt: '2026-11-02T00:00:00.000Z' },
      fields: [{ label: '放送日', value: '4月1日' }], history: [], links: [],
    },
  }),
})
;(window as unknown as { __acbPlugins: { turnOff(): void } }).__acbPlugins = {
  turnOff() { listed = false; changed.emit({ companyId: COMPANY }) },
}

const item = (id: string, title: string, turn: TaskListItem['turn'], impl?: string[]): TaskListItem => ({
  id, type: 'task', typeLabel: 'タスク', title, state: 'todo', stateLabel: null, version: 1, due: null, tags: [],
  turn, waitingFor: null, personal: false, own: false, actingFor: null, bundle: null, finishedAt: null, ...(impl ? { implements: impl } : {}),
})
const TASKS = [
  item('task-aaa111', '台本を確認する', 'mine', ['request']),
  item('task-bbb222', '出演者に連絡', 'others', ['request']),
  item('meeting-ccc333', '定例会議', 'mine', ['outside_event']),
]
const ENTRIES = [
  { name: '台本.pdf', path: `${ROOT}/企画/台本.pdf`, isDirectory: false },
  { name: '予算.xlsx', path: `${ROOT}/企画/予算.xlsx`, isDirectory: false },
]

function Preview() {
  const [lines, setLines] = useState<string[]>([])
  report = line => setLines(l => [...l, line])
  const [tab, setTab] = useState('files')
  const [menu, setMenu] = useState<{ entry: typeof ENTRIES[number]; x: number; y: number } | null>(null)
  const [fileAction, setFileAction] = useState<FileActionOpen | null>(null)
  const screens = usePluginScreens(COMPANY)
  useCommandHandler('record.open', ({ recordId }) => report(`open record ${recordId}`))
  useCommandHandler('file.open', ({ path }) => report(`open file ${path}`))
  const plugins = pluginSlots({
    companyId: COMPANY, rootPath: ROOT, plugins: screens, taskItems: TASKS, onFileAction: setFileAction,
    frameUrl: src => src.replace('acb-plugin://', '/__plugin/'),
  })
  const panels = [
    {
      id: 'files', title: 'ファイル', icon: FolderSimple, mount: 'always' as const,
      render: () => (
        <ul aria-label="ファイル" className="p-2 text-sm">
          {ENTRIES.map(e => (
            <li key={e.path}><button type="button" className="px-2 py-1" onContextMenu={ev => { ev.preventDefault(); setMenu({ entry: e, x: ev.clientX, y: ev.clientY }) }}>{e.name}</button></li>
          ))}
        </ul>
      ),
    },
    ...plugins.tabs,
  ]
  return (
    <main className="flex h-screen bg-white text-gray-900">
      <div className="flex w-[420px] flex-col border-r">
        <LeftPanelTabs panels={panels} selectedId={tab} onSelect={setTab} />
      </div>
      <div className="flex-1 overflow-auto">
        <RecordCard companyId={COMPANY} rootPath={ROOT} recordId="program_plan-abc123" renderSections={plugins.renderSections} />
        <ul aria-label="本体が受け取ったもの" className="p-4 text-xs">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </div>
      {menu && (
        <ContextMenu
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={treeMenuItems(menu.entry, `${ROOT}/企画`, undefined, {
            newFile: () => {}, newFolderIn: () => {}, rename: () => {}, askDelete: () => {}, askDeleteMany: () => {},
            copyPath: () => {}, download: () => {}, closeContextMenu: () => setMenu(null), extraItems: plugins.fileMenuItems,
          }, ((key: string) => key) as never)}
        />
      )}
      {fileAction && screens.screens.length > 0 && (
        <PluginFileActionDialog
          companyId={COMPANY} action={fileAction.action} companyPath={fileAction.companyPath} isFolder={fileAction.isFolder}
          onOpen={target => { setFileAction(null); return plugins.openFromPlugin(target) }} onClose={() => setFileAction(null)}
          frameUrl={src => src.replace('acb-plugin://', '/__plugin/')}
        />
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
