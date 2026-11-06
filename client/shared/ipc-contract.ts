// The IPC contract between the renderer and the main process: every channel,
// what it takes and what it answers, in one place.
//
//  - IpcInvokeChannels  renderer → main, ipcRenderer.invoke ↔ ipcMain.handle
//  - IpcSendChannels    renderer → main, ipcRenderer.send ↔ ipcMain.on
//  - IpcSyncChannels    renderer → main, ipcRenderer.sendSync ↔ ipcMain.on
//                       (the listener sets event.returnValue)
//  - IpcEventChannels   main → renderer, webContents.send ↔ ipcRenderer.on
//  - ElectronAPI        window.electronAPI as preload.ts exposes it, its
//                       methods typed from the channels above
//
// Both ends are checked against it at compile time: preload.ts builds
// `window.electronAPI` as an `ElectronAPI` through typed `invoke` / `send`
// helpers, and the main process registers handlers through a typed registrar
// (electron/ipc/registrar.ts), so a handler's parameters and result must
// match its channel here. tests/ipc-contract.test.ts checks at run time that
// every channel here has exactly one handler and one preload caller, and
// nothing else exists. To add a channel: .claude/rules/ipc-and-main-process.md.
//
// Types only: nothing here runs, and nothing here depends on Electron, Node
// or React — a different shell (Tauri) implements the same contract.

import type { HandoffCompletion, HandoffView } from './handoff'
import type { AgentInteractionRequest, AgentInteractionResponse } from './agent-interaction'
import type { ChatWindowContext, ChatWindowFileRequest, ChatWindowInfo, ChatWindowOpenFileResult, ChatWindowOpenRequest, ChatWindowOpenResult, ChatWindowStatus, ChatWindowsChange } from './chat-windows'
import type { AuthMode, CodexStatus } from './agent'
import type { VoiceCapabilities, VoiceDeviceList, VoiceEvent, VoiceInputAPI } from './voice-input'
import type { VoicePromptSettings } from './voice-prompt'
import type { ChatHistoryChange, ChatMetadataPatch, ChatSaveReceipt, ChatSession, ChatSessionSummary } from './chat-history'
import type { PermissionMode } from './permission-mode'
import type { WriteAccess } from './write-access'
import type { EnvVarStatus } from './env-file'
import type { AutoSyncMode, AutoSyncRendererState, AutoSyncResult } from './auto-sync'
import type { CreatePrivateFolderRequest, CreatePrivateFolderResult, MyPrivateFolder, PrivateFolderCreateContext } from './private-folder-ui'
import type { OwnKeyMoveResult, OwnKeysResult } from './broker-keys'
import type { GoogleConnectResult, GoogleFeature, GoogleStatusResult } from './google'
import type { PluginOperationResult } from './plugin-operations'
import type { ApprovalResult } from './approvals'
import type { AbsenceAddInput, AbsenceAddResult, AbsenceRemoveResult, AbsencesResult } from './absences'
import type { WorkSwitch, WorkSwitchesResult } from './work-switches'
import type { ViewersQuery, ViewersResult } from './viewers'
import type { MeetingArrivalsResult, MeetingBundleQuestionResult, MeetingCardStateResult, MeetingInviteResult, MeetingPressResult, MinutesActionResult, MinutesNoticesResult } from './minutes-app'
import type { NoticesActionResult, NoticesState } from './notifications-app'
import type { FindHomeResult, FindResult, RecordCardResult, RecordListResult } from './record-views'
import type { ConsultationTopicsResult } from './consultation-topics'
import type { CalendarTodayResult } from './calendar'
import type { ArchiveCursor, ArchivedTasksResult, BundleChoicesResult, BundleCreateInput, BundleKindsAnswer, RecordLinkInput, TaskActInput, TaskCreateInput, TaskListResult, TaskProposalsResult, TaskWriteResult } from './tasks'
import type { DroppedThing, DropLinkResult } from './link-drop'
import type { TagSuggestions } from './tag-suggest'
import type { TaskCardResult } from './task-card'
import type { AiTurnClaimResult, AiTurnSettleResult, AutoTurnSettings } from './ai-turns'
import type { MailAttachmentOpenResult, MailAwaitReply, MailDraftEdit, OutboundMailResult } from './outbound-mail'
import type { AppCommandAnswer, AppCommandRequest } from './app-commands'
// Lanes (ipc-and-main-process.md "Lane markers"): add only right under your lane's ▼.
// lane A ▼
import type { GoogleRelayResult } from './google'
import type { SlackConnectResult, SlackFeature, SlackStatusResult } from './slack'
import type { RecordThreadResult } from './threads'
import type { PluginBridgeAnswer } from './plugin-bridge-ops'
import type { PluginPackageRef } from './plugin-bridge'
import type { PluginScreensResult } from './plugin-screens'
// lane A ▲
// lane B ▼
// lane B ▲
// lane C ▼
import type { PluginStepButton, PluginStepStartResult, QueuedPluginStep } from './ai-turn-steps/plugin'
// lane C ▲

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export type GitFileStatus = 'added' | 'modified' | 'deleted'

export interface AuthUser {
  id: string
  email: string
  name: string | null
  image: string | null
  emailVerified: boolean
  /**
   * May this account create a company (GET /api/me; the check POST /api/companies makes)?
   * Absent from an older server: offered, and the server still refuses.
   */
  canCreateCompany?: boolean
}

/** Sign-in / sign-up: whether it worked. The server's answer (it holds the session token) stays in main. */
export interface AuthResult {
  success: boolean
  error?: string
}

export interface SessionResult {
  success: boolean
  user: AuthUser | null
}

export interface CompanyInfo {
  id: string
  name: string
  slug: string
  ownerId: string
  repoPath: string | null
  role: string
  createdAt: string
  updatedAt: string
}

export interface CompaniesResult {
  success: boolean
  data?: CompanyInfo[]
  error?: string
}

export interface CompanyResult {
  success: boolean
  data?: CompanyInfo
  error?: string
}

