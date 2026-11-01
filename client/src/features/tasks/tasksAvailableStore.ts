// Whether a company uses tasks (records on and a `task` type), read through useSyncExternalStore:
// the first subscriber starts the check, and while the answer is no (off, offline or unsure) it
// asks again when the window regains focus — records may have been turned on meanwhile. A yes is
// kept for the session (if records are turned off later, the chooser says so).
import { getTasksAvailable } from './api'

const available = new Set<string>()
const checking = new Set<string>()
const listeners = new Map<string, Set<() => void>>()

function check(companyId: string): void {
  if (available.has(companyId) || checking.has(companyId)) return
  checking.add(companyId)
  getTasksAvailable(companyId)
    .catch(() => false)
    .then(yes => {
      checking.delete(companyId)
      if (!yes) return
      available.add(companyId)
      for (const l of listeners.get(companyId) ?? []) l()
    })
}

export function subscribeTasksAvailable(companyId: string, listener: () => void): () => void {
  let set = listeners.get(companyId)
  if (!set) listeners.set(companyId, set = new Set())
  set.add(listener)
  check(companyId)
  const onFocus = () => check(companyId)
  window.addEventListener('focus', onFocus)
  return () => {
    window.removeEventListener('focus', onFocus)
    set.delete(listener)
    if (set.size === 0) listeners.delete(companyId)
  }
}

export const tasksAvailable = (companyId: string): boolean => available.has(companyId)
