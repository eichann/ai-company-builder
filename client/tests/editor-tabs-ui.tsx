// Preview of the editor tab strip after department switches: tabs stay open
// and tabs from another department carry a muted department label. The
// preload API is mocked (no Electron, no file system).
// Open /tests/editor-tabs-ui.html?theme=light|dark&dept=content|sales|company
// (&view=external: buttons that change / delete the open file on "disk", for
// the external-change banner — type in the editor first).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TabbedEditorPanel } from '../src/components/skill-ui/TabbedEditorPanel'
import { tabDepartmentLabels } from '../src/lib/editorTabs'

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
let emitChanges: ((changes: { type: string; path: string }[]) => void) | null = null
Object.assign(window, {
  electronAPI: {
    readFile: async (p: string) => (p in files ? files[p] : null),
    readFileBinary: async () => null,
    writeFile: async (p: string, content: string) => { files[p] = content; return true },
    createDirectory: async () => true,
    backupBeforeOverwrite: async () => ({ success: true, backupPath: `${ROOT}/.backups/2026-10-23T01-02-03-456_editor_overwrite` }),
    readDirectory: async () => [],
    deleteItem: async () => ({ success: true }),
    onFileChanges: (cb: (changes: { type: string; path: string }[]) => void) => { emitChanges = cb; return () => { emitChanges = null } },
  },
})

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
Object.assign(window, { __acbExternalEdit: externalEdit, __acbExternalDelete: externalDelete })

export function Preview() {
  const [dept, setDept] = useState(params.get('dept') ?? 'sales')
  const openFiles = Object.keys(files)
  const [active, setActive] = useState(`${ROOT}/コンテンツG/台本.md`)
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
      <div className="h-[420px] w-[760px]">
        <TabbedEditorPanel openFiles={openFiles} activeFilePath={active} tabLabels={labels} onSelectFile={setActive} onCloseFile={() => {}} />
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
