/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the main screen (src/app/AppShell.tsx: department tabs,
// skills / files / search / history, the editor and the chat), with the
// preload API faked (no Electron, git, server or AI). Synthetic data only.
// Open /tests/skill-layout-ui.html?theme=…&download=…&keep=…&seed=…
//
//   theme     light (default) | dark
//   download  ok (default) | offline — what 「ダウンロードして同期を開始」 gets
//   keep      1 = keep what the previous load saved (an app restart); otherwise storage starts empty
//   seed      JSON {key: value} written to localStorage before the screen mounts
//             (what an earlier version of the app saved)
//
// Departments: 営業部 (downloaded), 開発部 (not downloaded on this computer),
// 総務 (read-only for this member). window.__acbLayout lets the Playwright UI
// tests (tests/ui/skill-layout.spec.ts) act as the AI / a teammate and see
// which calls the screen made.
import { createRoot } from 'react-dom/client'
import { markAgentLogNoticeSeen } from '../src/lib/agentLogNotice'
import '../src/i18n'
import '../src/index.css'
import { useAppStore } from '../src/stores/appStore'
import { useAuthStore } from '../src/stores/authStore'
import { AppShell } from '../src/app/AppShell'
import { emitter, installElectronAPI, type ElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const downloadOffline = params.get('download') === 'offline'
try {
  if (params.get('keep') !== '1') localStorage.clear()
  for (const [key, value] of Object.entries(JSON.parse(params.get('seed') ?? '{}') as Record<string, string>)) localStorage.setItem(key, value)
} catch { /* preview only */ }
// The one-time AI action log notice only with ?notice=1 (it would cover the chat in the other specs).
if (params.get('notice') !== '1') markAgentLogNoticeSeen('u_me')

const ROOT = '/Users/demo/会社'
const COMPANY = 'demo'
// A second company (with no departments of its own on disk) for per-company state.
const OTHER_ROOT = '/Users/demo/別会社'
const COMPANIES: Record<string, { name: string; rootPath: string }> = {
  [COMPANY]: { name: '株式会社デモ', rootPath: ROOT },
  other: { name: '別会社', rootPath: OTHER_ROOT },
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Entry = { name: string; isDirectory: boolean }
const DISK: Record<string, Entry[]> = {
  [ROOT]: [{ name: '営業部', isDirectory: true }, { name: '総務', isDirectory: true }, { name: 'README.md', isDirectory: false }],
  [`${ROOT}/営業部`]: [{ name: '提案書', isDirectory: true }, { name: '顧客', isDirectory: true }, { name: '営業の進め方.md', isDirectory: false }, { name: '売上表.md', isDirectory: false }],
  [`${ROOT}/営業部/提案書`]: [{ name: 'A社_提案.md', isDirectory: false }, { name: 'B社_提案.md', isDirectory: false }],
  [`${ROOT}/営業部/顧客`]: [{ name: '一覧.csv', isDirectory: false }],
  [`${ROOT}/総務`]: [{ name: '規程', isDirectory: true }, { name: '備品.md', isDirectory: false }],
  [`${ROOT}/総務/規程`]: [{ name: '就業規則.md', isDirectory: false }],
  [OTHER_ROOT]: [{ name: '議事録.md', isDirectory: false }],
}
const FILES: Record<string, string> = {
  [`${ROOT}/総務/備品.md`]: '# 備品\n\nコピー用紙は総務へ。',
  [`${ROOT}/営業部/営業の進め方.md`]: '# 営業の進め方\n\n毎週月曜に共有します。',
  [`${OTHER_ROOT}/議事録.md`]: '# 議事録\n\n別会社の定例。',
  [`${ROOT}/README.md`]: '# 株式会社デモ\n\n会社の共有フォルダです。',
  [`${ROOT}/営業部/提案書/A社_提案.md`]: '# A社 提案\n\nA社への提案の骨子。',
  [`${ROOT}/営業部/提案書/B社_提案.md`]: '# B社 提案\n\nB社への提案の骨子。',
  [`${ROOT}/総務/規程/就業規則.md`]: '# 就業規則\n\n第1条 目的',
  // Lines wider than the editor (in its source view): they scroll inside the editor, never widen the screen.
  [`${ROOT}/営業部/売上表.md`]: [
    '# 売上表',
    '',
    `| 顧客 | ${Array.from({ length: 12 }, (_, i) => `${i + 1}月の売上と前年同月比のメモ`).join(' | ')} |`,
    `|${' --- |'.repeat(13)}`,
    `| A社 | ${Array.from({ length: 12 }, (_, i) => `${(i + 1) * 100}万円（前年比 ${100 + i}%）`).join(' | ')} |`,
    `| 資料 | ${Array.from({ length: 12 }, (_, i) => `https://example.com/sales/2026/${i + 1}/monthly-report.pdf`).join(' | ')} |`,
    '',
    '```',
    `集計式: ${Array.from({ length: 12 }, (_, i) => `month_${i + 1}_sales * rate_${i + 1}`).join(' + ')}`,
    '```',
  ].join('\n'),
}
const listDir = (dir: string) => (DISK[dir] ?? []).map(e => ({ ...e, path: `${dir}/${e.name}` }))
type TreeNode = { name: string; isDirectory: boolean; path: string; children?: TreeNode[] }
const tree = (dir: string, depth: number, max: number): TreeNode[] =>
  listDir(dir).map(e => (e.isDirectory && depth < max ? { ...e, children: tree(e.path, depth + 1, max) } : e))

const DEPARTMENTS = [
  { id: 'd_sales', name: '営業部', folder: '営業部', color: '#0ea5e9' },
  { id: 'd_dev', name: '開発部', folder: '開発部', color: '#22c55e' },
  { id: 'd_ga', name: '総務', folder: '総務', color: '#f59e0b' },
].map((d, i) => ({ ...d, companyId: COMPANY, parentId: null, nameEn: null, icon: 'folder', description: null, sortOrder: i, isActive: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }))

let excluded = ['開発部']

const skill = (folder: string, name: string, description: string) => ({
  id: `${folder}:${name}`, name, description, departmentId: DEPARTMENTS.find(d => d.folder === folder)?.id ?? 'company',
  skillPath: `${ROOT}/${folder}/.claude/skills/${name}`, files: { skillMd: 'SKILL.md' },
})
const SKILLS: Record<string, ReturnType<typeof skill>[]> = {
  '': [skill('', 'weekly-report', '週報をまとめる')],
  営業部: [skill('営業部', 'proposal', '提案書のたたき台を作る')],
  開発部: [skill('開発部', 'release-note', 'リリースノートを書く')],
  総務: [],
}

const COMMITS = [
  { hash: 'c2'.padEnd(40, '0'), hashShort: 'c2000000', message: '提案書を更新', author: '田中 太郎', date: '2026-10-22T09:00:00+09:00' },
  { hash: 'c1'.padEnd(40, '0'), hashShort: 'c1000000', message: '顧客一覧を追加', author: '山田 花子', date: '2026-10-21T09:00:00+09:00' },
]

const fileChanges = emitter<Array<{ type: string; path: string }>>()
const calls: Array<{ name: string; args: unknown[] }> = []
const record = (name: string, args: unknown[]) => { calls.push({ name, args }) }

const api: Partial<ElectronAPI> = {
  getDepartments: async () => ({ success: true, data: DEPARTMENTS }),
  sparseGetExclusions: async () => ({ success: true, enabled: excluded.length > 0, excluded: [...excluded] }) as never,
  sparseSetExclusions: async (_root: string, next: string[]) => {
    record('sparseSetExclusions', [next])
    await sleep(200)
    if (downloadOffline) return { success: false, offline: true, error: 'offline' } as never
    for (const folder of excluded.filter(e => !next.includes(e))) {
      DISK[ROOT].push({ name: folder, isDirectory: true })
      DISK[`${ROOT}/${folder}`] = [{ name: '設計.md', isDirectory: false }]
      // The checkout writes the files; the company watcher reports them.
      fileChanges.emit([{ type: 'addDir', path: `${ROOT}/${folder}` }, { type: 'add', path: `${ROOT}/${folder}/設計.md` }])
    }
    excluded = [...next]
    return { success: true, enabled: next.length > 0, excluded: [...next] } as never
  },
  onSparseProgress: () => () => {},
  exists: async (path: string) => path === ROOT || path in DISK || path in FILES,
  getStats: async () => { throw new Error('not found') },
  readDirectoryTree: async (dir: string, max?: number) => { record('readDirectoryTree', [dir]); return tree(dir, 0, max ?? 2) },
  readDirectory: async (dir: string) => { record('readDirectory', [dir]); return listDir(dir) },
  readFile: async (path: string) => FILES[path] ?? null,
  readFileBinary: async () => null,
  watchCompany: async () => ({ success: true }),
  unwatchCompany: async () => ({ success: true }),
  onFileChanges: fileChanges.subscribe,
  onFileChange: () => () => {},
  listSkills: async (_root: string, folder: string, _id: string, _name?: string, options?: { force?: boolean }) => {
    record('listSkills', [folder, !!options?.force])
    return { success: true, skills: [...(SKILLS[folder] ?? [])] }
  },
  getWriteAccess: async () => ({ version: 'v1', role: 'member', all: false, scopes: [{ path: '', write: true }, { path: '総務', write: false }] }),
  onWriteAccessChanged: () => () => {},
  getMyPrivateFolders: async () => ({ success: true, folders: [] }),
  gitGrep: async (_root: string, query: string, folder: string) => {
    record('gitGrep', [query, folder])
    await sleep(100)
    if (query === '提案') {
      return { success: true, results: [
        { file: '営業部/提案書/A社_提案.md', line: 3, text: 'A社への提案の骨子', column: 4 },
        { file: '営業部/提案書/A社_提案.md', line: 9, text: '提案価格', column: 0 },
        { file: '営業部/提案書/B社_提案.md', line: 1, text: '# B社 提案', column: 5 },
      ] }
    }
    if (query === 'の') {
      const results = Array.from({ length: 500 }, (_, i) => ({ file: `営業部/顧客/メモ${Math.floor(i / 20)}.md`, line: (i % 20) + 1, text: `${i}番目のメモ`, column: 0 }))
      return { success: true, results, truncated: true }
    }
    return { success: true, results: [] }
  },
  gitLog: async (_root: string, folder: string) => { record('gitLog', [folder]); return { success: true, commits: [...COMMITS] } },
  gitShowCommit: async () => ({ success: true, files: [] }) as never,
  gitSync: async () => {
    record('gitSync', [])
    await sleep(150)
    COMMITS.unshift({ hash: 'c3'.padEnd(40, '0'), hashShort: 'c3000000', message: 'チームの変更を取り込み', author: '高橋 美咲', date: '2026-10-23T09:00:00+09:00' })
    return { success: true, message: '同期しました' }
  },
  // The chat panel on the right: no chat server in this preview.
  getChatServerInfo: async () => null,
  getClaudeCodeStatus: async () => ({ available: true, authenticated: true, cliPath: null, version: null, error: null, checkedAt: 0 }),
  getAuthMode: async () => 'claude-code',
  getChatSessionSummaries: async () => [],
  getAgentInteractions: async () => [],
}
installElectronAPI(api)

Object.assign(window, {
  __acbLayout: {
    calls,
    /** The AI (or a sync) writes a file: it lands on the fake disk and the watcher reports it. */
    addSkill(folder: string, name: string) {
      ;(SKILLS[folder] ??= []).push(skill(folder, name, `${name} の説明`))
      fileChanges.emit([{ type: 'add', path: `${ROOT}/${folder ? `${folder}/` : ''}.claude/skills/${name}/SKILL.md` }])
    },
    emit(changes: Array<{ type: string; path: string }>) { fileChanges.emit(changes) },
  },
})

const openCompany = (id: string) => useAppStore.setState({ currentCompany: { id, ...COMPANIES[id], departments: [], createdAt: new Date() } })

// Did the editor ever show its empty state (「ファイルを選択してください」)? A restored
// tab strip must be there from the first frame, not filled in after an empty one.
let editorWasEmpty = false
new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.textContent?.includes('ファイルを選択してください')) editorWasEmpty = true
    }
  }
}).observe(document.getElementById('root')!, { childList: true, subtree: true })

Object.assign((window as unknown as { __acbLayout: object }).__acbLayout, {
  editorWasEmpty: () => editorWasEmpty,
  /** Like the app: back to the company list (the screen unmounts), then open another company. */
  async switchCompany(id: string) {
    useAppStore.setState({ currentCompany: null })
    await sleep(50)
    editorWasEmpty = false
    openCompany(id)
  },
})

useAuthStore.setState({ user: { id: 'u_me', email: 'yamada@example.com', name: '山田 花子', image: null, emailVerified: true } })
openCompany(COMPANY)

// App.tsx shows the screen only while a company is open.
function Screen() {
  const company = useAppStore(s => s.currentCompany)
  return company ? <AppShell /> : null
}
createRoot(document.getElementById('root')!).render(<div className="h-screen"><Screen /></div>)
