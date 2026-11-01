// 「やることにつなぐ…」's access to the main process (src/shared/ipc/electron-api.ts):
// main asks the company server with the member's session.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { LinkFileResult, OpenTasksResult } from '../../../shared/task-links'

/** Reading the member's open tasks from the company server. */
export type TaskReads = ElectronPort<'getTasksAvailable' | 'getOpenTasks'>
/** Linking a file to a task: changes the shared record (kept in its ledger). */
export type TaskLinkWrites = ElectronPort<'linkFileToTask'>

/** Whether the company uses tasks (records on, a `task` type); false offline. */
export function getTasksAvailable(companyId: string, reads: TaskReads = window.electronAPI): Promise<boolean> {
  return reads.getTasksAvailable(companyId)
}

export function getOpenTasks(companyId: string, reads: TaskReads = window.electronAPI): Promise<OpenTasksResult> {
  return reads.getOpenTasks(companyId)
}

export function linkFileToTask(companyId: string, taskId: string, companyPath: string, seenVersion: number, writes: TaskLinkWrites = window.electronAPI): Promise<LinkFileResult> {
  return writes.linkFileToTask(companyId, taskId, companyPath, seenVersion)
}
