import type { ScopeWithRules } from '../../shared/core/permissions'

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
  replaceRules(scopeId: string, rules: PrivateRuleSet, by: string): void
  makePublic(folder: PrivateFolderRecord, by: string): Promise<{ ok: true; value: { path: string; commit: string } } | PrivateFolderRefusal>
  delete(folder: PrivateFolderRecord, by: string): Promise<{ ok: true; value: { path: string } } | PrivateFolderRefusal>
}
