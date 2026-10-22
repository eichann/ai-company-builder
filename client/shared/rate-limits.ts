/**
 * Plan usage limits (the chat header's meter): how much of each rolling
 * window the member's subscription has used, and when it resets.
 *
 * Sources (pure mapping here, no Electron imports — unit tested):
 * - Claude Code: the SDK's `rate_limit_event` (`SDKRateLimitEvent`), once per
 *   turn. CLI 2.1.304 sends both windows in `rate_limit_info.unifiedWindows`
 *   (not in the SDK's type) with `utilization` as a FRACTION (0.24 = 24%), e.g.
 *   `{ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1792686000,
 *      unifiedWindows: { five_hour: { utilization: 0.24, resetsAt: … },
 *                        seven_day: { utilization: 0.66, resetsAt: … } } }`.
 *   Older CLIs send only the window named by `rateLimitType` (with an
 *   optional `utilization`), so windows are merged into the previous snapshot.
 *   API-key logins get no event at all → the meter stays "unknown".
 * - Codex: `account/rateLimits/read` (full snapshot) and the sparse
 *   `account/rateLimits/updated` notification; `usedPercent` is 0–100,
 *   `resetsAt` is in seconds, windows are told apart by `windowDurationMins`.
 */

export type RateLimitProvider = 'claude-code' | 'codex'

export interface RateLimitWindow {
  /** Stable key: Claude's window name (`five_hour`, `seven_day`, …) or `codex:<minutes>`. */
  id: string
  label: string
  /** 0–100, or null when the source named the window without a figure. */
  usedPercent: number | null
  /** Epoch milliseconds. */
  resetsAt: number | null
}

export interface RateLimitSnapshot {
  provider: RateLimitProvider
  windows: RateLimitWindow[]
  /** The source's own verdict: a warning or a refusal outranks the figures. */
  status: 'allowed' | 'warning' | 'rejected'
  /** Epoch milliseconds of the last update. */
  updatedAt: number
}

/** Transient UI stream part the chat server sends when limits change. */
export const RATE_LIMITS_PART_TYPE = 'data-rate-limits'

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: '5時間',
  seven_day: '1週間',
  seven_day_opus: '1週間（Opus）',
  seven_day_sonnet: '1週間（Sonnet）',
}
const CLAUDE_WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

/** Claude reports a fraction (0–1); a figure above 1 can only be a percentage. */
function claudePercent(value: unknown): number | null {
  const n = finite(value)
  if (n === null) return null
  return clampPercent(n <= 1 ? n * 100 : n)
}

/** Seconds (Claude, Codex) or milliseconds → milliseconds. */
function epochMs(value: unknown): number | null {
  const n = finite(value)
  if (n === null || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

function sortWindows(windows: RateLimitWindow[], order: (w: RateLimitWindow) => number): RateLimitWindow[] {
  return [...windows].sort((a, b) => order(a) - order(b))
}

function mergeWindows(previous: RateLimitWindow[], updates: RateLimitWindow[]): RateLimitWindow[] {
  const byId = new Map(previous.map(w => [w.id, w]))
  for (const update of updates) {
    const old = byId.get(update.id)
    byId.set(update.id, {
      ...update,
      usedPercent: update.usedPercent ?? old?.usedPercent ?? null,
      resetsAt: update.resetsAt ?? old?.resetsAt ?? null,
    })
  }
  return [...byId.values()]
}

/** `rate_limit_event.rate_limit_info` → snapshot (merged into `previous`). */
export function fromClaudeRateLimitInfo(info: unknown, previous?: RateLimitSnapshot, now = Date.now()): RateLimitSnapshot | undefined {
  if (!info || typeof info !== 'object') return undefined
  const value = info as Record<string, unknown>
  const updates: RateLimitWindow[] = []
  const unified = value.unifiedWindows
  if (unified && typeof unified === 'object') {
    for (const [id, raw] of Object.entries(unified as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const window = raw as Record<string, unknown>
      updates.push({ id, label: CLAUDE_WINDOW_LABELS[id] ?? id, usedPercent: claudePercent(window.utilization), resetsAt: epochMs(window.resetsAt) })
    }
  }
  const type = typeof value.rateLimitType === 'string' ? value.rateLimitType : undefined
  if (type && type !== 'overage' && !updates.some(w => w.id === type)) {
    updates.push({ id: type, label: CLAUDE_WINDOW_LABELS[type] ?? type, usedPercent: claudePercent(value.utilization), resetsAt: epochMs(value.resetsAt) })
  }
  const status = value.status === 'rejected' ? 'rejected' : value.status === 'allowed_warning' ? 'warning' : value.status === 'allowed' ? 'allowed' : undefined
  if (!status && updates.length === 0) return undefined
  const base = previous?.provider === 'claude-code' ? previous.windows : []
  const windows = sortWindows(mergeWindows(base, updates), w => {
    const at = CLAUDE_WINDOW_ORDER.indexOf(w.id)
    return at < 0 ? CLAUDE_WINDOW_ORDER.length : at
  })
  return { provider: 'claude-code', windows, status: status ?? previous?.status ?? 'allowed', updatedAt: now }
}

function codexLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback
  if (minutes === 10080) return '1週間'
  if (minutes % 1440 === 0) return `${minutes / 1440}日`
  if (minutes % 60 === 0) return `${minutes / 60}時間`
  return `${minutes}分`
}

function codexWindow(raw: unknown, slot: 'primary' | 'secondary'): RateLimitWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const window = raw as Record<string, unknown>
  const minutes = finite(window.windowDurationMins)
  const used = finite(window.usedPercent)
  return {
    id: minutes !== null ? `codex:${minutes}` : `codex:${slot}`,
    label: codexLabel(minutes, slot === 'primary' ? '短期' : '長期'),
    usedPercent: used === null ? null : clampPercent(used),
    resetsAt: epochMs(window.resetsAt),
  }
}

/**
 * Codex `RateLimitSnapshot` (from `account/rateLimits/read` → `rateLimits`, or
 * the `account/rateLimits/updated` notification's `rateLimits`) → snapshot.
 * Updates are sparse: a missing window keeps its previous figures.
 */
export function fromCodexRateLimits(snapshot: unknown, previous?: RateLimitSnapshot, now = Date.now()): RateLimitSnapshot | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined
  const value = snapshot as Record<string, unknown>
  const updates = [codexWindow(value.primary, 'primary'), codexWindow(value.secondary, 'secondary')].filter((w): w is RateLimitWindow => !!w)
  const reached = typeof value.rateLimitReachedType === 'string' && value.rateLimitReachedType.length > 0
  if (updates.length === 0 && !reached) return undefined
  const base = previous?.provider === 'codex' ? previous.windows : []
  const windows = sortWindows(mergeWindows(base, updates), w => {
    const minutes = Number(w.id.slice('codex:'.length))
    return Number.isFinite(minutes) ? minutes : Number.MAX_SAFE_INTEGER
  })
  const status = reached ? 'rejected' : updates.length > 0 ? 'allowed' : previous?.status ?? 'allowed'
  return { provider: 'codex', windows, status, updatedAt: now }
}

