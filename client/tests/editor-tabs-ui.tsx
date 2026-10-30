// Preview of the editor tab strip after department switches: tabs stay open
// and tabs from another department carry a muted department label. The
// preload API is mocked (no Electron, no file system).
// Open /tests/editor-tabs-ui.html?theme=light|dark&dept=content|sales|company
// (&view=external: buttons that change / delete the open file on "disk", for
// the external-change banner — type in the editor first;
// &view=tabs: tabs close, the last one opened is a preview tab, a long
// Markdown file, an image and a PDF; window.__acbWrites lists every save and
// window.__acbPinned every pinned tab).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TabbedEditorPanel } from '../src/features/editor/components/TabbedEditorPanel'
import { tabDepartmentLabels } from '../src/features/editor/editorTabs'
import { useAppStore } from '../src/stores/appStore'
import { useKeybindings } from '../src/shared/commands/commands'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const ROOT = '/Users/demo/会社'
const departments = [
  { id: 'content', name: 'コンテンツG', folder: 'コンテンツG' },
  { id: 'sales', name: '営業部', folder: '営業部' },
]
const files: Record<string, string> = {
  [`${ROOT}/コンテンツG/台本.md`]: '# 台本\n\n第12回の構成案です。',
  [`${ROOT}/営業部/提案書.md`]: '# 提案書\n\n来期のご提案。',
  [`${ROOT}/営業部/顧客リスト.csv`]: '会社名,担当\nA社,山田',
  [`${ROOT}/README.md`]: '# 会社フォルダ',
}
const tabsView = params.get('view') === 'tabs'
const LONG_DOC = `${ROOT}/営業部/議事録.md`
if (tabsView) {
  files[LONG_DOC] = ['# 議事録', ...Array.from({ length: 60 }, (_, i) => `## 第${i + 1}回\n\n担当は山田です。予算の確認をしました。`)].join('\n\n')
  files[`${ROOT}/営業部/ロゴ.png`] = ''
  files[`${ROOT}/営業部/契約書.pdf`] = ''
}
const writes: Array<[string, string]> = []
const pinned: string[] = []
let emitChanges: ((changes: { type: string; path: string }[]) => void) | null = null
Object.assign(window, {
  electronAPI: {
    readFile: async (p: string) => (p in files ? files[p] : null),
    readFileBinary: async () => null,
    writeFile: async (p: string, content: string) => { files[p] = content; writes.push([p, content]); return true },
    createDirectory: async () => true,
    backupBeforeOverwrite: async () => ({ success: true, backupPath: `${ROOT}/.backups/2026-10-23T01-02-03-456_editor_overwrite` }),
    readDirectory: async () => [],
    deleteItem: async () => ({ success: true }),
    onFileChanges: (cb: (changes: { type: string; path: string }[]) => void) => { emitChanges = cb; return () => { emitChanges = null } },
  },
})

// The open company, as in the app (the overwrite backup goes under its folder).
useAppStore.setState({ currentCompany: { id: 'demo', name: '株式会社デモ', rootPath: ROOT, departments: [], createdAt: new Date() } })

// What the AI (or a sync pull) does to the open file, as the watcher reports it.
// ?view=external adds the buttons; type in the editor first to have unsaved edits.
function externalEdit(p: string) {
  files[p] = `${files[p] ?? ''}\n\nAI が追記した段落です。`
  emitChanges?.([{ type: 'change', path: p }])
}
function externalDelete(p: string) {
  delete files[p]
  emitChanges?.([{ type: 'unlink', path: p }])
}
Object.assign(window, { __acbExternalEdit: externalEdit, __acbExternalDelete: externalDelete, __acbFiles: files, __acbWrites: writes, __acbPinned: pinned })

export function Preview() {
  // As AppShell does: shortcuts reach the focused area only.
  useKeybindings()
  const [dept, setDept] = useState(params.get('dept') ?? 'sales')
  const [openFiles, setOpenFiles] = useState(() => Object.keys(files))
  const [active, setActive] = useState(`${ROOT}/コンテンツG/台本.md`)
  const [previewTab, setPreviewTab] = useState<string | null>(tabsView ? `${ROOT}/README.md` : null)
  const closeFile = (p: string) => {
    if (!tabsView) return
    const rest = openFiles.filter(f => f !== p)
    setOpenFiles(rest)
    if (active === p) setActive(rest[0] ?? '')
  }
  const pinFile = (p: string) => { pinned.push(p); setPreviewTab(null) }
  const labels = tabDepartmentLabels(openFiles, { rootPath: ROOT, departments, selectedDeptId: dept === 'company' ? null : dept })
  return (
    <main className="min-h-screen bg-white text-gray-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="bg-amber-50 px-4 py-2 text-xs text-amber-900">表示確認用の人工データです。</div>
      <nav className="flex gap-1 border-b border-gray-200 px-3 pt-2 text-sm dark:border-zinc-800">
        {[['company', '全社'], ['content', 'コンテンツG'], ['sales', '営業部']].map(([id, name]) => (
          <button key={id} onClick={() => setDept(id)} className={`rounded-t px-3 py-1.5 ${dept === id ? 'border border-b-0 border-gray-200 bg-white font-medium dark:border-zinc-800 dark:bg-zinc-900' : 'text-gray-500'}`}>{name}</button>
        ))}
      </nav>
      {params.get('view') === 'external' && (
        <div className="flex gap-2 px-3 py-2 text-xs">
          <button data-testid="external-edit" className="rounded border px-2 py-1" onClick={() => externalEdit(active)}>AIがこのファイルを書き換える</button>
          <button data-testid="external-delete" className="rounded border px-2 py-1" onClick={() => externalDelete(active)}>AIがこのファイルを削除する</button>
        </div>
      )}
      {/* Tailwind does not scan this page: the tabs view sets its height itself so the preview scrolls. */}
      <div className="h-[420px] w-[760px]" style={tabsView ? { height: 420 } : undefined}>
        <TabbedEditorPanel openFiles={openFiles} activeFilePath={active} previewFilePath={previewTab} tabLabels={labels} onSelectFile={setActive} onCloseFile={closeFile} onPinFile={pinFile} />
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
