/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the "ダウンロードするフォルダ" settings and the file tree's
// 未ダウンロード placeholders, with the preload API mocked (no Electron, no
// git, no server). Open /tests/download-folders-ui.html?view=…&theme=…&state=…
//
//   view   settings (default) | filetree
//   theme  light (default) | dark
//   state  normal (default) | offline | slow (apply takes long) | confirm
//          (leaving out a folder with local edits) | applyOffline (download fails)
//   role   owner (default) | admin | member — the member's role in the company
//   tab    a settings section to open first (default: ダウンロードするフォルダ; mine = 自分の設定)
//   company  the company's 受信を読む: allowed (default) | off | later (stopped after the page read it:
//            shown allowed, turning it on is refused with WORK_SWITCH_COMPANY_OFF)
//   mail   no = Google has not let ACB read the member's mail yet
//   channels  none = the company has neither mail nor chat connected (no 受信を読む switch, one line instead)
//   google ready = the company offers Google and the member has not allowed it yet (設定 →「Google」 with
//          ［Google で許可］; the manual's picture, client/tests/manual/scenes.ts); otherwise the Google status is offline
//   manual 1 = the user manual's company (検証A社: 全社のファイル, 営業部 with 過去資料 left out, 総務部)
//          instead of 株式会社デモ's folders
//   jobs   (with manual=1, tab=jobs) the manual's job 「weekly-report（毎週月曜 09:00）」 waiting for 「受け取る」 (default) |
//          accepted = running, with ［止める］; the proposal that made it listed as approved
//   (manual=1) google=connected: 山田さん allowed 予定と議事録・受信を読む・Drive, not yet メールを送る; the company also offers
//          済んだメールを Gmail でもアーカイブする and the spreadsheet relay; one 「もう聞かない」 folder (chapters 28–29)
//   (manual=1) slack=connected: 山田さん allowed Slack (DMs and mentions, 「あなたの番」 by DM), not yet 返事を送る (chapter 28)
//   (manual=1) tab=ownkeys: Gemini, which members may bring their own key for, with none yet (chapter 28)
//   (manual=1) tab=absences: 山田さん has no absence yet; adding one keeps it and answers that 高橋さん cannot read
//          one waiting item (chapter 42)
//   closed 1 = start with the settings closed: a 「設定を開く」 button (always there) opens them (Esc closes, focus returns)
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { useAppStore } from '../src/stores/appStore'
import { SettingsPanel } from '../src/features/settings/components/SettingsPanel'
import { FileTreePanel } from '../src/features/files/components/FileTreePanel'
import { dispatchFileChanges } from '../src/shared/lib/fileEvents'
import { MANUAL_JOB_CANDIDATE, MANUAL_JOB_DEFINITION, MANUAL_JOB_FINGERPRINT } from './ui/fixtures/manual-job'

const params = new URLSearchParams(location.search)
const view = params.get('view') ?? 'settings'
const theme = params.get('theme') ?? 'light'
const state = params.get('state') ?? 'normal'
const role = params.get('role') ?? 'owner'
const tab = params.get('tab') ?? 'sync'
// 自分の設定: the member's two switches as the server would answer them.
const policy = { readIncoming: params.get('company') !== 'off' && params.get('company') !== 'later', autoRun: true }
let stoppedLater = params.get('company') === 'later'
const chosen: Record<string, boolean | null> = { readIncoming: null, autoRun: null }
const switchState = (k: 'readIncoming' | 'autoRun', def: boolean) => ({ on: policy[k] && (chosen[k] ?? def), allowed: policy[k] || (k === 'readIncoming' && stoppedLater), companyDefault: def, chosen: chosen[k] })
const mySwitches = () => ({ readIncoming: { ...switchState('readIncoming', false), connected: { mail: params.get('mail') !== 'no', chat: false } }, autoRun: switchState('autoRun', true),
  ...(params.get('channels') === 'none' ? { channels: { mail: false, chat: false } } : {}) })
const switchesSet: string[] = []
let repeatAskOn = true
if (theme === 'dark') document.documentElement.classList.add('dark')

const ROOT = '/Users/demo/会社'
const MANUAL = params.get('manual') === '1'
const COMPANY_NAME = MANUAL ? '検証A社' : '株式会社デモ'
const GB = 1024 ** 3
const MB = 1024 ** 2

