// Preview of the editor tab strip after department switches: tabs stay open
// and tabs from another department carry a muted department label. The
// preload API is mocked (no Electron, no file system).
// Open /tests/editor-tabs-ui.html?theme=light|dark&dept=content|sales|company
// (&view=external: buttons that change / delete the open file on "disk", for
// the external-change banner — type in the editor first;
// &view=tabs: tabs close, the last one opened is a preview tab, a long
// Markdown file, an image and a PDF; window.__acbWrites lists every save and
// window.__acbPinned every pinned tab;
// &view=html: an HTML document and one at the company folder's top level; the document views are
// faked and the editor sits between dividers as in the app (the left column's and the chat's beside it,
// the bottom panel's under it; the left one drags) — window.__acbDocCalls lists every docView call, __acbDocEvent(e) sends a docView:event,
// __acbOpened the links handed to the browser; 「メニューを出す」 draws a menu over the document;
// under the editor, the AI's tool rows of a reply (the chat's ［見る］, A3) — files.open and
// chat.insertText are handled as the app does, __acbInserted lists what reached the chat's input).
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TabbedEditorPanel } from '../src/features/editor/components/TabbedEditorPanel'
import { tabDepartmentLabels } from '../src/features/editor/editorTabs'
import { useAppStore } from '../src/stores/appStore'
import { useCommandHandler, useKeybindings } from '../src/shared/commands/commands'
import { ToolRunGroup } from '../src/features/chat/components/ToolRows'
import { planParts } from '../src/features/chat/toolRows'
import type { UIMessage } from 'ai'
import { hasUnsavedEdits } from '../src/shared/lib/unsavedEdits'
import { WindowCloseGuard } from '../src/app/WindowCloseGuard'
import { ResizeHandle } from '../src/features/workspace/components/ResizeHandle'

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
const htmlView = params.get('view') === 'html'
const HTML_DOC = `${ROOT}/営業部/報告/11月の売上.html`
const TOP_DOC = `${ROOT}/会社案内.html`
const SLIDES_DOC = `${ROOT}/営業部/報告/提案スライド.html`
if (htmlView) {
  for (const key of Object.keys(files)) delete files[key]
  files[HTML_DOC] = '<!doctype html><h1>11月の売上</h1><p>売上は前年比 120% でした。</p>'
  files[`${ROOT}/営業部/提案書.md`] = '# 提案書\n\n来期のご提案。'
  files[TOP_DOC] = '<!doctype html><p>会社案内</p>'
  files[SLIDES_DOC] = '<!doctype html><h1>提案スライド</h1>'
}
// The AI's lines of one reply: an HTML file written in the company folder (［見る］), one read, a
// Markdown file written, an HTML file written outside the company folder, a write that failed.
const toolPart = (id: string, toolName: string, input: unknown, state = 'output-available') =>
  ({ type: 'dynamic-tool', toolCallId: id, toolName, state, input, ...(state === 'output-error' ? { errorText: 'failed' } : { output: 'ok' }) }) as unknown as UIMessage['parts'][number]
