import { useCallback, useState, useSyncExternalStore } from 'react'
import type { BrowserInboxPlans, BrowserPlanListResult } from '../../../../shared/browser-plans'
import { useInterval } from '../../../shared/hooks/useInterval'

/** How the inbox reads the member's 「ブラウザ操作」 plans (`browserPlans:list`), handed in by AppShell. */
export type InboxBrowserPlanList = (companyId: string) => Promise<BrowserPlanListResult>

type Answer = { companyId: string; inbox: BrowserInboxPlans }

const EMPTY: BrowserInboxPlans = { plans: [], unsure: [] }

/** This inbox's last answer; each (re)subscription with a new key is one read, and only the newest read is taken. */
function createPlanReads() {
  let answer: Answer | null = null
  let newest = ''
  const listeners = new Set<() => void>()
  const put = (next: Answer | null) => { if (next !== answer) { answer = next; for (const l of listeners) l() } }
  return {
    answer: () => answer,
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
 * the panel opens and when a card closes, so a plan approved or run elsewhere leaves on the next read) and once
 * more a second after a run's 「済んでいた」/「されていなかった」 can first be pressed (its row then waits for the member).
 */
export function useInboxBrowserPlans(companyId: string | undefined, list: InboxBrowserPlanList | undefined, readKey: number):
  { inbox: BrowserInboxPlans; read: boolean } {
  const [reads] = useState(createPlanReads)
  const [tick, setTick] = useState(0)
  const key = `${companyId ?? ''}|${readKey}|${tick}`
  const subscribe = useCallback((listener: () => void) => (list && companyId ? reads.subscribe(key, companyId, list, listener) : () => {}), [reads, key, companyId, list])
  const answer = useSyncExternalStore(subscribe, reads.answer, reads.answer)
  const shown = list && companyId && answer?.companyId === companyId ? answer.inbox : null
  const now = Date.now()
  const next = Math.min(...(shown?.unsure ?? []).map(e => (e.confirmableAt ? Date.parse(e.confirmableAt) : NaN)).filter(t => Number.isFinite(t) && t > now))
  useInterval(() => setTick(n => n + 1), Number.isFinite(next) ? next - now + 1000 : null)
  return { inbox: shown ?? EMPTY, read: !list || !companyId || shown !== null }
}
