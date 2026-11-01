/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the file tree's own behaviour: selection, new file / rename /
// delete, multi-select, internal drag & drop, drops from Finder, hidden files and
// review marks, with an in-memory folder behind the preload API.
// Private-folder screens: private-folders-ui; not-downloaded folders: download-folders-ui.
//
// window.__acbCalls  every write the tree asked for, as [method, ...args]
// window.__acbSelected  the paths onSelectFile received, in order
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { useAppStore } from '../src/stores/appStore'
import { useAuthStore } from '../src/stores/authStore'
import { FileTreePanel } from '../src/features/files/components/FileTreePanel'
import { installElectronAPI } from './ui/fixtures/electron-api'
import type { MyPrivateFolder } from '../shared/private-folder-ui'

const ROOT = '/Users/demo/会社'
const DEPT = `${ROOT}/営業部`

type Entry = { name: string; isDirectory: boolean }
const DISK: Record<string, Entry[]> = {
  [DEPT]: [
    { name: '.settings.json', isDirectory: false },
    { name: '提案書', isDirectory: true },
    { name: '議事録', isDirectory: true },
    { name: '機密', isDirectory: true },
    { name: 'README.md', isDirectory: false },
    { name: 'ロゴ.png', isDirectory: false },
  ],
  [`${DEPT}/提案書`]: [
    { name: '2026春.md', isDirectory: false },
    { name: '2026春.md.review.0b7c-4f1e.json', isDirectory: false },
    { name: '見積.xlsx', isDirectory: false },
  ],
  [`${DEPT}/議事録`]: [{ name: '10月.md', isDirectory: false }],
  [`${DEPT}/機密`]: [{ name: '契約.md', isDirectory: false }],
}

const FOLDERS: MyPrivateFolder[] = [{
  scopeId: 's_secret',
  path: '営業部/機密',
  canWrite: true,
  viewerCount: 3,
  viewers: [
    { userId: 'u_me', name: '山田 花子', role: 'member' },
    { userId: 'u_owner', name: '佐藤 健', role: 'owner' },
    { userId: 'u_admin', name: '鈴木 一郎', role: 'admin' },
  ],
}]

const calls: unknown[][] = []
const selected: string[] = []
// Paths whose delete fails (a file another app holds open), set by a spec.
const failDelete = new Set<string>()
Object.assign(window, { __acbCalls: calls, __acbSelected: selected, __acbFailDelete: failDelete })
// What main answers when a name is taken (electron/features/fs: never replaces).
const TAKEN = { success: false, error: '同じ名前のファイルまたはフォルダがすでにあります。別の名前にしてください。', code: 'name_taken' as const }

const split = (p: string) => [p.slice(0, p.lastIndexOf('/')), p.slice(p.lastIndexOf('/') + 1)] as const
const find = (p: string) => { const [dir, name] = split(p); return DISK[dir]?.find(e => e.name === name) }
const add = (p: string, isDirectory: boolean) => {
  const [dir, name] = split(p)
  DISK[dir] = [...(DISK[dir] ?? []), { name, isDirectory }]
  if (isDirectory) DISK[p] ??= []
}
const remove = (p: string) => { const [dir, name] = split(p); DISK[dir] = (DISK[dir] ?? []).filter(e => e.name !== name) }
const listDir = (dir: string) => (DISK[dir] ?? []).map(e => ({ ...e, path: `${dir}/${e.name}` }))
type TreeNode = { name: string; isDirectory: boolean; path: string; children?: TreeNode[] }
const tree = (dir: string, depth: number, max: number): TreeNode[] =>
  listDir(dir).map(e => (e.isDirectory && depth < max ? { ...e, children: tree(e.path, depth + 1, max) } : e))
const move = (from: string, to: string) => {
  const entry = find(from)
  if (!entry) return { success: false, error: 'not found' }
  remove(from)
  add(to, entry.isDirectory)
  if (entry.isDirectory) { DISK[to] = DISK[from] ?? []; delete DISK[from] }
  return { success: true }
}

// Electron gives a dropped File its path on disk; Chromium does not.
Object.defineProperty(File.prototype, 'path', { get(this: File) { return `/Users/demo/Downloads/${this.name}` } })

installElectronAPI({
  sparseGetExclusions: async () => ({ success: true, excluded: [] }),
  readDirectoryTree: async (dir, max) => tree(dir, 0, max ?? 1),
  readDirectory: async dir => listDir(dir),
  getStats: async p => {
    if (!find(p)) throw new Error('not found')
    return { success: true }
  },
  createFile: async (p, content) => { calls.push(['createFile', p, content]); if (find(p)) return TAKEN; add(p, false); return { success: true } },
  createDirectory: async p => { calls.push(['createDirectory', p]); add(p, true); return true },
  renameItem: async (from, to) => { calls.push(['renameItem', from, to]); return find(to) ? TAKEN : move(from, to) },
  moveItem: async (from, to) => { calls.push(['moveItem', from, to]); return find(to) ? TAKEN : move(from, to) },
  deleteItem: async p => {
    calls.push(['deleteItem', p])
    if (failDelete.has(p)) return { success: false, error: 'EBUSY' }
    remove(p)
    return { success: true }
  },
  moveFromExternal: async (from, to) => { calls.push(['moveFromExternal', from, to]); add(to, false); return { success: true } },
  // A name a private folder this member cannot read already uses (the server knows).
  reservedPathRefusal: async p => (split(p)[1] === '人事評価' ? '「人事評価」という名前は使えません。別の名前にしてください。' : null),
  getMyPrivateFolders: async () => ({ success: true, folders: FOLDERS }),
})

useAppStore.setState({ currentCompany: { id: 'demo', name: '株式会社デモ', rootPath: ROOT, departments: [], createdAt: new Date() } })
useAuthStore.setState({ user: { id: 'u_me', email: 'yamada@example.com', name: '山田 花子', image: null, emailVerified: true } })

function Preview() {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <main className="flex h-screen bg-white dark:bg-zinc-950">
      <div className="w-72">
        <FileTreePanel
          rootPath={ROOT}
          departmentFolder="営業部"
          selectedFilePath={open}
          onSelectFile={p => { selected.push(p); setOpen(p) }}
        />
      </div>
      <div className="flex-1 p-8 text-sm text-gray-500 dark:text-zinc-400">
        表示確認用の人工データです（営業部、「機密」は非公開フォルダ）。
        <output aria-label="開いているファイル" className="block mt-4">{open ?? ''}</output>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
