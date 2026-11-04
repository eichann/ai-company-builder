// Records' access to the main process (src/shared/ipc/electron-api.ts): reading only.
// Main asks the company server with the member's session; the server answers only what
// the member may read.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { RemovableLink } from '../../../shared/record-views'

/** A record's card, and the records linked to a file (both read from the company server). */
export type RecordReads = ElectronPort<'getRecordCard' | 'getRecordsForFile'>

export function getRecordCard(companyId: string, recordId: string, reads: RecordReads = window.electronAPI) {
  return reads.getRecordCard(companyId, recordId)
}

/** Opening the original in the member's browser (Google, Slack): their own permission decides there. */
export type OutsideLinks = ElectronPort<'openExternal'>

export function openOutside(url: string, links: OutsideLinks = window.electronAPI) {
  return links.openExternal(url)
}

/** `companyPath`: the file's path inside the company folder (`営業部/見積.md`). */
export function getRecordsForFile(companyId: string, companyPath: string, reads: RecordReads = window.electronAPI) {
  return reads.getRecordsForFile(companyId, companyPath)
}

/** Taking a link between records off from 「つながっているもの」, and 取り消す right after (the server decides). */
export type RecordLinkChanges = ElectronPort<'unlinkRecordFromRecord' | 'undoTaskAction'>

export function unlinkRecord(companyId: string, link: RemovableLink, changes: RecordLinkChanges = window.electronAPI) {
  return changes.unlinkRecordFromRecord(companyId, link.source, { link: link.link, target: link.target, expectedVersion: link.sourceVersion })
}

/** Undoes ledger entry `version` of `recordId` (the record's version is that entry's). */
export function undoRecordChange(companyId: string, recordId: string, version: number, changes: RecordLinkChanges = window.electronAPI) {
  return changes.undoTaskAction(companyId, recordId, version, version)
}

/** A 来た連絡's ［済んだ］ / ［取り込まない］ (owner FB #20): the type's action at the version shown (the server decides). */
export type RecordActions = ElectronPort<'actOnTask'>

export function actOnRecord(companyId: string, recordId: string, action: string, expectedVersion: number, writes: RecordActions = window.electronAPI) {
  return writes.actOnTask(companyId, recordId, { action, expectedVersion })
}
