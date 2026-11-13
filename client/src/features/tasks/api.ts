// The task list's access to the main process (stage 2, renderer-structure.md): small
// ports, each function taking its port last (default window.electronAPI).
// Main asks the company server with the member's session; the server decides what the
// member may read and do.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { CalendarTodayResult } from '../../../shared/calendar'
import type { GoogleStatusResult } from '../../../shared/google'
import type { TaskCardResult } from '../../../shared/task-card'
import type { TagSuggestions } from '../../../shared/tag-suggest'
import { privateBundleFolderNames } from './model'
import type { ArchiveCursor, ArchivedTasksResult, BundleChoicesResult, BundleCreateInput, BundleKindsAnswer, RecordLinkInput, TaskActInput, TaskCreateInput, TaskDriveChoice, TaskDriveLinkOptions, TaskDriveLinkResult, TaskListResult, TaskProposalsResult, TaskWriteResult, TypedFileTarget } from '../../../shared/tasks'

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

/**
 * A 非公開 案件・プロジェクト (records.md "Private 案件・プロジェクト"): who may make one (the private-folder
 * rights: role and managed departments) and its private folder, made by the existing private-folder
 * route — a person's press only, never the chat.
 */
export type PrivateBundleWrites = ElectronPort<'getPrivateFolderCreateContext' | 'createPrivateFolder'>

export async function privateBundleRights(companyId: string, ports: PrivateBundleWrites = window.electronAPI): Promise<{ role: string; managedDepartmentIds: string[] } | null> {
  const r = await ports.getPrivateFolderCreateContext(companyId, '').catch(() => null)
  return r?.success ? { role: r.context.role, managedDepartmentIds: r.context.managedDepartmentIds } : null
}

/** Makes the private folder under `parent` ('' = the company root) with the first free name: its path, or the reason in words. */
export async function createPrivateBundleFolder(companyId: string, parent: string, names: string[], ports: ElectronPort<'createPrivateFolder'> = window.electronAPI): Promise<{ path: string; scopeId: string } | { error: string }> {
  for (const name of names) {
    const r = await ports.createPrivateFolder(companyId, { parentPath: parent, name }).catch(() => null)
    if (r?.success) return { path: r.path, scopeId: r.scopeId }
    if (r?.code !== 'FOLDER_NAME_UNAVAILABLE') return { error: r?.error || 'サーバーに接続できませんでした。' }
  }
  return { error: '同じ名前のフォルダがあるため作れませんでした。名前を変えてください。' }
}
/**
 * 「非公開にする」 on an existing 案件・プロジェクト (records.md "Making a 案件・プロジェクト private"): its own private
 * folder (as 「新しい〇〇にする」 makes one), the people it names added as participants, then the move.
 */
export type BundlePrivateWrites = ElectronPort<'makeBundlePrivatePlan' | 'createPrivateFolder' | 'getPrivateFolderMembers' | 'setPrivateFolderMembers' | 'makeBundlePrivate'>

const OFFLINE = 'サーバーに接続できませんでした。'

/**
 * Makes the 案件 `bundle` private. First the server's plan is asked again: refused, blocked or changed
 * meanwhile → nothing is made. Then its private folder in the plan's department (named after it), the
 * plan's people added as participants (the server already made the member and the department's managers
 * ones), then the server's move. A move refused after the folder was made puts the participants back as
 * the folder was made (the member and the managers only) and says, in words, that the empty folder is
 * left — the app cannot delete a private folder (owners / admins do, in the admin console).
 * null = done, else the reason in words.
 */
