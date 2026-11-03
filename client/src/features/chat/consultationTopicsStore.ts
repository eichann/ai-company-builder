import { useCallback, useSyncExternalStore } from 'react'
import { MAX_TOPIC_IDS, type ConsultationTopic } from '../../../shared/consultation-topics'
import { getConsultationTopics } from './api'

// The やること / 案件 each consultation is about (by topic record id), asked from the company
// server through main with the member's session: a record they cannot read comes back null.
// Kept per company while the app runs; all of them are asked again when the list is shown and a
// minute has passed (titles change, access is taken away), otherwise only new ids.

type Topics = ReadonlyMap<string, ConsultationTopic | null>
const NONE: Topics = new Map()
const byCompany = new Map<string, Topics>()
const listeners = new Map<string, Set<() => void>>()
const asking = new Map<string, Set<string>>()
const askedAllAt = new Map<string, number>()
const FRESH_MS = 60_000

function ask(companyId: string, ids: string[]) {
  const inFlight = asking.get(companyId) ?? new Set<string>()
  asking.set(companyId, inFlight)
  const fresh = ids.filter(id => !inFlight.has(id))
  for (let i = 0; i < fresh.length; i += MAX_TOPIC_IDS) askOnce(companyId, fresh.slice(i, i + MAX_TOPIC_IDS), inFlight)
}

function askOnce(companyId: string, wanted: string[], inFlight: Set<string>) {
  for (const id of wanted) inFlight.add(id)
  // Never throws into the render that subscribes: a failure only leaves the rows without their record.
  Promise.resolve().then(() => getConsultationTopics(companyId, wanted)).then(answer => {
    if (!answer.success) return
    const next = new Map(byCompany.get(companyId) ?? NONE)
    for (const [id, topic] of Object.entries(answer.topics)) next.set(id, topic)
    byCompany.set(companyId, next)
    for (const listener of listeners.get(companyId) ?? []) listener()
  }, () => {}).finally(() => { for (const id of wanted) inFlight.delete(id) })
}

/** Topics of `recordIds` as far as known: absent = not answered yet (or offline), null = nothing to show. */
export function useConsultationTopics(companyId: string, recordIds: readonly string[]): Topics {
  const key = [...new Set(recordIds)].sort().join('\n')
  const subscribe = useCallback((listener: () => void) => {
    const set = listeners.get(companyId) ?? new Set<() => void>()
    listeners.set(companyId, set)
    const ids = key ? key.split('\n') : []
    const known = byCompany.get(companyId) ?? NONE
    const stale = Date.now() - (askedAllAt.get(companyId) ?? 0) > FRESH_MS
    if (stale && ids.length) askedAllAt.set(companyId, Date.now())
    ask(companyId, stale ? ids : ids.filter(id => !known.has(id)))
    set.add(listener)
    return () => { set.delete(listener) }
  }, [companyId, key])
  return useSyncExternalStore(subscribe, () => byCompany.get(companyId) ?? NONE)
}
