import type { ScopeWithRules } from '../../shared/core/permissions'
import type { SkillEditing } from '../../shared/core/skill-files'

/**
 * Who a commit the server makes for someone is checked as: the push checker's snapshot of that
 * member, exactly as git-http builds it for their own push (pusher, the company's scopes and rules,
 * the departments they manage, their place on 「Skill を直せる人」).
 */
export interface PusherSnapshot {
  pusher: { id: string; role: string }
  scopes: ScopeWithRules[]
  managedFolders: string[]
  skillEditing: SkillEditing
}

/** A file of a private folder's repository (path as stored, relative to the folder). */
export interface FolderFile {
  path: string
  mode: string
  /** `blob` (a file or a link), `commit` (a gitlink). */
  type: string
  oid: string
}

export interface FolderTree {
  commit: string
  files: FolderFile[]
}

/** One change of a file: a blob (written with `writeBlob`) put at `path`, or the file removed. */
export type FolderFileEdit = { path: string; blob: string; mode: string } | { path: string; remove: true }

export type FolderCommitResult<T> =
  | { ok: true; commit: string | null; result: T }
  /** The push checker refused it (its markers and paths, relative to the folder). */
  | { ok: false; reason: 'REFUSED'; rejections: Array<{ marker: string; paths: string[] }> }
  /** The folder is being made public or deleted, a push ran too long, or members kept pushing. */
  | { ok: false; reason: 'BUSY' }
  /** An edit would put a file where a folder is (or the reverse) on the tip it was built on. */
  | { ok: false; reason: 'CONFLICT' }

/** A private folder: a scope with its own repository (adapters/private-folders.ts). */
export interface PrivateFolderRecord {
  scope: ScopeWithRules
  repoId: string
  createdAt: string
  createdBy: string | null
}

/** Who may read a private folder: viewers (read), editors (read + write). */
export interface PrivateRuleSet {
  viewers: string[]
  editors: string[]
}

/** One member's access at a path. */
export interface FolderAccess {
  userId: string
  role: string
  read: boolean
  write: boolean
}

/** Why a private-folder operation refused, with the message the API returns. */
export type PrivateFolderRefusal =
  | { ok: false; reason: 'unavailable' }
  | { ok: false; reason: 'BUSY' | 'PATH_OCCUPIED' | 'CONCURRENT_UPDATES'; message: string }

/**
 * One company's private folders, from its handle (`CompanyData.privateFolders`):
 * rows (scopes with repo_id, scope_repos) and their scope repositories
 * (adapters/private-folders.ts). Another company's scope id is not found. The
 * writes keep every race protection of the in-flight pushes
 * (lib/private-folders.ts): creation waits for company pushes registered
 * before it and re-checks the company repository; make-public and delete
 * refuse new scope pushes and archive first. Callers hold the company lock.
 */
export interface PrivateFolderRepository {
  /** The private folders, by path. */
  list(scopes?: ScopeWithRules[]): PrivateFolderRecord[]
  get(scopeId: string): PrivateFolderRecord | null
  /** The paths of the private folders, as stored. */
  paths(): string[]
  /** Every member's access at `path` (members oldest first). */
  access(path: string, scopes?: ScopeWithRules[]): FolderAccess[]

  /** 'unavailable' = the path is taken; 'BUSY' = a company push did not finish in time. Nothing created then. */
  create(input: { path: string; rules: PrivateRuleSet; createdBy: string }): Promise<{ ok: true; scopeId: string } | PrivateFolderRefusal>
  /** Takes readers away: call inside holdingTickets.track (private-folders.md "Access removed: holding tickets"). */
  replaceRules(scopeId: string, rules: PrivateRuleSet, by: string): void
  /**
   * `trackRows` runs the one transaction that turns the rows public (after the company commit):
   * the caller wraps it in holdingTickets.track, so the open holding tickets of everyone who now
   * reads the folder are cancelled with it.
   */
  makePublic(folder: PrivateFolderRecord, by: string, trackRows: (changeRows: () => void) => void): Promise<{ ok: true; value: { path: string; commit: string } } | PrivateFolderRefusal>
  /**
   * `trackRows` runs the one transaction that removes the folder's rows (after the archive,
   * before the repository goes): the caller wraps it in holdingTickets.track, so every reader's
   * ticket is written with the removal or not at all.
   */
  delete(folder: PrivateFolderRecord, by: string, trackRows: (removeRows: () => void) => void): Promise<{ ok: true; value: { path: string } } | PrivateFolderRefusal>

  // The holding place's review (private-folders.md "Holding: review"): reading the folder's
  // repository and committing into it as a member.

  /** The folder's files at `commit` ('tip' = its main), or null when that commit is not in its repository. */
  filesAt(folder: PrivateFolderRecord, commit: string | 'tip'): Promise<FolderTree | null>
  /** One blob of the folder's repository, or null. */
  readBlob(folder: PrivateFolderRecord, oid: string): Promise<Buffer | null>
  /**
   * The most recent commit of the folder's main (of its last 1,000) whose message has exactly this
   * line, or null when there is none. Throws when the history cannot be read (never answered as none).
   */
  findCommitWithLine(folder: PrivateFolderRecord, line: string): Promise<string | null>
  /**
   * One commit on the folder's main, pushed into its repository **through the push checker as
   * `as`** (never as the server's own push): every rule — write permission, protected files,
   * secrets, `.personal`, names — applies as if that member pushed. `decide` gets the tip (null:
   * an empty repository) and `writeBlob`, and answers the edits (none: nothing is committed); it is
   * called again on a new tip when a member pushed in between. Call under the company lock.
   */
  commitFiles<T>(folder: PrivateFolderRecord, input: {
    /** The commit message, from what `decide` answered on the tip it is built on. */
    message: (result: T, edits: number) => string
    as: PusherSnapshot
    decide: (tip: FolderTree | null, writeBlob: (content: Buffer) => Promise<string>) => Promise<{ edits: FolderFileEdit[]; result: T }>
  }): Promise<FolderCommitResult<T>>
}