export async function makeExistingBundlePrivate(
  companyId: string, bundle: { id: string; title: string; version: number }, word: string,
  ports: BundlePrivateWrites = window.electronAPI,
): Promise<string | null> {
  const plan = await ports.makeBundlePrivatePlan(companyId, bundle.id).catch(() => null)
  if (!plan?.success) return plan?.error || OFFLINE
  const offer = plan.offer
  if (offer.blocked) return `つながっているやることや記録の中に、あなたからは見える範囲を変えられないものがあるため、非公開にできません。管理者に相談してください。`
  if (offer.version !== bundle.version) return `ほかの人が先にこの${word}を変えました。画面を開き直してから、もう一度お試しください。`
  const made = await createPrivateBundleFolder(companyId, offer.parent, privateBundleFolderNames(bundle.title, word), ports)
  if ('error' in made) return made.error
  const left = (why: string, restored: boolean) => `非公開にできませんでした。${why}\n作りかけた非公開のフォルダ「${made.path}」は、中身がないまま残っています（見られるのはあなたと部署の管理役・管理者だけです）。要らなければ管理者に消してもらってください。${restored ? '' : 'このフォルダに足した人を外せなかったので、管理者に相談してください。'}`
  const first = await ports.getPrivateFolderMembers(companyId, made.scopeId).catch(() => null)
  if (!first?.success) return left(first?.error || OFFLINE, true)
  const named = first.members.filter(m => m.via === 'rule')
  const before = { viewers: named.map(m => m.userId), editors: named.filter(m => m.canWrite).map(m => m.userId) }
  const people = offer.people.map(p => p.id)
  const added = people.some(id => !before.viewers.includes(id))
  if (added) {
    const set = await ports.setPrivateFolderMembers(companyId, made.scopeId, {
      viewers: [...new Set([...before.viewers, ...people])], editors: [...new Set([...before.editors, ...people])],
    }).catch(() => null)
    if (!set?.success) return left(set?.error || OFFLINE, true)
  }
  const r = await ports.makeBundlePrivate(companyId, bundle.id, made.path, offer.version).catch(() => null)
  if (r?.success) return null
  // Refused: nobody but who the folder was made for keeps it.
  const restored = !added || (await ports.setPrivateFolderMembers(companyId, made.scopeId, before).catch(() => null))?.success === true
  return left(r?.error || OFFLINE, restored)
}

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
export type TaskShareWrites = ElectronPort<'shareTask' | 'shareTaskToBundle'>
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

/**
 * A company without the shared folder (records.md "File links without the shared folder"): a PC
 * file or a Drive file taken off a task, and 「Google Drive のファイルをつなぐ」 (Google Picker, then the links).
 */
export type TypedFileWrites = ElectronPort<'unlinkTargetFromTask' | 'linkDriveFilesToTask' | 'getTaskDriveChoices'>

export function unlinkTargetFromTask(companyId: string, recordId: string, target: TypedFileTarget, expectedVersion: number, writes: TypedFileWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.unlinkTargetFromTask(companyId, recordId, target, expectedVersion)
}

export function linkDriveFilesToTask(companyId: string, recordId: string, expectedVersion: number, options?: TaskDriveLinkOptions, writes: TypedFileWrites = window.electronAPI): Promise<TaskDriveLinkResult> {
  return writes.linkDriveFilesToTask(companyId, recordId, expectedVersion, options)
}

/** The member's own Drive files offered before the Picker (their picks and their AI's puts). */
export function getTaskDriveChoices(companyId: string, writes: TypedFileWrites = window.electronAPI): Promise<TaskDriveChoice[]> {
  return writes.getTaskDriveChoices(companyId)
}

/**
 * Whether ［Google Drive のファイルをつなぐ］ can work for the member: their Google status as the
 * server answers it (no token; the same read as 設定 → Google).
 */
export type DriveSetupReads = ElectronPort<'getGoogleStatus'>

export function getDriveSetup(companyId: string, reads: DriveSetupReads = window.electronAPI): Promise<GoogleStatusResult> {
  return reads.getGoogleStatus(companyId)
}

/** A Drive file opened in the member's browser (Drive decides who may see it). */
export type DriveFileOpening = ElectronPort<'openExternal'>

export function openOutside(url: string, links: DriveFileOpening = window.electronAPI) {
  return links.openExternal(url)
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

/** ［〇〇の人に見せる］: shown to the people of the 案件・プロジェクト it belongs to (the server finds where that is). */
export function shareTaskToBundle(companyId: string, recordId: string, expectedVersion: number, writes: TaskShareWrites = window.electronAPI): Promise<TaskWriteResult> {
  return writes.shareTaskToBundle(companyId, recordId, expectedVersion)
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
