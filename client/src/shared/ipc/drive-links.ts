// ACB foundation: Google Drive files linked to a record — the tasks feature (the task card) and the records
// feature (the 案件・プロジェクト card) both link, show and take them off (records.md "Drive and PC file links",
// owner decision 2026-11-13), so the port is shared. Small ports over the IPC contract (the channels keep their
// `tasks:` names: they take any record id); every function takes its port last, defaulting to window.electronAPI.
import type { ElectronPort } from './electron-api'
import type { GoogleStatusResult } from '../../../shared/google'
import type { TaskDriveChoice, TaskDriveLinkOptions, TaskDriveLinkResult, TaskWriteResult, TypedFileTarget } from '../../../shared/tasks'

/** A Drive file (or, without the shared folder, a PC file) taken off a record; 「Google Drive のファイルをつなぐ」. */
export type TypedFileWrites = ElectronPort<'unlinkTargetFromTask' | 'linkDriveFilesToTask' | 'getTaskDriveChoices'>

/** The card's ［やめる］ while Google's chooser is open. */
export type DrivePickStopping = ElectronPort<'stopDrivePick'>

/** Stops waiting for Google's chooser (the pick ticket is closed; nothing is linked). */
export function stopDrivePick(companyId: string, port: DrivePickStopping = window.electronAPI) {
  return port.stopDrivePick(companyId)
}

export function unlinkTypedFile(companyId: string, recordId: string, target: TypedFileTarget, expectedVersion: number, writes: TypedFileWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.unlinkTargetFromTask(companyId, recordId, target, expectedVersion)
}

/** Google Picker (or `chosen` from the member's own list), then each file linked to the record. */
export function linkDriveFiles(companyId: string, recordId: string, expectedVersion: number, options?: TaskDriveLinkOptions, writes: TypedFileWrites = window.electronAPI): Promise<TaskDriveLinkResult> {
  return writes.linkDriveFilesToTask(companyId, recordId, expectedVersion, options)
}

/** The member's own Drive files offered before the Picker (their picks and their AI's puts). */
export function getDriveChoices(companyId: string, writes: TypedFileWrites = window.electronAPI): Promise<TaskDriveChoice[]> {
  return writes.getTaskDriveChoices(companyId)
}

/** Whether ［Google Drive のファイルをつなぐ］ can work for the member: their Google status (no token). */
export type DriveSetupReads = ElectronPort<'getGoogleStatus'>

export function getDriveSetup(companyId: string, reads: DriveSetupReads = window.electronAPI): Promise<GoogleStatusResult> {
  return reads.getGoogleStatus(companyId)
}

/** A Drive file opened in the member's browser (Drive decides who may see it). */
export type DriveFileOpening = ElectronPort<'openExternal'>

export function openDriveFile(url: string, links: DriveFileOpening = window.electronAPI) {
  return links.openExternal(url)
}