// The company: department → sub-folders with sizes (bytes).
const TREE: Record<string, number> = MANUAL ? {
  '営業部/提案書': 86 * MB,
  '営業部/下書き': 4 * MB,
  '営業部/過去資料': 2.3 * GB,
  '総務部/規程': 12 * MB,
  '総務部/申請書': 26 * MB,
  '.claude/skills': 1 * MB,
} : {
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
// ?manual=1: the job the manual's 山田さん proposed (chapter 26), waiting for 「受け取る」 or running.
const JOB_ID = `job.${'1'.repeat(32)}`
const jobAccepted = params.get('jobs') === 'accepted'
const manualJobs = () => [{
  id: JOB_ID, name: MANUAL_JOB_DEFINITION.name, state: 'active' as const, waiting: jobAccepted ? null : 'NOT_ACCEPTED' as const, pausedReason: null,
  trigger: MANUAL_JOB_DEFINITION.trigger, placement: MANUAL_JOB_DEFINITION.placement, nextSlot: jobAccepted ? '2026-11-23T09:00' : null,
  toAccept: jobAccepted ? null : { version: 1, fingerprint: MANUAL_JOB_FINGERPRINT, definition: MANUAL_JOB_DEFINITION, why: 'accept' as const },
  deliverTo: null, controls: true, chainStopped: null, approvedVersion: 1,
}]
// ?manual=1&tab=absences: 山田さん's absences (none until he adds one).
let manualAbsences: Array<{ id: string; userId: string; from: string; until: string; delegateId: string; delegateName: string; active: boolean; setBy: string; setAt: string }> = []
const sizeUnder =(p: string) => Object.entries(TREE).filter(([k]) => k === p || k.startsWith(`${p}/`)).reduce((n, [, v]) => n + v, 0)
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

// ?manual=1&google=connected: 設定 →「Google」 after 山田さん allowed it (chapters 28–29).
const MANUAL_GOOGLE = MANUAL && params.get('google') === 'connected' ? {
  available: true, reason: null, connected: true, status: 'active', googleEmail: 'yamada@kensho-a.example', features: ['minutes', 'inbox', 'drive'], featuresOff: [],
  domain: 'kensho-a.example', practice: false, companyFeatures: ['minutes', 'mail', 'inbox', 'drive'], seen: ['minutes', 'mail', 'inbox', 'drive'], offeredByName: ['inbox_archive', 'sheets'],
} : null

let excluded = MANUAL ? ['営業部/過去資料'] : ['営業部', 'コンテンツ/動画/2025年度']
// The company .env on this computer (status only) and the member's own-key view on the server.
const envVars: Record<string, { set: boolean; last4?: string }> = { ANTHROPIC_API_KEY: { set: true, last4: 'ab12' } }
const ownKeys = {
  enabled: true,
  memberKeysAllowed: true,
  services: MANUAL && params.get('tab') === 'ownkeys' ? [
    { service: 'gemini', label: 'Google Gemini', category: 'tool', rule: 'company-first', ownKey: { allowed: true, hosts: ['generativelanguage.googleapis.com'] }, companyKeys: [], key: null },
  ] : [
    { service: 'anthropic', label: 'Anthropic（Claude API）', category: 'tool', rule: 'company-first', ownKey: { allowed: true, hosts: ['api.anthropic.com'] }, companyKeys: [], key: null },
    // `?ownkey=stopped`: an own key an admin stopped (a person stopped it: the grey 「止めています」 badge).
    ...(params.get('ownkey') === 'stopped' ? [{ service: 'gemini', label: 'Gemini', category: 'tool', rule: 'company-first', ownKey: { allowed: true, hosts: ['generativelanguage.googleapis.com'] }, companyKeys: [], key: { id: 'k-own', displayName: '自分の鍵', last4: 'zz99', hosts: ['generativelanguage.googleapis.com'], status: 'disabled', secretUpdatedAt: '2026-11-01T00:00:00.000Z' } }] : []),
  ],
}
const progressListeners = new Set<(d: { repoPath: string; receivedBytes: number }) => void>()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const DEPARTMENTS = MANUAL ? [
  { id: 'd_sales', name: '営業部', folder: '営業部', icon: 'folder', color: '#0ea5e9', sortOrder: 0, isActive: true },
  { id: 'd_ga', name: '総務部', folder: '総務部', icon: 'folder', color: '#f59e0b', sortOrder: 1, isActive: true },
] : [
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
// Simulate a file the AI writes: __acbAddFile('コンテンツ/記事', 'new.md') adds it to the
// fake disk and delivers the watcher event, as the main process would.
Object.assign(window, {
  __acbAddFile: (dirRel: string, name: string) => {
    const dir = `${ROOT}/${dirRel}`
    ;(DISK[dir] ??= []).push({ name, isDirectory: false })
    dispatchFileChanges([{ type: 'add', path: `${dir}/${name}` }])
  },
})
type TreeNode = { name: string; isDirectory: boolean; path: string; children?: TreeNode[] }
const tree = (dir: string, depth: number, max: number): TreeNode[] =>
  listDir(dir).map(e => (e.isDirectory && depth < max ? { ...e, children: tree(e.path, depth + 1, max) } : e))

Object.assign(window, {
  electronAPI: {
    gitBinaryStatus: async () => ({ bundled: true, binary: 'bundled' }),
    // 「ブラウザ操作」: `?browser=1` gives the member one site (else the company has it off); `?browser=clearFails` fails 「ログインを消す」.
    getBrowserSites: async () => ({ sites: params.get('browser') ? [{ host: 'manager.example.net' }] : [] }),
    onBrowserChanged: () => () => {},
    openBrowserSite: async (_companyId: string, host: string) => { (window as unknown as { browserOpened: string[] }).browserOpened = [...((window as unknown as { browserOpened?: string[] }).browserOpened ?? []), host]; return { ok: true } },
    clearBrowserLogin: async () => (params.get('browser') === 'clearFails' ? { ok: false, message: 'ログインを消せませんでした。もう一度お試しください。' } : { ok: true }),
    // 自分の設定 → 「Google で許可する」 opens the Google section: offline here, it says so (?google=ready: not allowed yet).
    getGoogleStatus: async () => (params.get('google') === 'ready'
      ? { success: true, data: { available: true, reason: null, connected: false, status: null, googleEmail: null, features: [], featuresOff: [], domain: 'kensho-a.example', practice: false, companyFeatures: ['minutes', 'mail'], seen: [] } }
      : { success: false, offline: true, error: 'サーバーにつながりませんでした。' }),
    ...(MANUAL_GOOGLE ? { getGoogleStatus: async () => ({ success: true, data: MANUAL_GOOGLE }) } : {}),
    // ?google=ready: the company offers no spreadsheet relay (its card stays hidden); ?manual=1&google=connected: offered, not allowed yet.
    getGoogleRelay: async () => ({ success: true, data: { available: true, reason: null, services: MANUAL_GOOGLE ? [{ service: 'sheets', offered: true, allowed: false, turnedOff: false }] : [], stopped: null, capPerDay: MANUAL_GOOGLE ? 500 : 0, usedToday: 0, records: [] } }),
    getDriveTrustedFolders: async () => ({ success: true, folders: MANUAL_GOOGLE ? [{ folderId: 'f-manual-1', folderName: 'A社と共有', outsideDomains: ['a-sha.example'], createdAt: '2026-11-18T01:00:00.000Z' }] : [] }),
    ...(MANUAL && params.get('slack') === 'connected' ? {
      getSlackStatus: async () => ({ success: true, data: { available: true, reason: null, connected: true, status: 'active', features: ['read', 'notices'], featuresOff: [], practice: false, seen: ['read', 'notices'] } }),
    } : {}),
    getWorkSwitches: async () => ({ success: true, switches: mySwitches() }),
    // 「AI から定期の仕事を提案してもらう」: this PC's own setting (on).
    getJobRepeatAsk: async () => ({ success: true, on: repeatAskOn }),
    setJobRepeatAsk: async (_companyId: string, on: boolean) => { repeatAskOn = on; return { success: true, on } },
    setWorkSwitch: async (_companyId: string, which: 'readIncoming' | 'autoRun', on: boolean) => {
      switchesSet.push(`${which}:${on}`)
      ;(window as unknown as { __switchesSet: string[] }).__switchesSet = switchesSet
      if (on && !policy[which]) { stoppedLater = false; return { success: false, offline: false, code: 'WORK_SWITCH_COMPANY_OFF', error: '会社の設定で止まっています。管理者に確かめてください。' } }
      chosen[which] = on
      return { success: true, switches: mySwitches() }
    },
    getEnvStatus: async () => ({ success: true, vars: { ...envVars } }),
    // ?manual=1: settings →「不在と代わりの人」 (chapter 42), kept like the server would.
    ...(MANUAL ? {
      getAbsences: async () => ({ success: true, view: { userId: 'u-yamada', absences: [...manualAbsences], canEdit: true, covering: [], today: '2026-11-20' },
        members: [{ userId: 'u-yamada', name: '山田 太郎' }, { userId: 'u-takahashi', name: '高橋 健一' }, { userId: 'u-sato', name: '佐藤 花子' }] }),
      addAbsence: async (_companyId: string, input: { from: string; until: string; delegateId: string }) => {
        const absence = { id: `ab-${manualAbsences.length + 1}`, userId: 'u-yamada', from: input.from, until: input.until, delegateId: input.delegateId,
          delegateName: input.delegateId === 'u-sato' ? '佐藤 花子' : '高橋 健一', active: false, setBy: 'u-yamada', setAt: '2026-11-20T01:00:00.000Z' }
        manualAbsences.push(absence)
        return { success: true, created: { absence, delegateCannotRead: 1 } }
      },
      removeAbsence: async (_companyId: string, id: string) => { manualAbsences = manualAbsences.filter(a => a.id !== id); return { success: true } },
    } : {}),
    // ?manual=1: settings →「定期の仕事」 (chapter 26).
    ...(MANUAL ? {
      getMyJobs: async () => ({ success: true, jobs: manualJobs() }),
      getMyJobProposals: async () => ({ success: true, supported: true, proposals: [{
        id: `jp.${'b'.repeat(32)}`, jobId: JOB_ID, proposerId: 'u-yamada', candidateId: MANUAL_JOB_CANDIDATE, submittedVersion: 1, submittedFingerprint: MANUAL_JOB_FINGERPRINT,
        state: 'approved', returnReason: null, decidedBy: 'u-sato', decidedAt: '2026-11-19T06:00:00.000Z', createdAt: '2026-11-18T06:00:00.000Z',
      }] }),
      getMyJobOccurrences: async () => ({ success: true, supported: true, occurrences: [] }),
      acceptJob: async () => ({ success: true }),
      pauseJob: async () => ({ success: true }),
    } : {}),
    listOwnBrokerKeys: async () => ({ success: true, data: ownKeys }),
    // Main reads the value, sends it and removes it from the .env once the server kept it.
    moveEnvKeyToServer: async (_companyId: string, _root: string, name: string) => {
      ;((window as unknown as { __acbMoved: unknown[] }).__acbMoved ??= []).push(name)
      delete envVars[name]
      return { success: true, removed: true, data: { ...ownKeys, check: { service: 'anthropic', result: 'valid' } } }
    },
    // The member's role in the company (the settings page asks it before offering the .gitignore editor).
    getCompanies: async () => {
      ;(window as unknown as { __acbRoleAnswered: boolean }).__acbRoleAnswered = true
      return { success: true, data: [{ id: 'demo', name: COMPANY_NAME, slug: 'demo', ownerId: 'u1', repoPath: null, role, createdAt: '', updatedAt: '' }] }
    },
    readFile: async () => '.backups/\n.env*\nnode_modules/\n',
    writeFile: async (p: string, content: string) => {
      ;((window as unknown as { __acbWrites: unknown[] }).__acbWrites ??= []).push([p, content])
      return true
    },
    updateEnv: async (_root: string, changes: Record<string, string | null>) => {
      ;((window as unknown as { __acbEnvUpdates: unknown[] }).__acbEnvUpdates ??= []).push(changes)
      return { success: true }
    },
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
      // What git checks out: the downloaded folders appear on the fake disk.
      for (const rel of downloading) {
        const dir = `${ROOT}/${rel.slice(0, rel.lastIndexOf('/'))}`
        const name = rel.slice(rel.lastIndexOf('/') + 1)
        if (rel.includes('/') && DISK[dir] && !DISK[dir].some(e => e.name === name)) DISK[dir].push({ name, isDirectory: true })
      }
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
    watchCompany: async () => ({ success: true }),
    unwatchCompany: async () => ({ success: true }),
    onFileChange: () => () => {},
    onFileChanges: () => () => {},
    getStats: async () => { throw new Error('not found') },
  },
})

useAppStore.setState({ currentCompany: { id: 'demo', name: COMPANY_NAME, rootPath: ROOT, departments: [], createdAt: new Date() } })

function Preview() {
  const [settingsOpen, setSettingsOpen] = useState(params.get('closed') !== '1')
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
      {params.get('closed') === '1' && <button type="button" className="m-6" onClick={() => setSettingsOpen(true)}>設定を開く</button>}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} initialTab={tab as never} />}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
