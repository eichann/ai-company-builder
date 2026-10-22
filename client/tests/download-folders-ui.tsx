/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the "ダウンロードするフォルダ" settings and the file tree's
// 未ダウンロード placeholders, with the preload API mocked (no Electron, no
// git, no server). Open /tests/download-folders-ui.html?view=…&theme=…&state=…
//
//   view   settings (default) | filetree
//   theme  light (default) | dark
//   state  normal (default) | offline | slow (apply takes long) | confirm
//          (leaving out a folder with local edits) | applyOffline (download fails)
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { useAppStore } from '../src/stores/appStore'
import { SettingsPanel } from '../src/components/settings/SettingsPanel'
import { FileTreePanel } from '../src/components/skill-ui/FileTreePanel'

const params = new URLSearchParams(location.search)
const view = params.get('view') ?? 'settings'
const theme = params.get('theme') ?? 'light'
const state = params.get('state') ?? 'normal'
if (theme === 'dark') document.documentElement.classList.add('dark')

const ROOT = '/Users/demo/会社'
const GB = 1024 ** 3
const MB = 1024 ** 2

// The company: department → sub-folders with sizes (bytes).
const TREE: Record<string, number> = {
  'コンテンツ/動画/2025年度': 3.2 * GB,
  'コンテンツ/動画/2026年度/撮影素材': 2.4 * GB,
  'コンテンツ/動画/2026年度/編集済み': 0.9 * GB,
  'コンテンツ/記事': 180 * MB,
  'コンテンツ/画像素材': 1.1 * GB,
  'コンテンツ/企画書': 42 * MB,
  '営業部/提案書': 640 * MB,
  '営業部/顧客': 95 * MB,
  '開発部/設計': 210 * MB,
  '開発部/資料': 1.6 * GB,
  '総務': 38 * MB,
  'shared': 12 * MB,
  '.claude/skills': 2 * MB,
}
const sizeUnder = (p: string) => Object.entries(TREE).filter(([k]) => k === p || k.startsWith(`${p}/`)).reduce((n, [, v]) => n + v, 0)
const childrenOf = (p: string) => {
  const set = new Set<string>()
  for (const k of Object.keys(TREE)) {
    if (p && !k.startsWith(`${p}/`)) continue
    const rest = p ? k.slice(p.length + 1) : k
    set.add(rest.split('/')[0])
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja')).map(name => {
    const path = p ? `${p}/${name}` : name
    return { name, path, size: state === 'offline' ? null : sizeUnder(path), files: 10, hasChildren: Object.keys(TREE).some(k => k.startsWith(`${path}/`)) }
  })
}

let excluded = ['営業部', 'コンテンツ/動画/2025年度']
const progressListeners = new Set<(d: { repoPath: string; receivedBytes: number }) => void>()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const DEPARTMENTS = [
  { id: 'd1', name: 'コンテンツ', folder: 'コンテンツ', icon: 'folder', color: '#6366f1', sortOrder: 0, isActive: true },
  { id: 'd2', name: '営業部', folder: '営業部', icon: 'folder', color: '#0ea5e9', sortOrder: 1, isActive: true },
  { id: 'd3', name: '開発部', folder: '開発部', icon: 'folder', color: '#22c55e', sortOrder: 2, isActive: true },
  { id: 'd4', name: '総務', folder: '総務', icon: 'folder', color: '#f59e0b', sortOrder: 3, isActive: true },
]

// Files on disk for the file tree (コンテンツ, with 動画/2025年度 not downloaded).
const DISK: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
  [`${ROOT}/コンテンツ`]: [{ name: '動画', isDirectory: true }, { name: '記事', isDirectory: true }, { name: '画像素材', isDirectory: true }, { name: '企画書', isDirectory: true }, { name: 'README.md', isDirectory: false }],
  [`${ROOT}/コンテンツ/動画`]: [{ name: '2026年度', isDirectory: true }, { name: '撮影ルール.md', isDirectory: false }],
  [`${ROOT}/コンテンツ/動画/2026年度`]: [{ name: '撮影素材', isDirectory: true }, { name: '編集済み', isDirectory: true }],
  [`${ROOT}/コンテンツ/記事`]: [{ name: '2026-10-連載.md', isDirectory: false }, { name: '入稿ルール.md', isDirectory: false }],
}
const listDir = (dir: string) => (DISK[dir] ?? []).map(e => ({ ...e, path: `${dir}/${e.name}` }))
type TreeNode = { name: string; isDirectory: boolean; path: string; children?: TreeNode[] }
const tree = (dir: string, depth: number, max: number): TreeNode[] =>
  listDir(dir).map(e => (e.isDirectory && depth < max ? { ...e, children: tree(e.path, depth + 1, max) } : e))

