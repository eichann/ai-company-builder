// Preview of the editor tab strip after department switches: tabs stay open
// and tabs from another department carry a muted department label. The
// preload API is mocked (no Electron, no file system).
// Open /tests/editor-tabs-ui.html?theme=light|dark&dept=content|sales|company
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
Object.assign(window, {
  electronAPI: {
    readFile: async (p: string) => files[p] ?? '',
    readFileBinary: async () => null,
    writeFile: async () => true,
    readDirectory: async () => [],
    deleteItem: async () => ({ success: true }),
    onFileChange: () => () => {},
  },
})

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
      <div className="h-[420px] w-[760px]">
        <TabbedEditorPanel openFiles={openFiles} activeFilePath={active} tabLabels={labels} onSelectFile={setActive} onCloseFile={() => {}} />
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
