// ACB foundation (chat's job proposal card and jobs' 「出した案」): what the server last answered for each candidate, so a
// 「取り下げる」 pressed in 「定期の仕事」 updates a card open in the chat. It cannot live in either feature (features never import
// each other). Read through useSyncExternalStore: the first subscriber starts the load (no effect), every card showing the
// same candidate sees the same answer, and a read never overwrites a newer act of the member. **Never a cache across showings**: the entry is dropped when its last card goes, so a
// reopened conversation reads the server again (an approval or return since, a candidate withheld since); a failed load is
// shown but kept only while the card is on screen, and 読み直す (`reloadJobCandidate`) asks again.
import type { JobCandidateResult } from '../../../shared/job-proposals'

const entries = new Map<string, JobCandidateResult>()
const listeners = new Map<string, Set<() => void>>()
const loaders = new Map<string, () => Promise<JobCandidateResult>>()
const loading = new Set<string>()

export const jobProposalKey = (companyId: string, candidateId: string) => `${companyId}|${candidateId}`

/** null while it has not been read yet. */
export function jobProposalEntry(key: string): JobCandidateResult | null {
  return entries.get(key) ?? null
}

function notify(key: string) {
  for (const l of listeners.get(key) ?? []) l()
}

/**
 * Each read and each of the member's acts takes the next number for its candidate: a read's answer counts only while its
 * number is still the newest — so a read that started before a 「これで管理者に出す」 / 「取り下げる」 / 「やめる」 (or before a newer
 * read) never puts back what the act replaced (Codex re-review of PR C). Kept for the session (numbers only, never reused).
 */
const generation = new Map<string, number>()
function nextGeneration(key: string): number {
  const g = (generation.get(key) ?? 0) + 1
  generation.set(key, g)
  return g
}

/**
 * An answer while a card shows it: a success replaces the copy; a failure keeps a success read before (the content does
 * not vanish on a moment offline) and is shown only when there is none. Nobody showing it → nothing kept.
 */
function take(key: string, r: JobCandidateResult): void {
  if (!listeners.has(key)) return
  const prev = entries.get(key)
  const next = r.success || !prev?.success ? r : prev
  if (next === prev) return
  entries.set(key, next)
  notify(key)
}

/**
 * The answer of the member's own act on the card (its submit, withdrawal, discard): shown at once, newer than any read on
 * its way (that read's answer is dropped), then the server is read once more to confirm.
 */
export function putJobProposal(key: string, r: JobCandidateResult): void {
  nextGeneration(key)
  take(key, r)
  load(key)
}

const again = new Set<string>()

/** A read already on its way may predate what changed: one more read after it (never two at once). */
function load(key: string) {
  const loader = loaders.get(key)
  if (!loader) return
  if (loading.has(key)) { again.add(key); return }
  loading.add(key)
  const started = nextGeneration(key)
  void loader().then(r => { if (generation.get(key) === started) take(key, r) }, () => {}).finally(() => {
    loading.delete(key)
    if (again.delete(key)) load(key)
  })
}

export function subscribeJobProposal(key: string, loader: () => Promise<JobCandidateResult>, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, set = new Set())
  set.add(listener)
  loaders.set(key, loader)
  if (!entries.has(key)) load(key)
  return () => {
    set!.delete(listener)
    if (set!.size > 0) return
    // The last card went: forget it, so the next showing reads the server again.
    listeners.delete(key)
    entries.delete(key)
    loaders.delete(key)
  }
}

/** 読み直す on a card (and after a refusal that says it moved on): ask the server again. */
export function reloadJobCandidate(key: string): void {
  load(key)
}

/**
 * Something about the candidate's proposal changed elsewhere (「出した案」's 「取り下げる」): a card showing it reads it again;
 * nobody showing it → nothing to do (the next showing reads anyway).
 */
export function jobCandidateChanged(companyId: string, candidateId: string): void {
  load(jobProposalKey(companyId, candidateId))
}
