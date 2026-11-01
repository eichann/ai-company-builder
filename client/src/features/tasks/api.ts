// The task list's access to the main process (stage 2, renderer-structure.md): small
// ports, each function taking its port last (default window.electronAPI).
// Main asks the company server with the member's session; the server decides what the
// member may read and do.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { CalendarTodayResult } from '../../../shared/calendar'
import type { TaskCardResult } from '../../../shared/task-card'
import type { BundleChoicesResult, TaskActInput, TaskCreateInput, TaskListResult, TaskWriteResult } from '../../../shared/tasks'

/** Reading the member's own meetings today (no attendee address ever comes back). */
export type CalendarReads = ElectronPort<'getCalendarToday'>
/** Reading the list, and hearing that the member's turn or notices may have changed. */
export type TaskReads = ElectronPort<'getTaskList' | 'onNotificationsChanged'>
/** Changing shared state on the server (a new task, an action on one). */
export type TaskWrites = ElectronPort<'createTask' | 'actOnTask'>
/** One task's card. */
export type TaskCardReads = ElectronPort<'getTaskCard'>
/** Linking a company file to a task, or taking the link away (the server checks both sides). */
export type TaskFileWrites = ElectronPort<'linkFileToTask' | 'unlinkFileFromTask'>
/** The company's file names on this computer (downloaded folders only), for 「＋ファイルをつなぐ」. */
export type CompanyFileReads = ElectronPort<'gitListFiles'>
/** 「どのまとまりの会議ですか？」: the まとまり to choose from, and linking the chosen one (nothing goes outside). */
export type MeetingBundleReads = ElectronPort<'getBundleChoices'>
export type MeetingBundleWrites = ElectronPort<'linkMinutesBundle'>
/** A run held for a person: 「もう一度」, or what the member found outside (the server records it). */
export type TaskRunWrites = ElectronPort<'retryTaskRun' | 'reconcileTaskRun'>

/**
 * Today's meetings of the member in `companyId`. A calendar that cannot be read
 * (no permission, the connection off) is `success: true` with an empty list and
 * `data.reason`; `success: false` only when the server could not answer.
 */
export function getCalendarToday(companyId: string, reads: CalendarReads = window.electronAPI): Promise<CalendarTodayResult> {
  return reads.getCalendarToday(companyId)
}

export function getTaskList(companyId: string, reads: TaskReads = window.electronAPI): Promise<TaskListResult> {
  return reads.getTaskList(companyId)
}

/**
 * `listener` hears that this company's 「あなたの番」 or notices may have changed
 * (the title bar keeps main watching; this only listens).
 */
export function onTasksMayHaveChanged(companyId: string, listener: () => void, reads: TaskReads = window.electronAPI): () => void {
  return reads.onNotificationsChanged(change => { if (change.companyId === companyId) listener() }) ?? (() => {})
}

export function createTask(companyId: string, input: TaskCreateInput, writes: TaskWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.createTask(companyId, input)
}

export function actOnTask(companyId: string, recordId: string, input: TaskActInput, writes: TaskWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.actOnTask(companyId, recordId, input)
}

export function getTaskCard(companyId: string, recordId: string, reads: TaskCardReads = window.electronAPI): Promise<TaskCardResult> {
  return reads.getTaskCard(companyId, recordId)
}

export function retryTaskRun(companyId: string, runId: string, writes: TaskRunWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.retryTaskRun(companyId, runId)
}

export function reconcileTaskRun(companyId: string, runId: string, key: string, done: boolean, writes: TaskRunWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.reconcileTaskRun(companyId, runId, key, done)
}

/** `companyPath`: inside the company folder (`営業/見積.xlsx`), never a local path. */
export function linkFileToTask(companyId: string, recordId: string, companyPath: string, expectedVersion: number, writes: TaskFileWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.linkFileToTask(companyId, recordId, companyPath, expectedVersion)
}

export function unlinkFileFromTask(companyId: string, recordId: string, companyPath: string, expectedVersion: number, writes: TaskFileWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.unlinkFileFromTask(companyId, recordId, companyPath, expectedVersion)
}

/** Company-relative paths of the files on this computer. */
export function listCompanyFiles(rootPath: string, reads: CompanyFileReads = window.electronAPI) {
  return reads.gitListFiles(rootPath, '')
}

export function getBundleChoices(companyId: string, reads: MeetingBundleReads = window.electronAPI): Promise<BundleChoicesResult> {
  return reads.getBundleChoices(companyId)
}

export function linkMeetingBundle(companyId: string, meetingId: string, bundleId: string, writes: MeetingBundleWrites = window.electronAPI) {
  return writes.linkMinutesBundle(companyId, meetingId, bundleId)
}
