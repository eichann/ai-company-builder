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
//   tasks     1 = records on with a task list: the やること tab shows (tests/ui/tasks-layout.spec.ts)
//   check     1 = (with tasks=1) each row offers its ☑ 完了にする, and the opened task's card its ［完了にする］;
//             the press is recorded (actOnTask)
//   plugin    1 = one business plugin with a left tab (番組): five tabs in the strip
//   kind      none = the company has no shared company folder (folderKind none: a working folder on this PC)
//   personal  1 = (with tasks=1) the opened task is one only the member sees (its card offers 新しいファイル)
//   (a プロジェクト `project-aaaaaa1` whose 責任者 is the member opens in the record card with ［終える］, recorded as actOnTask)
//   features  (「使う機能」) listoff = the task list turned off: 「確かめること」 with an approval, an AI-prepared task,
//             a decision to confirm, an arrived meeting and today's meeting; listoff,meetingsoff = 会議 off too
//   companies 1 | 2 = the member's companies from the server (株式会社デモ, then 別会社); absent = the list cannot be read
//   sync      manual = 「サーバーと同期」 runs until window.__acbLayout.finishSync()
//   bottom    1 = a sample in the bottom panel instead of the inbox; absent = the inbox when main has one (see inbox)
//   inbox     1 = records on with one approval waiting and one notice: the real inbox (I1) in the bottom panel
//   manual    1 = the user manual's fictional company (client/tests/manual/scenes.ts): 検証A社 (other: 検証B社),
//             山田 太郎 in 営業部 (訪問メモ, 提案書, 下書き), 総務部 not downloaded, three Skills, and one
//             consultation (お礼メールの下書き) in 「AIへの相談」 with a chat server faked for reading it
//             (sending is not answered). The other parameters still apply. With manual=1 also:
//     result    what 「サーバーと同期」 answers: conflict (a file both changed: the server's version kept,
//               this PC's in the backups) | offline (the send failed) | denied (a file in 総務部, which
//               this member only reads: sync stopped) | restored (that file put back, the rest sent);
//               absent = 同期が完了しました. 「変更を確認」 lists two changes, 「バックアップ履歴」 two backups.
//     chat      live = a new consultation whose sent messages get a fixed reply chosen by their words
//               (the manual's chapters 6–9: reading and writing files, an extra instruction while
//               the AI works, a choice question, a command to confirm, a refused write, a review
//               request, a Skill; chapters 18 and 26: a やること the AI makes, the time-job question and its
//               proposal card), and three earlier consultations in the list
//     tasks     manual = (instead of tasks=1) 山田さん's やること (chapter 17): the tab, today's meeting and the
//               title bar's ［受け箱］ with what waits for him
//     folders   marks = 総務部 downloaded (閲覧のみ), 営業部/過去資料 not downloaded and the private
//               folder 営業部/提案前メモ this member reads; other = the same for someone who does not read it
//
// 今日のフォルダ: the member belongs to 開発部 (not downloaded) and 営業部, so it is in 営業部;
// `createDirectory` makes folders on the fake disk (recorded).
//
// Departments: 営業部 (downloaded), 開発部 (not downloaded on this computer),
// 総務 (read-only for this member). window.__acbLayout lets the Playwright UI
// tests (tests/ui/skill-layout.spec.ts) act as the AI / a teammate and see
// which calls the screen made.
import { createRoot } from 'react-dom/client'
import { markAgentLogNoticeSeen } from '../src/shared/lib/agentLogNotice'
import '../src/i18n'
import '../src/index.css'
import { useAppStore } from '../src/stores/appStore'
import { useAuthStore } from '../src/stores/authStore'
import { AppShell } from '../src/app/AppShell'
import { emitter, installElectronAPI, type ElectronAPI } from './ui/fixtures/electron-api'
import type { AgentInteractionRequest } from '../shared/agent-interaction'
import type { ToolApprovalRequest } from '../shared/ipc-contract'
import { parseChoiceQuestions } from '../shared/choice-prompt'
import { REVIEW_PART_TYPE } from '../shared/review-request'
import { STEER_PART_TYPE } from '../shared/steer'
import { readOnlyMessage } from '../shared/write-access'
import { JOB_PROPOSAL_PART_TYPE } from '../shared/job-proposals'
import { MANUAL_JOB_CANDIDATE, MANUAL_JOB_DEFINITION, MANUAL_JOB_FINGERPRINT } from './ui/fixtures/manual-job'
import { builtinToolDisplay } from '../shared/tool-display'

const params = new URLSearchParams(location.search)
// A sample for the bottom panel's frame (B2) in place of the inbox (I1), which needs records on (?inbox=1).
const BOTTOM_PANEL = params.get('bottom') === '1'
  ? { title: '受け箱', body: <p className="p-3 text-small text-text-muted">見本の中身です。</p> }
  : undefined
const featuresParam = (params.get('features') ?? '').split(',')
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const downloadOffline = params.get('download') === 'offline'
try {
  if (params.get('keep') !== '1') localStorage.clear()
  for (const [key, value] of Object.entries(JSON.parse(params.get('seed') ?? '{}') as Record<string, string>)) localStorage.setItem(key, value)
} catch { /* preview only */ }
// The one-time AI action log notice only with ?notice=1 (it would cover the chat in the other specs).
if (params.get('notice') !== '1') markAgentLogNoticeSeen('u_me')

