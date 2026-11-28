// A change sent from a 「定期の仕事の案」 card (「その場で直す」), kept per candidate — not per card — so every card showing it (the
// chat's and the ［大きく開く］ tab's) waits while it is checked, and a read after an answer that never came compares the
// candidate with exactly what was sent (Codex review of UX 段3 #13). Memory only.
import type { JobCandidateInput } from '../../../../shared/core/job-proposals'

export interface Revising {
  /** Sent and not answered yet: every card of the candidate shows it and offers nothing else. */
  checking: JobCandidateInput | null
  /** The last change sent: what a read after an unknown answer is judged by. */
  sent: JobCandidateInput | null
}

const NONE: Revising = { checking: null, sent: null }
const states = new Map<string, Revising>()
const listeners = new Map<string, Set<() => void>>()

export function revisingOf(key: string): Revising {
  return states.get(key) ?? NONE
}

export function subscribeRevising(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, set = new Set())
  set.add(listener)
  return () => { set!.delete(listener); if (set!.size === 0) listeners.delete(key) }
}

function put(key: string, next: Revising) {
  if (next.checking === null && next.sent === null) states.delete(key)
  else states.set(key, next)
  for (const l of listeners.get(key) ?? []) l()
}

/** A change goes out: shown as checked until `revisionAnswered`. False when another change of it is still out (nothing sent). */
export function startRevision(key: string, input: JobCandidateInput): boolean {
  if (revisingOf(key).checking !== null) return false
  put(key, { checking: input, sent: input })
  return true
}

/** Its answer came (or it is now judged by reading the candidate): the cards are offered again; `sent` is kept for that read. */
export function revisionAnswered(key: string): void {
  put(key, { ...revisingOf(key), checking: null })
}
