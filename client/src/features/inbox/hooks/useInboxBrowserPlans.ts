import { useCallback, useState, useSyncExternalStore } from 'react'
import type { BrowserInboxPlans, BrowserPlanListResult } from '../../../../shared/browser-plans'
import { useInterval } from '../../../shared/hooks/useInterval'

/** How the inbox reads the member's 「ブラウザ操作」 plans (`browserPlans:list`), handed in by AppShell. */
export type InboxBrowserPlanList = (companyId: string) => Promise<BrowserPlanListResult>

/** 「A plan's state moved on some card」 (the plan cards' store, handed in by AppShell): a version and its signal. */
export interface InboxPlanStates { subscribe: (listener: () => void) => () => void; version: () => number }

const NO_STATES: InboxPlanStates = { subscribe: () => () => {}, version: () => 0 }

/** While any plan is open or a run unsettled, read again this often: a run started elsewhere becomes 「届いたか分かりません」. */
export const PLANS_REREAD_MS = 60_000
/**
 * …and this long after the last answer that listed one: a run claimed elsewhere is in neither list until its permit
 * (the server voids a claim without one after 2 minutes), then it is listed again as `permitted` / `unknown`.
 */
export const PLANS_GRACE_MS = 3 * 60_000

type Answer = { companyId: string; inbox: BrowserInboxPlans }

const EMPTY: BrowserInboxPlans = { plans: [], unsure: [] }

/** This inbox's last answer; each (re)subscription with a new key is one read, and only the newest read is taken. */
function createPlanReads() {
  let answer: Answer | null = null
  let newest = ''
  let listedAt: number | null = null
  const listeners = new Set<() => void>()
  const put = (next: Answer | null) => {
    if (next && next.inbox.plans.length + next.inbox.unsure.length > 0) listedAt = Date.now()
    if (next !== answer) { answer = next; for (const l of listeners) l() }
  }
  return {
    answer: () => answer,
    listedAt: () => listedAt,
    subscribe(key: string, companyId: string, list: InboxBrowserPlanList, listener: () => void) {
      listeners.add(listener)
      newest = key
      // The server out of reach keeps the rows shown; any other failure clears them (no longer listed = gone).
      const keep = (offline: boolean) => (offline && answer?.companyId === companyId ? answer : { companyId, inbox: EMPTY })
      void list(companyId).then(
        r => { if (newest === key) put(r.ok ? { companyId, inbox: r.inbox } : keep(r.offline)) },
        () => { if (newest === key) put(keep(true)) },
      )
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * The member's own open plans and unsettled runs for the inbox's rows. Without a `list` (the build's switch
 * off) there is nothing and nothing is read. Read when the company or `readKey` changes (the slot bumps it when
 * the panel opens and when a card closes, so a plan approved or run elsewhere leaves on the next read), when a
 * plan's state moves on any card (［任せる］ in the chat's card), a second after a run's 「済んでいた」/「されていなかった」
 * can first be pressed, and every `PLANS_REREAD_MS` while any plan or run is listed and `PLANS_GRACE_MS` after (then
 * no timer).
 */
export function useInboxBrowserPlans(companyId: string | undefined, list: InboxBrowserPlanList | undefined, readKey: number, planStates: InboxPlanStates = NO_STATES):
  { inbox: BrowserInboxPlans; read: boolean } {
  const [reads] = useState(createPlanReads)
  const [tick, setTick] = useState(0)
  const moved = useSyncExternalStore(planStates.subscribe, planStates.version, planStates.version)
  const key = `${companyId ?? ''}|${readKey}|${tick}|${moved}`
  const subscribe = useCallback((listener: () => void) => (list && companyId ? reads.subscribe(key, companyId, list, listener) : () => {}), [reads, key, companyId, list])
  const answer = useSyncExternalStore(subscribe, reads.answer, reads.answer)
  const shown = list && companyId && answer?.companyId === companyId ? answer.inbox : null
  const now = Date.now()
  const next = Math.min(...(shown?.unsure ?? []).map(e => (e.confirmableAt ? Date.parse(e.confirmableAt) : NaN)).filter(t => Number.isFinite(t) && t > now))
  useInterval(() => setTick(n => n + 1), Number.isFinite(next) ? next - now + 1000 : null)
  const listedAt = reads.listedAt()
  const keepReading = !!shown && listedAt !== null && now - listedAt < PLANS_GRACE_MS
  useInterval(() => setTick(n => n + 1), keepReading ? PLANS_REREAD_MS : null)
  return { inbox: shown ?? EMPTY, read: !list || !companyId || shown !== null }
}
