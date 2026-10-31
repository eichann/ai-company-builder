// The approval cards' copy of each request as the server last answered it (keyed by company and
// request), read through useSyncExternalStore: the first subscriber starts the load, every card
// showing the same request sees the same answer, and an approve / send back updates them all.
import type { ApprovalResult } from '../../../shared/approvals'
import type { ApprovalView } from '../../../../shared/types/approvals'

export interface ApprovalEntry {
  view: ApprovalView | null
  names: Record<string, string>
  /** Why it could not be read (offline, gone…), when there is no view. */
  error: string | null
}

const EMPTY: ApprovalEntry = Object.freeze({ view: null, names: {}, error: null }) as ApprovalEntry
const entries = new Map<string, ApprovalEntry>()
const listeners = new Map<string, Set<() => void>>()
const loading = new Set<string>()

export const approvalKey = (companyId: string, approvalId: string) => `${companyId}|${approvalId}`

export function approvalEntry(key: string): ApprovalEntry {
  return entries.get(key) ?? EMPTY
}

/** Take a server answer: a view replaces the copy; a failure without one keeps the copy (and says why only when there is none). */
export function putApproval(key: string, r: ApprovalResult): void {
  const prev = entries.get(key)
  const next: ApprovalEntry = r.approval
    ? { view: r.approval, names: r.names ?? {}, error: null }
    : prev?.view ? prev : { view: null, names: {}, error: r.success ? null : r.error }
  if (next === prev) return
  entries.set(key, next)
  for (const l of listeners.get(key) ?? []) l()
}

/** Subscribe to one request; the first subscriber for a request not read yet starts `load`. */
export function subscribeApproval(key: string, load: () => Promise<ApprovalResult>, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, set = new Set())
  set.add(listener)
  if (!entries.has(key) && !loading.has(key)) {
    loading.add(key)
    void load().then(r => putApproval(key, r)).finally(() => loading.delete(key))
  }
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listeners.delete(key)
  }
}

/** Forget a request (tests). */
export function clearApprovals(): void {
  entries.clear()
  loading.clear()
}
