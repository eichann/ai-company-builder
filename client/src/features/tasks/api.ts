// The task list's access to the main process (stage 2, renderer-structure.md): small
// ports, each function taking its port last (default window.electronAPI).
// Main asks the company server with the member's session; the server decides what the
// member may read and do.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { CalendarTodayResult } from '../../../shared/calendar'
import type { TaskCardResult } from '../../../shared/task-card'
import type { TagSuggestions } from '../../../shared/tag-suggest'
import type { ArchiveCursor, ArchivedTasksResult, BundleChoicesResult, BundleCreateInput, BundleKindsAnswer, RecordLinkInput, TaskActInput, TaskCreateInput, TaskListResult, TaskProposalsResult, TaskWriteResult } from '../../../shared/tasks'

/** Reading the member's own meetings today (no attendee address ever comes back). */
export type CalendarReads = ElectronPort<'getCalendarToday'>
/** Reading the list, and hearing that the member's turn, notices or records may have changed. */
export type TaskReads = ElectronPort<'getTaskList' | 'onNotificationsChanged' | 'onRecordsChanged'>
/** Changing shared state on the server (a new task, an action on one). */
export type TaskWrites = ElectronPort<'createTask' | 'actOnTask' | 'undoTaskAction'>
/** Setting or taking off a link between two records (the server decides which links may change). */
export type RecordLinkWrites = ElectronPort<'linkRecordToRecord' | 'unlinkRecordFromRecord'>
/** 「新しい〇〇にする」: making a 案件・プロジェクト (shared state on the server). */
export type BundleWrites = ElectronPort<'createBundle'>
/** One task's card, and the AI's proposals (案) of a meeting for 「議事録を確認する」. */
export type TaskCardReads = ElectronPort<'getTaskCard' | 'getTaskProposals'>
/** Linking a company file to a task, or taking the link away (the server checks both sides). */
export type TaskFileWrites = ElectronPort<'linkFileToTask' | 'unlinkFileFromTask'>
/** The company's file names on this computer (downloaded folders only), for 「＋ファイルをつなぐ」. */
export type CompanyFileReads = ElectronPort<'gitListFiles'>
/** 「どのまとまりの会議ですか？」: the まとまり to choose from, and linking the chosen one (nothing goes outside). */
export type MeetingBundleReads = ElectronPort<'getBundleChoices'>
/** What each department makes as its 束ねるもの and the names (案件, 番組, the company's 「プロジェクト」). */
export type BundleKindReads = ElectronPort<'getBundleKinds'>
export type MeetingBundleWrites = ElectronPort<'linkMinutesBundle' | 'declineMinutesBundle'>
/** 「部署に出す」: the member's owner-only task shown to a department's readers (the server checks owner and folder). */
export type TaskShareWrites = ElectronPort<'shareTask'>
/** Tags in use that fit a title: main asks a Haiku model through the company's key (only the title and the tags), else matches locally. */
export type TagSuggestionReads = ElectronPort<'suggestTaskTags'>
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

/** The folded 「アーカイブ」: archived tasks, newest first, one page (20) from `cursor`. */
export type ArchiveReads = ElectronPort<'getArchivedTasks'>

export function getArchivedTasks(companyId: string, cursor: ArchiveCursor, reads: ArchiveReads = window.electronAPI): Promise<ArchivedTasksResult> {
  return reads.getArchivedTasks(companyId, cursor)
}

/**
 * `listener` hears that this company's 「あなたの番」, notices or records may have changed (the
 * title bar keeps main watching; `records:changed` comes at once when the member's own AI wrote a
 * record, and on every records signal of the push channel). This only listens.
 */
export function onTasksMayHaveChanged(companyId: string, listener: () => void, reads: TaskReads = window.electronAPI): () => void {
  const mine = (change: { companyId: string }) => { if (change.companyId === companyId) listener() }
  const stops = [reads.onNotificationsChanged(mine), reads.onRecordsChanged?.(mine)]
  return () => { for (const stop of stops) stop?.() }
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

/** Whether a linked file inside a `.personal/` folder (never synced) is on this computer. */
export type PersonalFileReads = ElectronPort<'exists'>

export function fileIsHere(absPath: string, reads: PersonalFileReads = window.electronAPI): Promise<boolean> {
  return reads.exists(absPath)
}

/** Company-relative paths of the files on this computer. */
export function listCompanyFiles(rootPath: string, reads: CompanyFileReads = window.electronAPI) {
  return reads.gitListFiles(rootPath, '')
}

export function getBundleKinds(companyId: string, reads: BundleKindReads = window.electronAPI): Promise<BundleKindsAnswer> {
  return reads.getBundleKinds(companyId)
}

export function getBundleChoices(companyId: string, reads: MeetingBundleReads = window.electronAPI): Promise<BundleChoicesResult> {
  return reads.getBundleChoices(companyId)
}

export function linkMeetingBundle(companyId: string, meetingId: string, bundleId: string, writes: MeetingBundleWrites = window.electronAPI) {
  return writes.linkMinutesBundle(companyId, meetingId, bundleId)
}

/** 「まとまりはない（社内の会議など）」: the server closes the question for good (no AI turn). */
export function declineMeetingBundle(companyId: string, meetingId: string, writes: MeetingBundleWrites = window.electronAPI) {
  return writes.declineMinutesBundle(companyId, meetingId)
}

/** `folder`: a department folder as the company names it (`営業`). Never undone. */
export function shareTaskToFolder(companyId: string, recordId: string, folder: string, expectedVersion: number, writes: TaskShareWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.shareTask(companyId, recordId, folder, expectedVersion)
}

/** Only suggestions: the member chooses. Never fails (no AI → the app's own matching). */
export function suggestTaskTags(companyId: string, title: string, tagsInUse: string[], reads: TagSuggestionReads = window.electronAPI): Promise<TagSuggestions> {
  return reads.suggestTaskTags(companyId, title, tagsInUse)
}

/** 「取り消す」 right after the member's own action: undoes ledger `version` (the server decides). */
export function undoTaskAction(companyId: string, recordId: string, version: number, expectedVersion: number, writes: TaskWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.undoTaskAction(companyId, recordId, version, expectedVersion)
}

/** Links `recordId` to another record (`link` names it there; a `one` link is replaced), or takes that link off. */
export function setRecordLink(companyId: string, recordId: string, input: RecordLinkInput, remove: boolean, writes: RecordLinkWrites = window.electronAPI): Promise<TaskWriteResult> {
  return remove ? writes.unlinkRecordFromRecord(companyId, recordId, input) : writes.linkRecordToRecord(companyId, recordId, input)
}

/** The AI's proposals (案) from one meeting, proposed and put away. */
export function getTaskProposals(companyId: string, meetingId: string, reads: TaskCardReads = window.electronAPI): Promise<TaskProposalsResult> {
  return reads.getTaskProposals(companyId, meetingId)
}

/** A new 案件・プロジェクト of the department's kind, the member its 責任者; answers its id. */
export function createBundle(companyId: string, input: BundleCreateInput, writes: BundleWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.createBundle(companyId, input)
}