Object.assign(window, {
  electronAPI: {
    gitBinaryStatus: async () => ({ bundled: true, binary: 'bundled' }),
    readEnv: async () => ({ success: true, vars: { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxx' } }),
    readFile: async () => '.backups/\n.env*\nnode_modules/\n',
    writeFile: async () => true,
    writeEnv: async () => ({ success: true }),
    getDepartments: async () => ({ success: true, data: DEPARTMENTS }),
    getWriteAccess: async () => null,
    onWriteAccessChanged: () => () => {},
    sparseGetExclusions: async () => ({ success: true, excluded: [...excluded] }),
    sparseUncommittedChanges: async (_root: string, folders: string[]) => ({
      success: true,
      files: state === 'confirm' && folders.length > 0 ? [`${folders[0]}/編集メモ.md`, `${folders[0]}/構成案_v3.pptx`, `${folders[0]}/新規/台本.md`] : [],
    }),
    sparseSetExclusions: async (repoPath: string, next: string[]) => {
      const downloading = excluded.filter(e => !next.includes(e))
      if (state === 'applyOffline' && downloading.length > 0) {
        await sleep(600)
        return { success: false, offline: true, error: 'インターネットにつながっているときにダウンロードできます' }
      }
      const total = downloading.reduce((n, e) => n + sizeUnder(e), 0)
      const steps = state === 'slow' ? 1000 : 6
      for (let i = 1; i <= steps; i++) {
        await sleep(250)
        for (const fn of progressListeners) fn({ repoPath, receivedBytes: Math.round((total * i) / Math.max(steps, 20)) })
      }
      excluded = [...next]
      return { success: true, enabled: next.length > 0, excluded: [...next] }
    },
    onSparseProgress: (fn: (d: { repoPath: string; receivedBytes: number }) => void) => { progressListeners.add(fn); return () => progressListeners.delete(fn) },
    folderSizes: async (_root: string, _company: string, folder: string, measure: string[]) => {
      await sleep(folder ? 250 : 400)
      return {
        success: true,
        path: folder,
        size: state === 'offline' ? null : sizeUnder(folder) || Object.values(TREE).reduce((a, b) => a + b, 0),
        folders: childrenOf(folder),
        measured: Object.fromEntries(measure.map(m => [m, state === 'offline' ? null : sizeUnder(m)])),
        offline: state === 'offline',
      }
    },
    readDirectoryTree: async (dir: string, max: number) => tree(dir, 0, max),
    readDirectory: async (dir: string) => listDir(dir),
    watchDirectory: async () => {},
    unwatchDirectory: async () => {},
    onFileChange: () => () => {},
    getStats: async () => { throw new Error('not found') },
  },
})

useAppStore.setState({ currentCompany: { id: 'demo', name: '株式会社デモ', rootPath: ROOT, departments: [], createdAt: new Date() } })

function Preview() {
  if (view === 'filetree') {
    return (
      <main className="flex h-screen bg-white dark:bg-zinc-950">
        <div className="w-72">
          <FileTreePanel rootPath={ROOT} departmentFolder="コンテンツ" selectedFilePath={null} onSelectFile={() => {}} />
        </div>
        <div className="flex-1 p-8 text-sm text-gray-500 dark:text-zinc-400">表示確認用の人工データです（コンテンツ部、「動画/2025年度」は未ダウンロード）。</div>
      </main>
    )
  }
  return (
    <main className="h-screen bg-zinc-100 dark:bg-zinc-950">
      <SettingsPanel onClose={() => {}} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
