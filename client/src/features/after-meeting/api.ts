// 「会議のあと」's access to the main process (src/shared/ipc/electron-api.ts): small ports, each function taking its port last.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { AfterMeetingChange } from '../../../shared/after-meeting'

/** The run's files on this PC (更新案.json, result.json) and the card's own mark. */
export type AfterMeetingReads = ElectronPort<'readAfterMeeting'>
/** The card's mark on this PC: a press handed to a consultation (never the same item twice), an undo, ［いらない］. */
export type AfterMeetingWrites = ElectronPort<'noteAfterMeeting'>
/** A person's 「元に戻す」 of a HubSpot write (the server's undo: only while the written value is still there). */
export type HubspotUndo = ElectronPort<'undoPluginOperation'>

export function readAfterMeeting(companyId: string, rootPath: string, occurrenceId: string, reads: AfterMeetingReads = window.electronAPI) {
  // A window without it (a preview page, an older preload) shows nothing of this card.
  return reads.readAfterMeeting?.(companyId, rootPath, occurrenceId) ?? Promise.resolve({ success: true as const, run: null })
}

export function noteAfterMeeting(companyId: string, rootPath: string, occurrenceId: string, change: AfterMeetingChange, writes: AfterMeetingWrites = window.electronAPI) {
  return writes.noteAfterMeeting(companyId, rootPath, occurrenceId, change)
}

export function undoHubspotWrite(companyId: string, pluginId: string, operationId: string, outbound: HubspotUndo = window.electronAPI) {
  return outbound.undoPluginOperation(companyId, pluginId, operationId, undefined)
}
