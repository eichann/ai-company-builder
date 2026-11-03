// ACB foundation: 「落とすと、つながります」 on a record — the tasks feature (card, list rows) and the
// records feature (record card, 案件) both take drops, so the port is shared. Small ports over the
// IPC contract; every function takes its port last, defaulting to window.electronAPI.
import type { DroppedThing } from '../../../shared/link-drop'
import type { ElectronPort } from './electron-api'

/** Linking what was dropped (the server decides), and 取り消す right after. */
export type LinkDrops = ElectronPort<'dropLinkOnRecord' | 'undoTaskAction'>
/** A consultation dropped on a record becomes a consultation about it (this PC's history only). */
export type ConsultationTopics = ElectronPort<'patchChatSession'>

export function dropLinkOnRecord(companyId: string, targetId: string, dropped: DroppedThing, link?: string, port: LinkDrops = window.electronAPI) {
  return port.dropLinkOnRecord(companyId, targetId, dropped, link)
}

export function undoDropLink(companyId: string, recordId: string, version: number, port: LinkDrops = window.electronAPI) {
  return port.undoTaskAction(companyId, recordId, version, version)
}

/** null takes the topic off (and no topic is set by itself again: `topicDetached`). */
export function setConsultationTopic(companyId: string, sessionId: string, topicRecordId: string | null, port: ConsultationTopics = window.electronAPI) {
  return port.patchChatSession(companyId, sessionId, { topicRecordId })
}