const CHAT_LINES = planParts([
  toolPart('w1', 'Write', { file_path: SLIDES_DOC }),
  toolPart('r1', 'Read', { file_path: HTML_DOC }),
  toolPart('w2', 'Edit', { file_path: `${ROOT}/営業部/提案書.md` }),
  toolPart('w3', 'Write', { file_path: '/tmp/よそ.html' }),
  toolPart('w4', 'Write', { file_path: `${ROOT}/営業部/失敗.html` }, 'output-error'),
  toolPart('w5', 'Edit', { file_path: HTML_DOC }),
])
const inserted: string[] = []
const docCalls: unknown[][] = []
const opened: string[] = []
let docEvent: ((event: unknown) => void) | null = null
let nextViewId = 7
const writes: Array<[string, string]> = []
// Saves of these paths fail (a spec adds them); closing the window as main asks it (close-guard.ts).
const failWrites = new Set<string>()
const closeAnswers: string[] = []
let requestClose: (() => void) | null = null
const pinned: string[] = []
let emitChanges: ((changes: { type: string; path: string }[]) => void) | null = null
Object.assign(window, {
  electronAPI: {
    readFile: async (p: string) => (p in files ? files[p] : null),
    exists: async (p: string) => p in files,
    readFileBinary: async () => null,
    writeFile: async (p: string, content: string) => {
      if (failWrites.has(p)) return false
      files[p] = content
      writes.push([p, content])
      return true
    },
    onCloseRequested: (cb: () => void) => { requestClose = cb; return () => { requestClose = null } },
    answerCloseRequest: async (answer: string) => { closeAnswers.push(answer) },
    createDirectory: async () => true,
    backupBeforeOverwrite: async () => ({ success: true, backupPath: `${ROOT}/.backups/2026-10-23T01-02-03-456_editor_overwrite` }),
    // The review's sidecars live next to the document (?view=html: its review, doc-frame.md "Review in the document view").
    readDirectory: async (dir: string) => Object.keys(files)
      .filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map(p => ({ name: p.slice(dir.length + 1), path: p, isDirectory: false })),
    renameItem: async (from: string, to: string) => {
      if (!(from in files)) return { success: false, error: 'ENOENT' }
      files[to] = files[from]
      delete files[from]
      return { success: true, newPath: to }
    },
    deleteItem: async (p: string) => { delete files[p]; return { success: true } },
    onFileChanges: (cb: (changes: { type: string; path: string }[]) => void) => { emitChanges = cb; return () => { emitChanges = null } },
    openDocView: async (filePath: string) => {
      docCalls.push(['open', filePath])
      // A slow open (a spec sets it): the member may leave before the view is made.
      const delay = (window as unknown as { __acbDocDelay?: number }).__acbDocDelay
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (filePath === TOP_DOC) return { ok: false, reason: 'top_level', message: '会社フォルダのいちばん上にある HTML は表示できません。部署などのフォルダに入れてください。' }
      return { ok: true, viewId: nextViewId++ }
    },
    closeDocView: async (viewId: number, keepPlace?: boolean) => { docCalls.push(keepPlace === undefined ? ['close', viewId] : ['close', viewId, keepPlace]) },
    setDocViewBounds: async (viewId: number, bounds: unknown) => { docCalls.push(['bounds', viewId, bounds]) },
    setDocViewZoom: async (viewId: number, factor: number) => { docCalls.push(['zoom', viewId, factor]) },
    reloadDocView: async (viewId: number) => { docCalls.push(['reload', viewId]) },
    setDocViewReview: async (viewId: number, review: unknown) => { docCalls.push(['review', viewId, review]) },
    // What finding a comment's place answers (a spec sets it): 'shown' by default.
    findDocViewQuote: async (viewId: number, index: number) => {
      docCalls.push(['find', viewId, index])
      return (window as unknown as { __acbFound?: string }).__acbFound ?? 'shown'
    },
    onDocViewEvent: (cb: (event: unknown) => void) => { docEvent = cb; return () => { if (docEvent === cb) docEvent = null } },
    openExternal: async (url: string) => { opened.push(url); return { success: true } },
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
Object.assign(window, { __acbExternalEdit: externalEdit, __acbExternalDelete: externalDelete, __acbFiles: files, __acbWrites: writes, __acbPinned: pinned, __acbHasUnsavedEdits: hasUnsavedEdits,
  __acbFailWrites: failWrites, __acbDocCalls: docCalls, __acbDocEvent: (e: unknown) => docEvent?.(e), __acbOpened: opened, __acbInserted: inserted,
  __acbFileChange: (p: string) => emitChanges?.([{ type: 'change', path: p }]), __acbCloseAnswers: closeAnswers, __acbRequestClose: () => requestClose?.() })

export function Preview() {
  // As AppShell does: shortcuts reach the focused area only.
  useKeybindings()
  const [dept, setDept] = useState(params.get('dept') ?? 'sales')
  const [openFiles, setOpenFiles] = useState(() => Object.keys(files).filter(f => f !== SLIDES_DOC))
  const [active, setActive] = useState(htmlView ? HTML_DOC : `${ROOT}/コンテンツG/台本.md`)
  const [menuOpen, setMenuOpen] = useState(false)
  const [smallMenu, setSmallMenu] = useState(false)
  const [toast, setToast] = useState(false)
  const [leftWidth, setLeftWidth] = useState(160)
  const leftAtStart = useRef(leftWidth)
  const [previewTab, setPreviewTab] = useState<string | null>(tabsView ? `${ROOT}/README.md` : null)
  const closeFile = (p: string) => {
    if (!tabsView && !htmlView) return
    const rest = openFiles.filter(f => f !== p)
    setOpenFiles(rest)
    if (active === p) setActive(rest[0] ?? '')
  }
  const pinFile = (p: string) => { pinned.push(p); setPreviewTab(null) }
  // As AppShell and a chat pane do.
  useCommandHandler('file.open', ({ path }) => {
    setOpenFiles(list => (list.includes(path) ? list : [...list, path]))
    setActive(path)
  })
  useCommandHandler('chat.insertText', ({ text }) => { inserted.push(text) }, { target: 'chat' })
  const labels = tabDepartmentLabels(openFiles, { rootPath: ROOT, departments, selectedDeptId: dept === 'company' ? null : dept })
  return (
    <main className="min-h-screen bg-white text-gray-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="bg-amber-50 px-4 py-2 text-xs text-amber-900">表示確認用の人工データです。</div>
      <nav className="flex gap-1 border-b border-gray-200 px-3 pt-2 text-sm dark:border-zinc-800">
        {[['company', '全社'], ['content', 'コンテンツG'], ['sales', '営業部']].map(([id, name]) => (
          <button key={id} onClick={() => setDept(id)} className={`rounded-t-small px-3 py-1.5 ${dept === id ? 'border border-b-0 border-gray-200 bg-white font-medium dark:border-zinc-800 dark:bg-zinc-900' : 'text-gray-500'}`}>{name}</button>
        ))}
      </nav>
      {params.get('view') === 'external' && (
        <div className="flex gap-2 px-3 py-2 text-xs">
          <button data-testid="external-edit" className="rounded-small border px-2 py-1" onClick={() => externalEdit(active)}>AIがこのファイルを書き換える</button>
          <button data-testid="external-delete" className="rounded-small border px-2 py-1" onClick={() => externalDelete(active)}>AIがこのファイルを削除する</button>
        </div>
      )}
      {htmlView && (
        <div style={{ display: 'flex', gap: 8, padding: '4px 12px', fontSize: 12 }}>
          <button data-testid="open-menu" onClick={() => setMenuOpen(o => !o)}>メニューを出す</button>
          <button data-testid="open-small-menu" onClick={() => setSmallMenu(o => !o)}>小さいメニュー</button>
          <button data-testid="open-toast" onClick={() => setToast(o => !o)}>お知らせ</button>
        </div>
      )}
      {menuOpen && (
        <div role="menu" style={{ position: 'fixed', left: 300, top: 200, width: 120, height: 60, background: '#fff', border: '1px solid #ccc', zIndex: 60 }}>
          <button role="menuitem" onClick={() => setMenuOpen(false)}>閉じる</button>
        </div>
      )}
      {smallMenu && <div role="menu" aria-label="小さいメニュー" style={{ position: 'fixed', ...(window as unknown as { __acbSmallMenuAt?: object }).__acbSmallMenuAt, width: 12, height: 12, background: '#fff', zIndex: 60 }} />}
      {toast && <div role="status" style={{ position: 'fixed', ...(window as unknown as { __acbSmallMenuAt?: object }).__acbSmallMenuAt, width: 12, height: 12, background: '#333', zIndex: 70 }} />}
      {/* Tailwind does not scan this page: the tabs view sets its height itself so the preview scrolls. */}
      {htmlView ? (
        // As AppShell lays the middle out: the left column, the chat and the bottom panel beside the
        // editor, each behind a divider whose grab strip reaches 4 px over the editor's edge.
        <div style={{ display: 'flex', height: 420, width: 1000 }}>
          <div data-testid="left-column" style={{ width: leftWidth, flexShrink: 0 }} />
          <ResizeHandle label="ファイルツリーとエディタの境目" onResizeStart={() => { leftAtStart.current = leftWidth }} onResize={offset => setLeftWidth(leftAtStart.current + offset)} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 0 }}>
              <TabbedEditorPanel openFiles={openFiles} activeFilePath={active} previewFilePath={previewTab} tabLabels={labels} onSelectFile={setActive} onCloseFile={closeFile} onPinFile={pinFile} />
            </div>
            <ResizeHandle direction="vertical" label="エディタと下のパネルの境目" onResizeStart={() => {}} onResize={() => {}} />
            <div style={{ height: 40, flexShrink: 0 }} />
          </div>
          <ResizeHandle label="左の欄とチャットの境目" onResizeStart={() => {}} onResize={() => {}} />
          <div style={{ width: 60, flexShrink: 0 }} />
        </div>
      ) : (
        <div className="h-[420px] w-[760px]" style={tabsView ? { height: 420 } : undefined}>
          <TabbedEditorPanel openFiles={openFiles} activeFilePath={active} previewFilePath={previewTab} tabLabels={labels} onSelectFile={setActive} onCloseFile={closeFile} onPinFile={pinFile} />
        </div>
      )}
      {htmlView && (
        <section aria-label="AI の作業" className="w-[760px] px-3 py-2">
          {CHAT_LINES.map(item => (item.kind === 'run' ? <ToolRunGroup key={item.key} item={item} /> : null))}
        </section>
      )}
      <WindowCloseGuard />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