export interface DepartmentInfo {
  id: string
  companyId: string
  parentId: string | null
  name: string
  nameEn: string | null
  folder: string
  icon: string
  color: string
  description: string | null
  sortOrder: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface DepartmentsResult {
  success: boolean
  data?: DepartmentInfo[]
  error?: string
}

/** A success flag and, on failure, why. */
export interface SimpleResult {
  success: boolean
  error?: string
}

/**
 * A file operation that creates something at a name (new file, rename, move,
 * copy). `name_taken`: something is already there and was left untouched;
 * `error` is then a plain Japanese sentence for the member.
 */
export interface FileOpResult extends SimpleResult {
  /** `refused`: `error` is the sentence to show as it is (a skill file the member may not change, …). */
  code?: 'name_taken' | 'refused'
}

/**
 * The API key as the renderer may see it: never the key itself
 * (electron/services/api-key-store.ts keeps it encrypted, main decrypts it
 * only where it is used).
 */
export interface ApiKeyStatus {
  set: boolean
  /** The key's last four characters, to recognise it. */
  last4?: string
  /** False: this computer cannot encrypt it (no keychain), so a new key cannot be saved. */
  encryptionAvailable: boolean
  /** A key from an older version left in plain text that could not be encrypted here: not used; save it again. */
  storedInPlainText?: boolean
  /** A stored key this computer cannot decrypt (copied settings, reset keychain): enter it again. */
  unreadable?: boolean
}

export interface DirectoryEntry { name: string; isDirectory: boolean; path: string }
/** `children` down to the requested depth (absent below it, and for files). */
export interface DirectoryTreeNode extends DirectoryEntry { children?: DirectoryTreeNode[] }

export interface FileStats { isDirectory: boolean; isFile: boolean; size: number; mtime: string; ctime: string }

/** A watcher event (electron/company-watcher.ts FileChange). */
export interface FileChangeEvent { type: string; path: string }

export interface EditorBackupResult {
  success: boolean
  backupPath?: string
  skipped?: 'missing' | 'outside-company' | 'internal'
  error?: string
}

/** The company .env as the renderer sees it: per name set / last four characters, never a value. */
export interface EnvStatusResult {
  success: boolean
  vars?: Record<string, EnvVarStatus>
  error?: string
}

/**
 * Why a sync (or an automatic send) stopped. Read by released apps' notices
 * (src/features/sync/model.ts) and the automatic-sync stop list. Every value
 * sync produces is named here (editors complete them); a new one is added here.
 */
export type SyncErrorType =
  | 'network' | 'auth' | 'conflict' | 'locked' | 'push_failed' | 'protected_config' | 'write_denied'
  | 'personal_path' | 'local_only_path' | 'reserved_path' | 'needs_member' | 'file_open' | 'unknown'
  // Older or newer apps may send others; readers treat an unknown one as a plain failure.
  | (string & Record<never, never>)

export interface GitResult {
  success: boolean
  error?: string
  message?: string
  remoteUrl?: string
  pushFailed?: boolean
  // Sync-specific fields
  hadConflicts?: boolean
  conflictFiles?: string[]
  // Subset of conflictFiles the server had deleted; sync followed the deletion
  // instead of overwriting with a server version that no longer exists.
  deletedConflictFiles?: string[]
  backupPath?: string
  restoredFolders?: string[]
  ignoredLargeFiles?: string[]
  // Nested repos detected during this sync and excluded on this computer only
  // (.git/info/exclude; never the shared .gitignore)
  excludedNestedRepos?: string[]
  // Files of such a folder that a teammate shared at the same path: this
  // computer's versions were copied to nestedRepoBackupPath before the pull
  nestedRepoBackupFiles?: string[]
  nestedRepoBackupPath?: string
  errorType?: SyncErrorType
  // file_open: files a teammate changed that another app (Excel…) has open here; nothing was replaced
  openFiles?: string[]
  secretDetected?: boolean
  // Agent-execution config paths (.claude/settings.json, .mcp.json, ...) the
  // server refused because only an owner/admin may change them
  protectedFiles?: string[]
  // Protected paths sync put back to the server's version (member's copy in
  // protectedBackupPath)
  restoredProtectedFiles?: string[]
  protectedBackupPath?: string
  // Paths the server refused because the member may not edit their folder
  writeDeniedFiles?: string[]
  // Write-denied paths sync put back to the server's version (member's copy
  // in writeDeniedBackupPath)
  restoredWriteDeniedFiles?: string[]
  writeDeniedBackupPath?: string
  // .personal/ paths the server refused (never shared, for anyone)
  personalFiles?: string[]
  // .personal/ paths sync untracked so the rest could be shared (kept on disk)
  untrackedPersonalFiles?: string[]
  // Files created inside a folder not downloaded on this computer: not
  // shared, moved to outsideCheckoutBackupPath (.backups/<ts>_outside_checkout)
  outsideCheckoutFiles?: string[]
  outsideCheckoutBackupPath?: string
  // Files in a folder named like a private folder: not shared, moved to
  // reservedPathBackupPath (.backups/<ts>_reserved_path)
  reservedPathFiles?: string[]
  reservedPathBackupPath?: string
  // Large files kept on this computer that a teammate shared at the same
  // path: this computer's versions were copied to largeFileBackupPath
  largeFileBackupFiles?: string[]
  largeFileBackupPath?: string
  // On disk when an operation an earlier sync left half-way was cleaned up:
  // copied to recoveryBackupPath (.backups/<ts>_before_recovery)
  recoveredFiles?: string[]
  recoveryBackupPath?: string
  // Private folders deleted because the member may no longer read them (no backup)
  lostPrivateFolders?: string[]
  // Private folders made public; unsynced edits are in madePublicBackupPath
  madePublicFolders?: string[]
  madePublicBackupPath?: string
  // Private folders whose place held something else: moved to movedAsideBackupPath first
  movedAsideFolders?: string[]
  movedAsideBackupPath?: string
  // One entry per readable private folder this sync handled
  privateFolders?: Array<{ path: string; success: boolean; setAside?: boolean; backupPath?: string }>
}

export interface GitPreviewResult {
  success: boolean
  hasChanges: boolean
  changes: { added: string[]; modified: string[]; deleted: string[] }
  totalCount: number
  error?: string
}

export interface GitFileDiffResult {
  success: boolean
  diff: string
  isNewFile?: boolean
  isDeletedFile?: boolean
  error?: string
}

export interface GitCommitFileDiffResult {
  success: boolean
  diff: string
  error?: string
}

export interface GitListFilesResult {
  success: boolean
  files: string[]
  truncated?: boolean
  error?: string
}

// Fixed string, A–Z case-insensitive; ≤20 matches per file, ≤500 in all
// (`truncated`); `text` is cut around the match, `column` = its start.
export interface GitGrepResult {
  success: boolean
  results: Array<{ file: string; line: number; text: string; column?: number }>
  truncated?: boolean
  timedOut?: boolean
  /** A newer search from this window replaced this one. */
  cancelled?: boolean
  error?: string
}

export interface GitLogResult {
  success: boolean
  commits: Array<{
    hash: string
    hashShort: string
    message: string
    author: string
    date: string
  }>
  error?: string
}

/** electron/sync/company-folder.ts (CompanyFolderDecision) */
export type CompanyFolderDecisionView =
  | { action: 'firstSetup' | 'existingClone' | 'uploadExisting' }
  | { action: 'refuse'; reason: 'otherRemote' | 'unrelatedRepo' | 'notEmpty'; message: string }

export interface InspectCompanyFolderResult {
  success: boolean
  decision?: CompanyFolderDecisionView
  error?: string
}

/** Bytes arriving in .git/objects/pack while a download runs. */
export interface DownloadProgress { repoPath: string; receivedBytes: number }

export interface SparseExclusionsResult { success: boolean; excluded: string[]; error?: string }
export interface SparseSetExclusionsResult { success: boolean; enabled?: boolean; excluded?: string[]; error?: string; offline?: boolean }
export interface SparseUncommittedChangesResult { success: boolean; files: string[]; error?: string }

/** git:folderSizes — one level of the folder tree with sizes (electron/sync/folder-sizes.ts). */
export type FolderSizesResponse =
  | {
      success: true
      path: string
      size: number | null
      folders: Array<{ name: string; path: string; size: number | null; files: number | null; hasChildren: boolean; private?: boolean }>
      measured: Record<string, number | null>
      offline: boolean
    }
  | { success: false; error: string }

export interface GitBinaryStatus { bundled: boolean; binary: string }

export interface BackupInfo {
  id: string
  timestamp: string
  reason: string
  files: string[]
  path: string
}

export interface BackupListResult {
  success: boolean
  backups: BackupInfo[]
  error?: string
}

export interface BackupRestoreResult {
  success: boolean
  message?: string
  error?: string
  /** The backup folder holding what was there before the restore (none when nothing was there). */
  keptPath?: string
}

export interface ToolInfo {
  name: string
  displayName: string
  path: string
  hasPackageJson: boolean
  startCommand?: string
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  departmentId: string
  skillPath: string
  group?: string
  isPrivate?: boolean
  isNurturing?: boolean
  files: {
    skillMd: string
    rules?: string[]
    references?: string[]
    scripts?: string[]
    tools?: ToolInfo[]
  }
}

export interface SkillsResult {
  success: boolean
  skills: SkillInfo[]
  error?: string
}

export interface StartToolResult { success: boolean; port?: number; pid?: number; alreadyRunning?: boolean; error?: string }
export interface StopToolResult { success: boolean; message?: string; error?: string }

export interface ClaudeCodeStatus {
  available: boolean
  authenticated: boolean
  cliPath: string | null
  version: string | null
  error: string | null
  checkedAt: number
}

export interface ServerUrlValidation { valid: boolean; error?: string; serverName?: string; version?: string }

export interface ToolApprovalRequest {
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  appSessionId?: string
  reason?: string
}

export type PrivateFoldersFailure = { success: false; offline: boolean; error: string }

export interface ChatServerInfo { port: number; authToken: string }

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** renderer → main: ipcRenderer.invoke(channel, ...args) answers `result`. */
export interface IpcInvokeChannels {
  // Voice input (electron/voice-input.ts)
  'voice:capabilities': { args: []; result: VoiceCapabilities }
  'voice:devices': { args: []; result: VoiceDeviceList }
  'voice:start': { args: [requestId: string, deviceId?: string]; result: void }
  'voice:stop': { args: [requestId: string]; result: void }
  'voice:cancel': { args: [requestId: string]; result: void }
  'voice:getPrompt': { args: []; result: VoicePromptSettings }
  'voice:setPrompt': { args: [instructions: string]; result: VoicePromptSettings }
  'voice:resetPrompt': { args: []; result: VoicePromptSettings }

