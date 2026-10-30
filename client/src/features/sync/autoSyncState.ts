// The automatic-sync state per company on this computer (localStorage
// `acb.autoSync.state:<companyId>`): last runs, the "waits for the member"
// stop and the failure notices already shown. Unreadable → empty state.
import { useSyncExternalStore } from 'react'
import { EMPTY_AUTO_SYNC_STATE, type AutoSyncState } from './autoSyncSchedule'

const key = (companyId: string) => `acb.autoSync.state:${companyId}`
const listeners = new Set<() => void>()
const cache = new Map<string, AutoSyncState>()

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function parse(text: string | null): AutoSyncState {
  if (!text) return EMPTY_AUTO_SYNC_STATE
  const raw = JSON.parse(text) as Record<string, Record<string, unknown> | unknown>
  const run = (v: unknown) => {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    return { lastRunAt: num(r.lastRunAt), lastSkipAt: num(r.lastSkipAt) }
  }
  return {
    receive: run(raw.receive),
    send: run(raw.send),
    lastAutoSyncAt: num(raw.lastAutoSyncAt),
    needsMember: raw.needsMember === true,
    notified: Array.isArray(raw.notified) ? raw.notified.filter((k): k is string => typeof k === 'string') : [],
  }
}

export function readAutoSyncState(companyId: string): AutoSyncState {
  const cached = cache.get(companyId)
  if (cached) return cached
  let state = EMPTY_AUTO_SYNC_STATE
  try { state = parse(localStorage.getItem(key(companyId))) } catch { /* unreadable: start empty */ }
  cache.set(companyId, state)
  return state
}

export function updateAutoSyncState(companyId: string, update: (state: AutoSyncState) => AutoSyncState): AutoSyncState {
  const next = update(readAutoSyncState(companyId))
  cache.set(companyId, next)
  try { localStorage.setItem(key(companyId), JSON.stringify(next)) } catch { /* kept in memory for this session */ }
  listeners.forEach(fn => fn())
  return next
}

export function useAutoSyncState(companyId: string | undefined): AutoSyncState {
  return useSyncExternalStore(
    fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    () => (companyId ? readAutoSyncState(companyId) : EMPTY_AUTO_SYNC_STATE),
  )
}