// ---------------------------------------------------------------------------
// View model for the header meter
// ---------------------------------------------------------------------------

export type MeterLevel = 'unknown' | 'ok' | 'warn' | 'critical'

export const METER_WARN_PERCENT = 75
export const METER_CRITICAL_PERCENT = 90

export interface MeterWindowView {
  id: string
  label: string
  percent: number | null
  level: MeterLevel
  /** e.g. 「10/24 16:20 に回復（あと2時間10分）」, or '' when unknown. */
  resetText: string
}

export interface MeterView {
  level: MeterLevel
  windows: MeterWindowView[]
  /** One line under the details, e.g. a refusal or why nothing is shown. */
  note: string
}

function levelFor(percent: number | null): MeterLevel {
  if (percent === null) return 'unknown'
  if (percent >= METER_CRITICAL_PERCENT) return 'critical'
  if (percent >= METER_WARN_PERCENT) return 'warn'
  return 'ok'
}

const LEVEL_RANK: Record<MeterLevel, number> = { unknown: 0, ok: 1, warn: 2, critical: 3 }

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatReset(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return ''
  const at = new Date(resetsAt)
  const clock = `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000))
  if (resetsAt <= now) return `${clock} に回復済み`
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  const left = days > 0 ? `${days}日${hours > 0 ? `${hours}時間` : ''}` : hours > 0 ? `${hours}時間${rest > 0 ? `${rest}分` : ''}` : `${Math.max(1, rest)}分`
  return `${clock} に回復（あと${left}）`
}

export const METER_UNKNOWN_NOTE = {
  'claude-code': '利用上限の情報はまだ届いていません。AIが一度応答すると表示されます（APIキーでのログインや古いClaude Codeでは表示されません）。',
  codex: '利用上限の情報はまだ届いていません。AIが一度応答すると表示されます。',
} as const

export function meterView(snapshot: RateLimitSnapshot | undefined, provider: RateLimitProvider, now = Date.now()): MeterView {
  if (!snapshot || snapshot.provider !== provider) return { level: 'unknown', windows: [], note: METER_UNKNOWN_NOTE[provider] }
  const windows: MeterWindowView[] = snapshot.windows.map(w => {
    // A window whose reset time has passed starts over: its old figure is stale.
    const expired = w.resetsAt !== null && w.resetsAt <= now
    const percent = expired ? 0 : w.usedPercent
    return { id: w.id, label: w.label, percent, level: levelFor(percent), resetText: expired ? '' : formatReset(w.resetsAt, now) }
  })
  let level: MeterLevel = windows.reduce<MeterLevel>((worst, w) => LEVEL_RANK[w.level] > LEVEL_RANK[worst] ? w.level : worst, 'unknown')
  let note = ''
  if (snapshot.status === 'rejected') {
    level = 'critical'
    note = '利用上限に達しています。回復時刻まで待つか、別のモデルを選んでください。'
  } else if (snapshot.status === 'warning') {
    if (LEVEL_RANK[level] < LEVEL_RANK.warn) level = 'warn'
    note = '利用上限に近づいています。'
  } else if (windows.length > 0 && windows.every(w => w.percent === null)) {
    note = '使用率の数値は届いていません（上限には達していません）。'
    level = 'ok'
  }
  return { level, windows, note }
}