  // Authentication and the server's API (the session stays in the main process)
  'auth:signUp': { args: [email: string, password: string, name?: string]; result: AuthResult }
  'auth:signIn': { args: [email: string, password: string]; result: AuthResult }
  'auth:signOut': { args: []; result: SimpleResult }
  'auth:getSession': { args: []; result: SessionResult }
  'api:getCompanies': { args: []; result: CompaniesResult }
  'api:createCompany': { args: [name: string]; result: CompanyResult }
  'api:getDepartments': { args: [companyId: string]; result: DepartmentsResult }

  // File system (every path is checked against the allowed roots)
  'dialog:selectDirectory': { args: []; result: string | null }
  'fs:registerAllowedRoot': { args: [path: string]; result: { success: boolean } }
  'fs:readDirectory': { args: [path: string]; result: DirectoryEntry[] }
  'fs:readDirectoryTree': { args: [path: string, maxDepth: number]; result: DirectoryTreeNode[] }
  'fs:readFile': { args: [path: string]; result: string | null }
  'fs:readFileBinary': { args: [path: string]; result: ArrayBuffer | null }
  'fs:writeFile': { args: [path: string, content: string]; result: boolean }
  'fs:createFile': { args: [path: string, content: string]; result: FileOpResult }
  'editor:backupBeforeOverwrite': { args: [rootPath: string, filePath: string]; result: EditorBackupResult }
  'fs:createDirectory': { args: [path: string]; result: boolean }
  'fs:exists': { args: [path: string]; result: boolean }
  'fs:delete': { args: [path: string]; result: FileOpResult }
  'fs:rename': { args: [oldPath: string, newPath: string]; result: FileOpResult & { newPath?: string } }
  'fs:move': { args: [sourcePath: string, destPath: string]; result: FileOpResult }
  'fs:moveFromExternal': { args: [sourcePath: string, destPath: string]; result: FileOpResult }
  'fs:copy': { args: [sourcePath: string, destPath: string]; result: FileOpResult }
  'fs:stat': { args: [path: string]; result: { success: boolean; data?: FileStats } }
  'fs:watch': { args: [rootPath: string]; result: SimpleResult }
  'fs:unwatch': { args: [rootPath: string]; result: SimpleResult }

