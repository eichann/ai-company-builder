// The task list's access to the main process (stage 2, renderer-structure.md): small
// ports, each function taking its port last (default window.electronAPI).
// Main asks the company server with the member's session; the server decides what the
// member may read and do.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { CalendarTodayResult } from '../../../shared/calendar'
import type { TaskActInput, TaskCreateInput, TaskListResult, TaskWriteResult } from '../../../shared/tasks'

/** Reading the member's own meetings today (no attendee address ever comes back). */
export type CalendarReads = ElectronPort<'getCalendarToday'>
/** Reading the list, and hearing that the member's turn or notices may have changed. */
export type TaskReads = ElectronPort<'getTaskList' | 'onNotificationsChanged'>
/** Changing shared state on the server (a new task, an action on one). */
export type TaskWrites = ElectronPort<'createTask' | 'actOnTask'>

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
