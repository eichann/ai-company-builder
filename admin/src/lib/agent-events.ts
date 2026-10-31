// Words and helpers for the 「AI の操作の記録」 page (the AI action log,
// shared/types/agent-events.ts). Pure: no React, so every label and the URL
// filter round trip are unit-tested (tests/agent-events.test.tsx), and a new
// enum value without a label fails the compiler (Record<…>) and the tests.

import {
  AGENT_KINDS,
  DENIED_DECISIONS,
  GUARD_REASONS,
  SENSITIVE_LOCATIONS,
  TOOL_CATEGORIES,
  TOOL_DECISIONS,
  TOOL_OUTCOMES,
} from '../../../shared/types/agent-events'
import type {
  AgentEventRecord,
  AgentEventSummary,
  AgentEventTarget,
  AgentEventViewerMode,
  AgentKind,
  GuardReason,
  SandboxMark,
  SensitiveLocation,
  ShownFileTarget,
  ToolCategory,
  ToolDecision,
  ToolOutcome,
} from './api'

export { AGENT_KINDS, GUARD_REASONS, SENSITIVE_LOCATIONS, TOOL_CATEGORIES, TOOL_DECISIONS, TOOL_OUTCOMES }

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  read: '読む',
  write: '書く',
  command: 'コマンド',
  web: 'Web',
  'mcp-external': '外部の道具(MCP)',
  'app-tool': 'アプリの道具',
  subagent: 'サブエージェント',
  question: '質問',
  other: 'その他',
  broker: 'API キー経由の呼び出し',
}

export type DecisionTone = 'neutral' | 'allowed' | 'denied'

export const DECISION_LABELS: Record<ToolDecision, { label: string; description: string; tone: DecisionTone }> = {
  'auto-allowed': {
    label: 'アプリが自動で許可',
    description: '読むだけの操作やアプリの道具など、確認しなくてよいものとしてアプリが通しました。',
    tone: 'neutral',
  },
  'member-allowed': { label: '本人が許可', description: 'アプリが確認を求め、メンバー本人が許可しました。', tone: 'allowed' },
  'member-denied': { label: '本人が拒否', description: 'アプリが確認を求め、メンバー本人が断りました。', tone: 'denied' },
  'guard-denied': {
    label: 'アプリの守りで拒否',
    description: 'アプリの守り（閲覧のみのフォルダなど）が止めました。理由を併せて表示します。',
    tone: 'denied',
  },
  'policy-default': {
    label: 'AI の設定に任せた',
    description: 'アプリは判断せず、AI 自身の権限の設定（確認する・許可する）に任せました。',
    tone: 'neutral',
  },
  'policy-denied': { label: 'AI の設定で拒否', description: 'AI 自身の権限の設定が止めました。', tone: 'denied' },
  stopped: { label: 'AI の停止中のため拒否', description: '管理者が AI を止めていたため、実行されませんでした。', tone: 'denied' },
}

export const GUARD_REASON_LABELS: Record<GuardReason, string> = {
  'read-only-folder': '閲覧のみのフォルダ',
  'not-downloaded': 'ダウンロードしていないフォルダ',
  'reserved-path': '使えないフォルダ名',
  'instruction-file': 'AI への指示のファイル（CLAUDE.md など）',
  'git-clone': '外のリポジトリの取り込み（git clone）',
  'git-init': '新しいリポジトリの作成（git init）',
  'private-read': '非公開フォルダの中身',
  'dangerous-command': '危ないコマンド',
  'needs-approval': '本人の確認が必要な操作',
  'outside-folder': '会社フォルダの外',
  'denied-read': '読み取りを禁止している場所',
  sandbox: 'AI の囲い',
  'key-not-available': '使える API キーがない',
  'destination-not-allowed': 'API キーで許可していない宛先・モデル',
  'internal-address': '社内のアドレスへの送信',
  'over-cap': 'API キーの1日の上限',
  'type-definition': '記録の型の定義（管理者だけ）',
  'record-file': '記録のファイルの状態・id の書き換え',
}

/** The AI sandbox's mark on a call (「AI の囲い」). */
export const SANDBOX_MARK_LABELS: Record<SandboxMark, string> = {
  'would-block': '囲うと止まる',
  blocked: '囲いで止まった',
}

export const AGENT_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'api-key': 'API キー',
  script: 'スクリプト・道具（API キー経由）',
}

export const OUTCOME_LABELS: Record<ToolOutcome, string> = {
  ok: '成功',
  error: '失敗',
  unfinished: '終わらなかった',
}

export const SENSITIVE_LABELS: Record<SensitiveLocation, string> = {
  ssh: 'SSH の鍵（~/.ssh）',
  'env-file': '.env ファイル',
  keychain: 'キーチェーン',
  credentials: '認証情報のファイル',
  'app-data': 'アプリの設定フォルダ',
}

export const VIEWER_MODE_LABELS: Record<AgentEventViewerMode, string> = {
  admins: 'オーナーと管理者だけ',
  'admins-and-managers': 'オーナーと管理者、各部署の責任者（自分の部署の分だけ）',
}

