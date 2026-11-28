// Preview of a Markdown document read and edited in the same view (files-and-editor.md "Editing a
// document in place"): the real TabbedEditorPanel with `inPlaceEditing` (as AppShell passes it), the
// preload API faked. Fictional documents only.
// window.__acbFiles / __acbWrites: the "disk" and every save; __acbExternalEdit(path, text) writes a
// file as the AI would (and sends the watcher's event); __acbRequestClose() asks to close the window
// as main does; __acbCloseAnswers lists the answers; __acbBackups every keep (the disk version
// before an overwrite, or the edits given); __acbFailWrites: saves of these paths fail.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TabbedEditorPanel } from '../src/features/editor/components/TabbedEditorPanel'
import { useKeybindings } from '../src/shared/commands/commands'
import { WindowCloseGuard } from '../src/app/WindowCloseGuard'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'
import { useAppStore } from '../src/stores/appStore'

const ROOT = '/Users/demo/会社'
const MEETING = `${ROOT}/営業部/定例メモ.md`
const NOTES = `${ROOT}/営業部/注のある文書.md`
const files: Record<string, string> = {
  [MEETING]: [
    '---', 'title: 営業部 定例', '---', '',
    '# 営業部 定例ミーティング', '',
    '* 見積もりは _来週の木曜まで_ に送る',
    '    * 送る前に田中さんが確認する', '',
    '| 項目 | 10月 |', '|:-----|-----:|', '| 問い合わせ | 42 |', '',
    '<!-- AI メモ: 受注率を計算しておく -->', '',
    '研修の資料は [研修フォルダ](./研修/) にあります。予算の確認をしました。', '',
  ].join('\n'),
  [NOTES]: '本文です[^1]。\n\n[^1]: 注の中身\n',
}
const writes: Array<[string, string]> = []
const backups: Array<{ reason: string; path: string; content: string | undefined }> = []
const failWrites = new Set<string>()
const changes = emitter<Array<{ type: string; path: string }>>()
const closeRequests = emitter<void>()
const closeAnswers: string[] = []
installElectronAPI({
  readFile: async (p: string) => (p in files ? files[p] : null),
  exists: async (p: string) => p in files,
  writeFile: async (p: string, content: string) => {
    if (failWrites.has(p)) return false
    files[p] = content
    writes.push([p, content])
    return true
  },
  backupBeforeOverwrite: async (_root: string, p: string) => {
    backups.push({ reason: 'editor_overwrite', path: p, content: files[p] })
    return { success: true, backupPath: `${ROOT}/.backups/2026-11-28T01-02-03-456_editor_overwrite` }
  },
  backupEdits: async (_root: string, p: string, content: string, reason = 'editor_edits') => {
    backups.push({ reason, path: p, content })
    return { success: true, backupPath: `${ROOT}/.backups/2026-11-28T01-02-03-456_${reason}` }
  },
  readDirectory: async () => [],
  onFileChanges: changes.subscribe,
  onCloseRequested: (cb: () => void) => closeRequests.subscribe(cb),
  answerCloseRequest: async (answer: string) => { closeAnswers.push(answer) },
} as never)
Object.assign(window, {
  __acbFiles: files,
  __acbWrites: writes,
  __acbBackups: backups,
  __acbFailWrites: failWrites,
  __acbCloseAnswers: closeAnswers,
  __acbRequestClose: () => closeRequests.emit(),
  __acbExternalEdit: (p: string, text: string) => { files[p] = text; changes.emit([{ type: 'change', path: p }]) },
})

useAppStore.setState({ currentCompany: { id: 'demo', name: '株式会社デモ', rootPath: ROOT, departments: [], createdAt: new Date() } })

export function Preview() {
  useKeybindings()
  const [active, setActive] = useState(new URLSearchParams(location.search).get('file') === 'notes' ? NOTES : MEETING)
  return (
    <main className="min-h-screen bg-bg text-text">
      <div style={{ height: 480, width: 800 }}>
        <TabbedEditorPanel openFiles={[MEETING, NOTES]} activeFilePath={active} onSelectFile={setActive} onCloseFile={() => {}} inPlaceEditing />
      </div>
      <WindowCloseGuard />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
