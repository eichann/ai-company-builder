// Settings → 同期 → 自動同期: per member on this PC (localStorage), read by the
// settings page (features/settings) and the timer (features/sync). Owner
// decision 2026-10-30: receive on every 15 min, send off (12:00 and 18:00, or
// every N min, when turned on). .claude/rules/sync.md "Automatic sync".

export const RECEIVE_INTERVALS = [5, 10, 15, 30, 60] as const
export const SEND_INTERVALS = [30, 60, 120] as const

export interface AutoSyncSettings {
  receive: { enabled: boolean; intervalMinutes: number }
  send: {
    enabled: boolean
    mode: 'times' | 'interval'
    /** "HH:MM", local time, sorted, no duplicates. */
    times: string[]
    intervalMinutes: number
    /** When 「自動で送る」 was turned on (ms): the first run is the first slot after it, never a catch-up. */
    enabledAt: number | null
  }
}

export const DEFAULT_AUTO_SYNC_SETTINGS: AutoSyncSettings = {
  receive: { enabled: true, intervalMinutes: 15 },
  send: { enabled: false, mode: 'times', times: ['12:00', '18:00'], intervalMinutes: 60, enabledAt: null },
}

/** Minutes after midnight for "H:MM" / "HH:MM", or null. */
export function parseTimeOfDay(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** Valid times as "HH:MM", sorted, without duplicates. */
export function normalizeTimes(values: readonly unknown[]): string[] {
  const minutes = values
    .map(v => (typeof v === 'string' ? parseTimeOfDay(v) : null))
    .filter((v): v is number => v !== null)
  return [...new Set(minutes)].sort((a, b) => a - b).map(formatTime)
}

const oneOf = (value: unknown, allowed: readonly number[], fallback: number) =>
  typeof value === 'number' && allowed.includes(value) ? value : fallback

/** Whatever was stored, as valid settings (unknown or broken values → the defaults). */
export function normalizeAutoSyncSettings(raw: unknown): AutoSyncSettings {
  const d = DEFAULT_AUTO_SYNC_SETTINGS
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>
  const receive = r.receive ?? {}
  const send = r.send ?? {}
  const times = Array.isArray(send.times) ? normalizeTimes(send.times) : d.send.times
  return {
    receive: {
      enabled: typeof receive.enabled === 'boolean' ? receive.enabled : d.receive.enabled,
      intervalMinutes: oneOf(receive.intervalMinutes, RECEIVE_INTERVALS, d.receive.intervalMinutes),
    },
    send: {
      enabled: typeof send.enabled === 'boolean' ? send.enabled : d.send.enabled,
      mode: send.mode === 'interval' ? 'interval' : 'times',
      times: times.length > 0 ? times : d.send.times,
      intervalMinutes: oneOf(send.intervalMinutes, SEND_INTERVALS, d.send.intervalMinutes),
      enabledAt: typeof send.enabledAt === 'number' ? send.enabledAt : null,
    },
  }
}

const KEY = 'acb.autoSync.settings'

function read(): AutoSyncSettings {
  try {
    const text = localStorage.getItem(KEY)
    return normalizeAutoSyncSettings(text ? JSON.parse(text) : null)
  } catch {
    return DEFAULT_AUTO_SYNC_SETTINGS
  }
}

let current: AutoSyncSettings | null = null
const listeners = new Set<() => void>()

export const autoSyncSettings = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  getSnapshot: (): AutoSyncSettings => (current ??= read()),
  /** Throws when it cannot be saved (the page says so). */
  set: (next: AutoSyncSettings) => {
    const normalized = normalizeAutoSyncSettings(next)
    localStorage.setItem(KEY, JSON.stringify(normalized))
    current = normalized
    listeners.forEach(fn => fn())
  },
}
