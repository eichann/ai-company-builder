import { useSyncExternalStore } from 'react'
import { sameStatus, type ConsultationStatus } from './consultationStatus'

// Each open tab's status for the 「AIへの相談」 list (lib/consultationStatus.ts),
// keyed by tab id. A tab publishes only when its derived status changes, so a
// streaming reply does not re-render the list per chunk.

type Listener = () => void
const listeners = new Set<Listener>()
let statuses: ReadonlyMap<string, ConsultationStatus> = new Map()

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function replace(next: ReadonlyMap<string, ConsultationStatus>) {
  statuses = next
  for (const listener of listeners) listener()
}

export function publishConsultationStatus(tabId: string, status: ConsultationStatus) {
  const current = statuses.get(tabId)
  if (current && sameStatus(current, status)) return
  replace(new Map(statuses).set(tabId, status))
}

export function clearConsultationStatus(tabId: string) {
  if (!statuses.has(tabId)) return
  const next = new Map(statuses)
  next.delete(tabId)
  replace(next)
}

/** One tab's status now (outside React: an action that depends on it). */
export function consultationStatusOf(tabId: string): ConsultationStatus | undefined {
  return statuses.get(tabId)
}

/** Whether any open tab's status passes `test` now (outside React: the company switch asks before stopping an AI). */
export function someConsultationStatus(test: (status: ConsultationStatus) => boolean): boolean {
  for (const status of statuses.values()) if (test(status)) return true
  return false
}

export function useConsultationStatuses(): ReadonlyMap<string, ConsultationStatus> {
  return useSyncExternalStore(subscribe, () => statuses)
}
