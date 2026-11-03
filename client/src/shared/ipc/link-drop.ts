// ACB foundation: 「落とすと、つながります」 on a record — the tasks feature (card, list rows) and the
// records feature (record card, 案件) both take drops, so the port is shared. Small ports over the
// IPC contract; every function takes its port last, defaulting to window.electronAPI.
import type { DroppedThing } from '../../../shared/link-drop'
import type { ElectronPort } from './electron-api'

/** Linking what was dropped (the server decides), and 取り消す right after. */
export type LinkDrops = ElectronPort<'dropLinkOnRecord' | 'undoTaskAction'>
/**
 * A consultation dropped on a record becomes a consultation about it (this PC's history only); the
 * titles of its topic now and of the record are read for 「…に切り替えますか？」.
 */
export type ConsultationTopics = ElectronPort<'patchChatSession' | 'getConsultationTopics'>

export function dropLinkOnRecord(companyId: string, targetId: string, dropped: DroppedThing, link?: string, port: LinkDrops = window.electronAPI) {
  return port.dropLinkOnRecord(companyId, targetId, dropped, link)
}

export function undoDropLink(companyId: string, recordId: string, version: number, port: LinkDrops = window.electronAPI) {
  return port.undoTaskAction(companyId, recordId, version, version)
}

/** null takes the topic off (and no topic is set by itself again: `topicDetached`). */
/** The titles of records as the member may read them (`recordViews:topics`); unreadable ones are left out. */
export async function topicTitles(companyId: string, recordIds: string[], port: ConsultationTopics = window.electronAPI): Promise<Record<string, string>> {
  const r = await port.getConsultationTopics(companyId, recordIds).catch(() => null)
  if (!r?.success) return {}
  const out: Record<string, string> = {}
  for (const [id, t] of Object.entries(r.topics)) {
    const look = t?.own?.id === id ? t.own : t?.bundle?.id === id ? t.bundle : null
    if (look) out[id] = look.title
  }
  return out
}

export function setConsultationTopic(companyId: string, sessionId: string, topicRecordId: string | null, port: ConsultationTopics = window.electronAPI) {
  return port.patchChatSession(companyId, sessionId, { topicRecordId })
}
