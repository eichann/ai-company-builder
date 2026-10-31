/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the company selector (choosing a company and setting its
// folder up), with the preload API faked. Query:
//   ?companies=empty|error   the member's company list
//   ?folder=empty|clone|refuse|upload|offline   what main says the chosen folder is
//   ?depts=0                 the company has no departments (no picker)
//   ?pick=cancel             the folder dialog is cancelled
//   ?setup=fail|manual       the download fails / waits for window.__acbCompany.finishSetup()
// Calls the page made are in window.__acbCompany.calls; the opened company is
// shown under 「開いた会社」.
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { CompanySelector } from '../src/components/auth/CompanySelector'
import { useAppStore } from '../src/stores/appStore'
import { useAuthStore } from '../src/stores/authStore'
import type { CompanyInfo, DepartmentInfo, DirectoryEntry } from '../shared/ipc-contract'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
const calls: unknown[][] = []
const progress = emitter<{ repoPath: string; receivedBytes: number }>()
let finishSetup: (() => void) | null = null
;(window as unknown as { __acbCompany: unknown }).__acbCompany = {
  calls,
  progress: (receivedBytes: number) => progress.emit({ repoPath: '', receivedBytes }),
  finishSetup: () => finishSetup?.(),
  get listening() { return progress.size },
}

const company = (id: string, name: string, role: string): CompanyInfo => ({
  id, name, role, slug: id, ownerId: 'u1', repoPath: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
})
const department = (id: string, name: string, folder: string): DepartmentInfo => ({
  id, name, folder, companyId: 'c1', parentId: null, nameEn: null, icon: '', color: '', description: null, sortOrder: 0, isActive: true, createdAt: '', updatedAt: '',
})
const entry = (folder: string, name: string, isDirectory = true): DirectoryEntry => ({ name, isDirectory, path: `${folder}/${name}` })

const companies = params.get('companies') === 'empty' ? [] : [company('c1', '阿部商店', 'owner'), company('c2', '山田工務店', 'member')]
const decisions = {
  empty: { action: 'firstSetup' as const },
  clone: { action: 'existingClone' as const },
  upload: { action: 'uploadExisting' as const },
  refuse: { action: 'refuse' as const, reason: 'otherRemote' as const, message: '別の会社のフォルダです。' },
}
const folder = params.get('folder') ?? 'empty'

useAuthStore.setState({
  user: { id: 'u1', email: 'demo@example.com', name: '阿部', image: null, emailVerified: true },
  signOut: async () => { calls.push(['signOut']) },
})

installElectronAPI({
  getCompanies: async () => {
    calls.push(['getCompanies'])
    return params.get('companies') === 'error' ? { success: false, error: '会社の一覧を読めませんでした' } : { success: true, data: companies }
  },
  createCompany: async name => {
    calls.push(['createCompany', name])
    return name === '失敗' ? { success: false, error: '作成できませんでした' } : { success: true, data: company('c9', name, 'owner') }
  },
  selectDirectory: async () => {
    calls.push(['selectDirectory'])
    return params.get('pick') === 'cancel' ? null : '/Users/demo/作業'
  },
  gitInspectCompanyFolder: async (path, companyId) => {
    calls.push(['gitInspectCompanyFolder', path, companyId])
    if (folder === 'offline') return { success: false, error: 'オフラインです' }
    return { success: true, decision: decisions[folder as keyof typeof decisions] }
  },
  getDepartments: async companyId => {
    calls.push(['getDepartments', companyId])
    if (params.get('depts') === '0') return { success: true, data: [] }
    return { success: true, data: [department('d1', '営業部', '営業部'), department('d2', '開発', 'development'), department('d3', '入れ子', '営業部/東京')] }
  },
  createDirectory: async path => { calls.push(['createDirectory', path]); return true },
  gitSetupCompanyRemote: async (path, companyId, selected) => {
    calls.push(['gitSetupCompanyRemote', path, companyId, selected ?? null])
    if (params.get('setup') === 'manual') await new Promise<void>(resolve => { finishSetup = resolve })
    if (params.get('setup') === 'fail') return { success: false, error: 'ダウンロードが途中で止まりました' }
    return { success: true }
  },
  onSetupProgress: callback => progress.subscribe(callback),
  readDirectory: async path => {
    calls.push(['readDirectory', path])
    return [entry(path, 'development'), entry(path, '営業部'), entry(path, '_archive'), entry(path, '.claude'), entry(path, 'README.md', false)]
  },
  exists: async path => path.endsWith('/development/AGENT.md'),
})

function OpenedCompany() {
  const current = useAppStore(s => s.currentCompany)
  if (!current) return null
  const shown = { id: current.id, name: current.name, rootPath: current.rootPath, departments: current.departments.map(d => `${d.id}:${d.name}:${d.hasAgent ? 'agent' : '-'}`) }
  return <pre role="status" aria-label="開いた会社" className="text-xs">{JSON.stringify(shown)}</pre>
}

function Preview() {
  return (
    <main className="h-screen flex flex-col">
      <div className="flex-1 min-h-0"><CompanySelector /></div>
      <OpenedCompany />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