export function isDenied(decision: ToolDecision): boolean {
  return DENIED_DECISIONS.includes(decision)
}

/** 「Claude Code（claude-opus-5-5）」, with the subagent when the call ran in one. */
export function agentLabel(e: Pick<AgentEventRecord, 'agent' | 'model' | 'subagentType'>): string {
  const base = AGENT_LABELS[e.agent] ?? e.agent
  const model = e.model ? `（${e.model}）` : ''
  const sub = e.subagentType ? ` ・サブエージェント ${e.subagentType}` : ''
  return `${base}${model}${sub}`
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type TargetItem =
  | { kind: 'path'; text: string; sensitive?: string }
  | { kind: 'outside'; text: string; sensitive?: string }
  | { kind: 'hidden'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'plain'; text: string }

export interface TargetView {
  items: TargetItem[]
  /** Entries not listed (`ほか N 件`). */
  more: number
  /** The command wrote its output to a file (`>`). */
  redirect: boolean
  /** Hosts of URLs the command named (the AI sandbox's host list is about these). */
  hosts?: string[]
}

function fileItem(f: ShownFileTarget): TargetItem {
  if (f.kind === 'hidden') return { kind: 'hidden', text: '非公開（表示できません）' }
  const sensitive = f.sensitive ? SENSITIVE_LABELS[f.sensitive] ?? f.sensitive : undefined
  if (f.kind === 'outside') return { kind: 'outside', text: '会社フォルダの外', ...(sensitive ? { sensitive } : {}) }
  return { kind: 'path', text: f.path === '' ? '会社フォルダ全体' : f.path, ...(sensitive ? { sensitive } : {}) }
}

/** What a row shows as 対象. */
export function describeTarget(target: AgentEventTarget): TargetView {
  const none: TargetView = { items: [], more: 0, redirect: false }
  switch (target.kind) {
    case 'file':
    case 'outside':
    case 'hidden':
      return { ...none, items: [fileItem(target)] }
    case 'files':
      return { ...none, items: target.files.map(fileItem), more: target.more ?? 0 }
    case 'command':
      return {
        items: target.programs.map((p) => (p === '?' ? { kind: 'plain', text: '（名前を残さないプログラム）' } : { kind: 'code', text: p })),
        more: target.more ?? 0,
        redirect: target.redirect === true,
        ...(target.hosts?.length ? { hosts: target.hosts } : {}),
      }
    case 'web':
      return { ...none, items: [target.host ? { kind: 'code', text: target.host } : { kind: 'plain', text: '（宛先なし）' }] }
    case 'mcp':
      return { ...none, items: [{ kind: 'code', text: target.tool ? `${target.server} / ${target.tool}` : target.server }] }
    case 'subagent':
      return { ...none, items: [{ kind: 'plain', text: target.subagentType ? `サブエージェント ${target.subagentType}` : 'サブエージェント' }] }
    case 'broker': {
      const where = [target.host, target.path].filter(Boolean).join('')
      const facts = [
        target.model ? `モデル ${target.model}` : '',
        target.status !== undefined ? `応答 ${target.status}` : '',
        target.tokensIn !== undefined || target.tokensOut !== undefined ? `トークン ${target.tokensIn ?? 0} → ${target.tokensOut ?? 0}` : '',
        target.source === 'user' ? '自分の鍵' : target.source === 'company' ? '会社の鍵' : '',
      ].filter(Boolean).join('・')
      return { ...none, items: [{ kind: 'code', text: `${target.service}: ${where || '（宛先なし）'}` }, ...(facts ? [{ kind: 'plain' as const, text: facts }] : [])] }
    }
    case 'none':
      return none
    default:
      return none
  }
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** 「0.4秒」「12秒」「3分5秒」; null → '' */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}秒`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${sec % 60 ? `${sec % 60}秒` : ''}`
  const hour = Math.floor(min / 60)
  return `${hour}時間${min % 60 ? `${min % 60}分` : ''}`
}

