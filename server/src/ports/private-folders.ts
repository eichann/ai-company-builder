import type { ScopeWithRules } from '../../shared/core/permissions'

/** A private folder: a scope with its own repository (lib/private-folders.ts). */
export interface PrivateFolderRecord {
  scope: ScopeWithRules
  repoId: string
  createdAt: string
  createdBy: string | null
}

export interface PrivateFolderRepository {
  /** The company's private folders, by path. */
  list(companyId: string): PrivateFolderRecord[]
  get(companyId: string, scopeId: string): PrivateFolderRecord | null
  /** The paths of the company's private folders, as stored. */
  paths(companyId: string): string[]
}
