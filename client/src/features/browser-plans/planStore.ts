// The plan cards' copy of each plan as main last answered it (keyed by company and plan), read through
// useSyncExternalStore: the first subscriber (again) starts a load (no effect), every card showing the same
// plan — in the chat, in the inbox later — sees the same answer, and a press reloads them all.
import type { BrowserPlanCardData, BrowserPlanGetResult } from '../../../shared/browser-plans'

export interface PlanEntry {
  card: BrowserPlanCardData | null
  /** Why it could not be read, when there is no card. */
  error: string | null
}

const EMPTY: PlanEntry = Object.freeze({ card: null, error: null }) as PlanEntry
const entries = new Map<string, PlanEntry>()
const listeners = new Map<string, Set<() => void>>()
const loading = new Set<string>()

export const planKey = (userId: string, companyId: string, planId: string) => `${userId}|${companyId}|${planId}`
export const planEntry = (key: string): PlanEntry => entries.get(key) ?? EMPTY

// 「A plan's state moved」 on any card (approved and run, cancelled, confirmed, a result settled): what the inbox
// reads again on. Only a change of state counts, so a card's 15 s re-read of the same answer tells nothing.
const stateOf = (e: PlanEntry | undefined) => (e?.card ? `${e.card.plan.state}|${e.card.plan.execution?.state ?? ''}` : '')
let movedVersion = 0
const movedListeners = new Set<() => void>()
export const planStatesVersion = () => movedVersion
export function subscribePlanStates(listener: () => void): () => void {
  movedListeners.add(listener)
  return () => { movedListeners.delete(listener) }
}

/**
 * Take main's answer: a card replaces the copy; the server being out of reach keeps a copy already shown
 * (a 15 s re-read during a blip must not hide what to check); any other failure — not found, not this
 * member's, refused — drops it: what the server no longer shows this member is not shown from memory.
 */
export function putPlan(key: string, r: BrowserPlanGetResult): void {
  const prev = entries.get(key)
  const next: PlanEntry = r.ok ? { card: r.card, error: null } : r.offline && prev?.card ? prev : { card: null, error: r.message }
  if (next === prev) return
  entries.set(key, next)
  for (const l of listeners.get(key) ?? []) l()
  // A card shown for the first time is no move (opening the chat must not make the inbox read).
  if (prev?.card && stateOf(prev) !== stateOf(next)) { movedVersion++; for (const l of movedListeners) l() }
}

export async function reloadPlan(key: string, load: () => Promise<BrowserPlanGetResult>): Promise<void> {
  if (loading.has(key)) return
  loading.add(key)
  try {
    putPlan(key, await load().catch((): BrowserPlanGetResult => ({ ok: false, offline: true, message: 'カードを読み込めませんでした。' })))
  } finally {
    loading.delete(key)
  }
}

export function subscribePlan(key: string, load: () => Promise<BrowserPlanGetResult>, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, set = new Set())
  set.add(listener)
  // The first card showing it (again) reads it: a card reopened after a failure, a login or a run sees the
  // server now; cards shown together share the one read.
  if (set.size === 1) void reloadPlan(key, load)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}