const MANUAL = params.get('manual') === '1'
// ?manual=1&chat=live: 「AIへの相談」 answers what the member sends with a fixed reply (liveChat below).
const LIVE = MANUAL && params.get('chat') === 'live'
const ROOT = MANUAL ? '/Users/yamada/AI Company Builder/検証A社' : '/Users/demo/会社'
const COMPANY = 'demo'
// A second company (with no departments of its own on disk) for per-company state.
const OTHER_ROOT = MANUAL ? '/Users/yamada/AI Company Builder/検証B社' : '/Users/demo/別会社'
const COMPANIES: Record<string, { name: string; rootPath: string; folderKind?: 'none' }> = {
  [COMPANY]: { name: MANUAL ? '検証A社' : '株式会社デモ', rootPath: ROOT, ...(params.get('kind') === 'none' ? { folderKind: 'none' as const } : {}) },
  other: { name: MANUAL ? '検証B社' : '別会社', rootPath: OTHER_ROOT },
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Entry = { name: string; isDirectory: boolean }
const dir = (name: string): Entry => ({ name, isDirectory: true })
const file = (name: string): Entry => ({ name, isDirectory: false })
// ?manual=1: what the manual's pictures show (fictional; manual/README.md).
const MANUAL_DISK: Record<string, Entry[]> = {
  [ROOT]: [dir('営業部'), file('はじめに.md')],
  [`${ROOT}/営業部`]: [dir('下書き'), dir('提案書'), file('営業の進め方.md'), file('訪問メモ_1120.md'), file('訪問メモ_1123.md')],
  [`${ROOT}/営業部/下書き`]: [file('お礼メール_A社.md')],
  [`${ROOT}/営業部/提案書`]: [file('提案書_A社向け.md'), file('提案書_B社向け.md')],
  [OTHER_ROOT]: [file('議事録.md')],
}
const MANUAL_FILES: Record<string, string> = {
  [`${ROOT}/はじめに.md`]: '# 検証A社の共有フォルダ\n\n部署ごとのフォルダに、仕事のファイルを置きます。',
  [`${ROOT}/営業部/営業の進め方.md`]: '# 営業の進め方\n\n毎週月曜の朝会で、今週の訪問先を共有します。',
  [`${ROOT}/営業部/訪問メモ_1120.md`]: '# 訪問メモ 11/20 B社\n\n- 担当：山田\n- 来年度の研修の相談を受けた',
  [`${ROOT}/営業部/訪問メモ_1123.md`]: [
    '# 訪問メモ 11/23 A社',
    '',
    '- 担当：山田',
    '- 先方：購買部の田村さん',
    '- 提案書の内容におおむね賛成',
    '- 見積を来週までに送る',
    '- 納期は3月末を希望',
  ].join('\n'),
  [`${ROOT}/営業部/提案書/提案書_A社向け.md`]: [
    '# A社向け 提案書',
    '',
    '## ねらい',
    '',
    '受発注の手作業を減らし、商談の時間を増やします。',
    '',
    '## 進め方',
    '',
    '1. 今の手順を一緒に書き出す（12月）',
    '2. 試しに一部の部署で使う（1月）',
    '3. 全社で使い始める（3月）',
  ].join('\n'),
  [`${ROOT}/営業部/提案書/提案書_B社向け.md`]: '# B社向け 提案書\n\n研修の進め方の案です。',
  [`${ROOT}/営業部/下書き/お礼メール_A社.md`]: '# A社 田村様へのお礼（下書き）\n\n田村様\n\n本日はお時間をいただき、ありがとうございました。',
  [`${OTHER_ROOT}/議事録.md`]: '# 議事録\n\n検証B社の定例。',
}
const DISK: Record<string, Entry[]> = MANUAL ? MANUAL_DISK : {
  [ROOT]: [{ name: '営業部', isDirectory: true }, { name: '総務', isDirectory: true }, { name: 'README.md', isDirectory: false }],
  [`${ROOT}/営業部`]: [{ name: '提案書', isDirectory: true }, { name: '顧客', isDirectory: true }, { name: '営業の進め方.md', isDirectory: false }, { name: '売上表.md', isDirectory: false }],
  [`${ROOT}/営業部/提案書`]: [{ name: 'A社_提案.md', isDirectory: false }, { name: 'B社_提案.md', isDirectory: false }],
  [`${ROOT}/営業部/顧客`]: [{ name: '一覧.csv', isDirectory: false }],
  [`${ROOT}/総務`]: [{ name: '規程', isDirectory: true }, { name: '備品.md', isDirectory: false }],
  [`${ROOT}/総務/規程`]: [{ name: '就業規則.md', isDirectory: false }],
  [OTHER_ROOT]: [{ name: '議事録.md', isDirectory: false }],
}
const FILES: Record<string, string> = MANUAL ? MANUAL_FILES : {
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

const DEPARTMENTS = (MANUAL ? [
  { id: 'd_sales', name: '営業部', folder: '営業部', color: '#0ea5e9' },
  { id: 'd_ga', name: '総務部', folder: '総務部', color: '#f59e0b' },
] : [
  { id: 'd_sales', name: '営業部', folder: '営業部', color: '#0ea5e9' },
  { id: 'd_dev', name: '開発部', folder: '開発部', color: '#22c55e' },
  { id: 'd_ga', name: '総務', folder: '総務', color: '#f59e0b' },
]).map((d, i) => ({ ...d, companyId: COMPANY, parentId: null, nameEn: null, icon: 'folder', description: null, sortOrder: i, isActive: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }))

let excluded = [MANUAL ? '総務部' : '開発部']
/** The file a department brings when it is downloaded (sparseSetExclusions). */
const DOWNLOADED_FILE = MANUAL ? '申請書のひな形.md' : '設計.md'

const skill = (folder: string, name: string, description: string) => ({
  id: `${folder}:${name}`, name, description, departmentId: DEPARTMENTS.find(d => d.folder === folder)?.id ?? 'company',
  skillPath: `${ROOT}/${folder}/.claude/skills/${name}`, files: { skillMd: 'SKILL.md' },
})
const SHELF_VERSION = 'abcd1234'.repeat(8)
/** ?kind=none: weekly-report came from the company; release-note is the member's own beside a company one. */
const SHELF_MARKS: Record<string, { state: 'company' | 'clash' | 'editing'; version: string; newer?: { version: string; at: string } }> = {
  'weekly-report': { state: 'company', version: SHELF_VERSION },
  'release-note': {
    state: params.get('shelf') === 'editing' ? 'editing' : 'clash', version: SHELF_VERSION,
    // ?newer=1: the company handed out a newer version since the member started (「会社の版が新しくなっています」).
    ...(params.get('newer') === '1' ? { newer: { version: 'ef567890'.repeat(8), at: new Date(2026, 10, 9, 14, 5).toISOString() } } : {}),
  },
}
/** ?outputs=1: what main finds in the Skill that looks like outputs. */
const SHELF_OUTPUTS = ['output/A社への提案書.md', '見積.xlsx']
/** ?request=pending|declined: the member's latest request to publish (「会社に出してほしいと頼む」). */
const SHELF_REQUEST_LAST = params.get('request') === 'pending'
  ? { name: 'x', departmentFolder: null, state: 'pending' as const, requestedAt: new Date(2026, 10, 9, 9, 30).toISOString(), decidedAt: null, reason: null }
  : params.get('request') === 'declined'
    ? { name: 'x', departmentFolder: null, state: 'declined' as const, requestedAt: new Date(2026, 10, 8, 9, 30).toISOString(), decidedAt: new Date(2026, 10, 9, 10, 0).toISOString(), reason: 'いまは使わないため' }
    : undefined
const SKILLS: Record<string, ReturnType<typeof skill>[]> = MANUAL ? {
  '': [skill('', 'thank-you-mail', '訪問のあとのお礼メールを下書きする'), skill('', 'minutes-summary', '会議のメモを議事録にまとめる')],
  営業部: [skill('営業部', 'proposal-outline', '提案書の骨子を作る')],
  総務部: [],
} : {
  '': [skill('', 'weekly-report', '週報をまとめる')],
  営業部: [skill('営業部', 'proposal', '提案書のたたき台を作る')],
  開発部: [skill('開発部', 'release-note', 'リリースノートを書く')],
  総務: [],
}

const COMMITS = MANUAL ? [
  { hash: 'c2'.padEnd(40, '0'), hashShort: 'c2000000', message: '提案書の進め方を直しました', author: '山田 太郎', date: '2026-11-19T17:40:00+09:00' },
  { hash: 'c1'.padEnd(40, '0'), hashShort: 'c1000000', message: '提案書を追加しました', author: '佐藤 花子', date: '2026-11-18T09:10:00+09:00' },
] : [
  { hash: 'c2'.padEnd(40, '0'), hashShort: 'c2000000', message: '提案書を更新', author: '田中 太郎', date: '2026-10-22T09:00:00+09:00' },
  { hash: 'c1'.padEnd(40, '0'), hashShort: 'c1000000', message: '顧客一覧を追加', author: '山田 花子', date: '2026-10-21T09:00:00+09:00' },
]

const RECORD_TASK = { id: 'task-aaaaaa1', type: 'task', typeLabel: 'タスク', kind: 'task' as const, thing: 'task' as const, title: 'A社 提案書を仕上げる', summary: '', stateLabel: '進めている', updatedAt: '2026-10-30T10:00:00Z' }
const RECORD_PROJECT = { id: 'project-aaaaaa1', type: 'project', typeLabel: 'プロジェクト', kind: 'bundle' as const, thing: 'bundle' as const, title: '新人研修の見直し', summary: '', stateLabel: '進めている', updatedAt: '2026-10-30T10:00:00Z' }
const RECORD_DECISION = { id: 'decision-bbbbbb1', type: 'decision', typeLabel: '決めたこと', kind: 'decision' as const, thing: 'decision' as const, title: 'A社には150万円で出す', summary: '', stateLabel: '確かめた', updatedAt: '2026-10-30T10:00:00Z' }

// ?manual=1&tasks=manual: 山田さん's やること (chapter 17; the list's own page has more of them).
const taskItem = (id: string, title: string, turn: 'mine' | 'acceptance' | 'ai' | 'others', extra: Record<string, unknown> = {}) => ({
  id, type: 'task', typeLabel: 'やること', title, turn, state: 'todo', version: 1, due: null as string | null, tags: [] as string[], waitingFor: null as string | null,
  personal: false, own: false, actingFor: null, bundle: null as { id: string; title: string; typeLabel?: string } | null, finishedAt: null, stateLabel: null, ...extra,
})
const MANUAL_TASK_ITEMS = (() => {
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const project = { id: 'project-a00001', title: 'A社 研修導入', typeLabel: 'プロジェクト' }
  return [
    taskItem('task-macc01', 'セキュリティのチェックシートを埋める', 'acceptance', { state: 'awaiting_acceptance', due: '2026-11-25' }),
    taskItem('task-mmine1', 'お礼メールを確かめて送る', 'mine', { due: `${today}T17:00`, tags: ['営業'], bundle: project, check: { action: 'complete' } }),
    taskItem('task-mmine2', 'B社 訪問メモをまとめる', 'mine', { due: '2026-11-23T15:00', tags: ['営業'], own: true, personal: true, check: { action: 'complete' } }),
    taskItem('task-mai001', 'C社 日程の候補を探す', 'ai', { state: 'preparing' }),
    taskItem('task-mask01', 'セキュリティ資料を送る', 'others', { state: 'awaiting_acceptance', waitingFor: '高橋さんに頼んだ・引き受け待ち', askedOfOthers: true, bundle: project }),
  ]
})()
const fileChanges = emitter<Array<{ type: string; path: string }>>()
// A file link clicked in a consultation's own window, after main checked it.
const fileRequests = emitter<{ path: string }>()
// The consultation's AI changed the task (records:changed): its version and linked files grow.
const recordsChanged = emitter<{ companyId: string }>()
const openTasksClicks = emitter<{ companyId: string }>()
// The consultation AI running one of the app's commands here (shared/app-commands.ts), and the answers.
const appCommandRequests = emitter<{ requestId: string; companyId: string; commandId: string; args: unknown }>()
const appCommandAnswers = new Map<string, unknown>()
let taskVersion = 2
let taskFiles = ['営業部/提案書/A社_提案.md']
let cardReads = 0
let finishSync: (() => void) | null = null
const calls: Array<{ name: string; args: unknown[] }> = []
const record = (name: string, args: unknown[]) => { calls.push({ name, args }) }

const api: Partial<ElectronAPI> = {
  // 「使い方」: main would show the page in a view of its own; here it answers why not, so the pane shows it.
  openManual: async (pageId: string, anchor: string | null) => {
    record('openManual', [pageId, anchor])
    return { ok: false, message: `プレビューでは使い方を表示しません（${pageId}）` }
  },
  exportManual: async () => {
    record('exportManual', [])
    return { ok: true, folder: '/Users/member/Downloads/ACB の使い方' }
  },
  getDepartments: async () => ({ success: true, data: DEPARTMENTS }),
  sparseGetExclusions: async () => ({ success: true, enabled: excluded.length > 0, excluded: [...excluded] }) as never,
  sparseSetExclusions: async (_root: string, next: string[]) => {
    record('sparseSetExclusions', [next])
    await sleep(200)
    if (downloadOffline) return { success: false, offline: true, error: 'offline' } as never
    for (const folder of excluded.filter(e => !next.includes(e))) {
      DISK[ROOT].push({ name: folder, isDirectory: true })
      DISK[`${ROOT}/${folder}`] = [{ name: DOWNLOADED_FILE, isDirectory: false }]
      // The checkout writes the files; the company watcher reports them.
      fileChanges.emit([{ type: 'addDir', path: `${ROOT}/${folder}` }, { type: 'add', path: `${ROOT}/${folder}/${DOWNLOADED_FILE}` }])
    }
    excluded = [...next]
    return { success: true, enabled: next.length > 0, excluded: [...next] } as never
  },
  onSparseProgress: () => () => {},
  exists: async (path: string) => path === ROOT || path === OTHER_ROOT || path in DISK || path in FILES,
  // Opening a company registers its folder (the title bar's switch, features/company/reopen.ts).
  registerAllowedRoot: async (folder: string) => { record('registerAllowedRoot', [folder]); return { success: true } },
  // 「ブラウザ操作」 ships switched off: the real screen's inbox must never read the plans (agent-browser.md).
  listBrowserPlans: async (companyId: string) => { record('listBrowserPlans', [companyId]); return { ok: true, inbox: { plans: [], unsure: [] } } },
  getCompanies: async () => {
    record('getCompanies', [])
    const count = Number(params.get('companies'))
    if (!count) return undefined as never
    const info = (id: string) => ({ id, name: COMPANIES[id].name, role: 'member', slug: id, ownerId: 'u_owner', repoPath: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...(COMPANIES[id].folderKind ? { folderKind: COMPANIES[id].folderKind } : {}) })
    return { success: true, data: [COMPANY, 'other'].slice(0, count).map(info) }
  },
  getMyDepartments: async () => ({ success: true, departmentIds: MANUAL ? ['d_sales'] : ['d_dev', 'd_sales'] }),
  createDirectory: async (path: string) => {
    record('createDirectory', [path])
    // mkdir -p: every missing level appears in its parent.
    let dir = ROOT
    for (const name of path.slice(ROOT.length + 1).split('/')) {
      const next = `${dir}/${name}`
      if (!(next in DISK)) { (DISK[dir] ??= []).push({ name, isDirectory: true }); DISK[next] = [] }
      dir = next
    }
    return true
  },
  getStats: async () => { throw new Error('not found') },
  readDirectoryTree: async (dir: string, max?: number) => { record('readDirectoryTree', [dir]); return tree(dir, 0, max ?? 2) },
  readDirectory: async (dir: string) => { record('readDirectory', [dir]); return listDir(dir) },
  readFile: async (path: string) => FILES[path] ?? null,
  // Saving writes the fake disk (the editor's autosave, a tidy saving first).
  writeFile: async (path: string, content: string) => { record('writeFile', [path, content]); FILES[path] = content; return true },
  onAppCommandRequest: appCommandRequests.subscribe,
  answerAppCommand: async (requestId: string, answer: unknown) => { appCommandAnswers.set(requestId, answer) },
  // 探す ⌘K lists the company's files by name (company paths under the folder).
  gitListFiles: async (_root: string, folder: string) => ({ success: true, files: Object.keys(FILES).filter(p => p.startsWith(`${ROOT}/`)).map(p => p.slice(ROOT.length + 1)).filter(p => !folder || p.startsWith(`${folder}/`)) }),
  readFileBinary: async () => null,
  watchCompany: async () => ({ success: true }),
  unwatchCompany: async () => ({ success: true }),
  onFileChanges: fileChanges.subscribe,
  onFileRequestedFromChatWindow: fileRequests.subscribe,
  onFileChange: () => () => {},
  listSkills: async (_root: string, folder: string, _id: string, _name?: string, options?: { force?: boolean }) => {
    record('listSkills', [folder, !!options?.force])
    return { success: true, ...(params.get('kind') === 'none' ? { ruleClashes: ['tone'] } : {}), skills: (SKILLS[folder] ?? []).map(s => (params.get('kind') !== 'none' ? s : {
      ...s,
      ...(SHELF_MARKS[s.name] ? { shelf: SHELF_MARKS[s.name] } : {}),
      // ?publish=no: the server says this member may not publish a Skill here (so 頼む is offered on their own).
      shelfPublish: params.get('publish') !== 'no',
      ...(SHELF_MARKS[s.name]?.state === 'company' ? {} : { shelfRequest: { offered: params.get('publish') === 'no', ...(SHELF_REQUEST_LAST ? { last: SHELF_REQUEST_LAST } : {}) } }),
      // ?backup=1: 会社の版に戻す kept a copy of the company Skill.
      ...(SHELF_MARKS[s.name]?.state === 'company' && params.get('backup') === '1' ? { shelfBackup: true } : {}),
    })) }
  },
  getWriteAccess: async () => ({ version: 'v1', role: 'member', all: false, scopes: [{ path: '', write: true }, { path: MANUAL ? '総務部' : '総務', write: false }] }),
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
  gitCommitFileDiff: async () => ({ success: true, diff: '@@ -1 +1 @@\n-# 提案\n+# A社 提案\n' }),
  // Records (search, the record card, a file's 「つながっているもの」): what the server would answer.
  searchRecords: async (companyId: string, text: string) => {
    record('searchRecords', [companyId, text])
    return text === '提案'
      ? { success: true, available: true, total: 2, records: [RECORD_TASK, RECORD_DECISION] }
      : { success: true, available: true, total: 0, records: [] }
  },
  // The 探す tab's records: the same two, each with its department.
  findRecords: async (companyId: string, text: string) => {
    record('findRecords', [companyId, text])
    return text === '提案'
      ? { success: true, available: true, total: 2, hubs: [], hits: [
        { record: RECORD_TASK, department: '営業部', mine: true },
        { record: { ...RECORD_DECISION, summary: '提案の金額は150万円' }, department: '営業部', mine: false },
      ] }
      : { success: true, available: true, total: 0, hits: [], hubs: [] }
  },
  getRecordCard: async (_companyId: string, recordId: string) => recordId === RECORD_PROJECT.id
    ? { success: true, card: {
      record: RECORD_PROJECT, version: 2, fields: [], history: [], links: [],
      detail: { kind: 'bundle' as const, purpose: null, owner: null, groups: [], done: 0, total: 0, pendingApprovals: [], actions: {
        main: { action: 'finish', title: '終える', ends: true, noteRequired: false, noteOffered: false, args: [] },
        more: [{ action: 'cancel', title: 'やめる', ends: true, noteRequired: false, noteOffered: true, args: [] }], people: [],
      } },
    } }
    : recordId === RECORD_TASK.id
    ? { success: true, card: {
      record: RECORD_TASK,
      fields: [{ label: '担当', value: '田中 太郎' }, { label: '期限', value: '2026-11-05' }],
      history: [{ at: '2026-10-30T10:00:00+09:00', text: '山田 花子：作りました', ai: false }],
      links: [{ label: '関係するファイル', path: '営業部/提案書/A社_提案.md' }, { label: '決めたこと', record: RECORD_DECISION }],
    } }
    : { success: false, offline: false, notFound: true, error: '見つかりません。消されたか、見られないものです。' },
  // 「記録の一覧」 (features/records-table): the server's answer for やること, already what this member reads.
  getRecordsTablePage: async (_companyId, query) => ({ success: true, available: true, kinds: [{ name: 'task', label: 'やること' }], kind: 'task',
    columns: [{ field: 'assignee', label: '担当', kind: 'person', shown: true }], total: 1, offset: query.offset,
    rows: [{ id: RECORD_TASK.id, title: RECORD_TASK.title, stateLabel: '進めている', finished: false, updatedAt: RECORD_TASK.updatedAt, cells: { assignee: { text: '田中 太郎', sort: '田中 太郎' } } }] }),
  // A task opens in the task card (features/tasks): the same data, with nothing for this member to press.
  getTaskCard: async (_companyId: string, recordId: string) => recordId === RECORD_TASK.id
    ? (cardReads++, await sleep(120), { success: true, card: {
      record: { ...RECORD_TASK, state: 'in_progress', version: taskVersion, ...(params.get('personal') === '1' ? { personal: true } : {}) }, due: null, tags: [], purpose: null,
      fields: [{ label: '担当', value: '田中 太郎' }],
      roles: { assignee: false, requester: false, okGiver: false, reviewer: false }, names: { assignee: '田中 太郎', requester: null, reviewer: null }, reviewerId: null, assigneeId: 'u-tanaka', self: { id: 'u-me', name: null }, whenDone: null, bundle: null, canSetBundle: false, teamMode: false, origin: null, review: null, actions: params.get('check') === '1' ? [{ action: 'complete', title: '完了', noteRequired: false, args: [], needsOk: false, startFirst: false }] : [], canSetTags: false, okLine: null, prepSummary: null, prepared: [],
      files: taskFiles.map(path => ({ path })), localFiles: [], driveFiles: [],
      links: [{ label: '決めたこと', record: RECORD_DECISION }],
      history: [{ at: '2026-10-30T10:00:00+09:00', text: '山田 花子：作りました', ai: false }],
      runs: [], people: [], wait: null, holidays: [], fromIncoming: false,
    } })
    : { success: false, offline: false, notFound: true, error: '見つかりません。消されたか、見られないものです。' },
  getRecordsForFile: async (_companyId: string, companyPath: string) => {
    record('getRecordsForFile', [companyPath])
    return { success: true, available: true, total: companyPath === '営業部/提案書/A社_提案.md' ? 1 : 0, records: companyPath === '営業部/提案書/A社_提案.md' ? [RECORD_TASK] : [] }
  },
  gitSync: async () => {
    record('gitSync', [])
    if (params.get('sync') === 'manual') await new Promise<void>(resolve => { finishSync = resolve })
    else await sleep(150)
    COMMITS.unshift({ hash: 'c3'.padEnd(40, '0'), hashShort: 'c3000000', message: 'チームの変更を取り込み', author: '高橋 美咲', date: '2026-10-23T09:00:00+09:00' })
    return { success: true, message: '同期しました' }
  },
  // The chat panel on the right: no chat server in this preview.
  getChatServerInfo: async () => null,
  getClaudeCodeStatus: async () => ({ available: true, authenticated: true, cliPath: null, version: null, error: null, checkedAt: 0 }),
  getAuthMode: async () => 'claude-code',
  // ?consultations=1: one stored consultation in 「AIへの相談」 (探す ⌘K finds it by its title).
  getChatSessionSummaries: async () => params.get('consultations') === '1'
    ? [{ id: 's_estimate', companyId: COMPANY, title: '見積の相談', createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:30:00Z', messageCount: 2, sent: true, preview: '' }]
    : [],
  getAgentInteractions: async () => [],
  signOut: async () => { record('signOut', []); return { success: true } },
  // ?features=listoff: the task list turned off (「使う機能」): the small list 「確かめること」.
  getTaskList: async () => featuresParam.includes('listoff')
    ? { success: true, data: { available: true, listDepartmentIds: null, features: { taskList: false, meetings: !featuresParam.includes('meetingsoff'), inbox: true, decisions: true, projects: true },
      decisionsToConfirm: [{ id: 'decision-0000aa', title: '値引きは10%まで' }],
      items: [
        { id: 'approval-0000aa', type: 'approval', typeLabel: '承認のお願い', title: '金額の変更', turn: 'mine' as const, state: 'pending', version: 1, due: null, tags: [], waitingFor: null, personal: false, own: false, actingFor: null, bundle: null, finishedAt: null, stateLabel: null },
        { id: 'task-prep0001', type: 'task', typeLabel: 'やること', title: '見積の下書きを確かめる', turn: 'mine' as const, state: 'todo', version: 1, due: null, tags: [], waitingFor: null, personal: false, own: true, actingFor: null, bundle: null, finishedAt: null, stateLabel: null, aiPrepared: true as const },
        { id: 'task-plain001', type: 'task', typeLabel: 'やること', title: 'ふつうのやること', turn: 'mine' as const, state: 'todo', version: 1, due: null, tags: [], waitingFor: null, personal: false, own: true, actingFor: null, bundle: null, finishedAt: null, stateLabel: null },
      ] } }
    : MANUAL && params.get('tasks') === 'manual'
    ? { success: true, data: { available: true, listDepartmentIds: null, me: 'u_me',
      bundleKinds: { core: { type: 'project', name: 'プロジェクト', source: 'core' as const }, departments: [], kinds: [] },
      members: [{ id: 'u_me', name: '山田' }, { id: 'u_takahashi', name: '高橋' }, { id: 'u_sato', name: '佐藤' }],
      items: MANUAL_TASK_ITEMS } }
    : params.get('tasks') === '1'
    ? { success: true, data: { available: true, listDepartmentIds: null, items: Array.from({ length: 3 }, (_, i) => ({
      id: i === 0 ? RECORD_TASK.id : `task-row00${i}`, type: 'task', typeLabel: 'タスク', title: i === 0 ? RECORD_TASK.title : `やること ${i + 1}`, turn: 'mine' as const, state: 'todo', version: i === 0 ? taskVersion : 1, due: null,
      tags: [], waitingFor: null, personal: false, own: true, actingFor: null, bundle: null, finishedAt: null, stateLabel: null,
      ...(params.get('check') === '1' ? { check: { action: 'complete' as const } } : {}),
    })) } }
    : { success: true, data: { available: false, listDepartmentIds: null, items: [] } },
  // ?plugin=1: one plugin's left tab (its screen is not loaded here; only the tab strip is looked at).
  getPluginScreens: async () => ({ success: true, screens: params.get('plugin') === '1' ? [{
    plugin: { id: 'tv-program', version: '1.0.0' }, label: '番組づくり',
    tab: { label: '番組', icon: 'FilmSlate', entry: 'index.html' }, peek: null, recordSections: [], fileActions: [],
  }] : [] }) as never,
  // ?check=1: the ☑ on a row (the list reads again; this fake's list does not change).
  actOnTask: async (companyId: string, recordId: string, input: unknown) => {
    record('actOnTask', [companyId, recordId, input])
    return { success: true, recordId }
  },
  onPluginsChanged: () => () => {},
  // A company without the shared folder (?kind=none): ?shelf=refused = the server says no;
  // ?outputs=1 = the Skill holds what looks like outputs (main stops until 外して出す).
  publishSkillToCompany: async (_root: string, skillPath: string, expectedVersion: string | null, leaveOutOutputs: boolean) => {
    record('publishSkillToCompany', [skillPath.split('/').pop(), expectedVersion, leaveOutOutputs])
    if (params.get('outputs') === '1' && !leaveOutOutputs) return { success: false as const, outputs: SHELF_OUTPUTS }
    return params.get('shelf') === 'refused' ? { success: false as const, error: 'この Skill・指示を変えられるのは、決められた人だけです。' } : { success: true as const, ...(leaveOutOutputs ? { keptAside: 'all' as const } : {}) }
  },
  editCompanySkillLocally: async (_root: string, skillPath: string) => {
    record('editCompanySkillLocally', [skillPath.split('/').pop()])
    return { success: true }
  },
  // ?restore=later: the company's version was not received just now (offline).
  restoreCompanySkill: async (_root: string, skillPath: string) => {
    record('restoreCompanySkill', [skillPath.split('/').pop()])
    return { success: true as const, companyVersion: params.get('restore') === 'later' ? 'later' as const : 'back' as const }
  },
  requestCompanySkill: async (_root: string, skillPath: string, leaveOutOutputs: boolean) => {
    record('requestCompanySkill', [skillPath.split('/').pop(), leaveOutOutputs])
    if (params.get('outputs') === '1' && !leaveOutOutputs) return { success: false as const, outputs: SHELF_OUTPUTS }
    return { success: true as const, ...(leaveOutOutputs ? { keptAside: 'all' as const } : {}) }
  },
  openCompanySkillBackup: async (_root: string, skillPath: string) => {
    record('openCompanySkillBackup', [skillPath.split('/').pop()])
    return { success: true }
  },
  onSkillShelfChanged: () => () => {},
  onNotificationsChanged: () => () => {},
  onRecordsChanged: recordsChanged.subscribe,
  onNotificationsOpenTasks: openTasksClicks.subscribe,
  getCalendarToday: async () => ({ success: true, data: { date: '2026-11-02', timeZone: 'Asia/Tokyo', reason: null, events: featuresParam.includes('listoff')
    ? [{ id: 'ev1', title: '朝会', start: '2026-11-02T00:00:00Z', end: '2026-11-02T00:30:00Z', allDay: false, online: true, hasExternalAttendees: false, attendeeCount: 3 }] : [] } }) as never,
  // Answered even with 会議 off (the server would answer none): the screen must not show them by itself.
  getMeetingArrivals: async () => featuresParam.includes('listoff')
    ? { available: true, items: [{ recordId: 'meeting-0000cc', title: 'A社 定例', version: 2, meetingAt: '2026-11-02T01:00:00Z', status: 'arrived' as const, attendeeCount: 2, by: null, byYou: false, series: false, autoSeries: false, made: null }] }
    : { available: false, items: [] },
}
// ?manual=1&tasks=manual: the title bar's ［受け箱］ counts what waits for 山田さん (chapter 17).
if (MANUAL && params.get('tasks') === 'manual') {
  Object.assign(api, {
    watchNotifications: async () => {},
    onNotificationsChanged: () => () => {},
    getNotificationsState: async () => ({
      available: true,
      myTurn: { total: 3, items: MANUAL_TASK_ITEMS.filter(i => i.turn === 'mine' || i.turn === 'acceptance').map(i => ({ id: i.id, type: i.type, title: i.title, state: i.state, due: i.due })) },
      notices: { available: true, unread: 1, items: [{ id: 'n-1', kind: 'request_accepted', recordId: 'task-mask01', recordType: 'task', recordTitle: 'セキュリティ資料を送る', version: 2, text: '高橋さんが「セキュリティ資料を送る」を引き受けました', createdAt: new Date().toISOString(), read: false }] },
    }),
    getCalendarToday: async () => {
      const d = new Date()
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      return { success: true, data: { date: day, timeZone: 'Asia/Tokyo', reason: null, events: [
        { id: 'ev-m', title: 'A社 打ち合わせ', start: `${day}T14:00:00+09:00`, end: `${day}T15:00:00+09:00`, allDay: false, online: true, hasExternalAttendees: true, attendeeCount: 4 },
      ] } } as never
    },
  } satisfies Partial<ElectronAPI>)
}
// ?inbox=1: the real inbox (I1) from a turn and a notice main read (records on, no task list here).
if (params.get('inbox') === '1') {
  const notices = emitter<{ companyId: string }>()
  let read = false
  Object.assign(api, {
    watchNotifications: async () => {},
    onNotificationsChanged: notices.subscribe,
    getNotificationsState: async () => ({
      available: true,
      myTurn: { total: 1, items: [{ id: 'approval-0000aa', type: 'approval', title: '金額の変更', state: 'pending', due: null }] },
      notices: { available: true, unread: read ? 0 : 1, items: [{ id: 'n-1', kind: 'request_done', recordId: 'task-done0001', recordType: 'task', recordTitle: '見積書の確認', version: 2, text: '佐藤さんが「見積書の確認」を完了にしました', createdAt: new Date().toISOString(), read }] },
    }),
    markNotificationsRead: async (companyId: string) => {
      read = true
      record('markNotificationsRead', [companyId])
      setTimeout(() => notices.emit({ companyId }), 0)
      return { success: true }
    },
  } satisfies Partial<ElectronAPI>)
}
// ?manual=1&chat=live: what 「AIへの相談」 answers (the manual's chapters 6–9). A request opens a
// reply stream; its words choose the fixed reply (LIVE_REPLIES), which may stay open (the AI still
// working, a question or a confirmation waiting) until the picture is taken.
const liveQuestions = emitter<AgentInteractionRequest>()
const liveApprovals = emitter<ToolApprovalRequest>()
const LIVE_PAST = [
  { id: 'past-visit', title: '訪問メモの整理', minutesAgo: 60 * 26, preview: '今週の訪問メモを、会社ごとに1つの表にまとめました。' },
  { id: 'past-outline', title: 'B社 研修の提案の骨子', minutesAgo: 60 * 50, preview: '研修の提案の骨子を、ねらい・進め方・費用の順に作りました。' },
  { id: 'past-estimate', title: '見積の進め方の相談', minutesAgo: 60 * 75, preview: '見積は、前回の単価をもとに、数量だけ変えるのがよさそうです。' },
].map(p => {
  const at = new Date(Date.now() - p.minutesAgo * 60_000).toISOString()
  return { id: p.id, companyId: COMPANY, title: p.title, createdAt: at, updatedAt: at, messageCount: 4, sent: true, preview: p.preview }
})
type LiveStep = { chunk: unknown } | { wait: number } | { write: string } | { ask: unknown[] } | { approve: ToolApprovalRequest['toolInput'] } | { end: true }
// The Skill line the real stream carries (shared/tool-display.ts), so the manual's picture cannot drift from it.
const SKILL_LINE = builtinToolDisplay('Skill')!
// What main puts on a tool call (its plain-Japanese line with a company-relative path).
const line = (label: string, running: string, detail: string) => ({ acb: { display: { label, running, many: `${label}（{n} 回）`, detail } } })
const READ = (id: string, path: string): LiveStep[] => [
  { chunk: { type: 'tool-input-available', toolCallId: id, toolName: 'Read', dynamic: true, providerExecuted: true, input: { file_path: `${ROOT}/${path}` }, providerMetadata: line('ファイルを読みました', 'ファイルを読んでいます', path) } },
  { wait: 80 },
  { chunk: { type: 'tool-output-available', toolCallId: id, dynamic: true, providerExecuted: true, output: 'ok' } },
]
const WRITE = (id: string, path: string): LiveStep[] => [
  { chunk: { type: 'tool-input-available', toolCallId: id, toolName: 'Write', dynamic: true, providerExecuted: true, input: { file_path: `${ROOT}/${path}` }, providerMetadata: line('ファイルに書きました', 'ファイルに書いています', path) } },
  { wait: 80 },
  { write: path },
  { chunk: { type: 'tool-output-available', toolCallId: id, dynamic: true, providerExecuted: true, output: 'ok' } },
]
const SAY = (id: string, text: string): LiveStep[] => [
  { chunk: { type: 'text-start', id } }, { chunk: { type: 'text-delta', id, delta: text } }, { chunk: { type: 'text-end', id } },
]
const THANKS = '営業部/下書き/お礼メール_A社.md'
/** What the AI's files hold once written. */
const LIVE_WRITTEN: Record<string, string> = {
  [THANKS]: [
    '件名：本日のお打ち合わせのお礼',
    '',
    'A社 購買部',
    '田村様',
    '',
    '本日はお忙しいところ、お時間をいただきありがとうございました。',
    'ご提案の内容におおむねご賛同いただき、大変うれしく思います。',
    '',
    'お話しいただいたとおり、見積を来週までにお送りいたします。',
    '3月末の納期に間に合うよう、進め方もあわせてご相談させてください。',
    '',
    '引き続きどうぞよろしくお願いいたします。',
    '',
    '検証A社 営業部',
    '山田 太郎',
  ].join('\n'),
  '営業部/提案書/提案書_A社向け_骨子.md': '# A社向け 提案書（骨子）\n\n## ねらい\n\n## 進め方\n\n## 費用\n',
}
const MEMO = '営業部/訪問メモ_1123.md'
const LIVE_REPLIES: Array<{ when: RegExp; steps: LiveStep[] }> = [
  // A やること the AI makes (chapter 18): the record tool's line and what the tool told it to say.
  { when: /やることに入れて/, steps: [
    { chunk: { type: 'tool-input-available', toolCallId: 'c1', toolName: 'mcp__acb_records__records_create', dynamic: true, providerExecuted: true, input: { type: 'task', title: '見積を直す' }, providerMetadata: line('記録を作りました', '記録を作っています', 'タスク「見積を直す」') } },
    { wait: 80 },
    { chunk: { type: 'tool-output-available', toolCallId: 'c1', dynamic: true, providerExecuted: true, output: 'ok' } },
    ...SAY('t1', '「見積を直す」を、あなただけに見えるやることに入れました（期限：11/23（月）15:00）。部署に出すときは、やることのカードの［部署に出す］から出してください。'),
    { end: true },
  ] },
  // The third day with the same Skill (chapter 26): the work, then the one question about a time job.
  { when: /^\/weekly-report/, steps: [
    { chunk: { type: 'tool-input-available', toolCallId: 's1', toolName: 'Skill', dynamic: true, providerExecuted: true, input: { skill: 'weekly-report' }, providerMetadata: line('スキルを使いました', 'スキルを使っています', 'weekly-report') } },
    { chunk: { type: 'tool-output-available', toolCallId: 's1', dynamic: true, providerExecuted: true, output: 'ok' } },
    ...READ('r1', MEMO), ...WRITE('w1', '営業部/週報/週報_1120.md'),
    ...SAY('t1', '今週の訪問メモから、週報を「営業部/週報/週報_1120.md」にまとめました。\n\nこの仕事は、これまでにも何度か同じように頼まれています。毎週（または毎日・毎月）同じ時間に、定期の仕事としてやりましょうか？'),
    { end: true },
  ] },
  // 「はい」 to it (chapter 26): the proposal card (the server's candidate, read by the card itself).
  { when: /毎週月曜の朝9時/, steps: [
    ...SAY('t1', '毎週月曜の 9:00 に、新しい訪問メモがあるときだけ週報をまとめる案を作りました。内容を確かめて、よければ［これで管理者に出す］を押してください。'),
    { chunk: { type: JOB_PROPOSAL_PART_TYPE, id: 'job-proposal-1', data: { id: 'jp-card-1', companyId: COMPANY, conversationId: null, candidateId: MANUAL_JOB_CANDIDATE, at: new Date().toISOString() } } },
    { end: true },
  ] },
  // A Skill chosen with 「/」 (chapter 14).
  { when: /^\/thank-you-mail/, steps: [
    { chunk: { type: 'tool-input-available', toolCallId: 's1', toolName: 'Skill', dynamic: true, providerExecuted: true, input: { skill: 'thank-you-mail' }, providerMetadata: line(SKILL_LINE.label, SKILL_LINE.running, 'thank-you-mail') } },
    { chunk: { type: 'tool-output-available', toolCallId: 's1', dynamic: true, providerExecuted: true, output: 'ok' } },
    ...READ('r1', MEMO), ...WRITE('w1', THANKS),
    ...SAY('t1', '「thank-you-mail」の手順どおりに、お礼メールの下書きを「営業部/下書き/お礼メール_A社.md」に作りました。件名、お礼、次の約束（見積を来週お送りすること）の順に書いています。'),
    { end: true },
  ] },
  // The first request (chapter 11): read the visit notes, write the draft.
  { when: /お礼メールの下書き/, steps: [
    ...READ('r1', MEMO), ...WRITE('w1', THANKS),
    ...SAY('t1', 'お礼メールの下書きを「営業部/下書き/お礼メール_A社.md」に作りました。見積を来週お送りすることと、3月末の納期に向けて進めることにもふれています。'),
    { end: true },
  ] },
  // Still working (chapter 12: an instruction added meanwhile).
  { when: /見積の下書き/, steps: [
    ...SAY('t0', '訪問メモと提案書を見てから、見積の下書きを作ります。'),
    ...READ('r1', MEMO),
    { chunk: { type: 'tool-input-available', toolCallId: 'r2', toolName: 'Read', dynamic: true, providerExecuted: true, input: { file_path: `${ROOT}/営業部/提案書/提案書_A社向け.md` }, providerMetadata: line('ファイルを読みました', 'ファイルを読んでいます', '営業部/提案書/提案書_A社向け.md') } },
  ] },
  // A choice question (chapter 13).
  { when: /書き直して/, steps: [
    ...SAY('t0', 'お礼メールを書き直す前に、1つ確かめさせてください。'),
    { chunk: { type: 'tool-input-available', toolCallId: 'q1', toolName: 'AskUserQuestion', dynamic: true, providerExecuted: true, input: {} } },
    { ask: [{ question: 'お礼メールの宛名はどれにしますか？', header: '宛名', multiSelect: false, options: [
      { label: '田村様', description: '訪問でお会いした購買部の田村さんだけに送ります' },
      { label: '購買部の皆さま', description: '購買部の方々にまとめてお送りします' },
    ] }] },
  ] },
  // A command the app asks about first (chapter 13): deleting a file.
  { when: /消して/, steps: [
    ...SAY('t0', '古い下書きを消します。'),
    { chunk: { type: 'tool-input-available', toolCallId: 'b1', toolName: 'Bash', dynamic: true, providerExecuted: true, input: { command: 'rm "営業部/下書き/お礼メール_A社_古い版.md"', description: '古い下書きを消す' } } },
    { approve: { command: 'rm "営業部/下書き/お礼メール_A社_古い版.md"' } },
  ] },
  // A write into a folder this member only reads (chapter 13): refused before it runs.
  { when: /総務部/, steps: [
    { chunk: { type: 'tool-input-available', toolCallId: 'w1', toolName: 'Write', dynamic: true, providerExecuted: true, input: { file_path: `${ROOT}/総務部/お礼メールの書き方.md` }, providerMetadata: line('ファイルに書きました', 'ファイルに書いています', '総務部/お礼メールの書き方.md') } },
    { chunk: { type: 'tool-output-error', toolCallId: 'w1', dynamic: true, providerExecuted: true, errorText: readOnlyMessage('総務部') } },
    ...SAY('t1', '総務部のフォルダは閲覧のみのため、保存できませんでした。かわりに「営業部/下書き/お礼メールの書き方.md」に保存してもよいですか？'),
    { end: true },
  ] },
  // A review request (chapter 13).
  { when: /確認をお願い/, steps: [
    ...READ('r1', MEMO), ...WRITE('w1', '営業部/提案書/提案書_A社向け_骨子.md'),
    ...SAY('t1', '提案書の骨子を作りました。中身を見て、このまま進めてよいか教えてください。'),
    { chunk: { type: REVIEW_PART_TYPE, id: 'review-1', data: { id: 'rv1', title: 'A社向け 提案書の骨子', files: ['営業部/提案書/提案書_A社向け_骨子.md'], points: ['3つの進め方の順番', '費用の書き方'] } } },
    { end: true },
  ] },
]
const liveEncoder = new TextEncoder()
let liveStream: ReadableStreamDefaultController<Uint8Array> | null = null
let liveSteers = 0
const livePut = (chunk: unknown) => liveStream?.enqueue(liveEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
function lastUserText(body: Record<string, unknown> | null): string {
  const messages = (body?.messages ?? []) as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>
  const last = [...messages].reverse().find(m => m.role === 'user')
  return (last?.parts ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('')
}
async function playLive(steps: LiveStep[], sessionId: string) {
  for (const step of steps) {
    if ('chunk' in step) livePut(step.chunk)
    else if ('wait' in step) await sleep(step.wait)
    else if ('write' in step) {
      // The AI's file lands on the fake disk and the watcher reports it (the list shows it).
      const full = `${ROOT}/${step.write}`
      const folder = full.slice(0, full.lastIndexOf('/'))
      ;(DISK[folder] ??= []).push(file(step.write.split('/').pop()!))
      FILES[full] = LIVE_WRITTEN[step.write] ?? '# 下書き'
      fileChanges.emit([{ type: 'add', path: full }])
    } else if ('ask' in step) {
      liveQuestions.emit({ id: 'ask-q1', appSessionId: sessionId, kind: 'choices', agent: 'claude-code', toolCallId: 'q1', questions: parseChoiceQuestions(step.ask) })
    } else if ('approve' in step) {
      liveApprovals.emit({ toolUseId: 'b1', toolName: 'Bash', toolInput: step.approve, appSessionId: sessionId })
    } else {
      livePut({ type: 'finish-step' })
      livePut({ type: 'finish', finishReason: 'stop' })
      liveStream?.close()
      liveStream = null
    }
  }
}
function liveChat(path: string, init?: RequestInit): Response {
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
  if (path === '/api/rate-limits') return json({ rateLimits: null })
  if (path === '/api/generate-title') return json({ title: 'A社へのお礼メール' })
  if (path === '/api/steer') {
    // Delivered: the chat server puts the instruction into the running reply.
    const id = `s${++liveSteers}`
    livePut({ type: STEER_PART_TYPE, id: `steer-${id}`, data: { id, text: body?.text } })
    return json({ status: 'delivered', id })
  }
  if (path !== '/api/chat') return json({})
  const text = lastUserText(body)
  const sessionId = typeof body?.appSessionId === 'string' ? body.appSessionId : ''
  const reply = LIVE_REPLIES.find(r => r.when.test(text))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      liveStream = controller
      livePut({ type: 'start', messageId: `assistant-${Date.now()}` })
      livePut({ type: 'start-step' })
      void playLive(reply?.steps ?? [...SAY('t0', 'わかりました。'), { end: true }], sessionId)
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
}

// ?manual=1: one consultation to read in 「AIへの相談」 (the manual's chapter 1). The chat server
// is faked only so the panel opens; a message sent here gets no reply.
if (MANUAL) {
  const PORT = 4799
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const session = {
    id: 'thanks-mail', companyId: COMPANY, title: 'A社へのお礼メール', createdAt: at(12), updatedAt: at(10), revision: 1,
    messages: [
      { id: 'm1', role: 'user' as const, timestamp: at(12),
        content: '営業部の訪問メモ_1123.md を読んで、A社の田村さんへのお礼メールの下書きを 営業部/下書き/ に作ってください。' },
      { id: 'm2', role: 'assistant' as const, timestamp: at(10),
        content: '訪問メモを読みました。お礼メールの下書きを「営業部/下書き/お礼メール_A社.md」に作りました。見積を来週お送りすることと、3月末の納期に向けて進めることにもふれています。' },
    ],
  }
  try {
    // ?chat=live starts on a new, empty consultation (the stored one is in the list).
    if (!LIVE) localStorage.setItem(`chatTabs:${COMPANY}`, JSON.stringify({ tabs: [{ title: session.title, sessionId: session.id }], activeIndex: 0 }))
  } catch { /* preview only */ }
  Object.assign(api, {
    getChatServerInfo: async () => ({ port: PORT, authToken: 'preview' }),
    getChatSession: async (_company: string, id: string) => (id === session.id ? session : null),
    getChatSessionSummaries: async () => [{ id: session.id, companyId: COMPANY, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: 2, sent: true, preview: LIVE ? session.messages[1].content : '' }, ...(LIVE ? LIVE_PAST : [])],
    getPermissionMode: async () => 'auto',
    // The proposal card's candidate (chapter 26), as the server answers it.
    getJobCandidate: async () => ({ success: true, candidate: { id: MANUAL_JOB_CANDIDATE, definition: MANUAL_JOB_DEFINITION, fingerprint: MANUAL_JOB_FINGERPRINT, expiresAt: '2026-11-21T01:30:00.000Z', timeZone: 'Asia/Tokyo' }, proposal: null }),
    getHandoff: async () => ({ status: 'waiting', message: '', canUpdate: false, pendingTurns: 0 }),
    saveChatSession: async () => ({ status: 'saved', revision: 1 }),
    voiceInput: {
      // Off without a sentence: a preview-only reason (or the first-time microphone setup) would show in the pictures.
      capabilities: async () => ({ available: false, reason: '', retryable: false }),
      devices: async () => ({ ok: true, devices: [] }),
      start: async () => {}, stop: async () => {}, cancel: async () => {},
      onEvent: () => () => {}, onLevel: () => () => {}, onState: () => () => {},
    } as never,
  } satisfies Partial<ElectronAPI>)
  // 「変更を確認」: what 山田さん changed in chapter 5 (company-relative, as main answers them).
  const changes = { added: ['営業部/下書き/見積_下書き.md'], modified: ['営業部/訪問メモ_1123.md'], deleted: [] as string[] }
  const DIFFS: Record<string, string> = {
    '営業部/訪問メモ_1123.md': '@@ -5,3 +5,4 @@\n - 提案書の内容におおむね賛成\n - 見積を来週までに送る\n - 納期は3月末を希望\n+- 次回：12/1 に見積を持って再訪問',
    '営業部/下書き/見積_下書き.md': '@@ -0,0 +1,3 @@\n+# A社 見積（下書き）\n+\n+- 研修の進め方の見直し一式',
  }
  const BACKUPS = `${ROOT}/.backups`
  const result = params.get('result')
  const deniedFile = '総務部/備品の申請.md'
  Object.assign(api, {
    gitPreview: async () => ({ success: true, hasChanges: changes.added.length + changes.modified.length > 0, changes: { ...changes }, totalCount: changes.added.length + changes.modified.length }),
    gitFileDiff: async (_root: string, file: string, status: 'added' | 'modified' | 'deleted') => ({ success: true, diff: DIFFS[file] ?? '', isNewFile: status === 'added' }),
    gitRevertFile: async (_root: string, file: string, status: string) => {
      record('gitRevertFile', [file, status])
      changes.added = changes.added.filter(f => f !== file)
      changes.modified = changes.modified.filter(f => f !== file)
      return { success: true }
    },
    backupList: async () => ({
      success: true,
      backups: [
        { id: '2026-11-20T01-28-00-000Z', timestamp: '2026-11-20T01:28:00.000Z', reason: 'conflict', files: ['営業部/訪問メモ_1123.md'], path: `${BACKUPS}/2026-11-20T01-28-00-000Z` },
        { id: '2026-11-19T08-15-00-000Z_before_revert', timestamp: '2026-11-19T08:15:00.000Z', reason: 'before_revert', files: ['営業部/下書き/見積_下書き.md'], path: `${BACKUPS}/2026-11-19T08-15-00-000Z_before_revert` },
      ],
    }),
    backupRestore: async (_root: string, id: string, file: string) => {
      record('backupRestore', [id, file])
      return { success: true, message: `Restored: ${file}`, keptPath: `${BACKUPS}/2026-11-20T01-30-00-000Z_before_restore` }
    },
    backupOpenFolder: async (path: string) => { record('backupOpenFolder', [path]); return { success: true } },
    gitSync: async () => {
      record('gitSync', [])
      if (params.get('sync') === 'manual') await new Promise<void>(resolve => { finishSync = resolve })
      else await sleep(150)
      // The texts git-sync.ts answers in these cases (electron/sync/git-sync.ts, protected-config.ts).
      if (result === 'conflict') {
        return {
          success: true, hadConflicts: true, conflictFiles: ['営業部/訪問メモ_1123.md'], deletedConflictFiles: [],
          backupPath: `${BACKUPS}/2026-11-20T01-28-00-000Z`,
          message: '同期完了。1件のファイルは、ほかの人も同じところを変えていたため、サーバーの版を残しました。あなたが変えていた版は、タイトルバーの［バックアップ履歴］に保存してあります。その他の変更は正常に反映されました。',
        }
      }
      if (result === 'offline') return { success: false, errorType: 'push_failed', pushFailed: true, error: 'このPCには保存しましたが、サーバーに届けられませんでした。インターネットにつながっているか確かめて、もう一度［サーバーと同期］を押してください。' }
      if (result === 'denied') {
        return { success: false, errorType: 'write_denied', writeDeniedFiles: [deniedFile], error: `同期を中止しました。\n\n編集できないファイルがあります。\n次のファイルは、あなたに編集する権限がないフォルダにあるため、変更を共有できません。\n\n・${deniedFile}` }
      }
      if (result === 'restored') {
        return {
          success: true, restoredWriteDeniedFiles: [deniedFile], writeDeniedBackupPath: `${BACKUPS}/2026-11-20T01-29-00-000Z_write_denied`, backupPath: `${BACKUPS}/2026-11-20T01-29-00-000Z_write_denied`,
          message: '同期完了。編集する権限がないフォルダのファイル（1件）は元に戻しました。あなたが編集した版は、タイトルバーの［バックアップ履歴］に保存してあります。その他の変更は正常に反映されました。',
        }
      }
      return { success: true, message: '同期が完了しました' }
    },
  } satisfies Partial<ElectronAPI>)
  // ?folders=marks|other: the three marks of the file list (chapter 10).
  const folders = params.get('folders')
  if (folders === 'marks' || folders === 'other') {
    excluded = ['営業部/過去資料']
    DISK[ROOT].splice(1, 0, dir('総務部'))
    DISK[`${ROOT}/総務部`] = [dir('規程'), file('備品の申請.md'), file('申請書のひな形.md')]
    DISK[`${ROOT}/総務部/規程`] = [file('就業規則.md')]
    FILES[`${ROOT}/総務部/申請書のひな形.md`] = '# 申請書のひな形\n\n- 申請する人：\n- 申請する日：\n- 内容：'
    FILES[`${ROOT}/総務部/備品の申請.md`] = '# 備品の申請\n\n申請書のひな形に書いて、総務部に出してください。'
    FILES[`${ROOT}/総務部/規程/就業規則.md`] = '# 就業規則\n\n第1条 目的'
    if (folders === 'marks') {
      DISK[`${ROOT}/営業部`].splice(2, 0, dir('提案前メモ'))
      DISK[`${ROOT}/営業部/提案前メモ`] = [file('C社_検討メモ.md')]
      FILES[`${ROOT}/営業部/提案前メモ/C社_検討メモ.md`] = '# C社 検討メモ\n\n- 提案の前に、値引きの幅を相談する'
      Object.assign(api, {
        getMyPrivateFolders: async () => ({ success: true, folders: [{
          scopeId: 's_memo', path: '営業部/提案前メモ', canWrite: true, viewerCount: 3,
          viewers: [
            { userId: 'u_me', name: '山田 太郎', role: 'member' },
            { userId: 'u_sato', name: '佐藤 花子', role: 'admin' },
            { userId: 'u_takahashi', name: '高橋 美咲', role: 'member' },
          ],
        }] }),
      } satisfies Partial<ElectronAPI>)
    }
  }
  if (LIVE) {
    // The draft the AI will write starts missing, so the list shows it appear.
    DISK[`${ROOT}/営業部/下書き`] = []
    delete FILES[`${ROOT}/営業部/下書き/お礼メール_A社.md`]
    // Each Skill's SKILL.md opens in the editor (as main answers it: an absolute path).
    for (const list of Object.values(SKILLS)) {
      for (const s of list) {
        s.skillPath = s.skillPath.replace('//', '/')
        s.files.skillMd = `${s.skillPath}/SKILL.md`
      }
    }
    FILES[`${ROOT}/.claude/skills/thank-you-mail/SKILL.md`] = [
      '---',
      'name: thank-you-mail',
      'description: 訪問のあとのお礼メールを下書きする',
      '---',
      '',
      '# 訪問のあとのお礼メール',
      '',
      '1. 訪問メモを読み、会った人・決まったこと・次の約束を確かめる',
      '2. 件名は「本日のお打ち合わせのお礼」とする',
      '3. お礼、決まったこと、次の約束の順に、短く書く',
      '4. 下書きは、その部署の「下書き」フォルダに置く',
    ].join('\n')
    Object.assign(api, {
      getChatSession: async (_company: string, id: string) => {
        const past = LIVE_PAST.find(p => p.id === id)
        return id === session.id ? session : past ? { ...past, revision: 1, messages: [] } : null
      },
      onAgentInteraction: liveQuestions.subscribe,
      respondAgentInteraction: async () => true,
      onToolApprovalRequest: liveApprovals.subscribe,
      respondToolApproval: async () => true,
    } satisfies Partial<ElectronAPI>)
  }
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(`http://127.0.0.1:${PORT}/`)) return realFetch(input, init)
    if (LIVE) return liveChat(new URL(url).pathname, init)
    return new Response(JSON.stringify(new URL(url).pathname === '/api/rate-limits' ? { rateLimits: null } : {}), { headers: { 'content-type': 'application/json' } })
  }
}
installElectronAPI(api)

Object.assign(window, {
  __acbLayout: {
    calls,
    /** The morning's 「今日のあなたの番」 Mac notification was clicked (main's `notifications:openTasks`). */
    macNotificationClicked() { openTasksClicks.emit({ companyId: COMPANY }) },
    /** The AI (or a sync) writes a file: it lands on the fake disk and the watcher reports it. */
    addSkill(folder: string, name: string) {
      ;(SKILLS[folder] ??= []).push(skill(folder, name, `${name} の説明`))
      fileChanges.emit([{ type: 'add', path: `${ROOT}/${folder ? `${folder}/` : ''}.claude/skills/${name}/SKILL.md` }])
    },
    emit(changes: Array<{ type: string; path: string }>) { fileChanges.emit(changes) },
    /** A consultation's own window asked main to open this file here. */
    fileFromChatWindow(path: string) { fileRequests.emit({ path }) },
    /** The consultation's AI linked a file to the task: a new version, and main says records changed. */
    aiLinksFile(path: string) {
      taskVersion += 1
      taskFiles = [...taskFiles, path]
      recordsChanged.emit({ companyId: COMPANY })
    },
    /** Someone changed the task on the server while its tab was not shown (no signal reached this app). */
    serverLinksFile(path: string) {
      taskVersion += 1
      taskFiles = [...taskFiles, path]
    },
    cardReads: () => cardReads,
    /** The consultation AI runs an app command (tabs.list / tidy / restore); resolves to the window's answer. */
    async aiCommand(commandId: string, args: unknown = {}, companyId: string = COMPANY) {
      const requestId = `r${Math.random()}`
      appCommandRequests.emit({ requestId, companyId, commandId, args })
      for (let i = 0; i < 100 && !appCommandAnswers.has(requestId); i++) await sleep(20)
      return appCommandAnswers.get(requestId)
    },
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
  /** After ログアウト: is anyone signed in, is a company open? */
  session: () => ({ user: useAuthStore.getState().user?.id ?? null, company: useAppStore.getState().currentCompany?.id ?? null }),
  /** ?sync=manual: the running sync ends. */
  finishSync: () => { finishSync?.(); finishSync = null },
  /** The company the selector would start with (a switch to a company this computer does not know). */
  companyToChoose: () => useAppStore.getState().companyToChoose,
  /** Like the app: back to the company list (the screen unmounts), then open another company. */
  async switchCompany(id: string) {
    useAppStore.setState({ currentCompany: null })
    await sleep(50)
    editorWasEmpty = false
    openCompany(id)
  },
})

useAuthStore.setState({ user: { id: 'u_me', email: 'yamada@example.com', name: MANUAL ? '山田 太郎' : '山田 花子', image: null, emailVerified: true } })
openCompany(COMPANY)

// App.tsx shows the screen only while a company is open.
function Screen() {
  const company = useAppStore(s => s.currentCompany)
  return company ? <AppShell key={company.id} bottomPanel={BOTTOM_PANEL} /> : null
}
createRoot(document.getElementById('root')!).render(<div className="h-screen"><Screen /></div>)