  // Git
  'git:sync': { args: [repoPath: string, companyId: string, commitMessage: string]; result: GitResult }
  'git:autoSync': { args: [repoPath: string, companyId: string, mode: AutoSyncMode, state: AutoSyncRendererState]; result: AutoSyncResult<GitResult> }
  'writeAccess:get': { args: [companyId: string, refresh?: boolean]; result: WriteAccess | null }
  'privateFolders:mine': { args: [companyId: string]; result: { success: true; folders: MyPrivateFolder[] } | PrivateFoldersFailure }
  'privateFolders:createContext': { args: [companyId: string, parentPath: string]; result: { success: true; context: PrivateFolderCreateContext } | PrivateFoldersFailure }
  'privateFolders:create': { args: [companyId: string, input: CreatePrivateFolderRequest]; result: CreatePrivateFolderResult }
  // The member's own API keys (「自分の鍵」): the value goes in once, never comes back.
  'brokerKeys:list': { args: [companyId: string]; result: OwnKeysResult }
  'brokerKeys:save': { args: [companyId: string, service: string, secret: string, displayName?: string]; result: OwnKeysResult }
  'brokerKeys:delete': { args: [companyId: string, service: string]; result: OwnKeysResult }
  /** Moves a built-in service's key from the company folder's .env to the server (removed locally only after the server kept it). */
  'brokerKeys:moveFromEnv': { args: [companyId: string, rootPath: string, name: string]; result: OwnKeyMoveResult }
  // The Google connection (「Google で許可」): the app holds no token; the sign-in URL stays in main.
  'google:status': { args: [companyId: string]; result: GoogleStatusResult }
  /** Opens Google's sign-in page in the system browser (the URL never comes back). */
  'google:connect': { args: [companyId: string, features: GoogleFeature[]]; result: GoogleConnectResult }
  /** 「許可をやめる」 (revoked at Google too). */
  'google:disconnect': { args: [companyId: string]; result: GoogleStatusResult }
  // The chat card of an outside system's write (HubSpot): the person's own actions, with their session.
  /** 「変更前の値を書き戻す」 (a person's action; the consultation is informational provenance). */
  'pluginOperations:undo': { args: [companyId: string, pluginId: string, operationId: string, conversationId?: string]; result: PluginOperationResult }
  'pluginOperations:reconcile': { args: [companyId: string, pluginId: string, operationId: string]; result: PluginOperationResult }
  // The chat's approval card (承認のお願い): read and act with the member's session (no AI route approves).
  'approvals:get': { args: [companyId: string, approvalId: string]; result: ApprovalResult }
  /** 「承認」: the reason and the hash of the content the card shows. */
  'approvals:approve': { args: [companyId: string, approvalId: string, hash: string, reason: string]; result: ApprovalResult }
  'approvals:sendBack': { args: [companyId: string, approvalId: string, reason: string]; result: ApprovalResult }
  'approvals:withdraw': { args: [companyId: string, approvalId: string]; result: ApprovalResult }
  /** 「これと同じ…です（作らない）」: a create is the same as this existing record (and, when asked, the meeting belongs to it). */
  'approvals:sameAs': { args: [companyId: string, approvalId: string, recordId: string, linkMeeting: boolean]; result: ApprovalResult }
  // Settings → 「不在と代わりの人」: the member's own absences, read and changed with their session.
  /** The member's view (absences, whom they cover today) and the company's members for the picker. */
  'absences:get': { args: [companyId: string]; result: AbsencesResult }
  'absences:add': { args: [companyId: string, input: AbsenceAddInput]; result: AbsenceAddResult }
  'absences:remove': { args: [companyId: string, absenceId: string]; result: AbsenceRemoveResult }
  // 自分の設定 → 「受信を読む」「AI が自動で進める」: the member's own switches, with their session.
  /** The member's switches (+ the company's 使ってよいか / 初めの値). */
  'workSwitches:get': { args: [companyId: string]; result: WorkSwitchesResult }
  /** Turn one on / off (a switch the company does not allow cannot be turned on: `WORK_SWITCH_COMPANY_OFF`). */
  'workSwitches:set': { args: [companyId: string, which: WorkSwitch, on: boolean]; result: WorkSwitchesResult }
  // 見られる人 for the lists: the phrase per record id / company path, with the member's session.
  'viewers:get': { args: [companyId: string, query: ViewersQuery]; result: ViewersResult }
  /** 「もう一度作る」 for a create HubSpot did not show (a person only); without `confirm` the server answers its warning. */
  'pluginOperations:recreate': { args: [companyId: string, pluginId: string, operationId: string, confirm: boolean, conversationId?: string]; result: PluginOperationResult }
  // 「今日の予定」 (calendar.md): the member's own meetings today, read by the server now (nothing stored).
  /** Not being able to read the calendar is an empty list with a reason (`data.reason`), not a failure. */
  'calendar:today': { args: [companyId: string]; result: CalendarTodayResult }
  // The task list (tasks.ts): read and changed with the member's session in main; the server decides who may.
  'tasks:list': { args: [companyId: string]; result: TaskListResult }
  /** The folded 「アーカイブ」: archived tasks, newest first, 20 per call from `cursor` (start: 0 / 0). */
  'tasks:archived': { args: [companyId: string, cursor: ArchiveCursor]; result: ArchivedTasksResult }
  /** The list's one line: a task of the member's own (only they see it). */
  'tasks:create': { args: [companyId: string, input: TaskCreateInput]; result: TaskWriteResult }
  'tasks:act': { args: [companyId: string, recordId: string, input: TaskActInput]; result: TaskWriteResult }
  /** One task's card: what the AI prepared, what the member can do, 経緯, its runs waiting for a person. */
  'tasks:card': { args: [companyId: string, recordId: string]; result: TaskCardResult }
  /** The unfinished まとまり the member reads (for 「どのまとまりの会議ですか？」). */
  'tasks:bundles': { args: [companyId: string]; result: BundleChoicesResult }
  /** The AI's proposals (案) from a meeting, proposed and put away (records.md "Task version 11"). */
  'tasks:proposals': { args: [companyId: string, meetingId: string]; result: TaskProposalsResult }
  'tasks:bundleKinds': { args: [companyId: string]; result: BundleKindsAnswer }
  /** A company file or folder linked to a task (`companyPath`: inside the company folder, e.g. `営業/見積.xlsx`). */
  'tasks:linkFile': { args: [companyId: string, recordId: string, companyPath: string, expectedVersion: number]; result: TaskWriteResult }
  'tasks:unlinkFile': { args: [companyId: string, recordId: string, companyPath: string, expectedVersion: number]; result: TaskWriteResult }
  /** 「もう一度」 on a run held for a person. */
  /** 「部署に出す」: an owner-only task shown to a department folder's readers (never undone). */
  'tasks:share': { args: [companyId: string, recordId: string, folder: string, expectedVersion: number]; result: TaskWriteResult }
  /** Tags in use that fit a title (AI through the company's key, else local matching); only suggestions. */
  'tasks:suggestTags': { args: [companyId: string, title: string, tagsInUse: string[]]; result: TagSuggestions }
  'tasks:retryRun': { args: [companyId: string, runId: string]; result: TaskWriteResult }
  /** What the member found in the outside system about an operation whose result was unknown. */
  'tasks:reconcile': { args: [companyId: string, runId: string, key: string, done: boolean]; result: TaskWriteResult }
  /** 「取り消す」 right after the member's own action: the ledger's undo of that version (the server checks the actor and later changes). */
  /** A link between records set later (a `one` link such as bundle is replaced) or taken off; the server decides. */
  /** 「新しい〇〇にする」: a new 案件・プロジェクト of the department's kind, the member its 責任者 (the server decides). */
  'tasks:createBundle': { args: [companyId: string, input: BundleCreateInput]; result: TaskWriteResult }
  'tasks:linkRecord': { args: [companyId: string, recordId: string, input: RecordLinkInput]; result: TaskWriteResult }
  'tasks:unlinkRecord': { args: [companyId: string, recordId: string, input: RecordLinkInput]; result: TaskWriteResult }
  'tasks:undo': { args: [companyId: string, recordId: string, version: number, expectedVersion: number]; result: TaskWriteResult }
  /** Something dropped on a record's 「つながっているもの」 or list row (a record, a file, a folder) linked to it; `link` answers a choice. */
  'tasks:dropLink': { args: [companyId: string, targetId: string, dropped: DroppedThing, link?: string]; result: DropLinkResult }
  // 「議事録が届きました」 (minutes): checked with the member's session in main; the app never holds minutes text.
  /** The company the member works in now (null: none); starts the 10-minute check while Google may read minutes. */
  'minutes:watch': { args: [companyId: string | null]; result: void }
  /** 「議事録を確かめる」. */
  'minutes:check': { args: [companyId: string]; result: MinutesActionResult }
  'minutes:notices': { args: [companyId: string]; result: MinutesNoticesResult }
  /** 「今は読まない」. */
  'minutes:skip': { args: [companyId: string, minutesId: string]; result: MinutesActionResult }
  /** 「どの案件の議事録ですか？」: link the chosen deal (nothing is written to HubSpot). */
  'minutes:linkBundle': { args: [companyId: string, minutesId: string, bundleId: string]; result: MinutesActionResult }
  /** 「まとまりはない（社内の会議など）」: the question closed for good (the person's choice, no AI turn). */
  'minutes:noBundle': { args: [companyId: string, minutesId: string]; result: MinutesActionResult }
  /** The meeting card's question: may a まとまり be chosen, was 「まとまりはない」 chosen. */
  'minutes:bundleQuestion': { args: [companyId: string, minutesId: string]; result: MeetingBundleQuestionResult }
  // Meetings for their attendees (minutes.md): the task list's 「議事録が届きました」 and the meeting card.
  /** The member's meetings of the last 3 days (`available` false: an older server, no banner). */
  'minutes:arrivals': { args: [companyId: string]; result: MeetingArrivalsResult }
  /** One meeting for its card: where its reading stands and, once read, its summary and decisions. */
  'minutes:meeting': { args: [companyId: string, meetingId: string]; result: MeetingCardStateResult }
  /** ［AI に読ませる］: the AI's turn on this member's PC. */
  'minutes:requestReading': { args: [companyId: string, meetingId: string, expectedVersion: number]; result: MeetingPressResult }
  /** ［読まない］ (取り消す: tasks:undo of that entry). */
  'minutes:skipReading': { args: [companyId: string, meetingId: string, expectedVersion: number]; result: MeetingPressResult }
  /** 「この定例は次から自動で読む」 (true) / 「次から自動で読まない」 (false): the member's own choice. */
  'minutes:autoSeries': { args: [companyId: string, meetingId: string, auto: boolean]; result: MinutesActionResult }
  /** ［招待する］: members added to a members-only record's list (never undone). */
  'minutes:invite': { args: [companyId: string, recordId: string, memberIds: string[], expectedVersion: number]; result: MeetingInviteResult }
  // 「AI の番」 run automatically in the main window (ai-turns.md): main claims and settles, never runs the AI.
  'aiTurns:settings': { args: [companyId: string]; result: AutoTurnSettings }
  /** Take the record's AI turn for this hidden consultation (its first AI action at this version; one PC wins). */
  'aiTurns:claim': { args: [companyId: string, recordId: string, expectedVersion: number, conversationId: string, companyRoot?: string]; result: AiTurnClaimResult }
  /** After the automatic turn: done / failed / still in progress → put back to 「AI の番」. */
  'aiTurns:settle': { args: [companyId: string, recordId: string]; result: AiTurnSettleResult }
  /** 「もう一度」: give the record's execution run the server holds for a person back to the AI (S10b). */
  'aiTurns:retry': { args: [companyId: string, recordId: string]; result: { ok: boolean } }
  // The title bar's 「あなたの番」 and bell (notifications.md): read with the member's session in main.
  /** The company on screen (null: none); starts the 5-minute check. */
  'notifications:watch': { args: [companyId: string | null]; result: void }
  'notifications:state': { args: [companyId: string]; result: NoticesState }
  'notifications:markRead': { args: [companyId: string, ids: string[] | 'all']; result: NoticesActionResult }
  'notifications:settings': { args: [companyId: string]; result: { success: true; kinds: Record<string, boolean> } | { success: false; error: string } }
  'notifications:setSetting': { args: [companyId: string, kind: string, on: boolean]; result: NoticesActionResult }
  // What the app shows of records (record-views.ts), read with the session in main.
  'recordViews:search': { args: [companyId: string, text: string]; result: RecordListResult }
  'recordViews:find': { args: [companyId: string, text: string, today: string]; result: FindResult }
  'recordViews:findHome': { args: [companyId: string, today: string, from: string, to: string]; result: FindHomeResult }
  'recordViews:card': { args: [companyId: string, recordId: string]; result: RecordCardResult }
  /** companyPath: the file's path inside the company folder (`営業部/見積.md`), not a local path. */
  'recordViews:forFile': { args: [companyId: string, companyPath: string]; result: RecordListResult }
  /** The やること / 案件 of the member's AI consultations (topic record ids); unreadable → null. */
  'recordViews:topics': { args: [companyId: string, recordIds: string[]]; result: ConsultationTopicsResult }
  // The chat's mail card (outbound-mail.md): the person's own actions, with the session in main.
  'outboundMail:get': { args: [companyId: string, messageId: string]; result: OutboundMailResult }
  'outboundMail:recipients': { args: [companyId: string, messageId: string]; result: OutboundMailResult }
  'outboundMail:update': { args: [companyId: string, messageId: string, edit: MailDraftEdit, conversationId?: string]; result: OutboundMailResult }
  'outboundMail:addRecipient': { args: [companyId: string, messageId: string, email: string, name?: string]; result: OutboundMailResult }
  'outboundMail:send': { args: [companyId: string, messageId: string, hash: string, awaitReply?: MailAwaitReply | null, attachmentsShown?: string[] | null]; result: OutboundMailResult }
  'outboundMail:openAttachment': { args: [companyId: string, messageId: string, sha256: string]; result: MailAttachmentOpenResult }
  'outboundMail:removeAttachment': { args: [companyId: string, messageId: string, sha256: string, expectedVersion: number]; result: OutboundMailResult }
  'outboundMail:resolve': { args: [companyId: string, messageId: string, sent: boolean]; result: OutboundMailResult }
  'outboundMail:discard': { args: [companyId: string, messageId: string]; result: OutboundMailResult }
  'git:preview': { args: [repoPath: string]; result: GitPreviewResult }
  'git:generateSummary': { args: [repoPath: string]; result: { success: boolean; summary: string | null } }
  'git:revertFile': { args: [repoPath: string, filePath: string, fileStatus: GitFileStatus]; result: SimpleResult }
  'git:fileDiff': { args: [repoPath: string, filePath: string, fileStatus: GitFileStatus]; result: GitFileDiffResult }
  'git:commitFileDiff': { args: [repoPath: string, commitHash: string, filePath: string]; result: GitCommitFileDiffResult }
  // folderPath '' = the whole company (electron/git-search.ts)
  'git:listFiles': { args: [repoPath: string, folderPath: string]; result: GitListFilesResult }
  'git:unsharedLargeFiles': { args: [repoPath: string]; result: { success: boolean; files: string[] } }
  'git:grep': { args: [repoPath: string, query: string, folderPath: string]; result: GitGrepResult }
  // folderPath: a folder or one file (「前の版」); inside a private folder, read from its own repository
  'git:log': { args: [repoPath: string, folderPath: string, limit?: number]; result: GitLogResult }
  'git:setupCompanyRemote': { args: [repoPath: string, companyId: string, selectedPaths?: string[]]; result: GitResult & { refused?: boolean } }
  'git:inspectCompanyFolder': { args: [folder: string, companyId: string]; result: InspectCompanyFolderResult }
  // A member's first time without choices (features/company-setup): 所属 and the default folder
  'companySetup:myDepartments': { args: [companyId: string]; result: { success: boolean; departmentIds?: string[] } }
  'companySetup:defaultParentFolder': { args: []; result: { success: boolean; folder?: string } }
  'git:sparseGetExclusions': { args: [repoPath: string]; result: SparseExclusionsResult }
  'git:sparseSetExclusions': { args: [repoPath: string, excluded: string[]]; result: SparseSetExclusionsResult }
  'git:sparseUncommittedChanges': { args: [repoPath: string, folders: string[]]; result: SparseUncommittedChangesResult }
  'git:folderSizes': { args: [repoPath: string, companyId: string, folder: string, measure: string[]]; result: FolderSizesResponse }
  /** The 「『…』というフォルダ名は使えません」 sentence when a path would write into a private folder the member cannot read (else null). */
  'privateFolders:reservedPathRefusal': { args: [targetPath: string]; result: string | null }
  'git:getBinaryStatus': { args: []; result: GitBinaryStatus }

