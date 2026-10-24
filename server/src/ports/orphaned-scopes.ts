import type { ScopeWithRules } from '../../shared/core/permissions'

export interface OrphanedScope {
  scope: ScopeWithRules
  /** When the folder was first noticed missing (ISO 8601). */
  since: string
}

/**
 * Scopes with rules whose folder is missing on the shared branch
 * (lib/orphaned-scopes.ts: the repository's tree against the scopes, cached
 * per commit). Never throws: a failed check answers [].
 */
export interface OrphanedScopeReader {
  find(companyId: string): Promise<OrphanedScope[]>
}