/** 「10:31:02」 today, 「10/24 10:31:02」 this year, else with the year. */
export function formatEventTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (sameLocalDay(d, now)) return time
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${time}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${time}`
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Minutes east of UTC (540 in Japan), as the summary endpoint takes it. */
export function localTzOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset()
}

// ---------------------------------------------------------------------------
// Filters (kept in the URL so a view can be shared)
// ---------------------------------------------------------------------------

export const PERIODS = ['today', '7d', '30d', 'custom'] as const
export type Period = (typeof PERIODS)[number]

export const PERIOD_LABELS: Record<Period, string> = {
  today: '今日',
  '7d': '7日',
  '30d': '30日',
  custom: '期間を指定',
}

export interface LogFilters {
  period: Period
  /** YYYY-MM-DD (local), for `custom`. */
  fromDay?: string
  toDay?: string
  userId?: string
  category?: ToolCategory
  decision?: ToolDecision
  q?: string
  conversationId?: string
}

export const DEFAULT_PERIOD: Period = '7d'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function oneOf<T extends string>(list: readonly T[], value: string | null): T | undefined {
  return value !== null && (list as readonly string[]).includes(value) ? (value as T) : undefined
}

function textParam(value: string | null, max: number): string | undefined {
  const v = value?.trim()
  return v && v.length <= max ? v : undefined
}

/** The page's filters from its URL query; unknown or invalid values are ignored. */
export function parseFilters(params: URLSearchParams): LogFilters {
  const period = oneOf(PERIODS, params.get('period')) ?? DEFAULT_PERIOD
  const fromDay = params.get('from') ?? ''
  const toDay = params.get('to') ?? ''
  const f: LogFilters = { period }
  if (period === 'custom') {
    if (DAY_RE.test(fromDay)) f.fromDay = fromDay
    if (DAY_RE.test(toDay)) f.toDay = toDay
  }
  const userId = textParam(params.get('member'), 200)
  const category = oneOf(TOOL_CATEGORIES, params.get('category'))
  const decision = oneOf(TOOL_DECISIONS, params.get('decision'))
  const q = textParam(params.get('q'), 200)
  const conversationId = textParam(params.get('conversation'), 100)
  if (userId) f.userId = userId
  if (category) f.category = category
  if (decision) f.decision = decision
  if (q) f.q = q
  if (conversationId) f.conversationId = conversationId
  return f
}

/** The URL query for the filters (defaults left out). `extra` keeps other keys (the tab). */
export function filtersToSearch(f: LogFilters, extra: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v)
  if (f.period !== DEFAULT_PERIOD) p.set('period', f.period)
  if (f.period === 'custom') {
    if (f.fromDay) p.set('from', f.fromDay)
    if (f.toDay) p.set('to', f.toDay)
  }
  if (f.userId) p.set('member', f.userId)
  if (f.category) p.set('category', f.category)
  if (f.decision) p.set('decision', f.decision)
  if (f.q) p.set('q', f.q)
  if (f.conversationId) p.set('conversation', f.conversationId)
  return p.toString()
}

function localMidnight(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

/** `YYYY-MM-DD` of a date, local. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The period as ISO instants (from inclusive, to exclusive; to omitted = up
 * to now). 7日 / 30日 are whole local days ending today.
 */
export function periodRange(f: Pick<LogFilters, 'period' | 'fromDay' | 'toDay'>, now: Date = new Date()): { from?: string; to?: string } {
  const today = startOfToday(now)
  switch (f.period) {
    case 'today':
      return { from: today.toISOString() }
    case '7d':
      return { from: addDays(today, -6).toISOString() }
    case '30d':
      return { from: addDays(today, -29).toISOString() }
    case 'custom': {
      const range: { from?: string; to?: string } = {}
      if (f.fromDay) range.from = localMidnight(f.fromDay).toISOString()
      if (f.toDay) range.to = addDays(localMidnight(f.toDay), 1).toISOString()
      return range
    }
  }
}

/** Every local day of the period, oldest first (for the summary's bars); at most `max`. */
export function periodDays(f: Pick<LogFilters, 'period' | 'fromDay' | 'toDay'>, now: Date = new Date(), max = 400): string[] {
  const range = periodRange(f, now)
  const first = range.from ? startOfToday(new Date(range.from)) : addDays(startOfToday(now), -29)
  const last = range.to ? addDays(startOfToday(new Date(range.to)), -1) : startOfToday(now)
  const days: string[] = []
  for (let d = first; d <= last && days.length < max; d = addDays(d, 1)) days.push(dayKey(d))
  return days
}

export function hasNarrowingFilters(f: LogFilters): boolean {
  return Boolean(f.userId || f.category || f.decision || f.q)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface SummaryRow {
  userId: string
  name: string
  total: number
  denied: number
  /** Count per day of `days`, same order. */
  perDay: number[]
  /** The categories used most, with counts, largest first. */
  topCategories: Array<{ category: ToolCategory; count: number }>
}

/** Rows per member (busiest first) over the given days. */
export function summaryRows(summary: AgentEventSummary, days: string[]): SummaryRow[] {
  const names = new Map(summary.members.map((m) => [m.userId, m.name || m.email || '不明なメンバー']))
  const index = new Map(days.map((d, i) => [d, i]))
  const rows = new Map<string, SummaryRow & { cats: Map<ToolCategory, number> }>()
  for (const d of summary.days) {
    let row = rows.get(d.userId)
    if (!row) {
      row = { userId: d.userId, name: names.get(d.userId) ?? '不明なメンバー', total: 0, denied: 0, perDay: days.map(() => 0), topCategories: [], cats: new Map() }
      rows.set(d.userId, row)
    }
    row.total += d.total
    row.denied += d.denied
    const i = index.get(d.day)
    if (i !== undefined) row.perDay[i] += d.total
    for (const [c, n] of Object.entries(d.byCategory) as Array<[ToolCategory, number]>) row.cats.set(c, (row.cats.get(c) ?? 0) + n)
  }
  return [...rows.values()]
    .map(({ cats, ...row }) => ({
      ...row,
      topCategories: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, count]) => ({ category, count })),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ja'))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const RETENTION_PRESETS = [30, 90, 180, 365] as const

export function retentionLabel(days: number): string {
  if (days === 365) return '1年'
  if (days % 365 === 0) return `${days / 365}年`
  return `${days}日`
}