  // Backups
  'backup:list': { args: [repoPath: string]; result: BackupListResult }
  'backup:restore': { args: [repoPath: string, backupId: string, filePath: string]; result: BackupRestoreResult }
  'backup:openFolder': { args: [backupPath: string]; result: SimpleResult }

  // Environment variables (.env file)
  'env:status': { args: [rootPath: string]; result: EnvStatusResult }
  /** A string sets or replaces that name (empty removes it), null removes it; other names stay. */
  'env:update': { args: [rootPath: string, changes: Record<string, string | null>]; result: SimpleResult }

  // Skills and their tools (web apps)
  'skills:list': { args: [rootPath: string, departmentFolder: string, departmentId: string, departmentName?: string, options?: { force?: boolean }]; result: SkillsResult }
  'skills:publish': { args: [rootPath: string, skillRelativePath: string]; result: FileOpResult }
  'skills:makePrivate': { args: [rootPath: string, skillRelativePath: string]; result: SimpleResult & { code?: 'already_shared' } }
  'skills:toggleNurturing': { args: [skillMdPath: string, makeNurturing: boolean]; result: FileOpResult }
  'tools:start': { args: [toolPath: string, startCommand?: string, companyId?: string]; result: StartToolResult }
  'tools:stop': { args: [toolPath: string]; result: StopToolResult }
  'shell:openExternal': { args: [url: string]; result: SimpleResult }

  // Settings
  'config:getApiKeyStatus': { args: []; result: ApiKeyStatus }
  'config:setApiKey': { args: [apiKey: string]; result: SimpleResult }
  'config:hasApiKey': { args: []; result: boolean }
  'codex:status': { args: []; result: CodexStatus }
  'config:getAuthMode': { args: []; result: AuthMode }
  'config:setAuthMode': { args: [mode: AuthMode]; result: boolean }
  'config:getClaudeCodeStatus': { args: []; result: ClaudeCodeStatus }
  'config:getPermissionMode': { args: []; result: PermissionMode }
  'config:setPermissionMode': { args: [mode: PermissionMode]; result: boolean }
  'config:getServerUrl': { args: []; result: string | null }
  'config:setServerUrl': { args: [url: string]; result: boolean }
  'config:validateServerUrl': { args: [url: string]; result: ServerUrlValidation }
  // The server address from an invitation's 「アプリを開く」 link (features/app-link): offered, shown, accepted by the member
  'appLink:serverOffer': { args: []; result: { server: string } | null }
  'appLink:acceptServer': { args: []; result: SimpleResult }
  'appLink:dismissServer': { args: []; result: void }
  // Extra environment variable names passed to AI processes (agents/agent-env.ts), this computer only
  'config:getAgentEnvPassthrough': { args: []; result: string[] }
  'config:setAgentEnvPassthrough': { args: [names: string[]]; result: { names: string[]; invalid: string[]; denied: string[] } }

