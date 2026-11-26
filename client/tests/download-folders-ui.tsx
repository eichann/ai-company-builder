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
//   pc     (with browser=…) 「この PC」: none (default) | pending | enabled | revoked | unavailable | unknown; pcFail=1 refuses
//          a press with the server's sentence; lines=0 gives the member no usable combination
//          「記録する」 (with browser=…): start → recording, stop → four sample lines to check, ［消す］ / ［送る］ / ［捨てる］ as main
//          would answer; the lines sent land in window.recordingSent
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
import { setWatchProposalDefinition } from '../../shared/core/job-proposals'
import { JOB_SET_WATCH_OPENED } from '../../shared/core/jobs'

const params = new URLSearchParams(location.search)
const view = params.get('view') ?? 'settings'
const theme = params.get('theme') ?? 'light'
const state = params.get('state') ?? 'normal'
const role = params.get('role') ?? 'owner'
const tab = params.get('tab') ?? 'sync'
// 自分の設定: the member's two switches as the server would answer them.
// 「AI に完了を頼めるようにする」 is the member's alone (always allowed); `?aiCompletes=none` = a server without it.
const policy = { readIncoming: params.get('company') !== 'off' && params.get('company') !== 'later', autoRun: true, aiCompletes: true }
let stoppedLater = params.get('company') === 'later'
let autoRead = { mode: 'off' as 'outside' | 'all' | 'off', chosen: false }
const autoReadSet: string[] = []
const chosen: Record<string, boolean | null> = { readIncoming: null, autoRun: null, aiCompletes: null }
const switchState = (k: 'readIncoming' | 'autoRun' | 'aiCompletes', def: boolean) => ({ on: policy[k] && (chosen[k] ?? def), allowed: policy[k] || (k === 'readIncoming' && stoppedLater), companyDefault: def, chosen: chosen[k] })
const mySwitches = () => ({ readIncoming: { ...switchState('readIncoming', false), connected: { mail: params.get('mail') !== 'no', chat: false } }, autoRun: switchState('autoRun', true),
  ...(params.get('aiCompletes') === 'none' ? {} : { aiCompletes: switchState('aiCompletes', false) }),
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
// ?manual=1&tab=jobs: the set watch 山田さん adds (4b-4 PR6b), as the server would build it from his choice.
const SET_WATCH_CANDIDATE = `jc.${'5'.repeat(32)}`
function setWatchCandidateDefinition() {
  const d = setWatchProposalDefinition({ trigger: JSON.parse(JSON.stringify(JOB_SET_WATCH_OPENED[0])), skill: { place: '法人ソリューション', skill: 'sales-proposal-auto' }, readSkills: [{ place: '法人ソリューション', skill: 'sales-proposal-v1' }] }, 'u-yamada')
  const pinned = JSON.parse(JSON.stringify(d).replace(/"0{40}"/g, `"${'a'.repeat(40)}"`))
  return { ...pinned, decision: { reasons: [{ code: 'requested', label: '提案を求められた' }, { code: 'internal_meeting', label: '社内の会議' }] } }
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

type PcState = 'none' | 'pending' | 'enabled' | 'revoked' | 'unavailable' | 'unknown'
let pc: { state: PcState; label: string | null } = (() => {
  const state = (params.get('pc') ?? 'none') as PcState
  return { state, label: state === 'pending' || state === 'enabled' || state === 'revoked' ? '見本の MacBook' : null }
})()
const pcView = () => ({
  ...pc, suggestedLabel: '見本の Mac',
  lines: params.get('lines') === '0' ? [] : [{ label: '流入経路を点検する', writes: false }, { label: '流入経路を作る', writes: true }],
})

// 「記録する」: main's view of the member's recording (lines in their kept form only).
const REC_LINES = [
  { id: 1, kind: 'ページ', text: '/orders/{n}', estimated: null },
  { id: 2, kind: '入力した', text: '「受付終了日」 (end_date) ＝ 値1', estimated: null },
  { id: 3, kind: '押した', text: '「保存」', estimated: null },
  { id: 4, kind: '送った', text: 'POST /api/orders/{n} ［end_date=値1］ → 200', estimated: '（推定）手順3のあと' },
]
const REC_NOTE = 'いつもの作業を、サイトの窓で1回通してやってください。'
const REC_WARNING = 'ボタンや欄の見出し、ページのアドレスに、お客さまなどの名前が入っていることがあります。'
type RecView =
  | { state: 'none'; message: string | null; notes: string[] }
  | { state: 'recording'; host: string; lines: number; notes: string[] }
  | { state: 'review'; host: string; lines: typeof REC_LINES; message: string | null; notes: string[]; words: Array<{ word: string; count: number }>; hosts: Array<{ host: string; loaded: boolean }>; titles: { lines: string; words: string; hosts: string } }
let rec: RecView = { state: 'none', message: null, notes: [REC_NOTE] }
const recAnswer = () => ({ ok: true as const, view: rec })

Object.assign(window, {
  electronAPI: {
    gitBinaryStatus: async () => ({ bundled: true, binary: 'bundled' }),
    // 「ブラウザ操作」: `?browser=1` gives the member one site (else the company has it off); `?browser=clearFails` fails 「ログインを消す」;
    // `?browser=kept` keeps its login on this PC.
    getBrowserSites: async () => ({ sites: params.get('browser') ? [{ host: 'manager.example.net', ...(params.get('browser') === 'kept' ? { kept: true } : {}) }] : [] }),
    onBrowserChanged: () => () => {},
    openBrowserSite: async (_companyId: string, host: string) => { (window as unknown as { browserOpened: string[] }).browserOpened = [...((window as unknown as { browserOpened?: string[] }).browserOpened ?? []), host]; return { ok: true } },
    clearBrowserLogin: async () => (params.get('browser') === 'clearFails' ? { ok: false, message: 'ログインを消せませんでした。もう一度お試しください。' } : { ok: true }),
    // 「この PC」: main's view (a state, a name, the combinations — never a key). A press moves the state as the server would.
    getBrowserPc: async () => ({ ok: true, view: pcView() }),
    registerBrowserPc: async (_companyId: string, label: string) => {
      if (params.get('pcFail')) return { ok: false, message: '登録できる PC の数を超えています。使わない PC の登録をやめてから、もう一度登録してください' }
      ;(window as unknown as { pcRegistered?: string }).pcRegistered = label
      pc = { state: 'pending', label }
      return { ok: true, view: pcView() }
    },
    withdrawBrowserPc: async () => { pc = { state: 'revoked', label: pc.label }; return { ok: true, view: pcView() } },
    getBrowserRecording: async () => recAnswer(),
    startBrowserRecording: async (_companyId: string, host: string) => { rec = { state: 'recording', host, lines: 3, notes: [`${host} を記録しています（3行）。`] }; return recAnswer() },
    stopBrowserRecording: async () => {
      if (rec.state === 'recording') rec = { state: 'review', host: rec.host, lines: [...REC_LINES], message: null, notes: [REC_WARNING], titles: { lines: '送る前に確かめてください', words: '伏せる言葉', hosts: 'ほかのサイト' }, words: [{ word: 'orders', count: 2 }, { word: 'tanaka', count: 1 }], hosts: [{ host: 'cdn.example-assets.test', loaded: true }] }
      return recAnswer()
    },
    editBrowserRecording: async (_companyId: string, change: { kind: 'line'; id: number } | { kind: 'word'; word: string } | { kind: 'host'; host: string }) => {
      if (rec.state !== 'review') return recAnswer()
      ;(window as unknown as { recordingEdits?: unknown[] }).recordingEdits = [...((window as unknown as { recordingEdits?: unknown[] }).recordingEdits ?? []), change]
      if (change.kind === 'line') rec = { ...rec, lines: rec.lines.filter(l => l.id !== change.id) }
      if (change.kind === 'word') rec = { ...rec, words: rec.words.filter(w => w.word !== change.word) }
      if (change.kind === 'host') rec = { ...rec, hosts: rec.hosts.filter(h => h.host !== change.host) }
      return recAnswer()
    },
    sendBrowserRecording: async () => {
      if (rec.state === 'review') { (window as unknown as { recordingSent?: number[] }).recordingSent = rec.lines.map(l => l.id); rec = { state: 'none', message: '記録を送りました。管理者に「記録を送りました」と伝えてください。', notes: [REC_NOTE] } }
      return recAnswer()
    },
    discardBrowserRecording: async () => { rec = { state: 'none', message: '記録を捨てました。', notes: [REC_NOTE] }; return recAnswer() },
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
    // 「届いた議事録を AI が自動で読む」 (?autoread=new: never chose, starts off; absent: an older server, hidden).
    getMeetingAutoRead: async () => (params.get('autoread') === 'new' ? { success: true, setting: autoRead } : { success: false, error: '' }),
    setMeetingAutoRead: async (_companyId: string, mode: 'outside' | 'all' | 'off') => {
      autoReadSet.push(mode)
      ;(window as unknown as { __autoReadSet: string[] }).__autoReadSet = autoReadSet
      autoRead = { mode, chosen: true }
      return { success: true, setting: autoRead }
    },
    // 「AI から定期の仕事を提案してもらう」: this PC's own setting (on).
    getJobRepeatAsk: async () => ({ success: true, on: repeatAskOn }),
    setJobRepeatAsk: async (_companyId: string, on: boolean) => { repeatAskOn = on; return { success: true, on } },
    setWorkSwitch: async (_companyId: string, which: 'readIncoming' | 'autoRun' | 'aiCompletes', on: boolean) => {
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
    // 設定 →「AIに渡す環境変数」 (tab=aienv; the administrator guide's 15節): one name passed on already.
    getAgentEnvPassthrough: async () => ['CRM_BASE_URL'],
    setAgentEnvPassthrough: async (names: string[]) => ({ names, invalid: [], denied: [] }),
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
      // 「会議のあとの見張りを足す」 (4b-4 PR6b): the department Skills she reads; the candidate the server would build from the
      // choice (recorded in window.__acbSetWatch), and the submit.
      getSetWatchSkills: async () => ({ success: true, supported: true, skills: [
        { place: '法人ソリューション', skill: 'sales-proposal-auto', runs: true }, { place: '法人ソリューション', skill: 'sales-proposal-v1', runs: false },
      ] }),
      createSetWatchCandidate: async (_companyId: string, choice: unknown) => {
        ;((window as unknown as { __acbSetWatch: unknown[] }).__acbSetWatch ??= []).push(choice)
        return { success: true, candidate: { id: SET_WATCH_CANDIDATE, definition: setWatchCandidateDefinition(), fingerprint: MANUAL_JOB_FINGERPRINT, expiresAt: '2026-11-25T00:00:00.000Z', timeZone: null } }
      },
      submitJobProposal: async (_companyId: string, candidateId: string, fingerprint: string) => {
        ;((window as unknown as { __acbSetWatch: unknown[] }).__acbSetWatch ??= []).push({ candidateId, fingerprint })
        return { success: true, proposal: { id: `jp.${'c'.repeat(32)}`, jobId: `job.${'2'.repeat(32)}`, proposerId: 'u-yamada', candidateId, submittedVersion: 1, submittedFingerprint: fingerprint, state: 'submitted', returnReason: null, decidedBy: null, decidedAt: null, createdAt: '2026-11-24T06:00:00.000Z' } }
      },
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
