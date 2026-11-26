// Preview of an HTML document's review (doc-frame.md "Review in the document view"): an .html tab
// shown as 見る with the review's banner, side panel, comment box and history — the real
// TabbedEditorPanel. Two ways to open it:
// - in the Electron demo (tests/html-review-demo/main.ts): its preload hands the real document views
//   (doc-view.ts, the acb-doc session, the review piece) and real files in a fictional company folder
//   (`?root=<folder>&doc=<path>` name them);
// - in a browser (Playwright, by hand): files in memory and faked views; window.__acbDocCalls lists
//   every docView call, __acbDocEvent(e) sends a docView:event (a selection), __acbFiles the files.
// Fictional data only.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TabbedEditorPanel } from '../src/features/editor/components/TabbedEditorPanel'
import { useAppStore } from '../src/stores/appStore'
import { useAuthStore } from '../src/stores/authStore'
import { useKeybindings } from '../src/shared/commands/commands'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const ROOT = params.get('root') ?? '/Users/demo/会社'
const DOC = params.get('doc') ?? `${ROOT}/営業部/報告/11月の売上.html`

const real = typeof (window as { electronAPI?: unknown }).electronAPI === 'object'
if (!real) {
  const files: Record<string, string> = {
    [DOC]: '<!doctype html><h1>11月の売上</h1><p>売上は前年比 120% でした。</p>',
  }
  const docCalls: unknown[][] = []
  let docEvent: ((event: unknown) => void) | null = null
  let nextViewId = 7
  Object.assign(window, {
    electronAPI: {
      readFile: async (p: string) => (p in files ? files[p] : null),
      exists: async (p: string) => p in files,
      writeFile: async (p: string, content: string) => { files[p] = content; return true },
      renameItem: async (from: string, to: string) => {
        if (!(from in files)) return { success: false, error: 'ENOENT' }
        files[to] = files[from]
        delete files[from]
        return { success: true, newPath: to }
      },
      deleteItem: async (p: string) => {
        if (!(p in files)) return { success: false, error: 'ENOENT' }
        delete files[p]
        return { success: true }
      },
      readDirectory: async (dir: string) => Object.keys(files)
        .filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), path: p, isDirectory: false })),
      openDocView: async (filePath: string) => { docCalls.push(['open', filePath]); return { ok: true, viewId: nextViewId++ } },
      closeDocView: async (viewId: number) => { docCalls.push(['close', viewId]) },
      setDocViewBounds: async () => {},
      setDocViewZoom: async () => {},
      reloadDocView: async () => {},
      setDocViewReview: async (viewId: number, review: unknown) => { docCalls.push(['review', viewId, review]) },
      findDocViewQuote: async (viewId: number, index: number) => { docCalls.push(['find', viewId, index]); return 'hidden' },
      onDocViewEvent: (cb: (event: unknown) => void) => { docEvent = cb; return () => { if (docEvent === cb) docEvent = null } },
    },
  })
  Object.assign(window, { __acbFiles: files, __acbDocCalls: docCalls, __acbDocEvent: (e: unknown) => docEvent?.(e) })
}

useAppStore.setState({ currentCompany: { id: 'demo', name: '株式会社デモ', rootPath: ROOT, departments: [], createdAt: new Date() } })
useAuthStore.setState({ user: { id: 'u-yamada', email: params.get('email') ?? 'yamada@example.com', name: params.get('name') ?? '山田 花子', image: null, emailVerified: true } })

export function Preview() {
  useKeybindings()
  const [active, setActive] = useState(DOC)
  return (
    <main className="min-h-screen bg-white text-gray-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="bg-amber-50 px-4 py-2 text-xs text-amber-900">表示確認用の人工データです。</div>
      <div style={{ height: 'calc(100vh - 32px)', width: '100%' }}>
        <TabbedEditorPanel openFiles={[DOC]} activeFilePath={active} onSelectFile={setActive} onCloseFile={() => {}} />
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