  // Chat: choice prompts, tool approvals, hand-offs, history, the chat server
  'agent-interaction:list': { args: []; result: AgentInteractionRequest[] }
  'agent-interaction:respond': { args: [id: string, response: AgentInteractionResponse]; result: boolean }
  'tool-approval-response': { args: [toolUseId: string, approved: boolean]; result: boolean }
  'handoff:get': { args: [company: string, id: string]; result: HandoffView }
  'handoff:update': { args: [company: string, id: string]; result: void }
  'handoff:complete': { args: [company: string, id: string, receipt: HandoffCompletion]; result: void }
  // Session lists use summaries (no message bodies); body search runs in the main process.
  'chatHistory:getSummaries': { args: [companyId: string]; result: ChatSessionSummary[] }
  'chatHistory:search': { args: [companyId: string, query: string]; result: string[] }
  'chatHistory:getSession': { args: [companyId: string, sessionId: string]; result: ChatSession | null }
  'chatHistory:saveSession': { args: [companyId: string, session: ChatSession]; result: ChatSaveReceipt }
  'chatHistory:patchSession': { args: [companyId: string, sessionId: string, patch: ChatMetadataPatch]; result: ChatSession | null }
  'chatHistory:deleteSession': { args: [companyId: string, sessionId: string]; result: boolean }
  'chat-server:getInfo': { args: []; result: ChatServerInfo | null }
  // 「別ウィンドウで開く」 (shared/chat-windows.ts): open / focus / list / closeAll from the main
  // window only; getContext / reportStatus / openFile from a consultation's own window only.
  'chatWindow:open': { args: [sessionId: string, request: ChatWindowOpenRequest]; result: ChatWindowOpenResult }
  'chatWindow:focus': { args: [sessionId: string]; result: boolean }
  'chatWindow:list': { args: []; result: ChatWindowInfo[] }
  'chatWindow:closeAll': { args: []; result: void }
  'chatWindow:getContext': { args: []; result: ChatWindowContext | null }
  'chatWindow:reportStatus': { args: [status: ChatWindowStatus]; result: boolean }
  // A file link in a consultation's window: opened in the main window's editor (a file in its company folder only).
  'chatWindow:openFile': { args: [filePath: string]; result: ChatWindowOpenFileResult }
  /** The main window's answer to app:closeRequested: `ack` at once, then `close` or `stay`. */
  'app:closeResponse': { args: [answer: 'ack' | 'close' | 'stay']; result: void }
  /** The main window's answer to appCommand:request (only the window asked may answer). */
  'appCommand:respond': { args: [requestId: string, answer: AppCommandAnswer]; result: void }
  // Lanes (ipc-and-main-process.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  // The Slack connection (「Slack で許可」, slack-connector.md): the app holds no token; the sign-in URL stays in main.
  'slack:status': { args: [companyId: string]; result: SlackStatusResult }
  /** Opens Slack's sign-in page in the system browser (the URL never comes back). */
  'slack:connect': { args: [companyId: string, features: SlackFeature[]]; result: SlackConnectResult }
  /** 「許可をやめる」 (revoked at Slack too). */
  'slack:disconnect': { args: [companyId: string]; result: SlackStatusResult }
  /** The member turns an allowed feature off / on (大事な知らせを DM で受け取る). */
  'slack:setFeature': { args: [companyId: string, feature: SlackFeature, on: boolean]; result: SlackStatusResult }
  // 「仕事の道具をつなぐ」 (google-connector.md "One consent"): one Google consent for what the
  // company offers (the sign-in URL stays in main), and 「あとで」 per service.
  'google:connectAll': { args: [companyId: string]; result: GoogleConnectResult }
  'google:markSeen': { args: [companyId: string]; result: GoogleStatusResult }
  // 「スプレッドシートを中継で使う」 (google-connector.md "The relay"): the member's view and own records; 「やめる」 / back on.
  'google:relay': { args: [companyId: string]; result: GoogleRelayResult }
  'google:setRelay': { args: [companyId: string, on: boolean]; result: GoogleRelayResult }
  // 「済んだメールを Gmail でもアーカイブする」 (google-connector.md "Archiving in Gmail"): the member's own switch, back on without a consent.
  'google:setArchive': { args: [companyId: string, on: boolean]; result: GoogleStatusResult }
  'slack:markSeen': { args: [companyId: string]; result: SlackStatusResult }
  // The card's 元のスレッド (outbound-mail.md "Replies"): read now on the server with the member's own permission.
  'threads:get': { args: [companyId: string, recordId: string]; result: RecordThreadResult }
  // One call a plugin's screen made on its bridge (plugin-frame.md): the host names the plugin, main adds the session.
  'plugins:bridge': { args: [companyId: string, plugin: PluginPackageRef, op: string, args: unknown]; result: PluginBridgeAnswer }
  /** The screens of the plugins the company lists now and this app keeps, verified (A6, plugin-frame.md). */
  'plugins:screens': { args: [companyId: string]; result: PluginScreensResult }
  // lane A ▲
  // lane B ▼
  // lane B ▲
  // lane C ▼
  /** The member's records at a business plugin's ai_turn step (C5, plugin-steps.md); main remembers them for the claim. */
  'aiTurns:pluginTurns': { args: [companyId: string]; result: QueuedPluginStep[] }
  /** The `start: person` steps at a record's state (its card's buttons). */
  'pluginSteps:onRecord': { args: [companyId: string, recordId: string]; result: PluginStepButton[] }
  /** A person starts a step: the server pins the work's procedure; main answers the consultation's first message. */
  'pluginSteps:start': { args: [companyId: string, recordId: string, pluginId: string, step: string, companyRoot?: string]; result: PluginStepStartResult }
  // lane C ▲
}

/** renderer → main, fire and forget: ipcRenderer.send(channel, ...args). */
export interface IpcSendChannels {
  // Native drag to external apps (browser, Finder, Slack, …)
  'fs:startDrag': { args: [filePath: string] }
}

/** renderer → main, blocking: ipcRenderer.sendSync(channel, ...args) returns `result` (event.returnValue). */
export interface IpcSyncChannels {
  // Used only during unload, when an asynchronous renderer request cannot be awaited.
  'chatHistory:flushSession': { args: [companyId: string, session: ChatSession]; result: { result: ChatSaveReceipt; error?: undefined } | { error: string; result?: undefined } }
}

/** main → renderer: webContents.send(channel, ...payload). */
export interface IpcEventChannels {
  'voice:event': [event: VoiceEvent]
  // One batch per ~100 ms from the company watcher.
  'fs:changes': [changes: FileChangeEvent[]]
  'writeAccess:changed': [data: { companyId: string; access: WriteAccess }]
  /** The received minutes of this company may have changed: re-read them (`minutes:notices`). */
  'minutes:changed': [data: { companyId: string }]
  /** 「あなたの番」 or the notices of this company may have changed: re-read them (`notifications:state`). */
  'notifications:changed': [data: { companyId: string }]
  /**
   * A record this member may see may have changed in this company — their own AI wrote one
   * (instant, in this app) or the push channel's `records` signal came: re-read the task list.
   * No content: the list asks the server again (tasks-ui.md).
   */
  'records:changed': [data: { companyId: string }]
  /** The morning's 「今日のあなたの番」 Mac notification was clicked: show the task list. */
  'notifications:openTasks': [data: { companyId: string }]
  'setup:progress': [data: DownloadProgress]
  'sparse:progress': [data: DownloadProgress]
  'agent-interaction:request': [request: AgentInteractionRequest]
  'agent-interaction:closed': [request: AgentInteractionRequest]
  'tool-approval-request': [data: ToolApprovalRequest]
  'handoff:changed': [scope: { companyId: string; sessionId: string }]
  'chatHistory:changed': [data: ChatHistoryChange]
  'chat-server:info': [info: ChatServerInfo]
  'chatWindow:changed': [change: ChatWindowsChange]
  // To the main window only: a consultation's window asked to open this file (checked by main).
  'chatWindow:fileRequested': [request: ChatWindowFileRequest]
  /** The member closes the main window or quits: save the open tabs first, then answer app:closeResponse. */
  'app:closeRequested': []
  /** To the main window only: the consultation AI runs one of the app's commands (shared/app-commands.ts). */
  'appCommand:request': [request: AppCommandRequest]
  // Lanes (ipc-and-main-process.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  /** The plugin packages a company lists and this app keeps changed: ask `plugins:screens` again. */
  'plugins:changed': [change: { companyId: string }]
  // lane A ▲
  // lane B ▼
  // lane B ▲
  // lane C ▼
  // lane C ▲
}

export type InvokeChannel = keyof IpcInvokeChannels
export type InvokeArgs<C extends InvokeChannel> = IpcInvokeChannels[C]['args']
export type InvokeResult<C extends InvokeChannel> = IpcInvokeChannels[C]['result']
export type SendChannel = keyof IpcSendChannels
export type SendArgs<C extends SendChannel> = IpcSendChannels[C]['args']
export type SyncChannel = keyof IpcSyncChannels
export type SyncArgs<C extends SyncChannel> = IpcSyncChannels[C]['args']
export type SyncResult<C extends SyncChannel> = IpcSyncChannels[C]['result']
export type EventChannel = keyof IpcEventChannels
export type EventPayload<C extends EventChannel> = IpcEventChannels[C]

// ---------------------------------------------------------------------------
// window.electronAPI
// ---------------------------------------------------------------------------

/** A preload method that forwards its arguments to `C` unchanged. */
type Invoke<C extends InvokeChannel> = (...args: InvokeArgs<C>) => Promise<InvokeResult<C>>
/** `on…(callback)`: subscribe to an event, returns the unsubscribe. */
type Subscribe<C extends EventChannel> = (callback: (...payload: EventPayload<C>) => void) => () => void

export interface ElectronAPI {
  voiceInput: VoiceInputAPI

  // Authentication
  signUp: Invoke<'auth:signUp'>
  signIn: Invoke<'auth:signIn'>
  signOut: Invoke<'auth:signOut'>
  getSession: Invoke<'auth:getSession'>

