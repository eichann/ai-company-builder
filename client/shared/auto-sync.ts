// Automatic sync while the app is open (owner decision 2026-10-30; rule:
// .claude/rules/sync.md "Automatic sync"). The renderer's timer decides when
// a run is due (src/features/sync/autoSyncSchedule.ts); main decides whether
// it may run now (`autoSyncSkipReason`) and runs it (`git:autoSync`).

/** 「自動で受け取る」 (teammates' changes only) or 「自動で送る」 (the normal sync). */
export type AutoSyncMode = 'receive' | 'send'

/** Why a run did not happen. Every one is silent: the next tick tries again. */
export type AutoSyncSkipReason =
  /** The editor has edits not yet saved to disk. */
  | 'unsaved-edits'
  /** An AI turn is running in some chat (it may be writing files). */
  | 'ai-running'
  /** The last sync stopped on something only the member can resolve. */
  | 'needs-member'
  /** The computer is offline (or the server could not be reached for the fetch). */
  | 'offline'
  /** A sync (manual or automatic) is running. */
  | 'sync-running'
  /** A download-choice change is being applied. */
  | 'download-choices'
  /** A private folder is being created or set up. */
  | 'private-folder-setup'
  /** A rebase / merge / cherry-pick is in progress in the repository. */
  | 'repository-busy'

/** What the renderer knows and tells main with each request. */
export interface AutoSyncRendererState {
  unsavedEdits: boolean
  needsMember: boolean
  offline: boolean
}

/** The error type of an automatic send that stopped at a question only the member can answer. */
export const NEEDS_MEMBER_ERROR = 'needs_member'

/** What main knows. */
export interface AutoSyncMainState {
  aiRunning: boolean
  syncRunning: boolean
  /** A long operation that must not overlap a sync (download choices, private folder setup). */
  activity: 'download-choices' | 'private-folder-setup' | null
}

/**
 * Whether an automatic run must wait. Order = what the member would most
 * likely recognise first; any one of them is enough.
 */
export function autoSyncSkipReason(renderer: AutoSyncRendererState, main: AutoSyncMainState): AutoSyncSkipReason | null {
  if (renderer.needsMember) return 'needs-member'
  if (renderer.offline) return 'offline'
  if (main.syncRunning) return 'sync-running'
  if (main.activity) return main.activity
  if (renderer.unsavedEdits) return 'unsaved-edits'
  if (main.aiRunning) return 'ai-running'
  return null
}

/**
 * 「受け取る」's outcome. `received` counts files changed on this computer;
 * `heldBack` names repositories whose update waits because the member's own
 * changes (or a file in the way) touch what teammates changed: the next
 * manual sync handles them with its backups.
 */
export interface ReceiveResult {
  success: boolean
  received: number
  heldBack: number
  /** The company repository's server could not be reached: nothing was checked. */
  offline?: boolean
}

export type AutoSyncResult<SyncResult> =
  | { status: 'skipped'; reason: AutoSyncSkipReason }
  | { status: 'received'; result: ReceiveResult }
  | { status: 'sent'; result: SyncResult }
