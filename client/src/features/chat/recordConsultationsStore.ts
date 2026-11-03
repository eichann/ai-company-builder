import { useCallback, useSyncExternalStore } from 'react'
import type { ChatSessionSummary } from '../../../shared/chat-history'
import type { LinkedConsultation } from '../../shared/ui/consultationLinks'
import { getChatSessionSummaries, onChatHistoryChanged } from './api'

// The consultations about each record (主な話題), for a record's 「つながっているもの」: read from
// this PC's history when the first screen asks, and again whenever that company's history changes.

/** Consultations whose main topic is a record, by record id, newest first. */
export function consultationsByRecord(sessions: readonly ChatSessionSummary[]): ReadonlyMap<string, LinkedConsultation[]> {
  const out = new Map<string, LinkedConsultation[]>()
  for (const s of [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (!s.topicRecordId) continue
    out.set(s.topicRecordId, [...(out.get(s.topicRecordId) ?? []), { sessionId: s.id, title: s.title, updatedAt: s.updatedAt }])
  }
  return out
}

const NONE: ReadonlyMap<string, LinkedConsultation[]> = new Map()
const byCompany = new Map<string, ReadonlyMap<string, LinkedConsultation[]>>()

function subscribeTo(companyId: string, listener: () => void): () => void {
  let alive = true
  const read = () => {
    getChatSessionSummaries(companyId).then(s => {
      if (!alive) return
      byCompany.set(companyId, consultationsByRecord(s))
      listener()
    }, () => {})
  }
  read()
  const off = onChatHistoryChanged(change => { if (change.companyId === companyId) read() })
  return () => { alive = false; off() }
}

export function useLinkedConsultations(companyId: string | undefined): ReadonlyMap<string, LinkedConsultation[]> {
  const subscribe = useCallback((listener: () => void) => (companyId ? subscribeTo(companyId, listener) : () => {}), [companyId])
  return useSyncExternalStore(subscribe, () => (companyId ? byCompany.get(companyId) ?? NONE : NONE))
}