  // Companies API
  getCompanies: Invoke<'api:getCompanies'>
  createCompany: Invoke<'api:createCompany'>

  // Departments API
  getDepartments: Invoke<'api:getDepartments'>

  // File system
  selectDirectory: Invoke<'dialog:selectDirectory'>
  registerAllowedRoot: Invoke<'fs:registerAllowedRoot'>
  readDirectory: Invoke<'fs:readDirectory'>
  /** maxDepth defaults to 2. */
  readDirectoryTree: (path: string, maxDepth?: number) => Promise<InvokeResult<'fs:readDirectoryTree'>>
  readFile: Invoke<'fs:readFile'>
  readFileBinary: Invoke<'fs:readFileBinary'>
  writeFile: Invoke<'fs:writeFile'>
  /** Never replaces an existing file (`code: 'name_taken'`). */
  createFile: Invoke<'fs:createFile'>
  /** Keep the disk version before the editor overwrites a file changed elsewhere (.backups/<ts>_editor_overwrite/). */
  backupBeforeOverwrite: Invoke<'editor:backupBeforeOverwrite'>
  createDirectory: Invoke<'fs:createDirectory'>
  exists: Invoke<'fs:exists'>

  // Extended file system operations
  deleteItem: Invoke<'fs:delete'>
  renameItem: Invoke<'fs:rename'>
  moveItem: Invoke<'fs:move'>
  moveFromExternal: Invoke<'fs:moveFromExternal'>
  /**
   * Where a file dropped from Finder lies on this computer ('' for a file that has
   * none). Not a channel: preload asks Electron (`webUtils.getPathForFile`; the
   * renderer's `File.path` was removed in Electron 32).
   */
  getPathForFile: (file: File) => string
  copyItem: Invoke<'fs:copy'>
  getStats: Invoke<'fs:stat'>

  // Native drag to external apps
  startDrag: (...args: SendArgs<'fs:startDrag'>) => void

  // File watching: one recursive watcher per open company folder (opened by
  // SkillCentricLayout when the company opens). Everything else subscribes.
  watchCompany: Invoke<'fs:watch'>
  unwatchCompany: Invoke<'fs:unwatch'>
  /** One call per change. */
  onFileChange: (callback: (data: FileChangeEvent) => void) => () => void
  /** The same events, one call per batch (sent at most every ~100 ms). */
  onFileChanges: Subscribe<'fs:changes'>

  // Environment variables
  getEnvStatus: Invoke<'env:status'>
  updateEnv: Invoke<'env:update'>

  // Skills
  listSkills: Invoke<'skills:list'>
  publishSkill: Invoke<'skills:publish'>
  makeSkillPrivate: Invoke<'skills:makePrivate'>
  toggleSkillNurturing: Invoke<'skills:toggleNurturing'>

  // Tools (Web apps)
  startTool: Invoke<'tools:start'>
  stopTool: Invoke<'tools:stop'>
  openExternal: Invoke<'shell:openExternal'>

  // Config
  getApiKeyStatus: Invoke<'config:getApiKeyStatus'>
  setApiKey: Invoke<'config:setApiKey'>
  hasApiKey: Invoke<'config:hasApiKey'>
  getCodexStatus: Invoke<'codex:status'>
  getAuthMode: Invoke<'config:getAuthMode'>
  setAuthMode: Invoke<'config:setAuthMode'>
  getClaudeCodeStatus: Invoke<'config:getClaudeCodeStatus'>
  getPermissionMode: Invoke<'config:getPermissionMode'>
  setPermissionMode: Invoke<'config:setPermissionMode'>

  // Server URL config
  getServerUrl: Invoke<'config:getServerUrl'>
  setServerUrl: Invoke<'config:setServerUrl'>
  validateServerUrl: Invoke<'config:validateServerUrl'>
  getAppLinkServerOffer: Invoke<'appLink:serverOffer'>
  acceptAppLinkServer: Invoke<'appLink:acceptServer'>
  dismissAppLinkServer: Invoke<'appLink:dismissServer'>
  getAgentEnvPassthrough: Invoke<'config:getAgentEnvPassthrough'>
  setAgentEnvPassthrough: Invoke<'config:setAgentEnvPassthrough'>

  onAgentInteraction: Subscribe<'agent-interaction:request'>
  onAgentInteractionClosed: Subscribe<'agent-interaction:closed'>
  getAgentInteractions: Invoke<'agent-interaction:list'>
  respondAgentInteraction: Invoke<'agent-interaction:respond'>

  // Tool approval
  onToolApprovalRequest: Subscribe<'tool-approval-request'>
  respondToolApproval: Invoke<'tool-approval-response'>

  getHandoff: Invoke<'handoff:get'>
  updateHandoff: Invoke<'handoff:update'>
  completeHandoffTurn: Invoke<'handoff:complete'>
  onHandoffChanged: Subscribe<'handoff:changed'>

  // Chat history
  getChatSessionSummaries: Invoke<'chatHistory:getSummaries'>
  searchChatSessions: Invoke<'chatHistory:search'>
  getChatSession: Invoke<'chatHistory:getSession'>
  saveChatSession: Invoke<'chatHistory:saveSession'>
  /** Synchronous (page unload); throws the main process's error. */
  flushChatSession: (...args: SyncArgs<'chatHistory:flushSession'>) => ChatSaveReceipt
  patchChatSession: Invoke<'chatHistory:patchSession'>
  deleteChatSession: Invoke<'chatHistory:deleteSession'>
  /** Change broadcasts (multi-tab sync). */
  onChatHistoryChanged: Subscribe<'chatHistory:changed'>

