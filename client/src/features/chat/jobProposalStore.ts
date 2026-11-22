// The job proposal cards' copy of each candidate as the server last answered it (keyed by company and candidate), read
// through useSyncExternalStore: the first subscriber starts the load (no effect), every card showing the same candidate
// sees the same answer, and a press updates them all. A reopened conversation reads it again from the server.
import type { JobCandidateResult } from '../../../shared/job-proposals'

const entries = new Map<string, JobCandidateResult>()
const listeners = new Map<string, Set<() => void>>()
const loading = new Set<string>()

export const jobProposalKey = (companyId: string, candidateId: string) => `${companyId}|${candidateId}`

/** null while it has not been read yet. */
export function jobProposalEntry(key: string): JobCandidateResult | null {
  return entries.get(key) ?? null
}

/** Take a server answer: a failure keeps a copy that was read before (and is shown only when there is none). */
export function putJobProposal(key: string, r: JobCandidateResult): void {
  const prev = entries.get(key)
  const next = r.success || !prev?.success ? r : prev
  if (next === prev) return
  entries.set(key, next)
  for (const l of listeners.get(key) ?? []) l()
}

export function subscribeJobProposal(key: string, load: () => Promise<JobCandidateResult>, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, set = new Set())
  set.add(listener)
  if (!entries.has(key) && !loading.has(key)) {
    loading.add(key)
    void load().then(r => putJobProposal(key, r)).finally(() => loading.delete(key))
  }
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listeners.delete(key)
  }
}
