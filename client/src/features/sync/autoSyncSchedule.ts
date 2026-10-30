// When 「自動で受け取る」 / 「自動で送る」 run, and what the member is told about
// them (.claude/rules/sync.md "Automatic sync"). Pure: the timer
// (hooks/useAutoSync.ts) feeds it the clock and the stored state.
import type { AutoSyncMode } from '../../../shared/auto-sync'
import { NEEDS_MEMBER_ERROR } from '../../../shared/auto-sync'
import { parseTimeOfDay, type AutoSyncSettings } from '../../shared/lib/autoSyncSettings'

/** A skipped run is tried again this much later (skips are short: an unsaved tab, a running AI). */
export const RETRY_AFTER_SKIP_MS = 2 * 60_000
const MINUTE = 60_000

/** What this computer remembers per company (localStorage, autoSyncState.ts). */
export interface AutoSyncState {
  receive: { lastRunAt: number | null; lastSkipAt: number | null }
  send: { lastRunAt: number | null; lastSkipAt: number | null }
  /** Last automatic run that did its work (shown in the sync button's tooltip). */
  lastAutoSyncAt: number | null
  /** The last sync stopped at something only the member can resolve: no automatic run until a sync succeeds. */
  needsMember: boolean
  /** Failure kinds already shown since the last successful sync (one notice per kind). */
  notified: string[]
}

export const EMPTY_AUTO_SYNC_STATE: AutoSyncState = {
  receive: { lastRunAt: null, lastSkipAt: null },
  send: { lastRunAt: null, lastSkipAt: null },
  lastAutoSyncAt: null,
  needsMember: false,
  notified: [],
}

/** The first time slot (local time of day) strictly after `after`. */
export function nextSlotAfter(times: readonly string[], after: number): number | null {
  const minutes = times.map(parseTimeOfDay).filter((m): m is number => m !== null)
  if (minutes.length === 0) return null
  const day = new Date(after)
  day.setHours(0, 0, 0, 0)
  let best: number | null = null
  // Today and tomorrow cover every slot; DST shifts only move a slot by the hour.
  for (const offset of [0, 1]) {
    for (const m of minutes) {
      const slot = new Date(day)
      slot.setDate(day.getDate() + offset)
      slot.setHours(Math.floor(m / 60), m % 60, 0, 0)
      const t = slot.getTime()
      if (t > after && (best === null || t < best)) best = t
    }
  }
  return best
}

/**
 * When a mode is next due (ms), or null when it is off. Measured from its
 * last run, so runs missed while the app was closed come due once — never
 * one per missed slot. 「送る」 never catches up on slots before it was turned on.
 */
export function dueAt(mode: AutoSyncMode, settings: AutoSyncSettings, state: AutoSyncState, startedAt: number): number | null {
  if (mode === 'receive') {
    if (!settings.receive.enabled) return null
    const last = state.receive.lastRunAt
    return last === null ? startedAt : last + settings.receive.intervalMinutes * MINUTE
  }
  if (!settings.send.enabled) return null
  const base = state.send.lastRunAt ?? settings.send.enabledAt ?? startedAt
  return settings.send.mode === 'interval'
    ? base + settings.send.intervalMinutes * MINUTE
    : nextSlotAfter(settings.send.times, base)
}

/** A due run that was skipped waits RETRY_AFTER_SKIP_MS before the next try. */
function attemptAt(due: number | null, lastSkipAt: number | null): number | null {
  if (due === null) return null
  return lastSkipAt !== null && lastSkipAt >= due ? lastSkipAt + RETRY_AFTER_SKIP_MS : due
}

/** The run to start now, if any. Sending first: it also brings teammates' changes. */
export function runDueNow(settings: AutoSyncSettings, state: AutoSyncState, now: number, startedAt: number): AutoSyncMode | null {
  for (const mode of ['send', 'receive'] as const) {
    const at = attemptAt(dueAt(mode, settings, state, startedAt), state[mode].lastSkipAt)
    if (at !== null && at <= now) return mode
  }
  return null
}

/** Record that a run happened (`ran`) or had to wait (`skipped`). A send also counts as a receive. */
export function recordRun(state: AutoSyncState, mode: AutoSyncMode, outcome: 'ran' | 'skipped', now: number): AutoSyncState {
  if (outcome === 'skipped') return { ...state, [mode]: { ...state[mode], lastSkipAt: now } }
  const ran = { lastRunAt: now, lastSkipAt: null }
  return mode === 'send' ? { ...state, send: ran, receive: ran } : { ...state, receive: ran }
}

/** What sync reported, as far as these decisions need it. */
export interface SyncOutcomeView {
  success: boolean
  errorType?: string
  error?: string
  secretDetected?: boolean
}

const NEEDS_MEMBER_TYPES = new Set([
  'conflict', NEEDS_MEMBER_ERROR, 'protected_config', 'write_denied', 'personal_path', 'local_only_path', 'reserved_path',
])

/** The member pressed キャンセル in a manual sync's question: "not now", not a stop. */
function isMemberCancel(result: SyncOutcomeView): boolean {
  return !result.success && /^同期を中止しました|^同期がキャンセルされました/.test(result.error ?? '')
}

/**
 * Whether a failed sync stopped at something only the member can resolve
 * (a question an automatic send would not answer, a rejected file, a
 * secret). Network, sign-in and lock failures are not: the next automatic
 * run simply tries again.
 */
export function needsMemberAfter(result: SyncOutcomeView): boolean {
  if (result.success) return false
  if (result.secretDetected) return true
  return !!result.errorType && NEEDS_MEMBER_TYPES.has(result.errorType)
}

function failureKind(result: SyncOutcomeView): string {
  return result.secretDetected ? 'secret' : (result.errorType || 'unknown')
}

/**
 * The state after a sync (manual or automatic) and whether its failure
 * notice is shown. A success clears everything; a failure is shown once per
 * kind until a sync succeeds (an automatic run never repeats a notice the
 * member already saw, a manual press always shows its own result). A manual
 * sync the member cancelled lifts an automatic stop: automatic sync resumes
 * at its next scheduled run (a send still facing the question stops again,
 * without repeating its notice).
 */
export function afterSync(state: AutoSyncState, result: SyncOutcomeView, options: { manual: boolean }): { state: AutoSyncState; showFailure: boolean } {
  if (result.success) return { state: { ...state, needsMember: false, notified: [] }, showFailure: false }
  if (options.manual && isMemberCancel(result)) return { state: { ...state, needsMember: false }, showFailure: true }
  const kind = failureKind(result)
  const seen = state.notified.includes(kind)
  return {
    state: { ...state, needsMember: state.needsMember || needsMemberAfter(result), notified: seen ? state.notified : [...state.notified, kind] },
    showFailure: options.manual || !seen,
  }
}

/** The sync button's tooltip: when the last automatic sync ran, or that automatic sync waits for the member. */
export function syncButtonTitle(state: AutoSyncState, settings: AutoSyncSettings): string {
  if (!settings.receive.enabled && !settings.send.enabled) return 'サーバーと同期'
  if (state.needsMember) return 'サーバーと同期\n自動同期は止まっています（このボタンで同期すると再開します）'
  if (state.lastAutoSyncAt === null) return 'サーバーと同期'
  const at = new Date(state.lastAutoSyncAt)
  const time = `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return `サーバーと同期\n最後の自動同期: ${time}`
}