  // Git
  gitSync: Invoke<'git:sync'>
  gitAutoSync: Invoke<'git:autoSync'>
  /** Per-folder write access (閲覧のみ badges); refreshed by sync and the chat. */
  getWriteAccess: Invoke<'writeAccess:get'>
  onWriteAccessChanged: Subscribe<'writeAccess:changed'>
  // Private folders (lock icons, 「新しいフォルダ…」 dialog). Human-only: no chat tool.
  getMyPrivateFolders: Invoke<'privateFolders:mine'>
  getPrivateFolderCreateContext: Invoke<'privateFolders:createContext'>
  createPrivateFolder: Invoke<'privateFolders:create'>
  // The member's own API keys (「自分の鍵」): last 4 only ever comes back.
  listOwnBrokerKeys: Invoke<'brokerKeys:list'>
  saveOwnBrokerKey: Invoke<'brokerKeys:save'>
  deleteOwnBrokerKey: Invoke<'brokerKeys:delete'>
  moveEnvKeyToServer: Invoke<'brokerKeys:moveFromEnv'>
  // The Google connection (設定 → Google): the member's view only, never a token or the sign-in URL.
  getGoogleStatus: Invoke<'google:status'>
  connectGoogle: Invoke<'google:connect'>
  disconnectGoogle: Invoke<'google:disconnect'>
  // The chat card of an outside system's write: the person's own actions (never the AI's).
  undoPluginOperation: Invoke<'pluginOperations:undo'>
  reconcilePluginOperation: Invoke<'pluginOperations:reconcile'>
  // The chat's approval card: the person's own acts (never the AI's).
  getApproval: Invoke<'approvals:get'>
  approveApproval: Invoke<'approvals:approve'>
  sendBackApproval: Invoke<'approvals:sendBack'>
  withdrawApproval: Invoke<'approvals:withdraw'>
  sameAsApproval: Invoke<'approvals:sameAs'>
  // Settings → 「不在と代わりの人」.
  getAbsences: Invoke<'absences:get'>
  addAbsence: Invoke<'absences:add'>
  removeAbsence: Invoke<'absences:remove'>
  // 自分の設定 → 「受信を読む」「AI が自動で進める」.
  getWorkSwitches: Invoke<'workSwitches:get'>
  setWorkSwitch: Invoke<'workSwitches:set'>
  // 見られる人 for the lists.
  getViewers: Invoke<'viewers:get'>
  recreatePluginOperation: Invoke<'pluginOperations:recreate'>
  // 「今日の予定」 for the task list (provider-neutral; no attendee address ever).
  getCalendarToday: Invoke<'calendar:today'>
  // The task list (やることの一覧).
  getTaskList: Invoke<'tasks:list'>
  getArchivedTasks: Invoke<'tasks:archived'>
  createTask: Invoke<'tasks:create'>
  actOnTask: Invoke<'tasks:act'>
  getTaskCard: Invoke<'tasks:card'>
  linkFileToTask: Invoke<'tasks:linkFile'>
  getBundleChoices: Invoke<'tasks:bundles'>
  getTaskProposals: Invoke<'tasks:proposals'>
  getBundleKinds: Invoke<'tasks:bundleKinds'>
  unlinkFileFromTask: Invoke<'tasks:unlinkFile'>
  retryTaskRun: Invoke<'tasks:retryRun'>
  shareTask: Invoke<'tasks:share'>
  suggestTaskTags: Invoke<'tasks:suggestTags'>
  reconcileTaskRun: Invoke<'tasks:reconcile'>
  undoTaskAction: Invoke<'tasks:undo'>
  createBundle: Invoke<'tasks:createBundle'>
  linkRecordToRecord: Invoke<'tasks:linkRecord'>
  unlinkRecordFromRecord: Invoke<'tasks:unlinkRecord'>
  dropLinkOnRecord: Invoke<'tasks:dropLink'>
  // 「議事録が届きました」: the notices, 「今は読まない」, 「議事録を確かめる」 and the まとまり choice.
  watchMinutes: Invoke<'minutes:watch'>
  checkMinutes: Invoke<'minutes:check'>
  getMinutesNotices: Invoke<'minutes:notices'>
  skipMinutes: Invoke<'minutes:skip'>
  linkMinutesBundle: Invoke<'minutes:linkBundle'>
  declineMinutesBundle: Invoke<'minutes:noBundle'>
  getMeetingBundleQuestion: Invoke<'minutes:bundleQuestion'>
  getMeetingArrivals: Invoke<'minutes:arrivals'>
  getMeetingCardState: Invoke<'minutes:meeting'>
  requestMeetingReading: Invoke<'minutes:requestReading'>
  skipMeetingReading: Invoke<'minutes:skipReading'>
  setMeetingAutoSeries: Invoke<'minutes:autoSeries'>
  inviteToRecord: Invoke<'minutes:invite'>
  onMinutesChanged: Subscribe<'minutes:changed'>
  // 「AI の番」 run automatically (the main window only).
  getAutoTurnSettings: Invoke<'aiTurns:settings'>
  claimAiTurn: Invoke<'aiTurns:claim'>
  settleAiTurn: Invoke<'aiTurns:settle'>
  retryAiTurn: Invoke<'aiTurns:retry'>
  watchNotifications: Invoke<'notifications:watch'>
  getNotificationsState: Invoke<'notifications:state'>
  markNotificationsRead: Invoke<'notifications:markRead'>
  getNotificationSettings: Invoke<'notifications:settings'>
  setNotificationSetting: Invoke<'notifications:setSetting'>
  onNotificationsChanged: Subscribe<'notifications:changed'>
  onNotificationsOpenTasks: Subscribe<'notifications:openTasks'>
  onRecordsChanged: Subscribe<'records:changed'>
  searchRecords: Invoke<'recordViews:search'>
  findRecords: Invoke<'recordViews:find'>
  findRecordsHome: Invoke<'recordViews:findHome'>
  getRecordCard: Invoke<'recordViews:card'>
  getRecordsForFile: Invoke<'recordViews:forFile'>
  getConsultationTopics: Invoke<'recordViews:topics'>
  getOutboundMail: Invoke<'outboundMail:get'>
  getOutboundMailRecipients: Invoke<'outboundMail:recipients'>
  updateOutboundMail: Invoke<'outboundMail:update'>
  addOutboundMailRecipient: Invoke<'outboundMail:addRecipient'>
  sendOutboundMail: Invoke<'outboundMail:send'>
  resolveOutboundMail: Invoke<'outboundMail:resolve'>
  discardOutboundMail: Invoke<'outboundMail:discard'>
  openOutboundMailAttachment: Invoke<'outboundMail:openAttachment'>
  removeOutboundMailAttachment: Invoke<'outboundMail:removeAttachment'>
  gitPreview: Invoke<'git:preview'>
  gitGenerateSummary: Invoke<'git:generateSummary'>
  gitRevertFile: Invoke<'git:revertFile'>
  gitFileDiff: Invoke<'git:fileDiff'>
  gitCommitFileDiff: Invoke<'git:commitFileDiff'>
  gitListFiles: Invoke<'git:listFiles'>
  gitUnsharedLargeFiles: Invoke<'git:unsharedLargeFiles'>
  gitGrep: Invoke<'git:grep'>
  gitLog: Invoke<'git:log'>
  gitSetupCompanyRemote: Invoke<'git:setupCompanyRemote'>
  gitInspectCompanyFolder: Invoke<'git:inspectCompanyFolder'>
  getMyDepartments: Invoke<'companySetup:myDepartments'>
  getDefaultParentFolder: Invoke<'companySetup:defaultParentFolder'>
  onSetupProgress: Subscribe<'setup:progress'>

  // Sparse checkout
  sparseGetExclusions: Invoke<'git:sparseGetExclusions'>
  sparseSetExclusions: Invoke<'git:sparseSetExclusions'>
  sparseUncommittedChanges: Invoke<'git:sparseUncommittedChanges'>
  folderSizes: Invoke<'git:folderSizes'>
  reservedPathRefusal: Invoke<'privateFolders:reservedPathRefusal'>
  onSparseProgress: Subscribe<'sparse:progress'>
  gitBinaryStatus: Invoke<'git:getBinaryStatus'>

  // Backup
  backupList: Invoke<'backup:list'>
  backupRestore: Invoke<'backup:restore'>
  backupOpenFolder: Invoke<'backup:openFolder'>

  // Chat server (for useChat transport)
  getChatServerInfo: Invoke<'chat-server:getInfo'>
  onChatServerInfo: Subscribe<'chat-server:info'>

  // Consultations in windows of their own
  openChatWindow: Invoke<'chatWindow:open'>
  focusChatWindow: Invoke<'chatWindow:focus'>
  listChatWindows: Invoke<'chatWindow:list'>
  closeChatWindows: Invoke<'chatWindow:closeAll'>
  onChatWindowsChanged: Subscribe<'chatWindow:changed'>
  getChatWindowContext: Invoke<'chatWindow:getContext'>
  reportChatWindowStatus: Invoke<'chatWindow:reportStatus'>
  openFileInMainWindow: Invoke<'chatWindow:openFile'>
  onFileRequestedFromChatWindow: Subscribe<'chatWindow:fileRequested'>
  onCloseRequested: Subscribe<'app:closeRequested'>
  answerCloseRequest: Invoke<'app:closeResponse'>
  onAppCommandRequest: Subscribe<'appCommand:request'>
  answerAppCommand: Invoke<'appCommand:respond'>
  // Lanes (ipc-and-main-process.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  // The Slack connection (設定 → Slack): the member's view only, never a token or the sign-in URL.
  getSlackStatus: Invoke<'slack:status'>
  connectSlack: Invoke<'slack:connect'>
  disconnectSlack: Invoke<'slack:disconnect'>
  setSlackFeature: Invoke<'slack:setFeature'>
  connectGoogleAll: Invoke<'google:connectAll'>
  markGoogleSeen: Invoke<'google:markSeen'>
  getGoogleRelay: Invoke<'google:relay'>
  setGoogleRelay: Invoke<'google:setRelay'>
  setGoogleArchive: Invoke<'google:setArchive'>
  markSlackSeen: Invoke<'slack:markSeen'>
  getRecordThread: Invoke<'threads:get'>
  callPluginBridge: Invoke<'plugins:bridge'>
  getPluginScreens: Invoke<'plugins:screens'>
  onPluginsChanged: Subscribe<'plugins:changed'>
  // lane A ▲
  // lane B ▼
  // lane B ▲
  // lane C ▼
  listPluginStepTurns: Invoke<'aiTurns:pluginTurns'>
  listPersonSteps: Invoke<'pluginSteps:onRecord'>
  startPersonStep: Invoke<'pluginSteps:start'>
  // lane C ▲
}
