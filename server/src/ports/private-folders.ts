import type { ScopeWithRules } from '../../shared/core/permissions'

/** A private folder: a scope with its own repository (lib/private-folders.ts). */
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
 * Private folders: rows (scopes with repo_id, scope_repos) and their scope
 * repositories. The writes keep every race protection of
 * lib/private-folders.ts — creation waits for company pushes registered
 * before it and re-checks the company repository; make-public and delete
 * refuse new scope pushes and archive first. Callers hold the company lock.
 */
export interface PrivateFolderRepository {
  /** The company's private folders, by path. */
  list(companyId: string, scopes?: ScopeWithRules[]): PrivateFolderRecord[]
  get(companyId: string, scopeId: string): PrivateFolderRecord | null
  /** The paths of the company's private folders, as stored. */
  paths(companyId: string): string[]
  /** Every member's access at `path` (members oldest first). */
  access(companyId: string, path: string, scopes?: ScopeWithRules[]): FolderAccess[]

  /** 'unavailable' = the path is taken; 'BUSY' = a company push did not finish in time. Nothing created then. */
  create(input: { companyId: string; path: string; rules: PrivateRuleSet; createdBy: string }): Promise<{ ok: true; scopeId: string } | PrivateFolderRefusal>
  replaceRules(scopeId: string, rules: PrivateRuleSet, by: string): void
  makePublic(companyId: string, folder: PrivateFolderRecord, by: string): Promise<{ ok: true; value: { path: string; commit: string } } | PrivateFolderRefusal>
  delete(companyId: string, folder: PrivateFolderRecord, by: string): Promise<{ ok: true; value: { path: string } } | PrivateFolderRefusal>
}
