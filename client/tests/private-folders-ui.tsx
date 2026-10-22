/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for private folders in the file tree (lock icon, 「🔒 非公開」
// banner, 「新しいフォルダ…」 with 公開 / 非公開, move confirmations), with the
// preload API mocked (no Electron, no git, no server).
// Open /tests/private-folders-ui.html?theme=…&role=…&state=…&select=…
//
//   theme   light (default) | dark
//   role    manager (default: manager of 人事部) | member | admin
//   state   normal (default) | offline | taken (the name is unavailable) | outdated
//   select  a company-relative path to select (e.g. 人事部/評価/面談メモ.md)
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { useAppStore } from '../src/stores/appStore'
import { useAuthStore } from '../src/stores/authStore'
import { FileTreePanel } from '../src/components/skill-ui/FileTreePanel'
import type { MyPrivateFolder } from '../shared/private-folder-ui'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') ?? 'light'
const role = params.get('role') ?? 'manager'
const state = params.get('state') ?? 'normal'
const select = params.get('select')
if (theme === 'dark') document.documentElement.classList.add('dark')

const ROOT = '/Users/demo/会社'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const DISK: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
  [`${ROOT}/人事部`]: [
    { name: '評価', isDirectory: true },
    { name: '採用', isDirectory: true },
    { name: '規程', isDirectory: true },
    { name: '人事部の進め方.md', isDirectory: false },
  ],
  [`${ROOT}/人事部/評価`]: [
    { name: '2026上期', isDirectory: true },
    { name: '面談メモ.md', isDirectory: false },
    { name: '評価基準.xlsx', isDirectory: false },
  ],
  [`${ROOT}/人事部/評価/2026上期`]: [{ name: '営業部.xlsx', isDirectory: false }],
  [`${ROOT}/人事部/採用`]: [{ name: '求人票.md', isDirectory: false }, { name: '面接の流れ.md', isDirectory: false }],
  [`${ROOT}/人事部/規程`]: [{ name: '就業規則.pdf', isDirectory: false }],
}
const listDir = (dir: string) => (DISK[dir] ?? []).map(e => ({ ...e, path: `${dir}/${e.name}` }))
type TreeNode = { name: string; isDirectory: boolean; path: string; children?: TreeNode[] }
const tree = (dir: string, depth: number, max: number): TreeNode[] =>
  listDir(dir).map(e => (e.isDirectory && depth < max ? { ...e, children: tree(e.path, depth + 1, max) } : e))

const MEMBERS = [
  { userId: 'u_owner', name: '佐藤 健', email: 'sato@example.com', role: 'owner' },
  { userId: 'u_admin', name: '鈴木 一郎', email: 'suzuki@example.com', role: 'admin' },
  { userId: 'u_me', name: '山田 花子', email: 'yamada@example.com', role: role === 'admin' ? 'admin' : 'member' },
  { userId: 'u_hr2', name: '高橋 美咲', email: 'takahashi@example.com', role: 'member' },
  { userId: 'u_sales', name: '田中 太郎', email: 'tanaka@example.com', role: 'member' },
  { userId: 'u_dev', name: '伊藤 翔', email: 'ito@example.com', role: 'member' },
]

const FOLDERS: MyPrivateFolder[] = [
  {
    scopeId: 's_eval',
    path: '人事部/評価',
    canWrite: true,
    viewerCount: 4,
    viewers: [
      { userId: 'u_me', name: '山田 花子', role: 'member' },
      { userId: 'u_hr2', name: '高橋 美咲', role: 'member' },
      { userId: 'u_owner', name: '佐藤 健', role: 'owner' },
      { userId: 'u_admin', name: '鈴木 一郎', role: 'admin' },
    ],
  },
]

if (state === 'offline') Object.defineProperty(navigator, 'onLine', { get: () => false })

Object.assign(window, {
  electronAPI: {
    getWriteAccess: async () => null,
    onWriteAccessChanged: () => () => {},
    sparseGetExclusions: async () => ({ success: true, excluded: [] }),
    onSparseProgress: () => () => {},
    readDirectoryTree: async (dir: string, max: number) => tree(dir, 0, max),
    readDirectory: async (dir: string) => listDir(dir),
    watchDirectory: async () => {},
    unwatchDirectory: async () => {},
    onFileChange: () => () => {},
    getStats: async () => { throw new Error('not found') },
    createDirectory: async (p: string) => {
      const dir = p.slice(0, p.lastIndexOf('/'))
      DISK[dir] = [...(DISK[dir] ?? []), { name: p.slice(dir.length + 1), isDirectory: true }]
      return true
    },
    moveItem: async () => ({ success: true }),
    getMyPrivateFolders: async () => ({ success: true, folders: FOLDERS }),
    getPrivateFolderCreateContext: async () => {
      await sleep(250)
      if (state === 'offline') return { success: false, offline: true, error: 'offline' }
      return {
        success: true,
        context: {
          role: role === 'admin' ? 'admin' : 'member',
          managedDepartmentIds: role === 'manager' ? ['d_hr'] : [],
          department: { id: 'd_hr', name: '人事部', folder: '人事部' },
          managerIds: ['u_me', 'u_hr2'],
          members: MEMBERS,
        },
      }
    },
    createPrivateFolder: async (_company: string, input: { parentPath: string; name: string; force?: boolean }) => {
      await sleep(500)
      if (state === 'taken') return { success: false, offline: false, status: 409, code: 'FOLDER_NAME_UNAVAILABLE', error: `『${input.parentPath}/${input.name}』というフォルダ名は使えません。別の名前にしてください。` }
      if (state === 'outdated' && !input.force) return { success: false, offline: false, status: 409, code: 'OUTDATED_CLIENTS', error: 'outdated', outdatedMembers: ['伊藤 翔'], canForce: role === 'admin' }
      return { success: true, scopeId: 's_new', path: `${input.parentPath}/${input.name}`, viewerCount: 4 }
    },
  },
})

useAppStore.setState({ currentCompany: { id: 'demo', name: '株式会社デモ', rootPath: ROOT, departments: [], createdAt: new Date() } })
useAuthStore.setState({ user: { id: 'u_me', email: 'yamada@example.com', name: '山田 花子', image: null, emailVerified: true } })

function Preview() {
  return (
    <main className="flex h-screen bg-white dark:bg-zinc-950">
      <div className="w-72">
        <FileTreePanel
          rootPath={ROOT}
          departmentFolder="人事部"
          selectedFilePath={select ? `${ROOT}/${select}` : null}
          onSelectFile={() => {}}
          onPrivateFolderCreated={() => {}}
        />
      </div>
      <div className="flex-1 p-8 text-sm text-gray-500 dark:text-zinc-400">表示確認用の人工データです（人事部、「評価」は非公開フォルダ）。</div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
