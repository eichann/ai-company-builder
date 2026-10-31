import type { ScopeWithRules } from '../../shared/core/permissions'

export interface OrphanedScope {
  scope: ScopeWithRules
  /** When the folder was first noticed missing (ISO 8601). */
  since: string
}

/**
 * One company's scopes with rules whose folder is missing on the shared
 * branch, from its handle (`CompanyData.orphanedScopes`;
 * adapters/orphaned-scopes.ts: the repository's tree against the scopes,
 * cached per commit). Never throws: a failed check answers [].
 */
export interface OrphanedScopeReader {
  find(): Promise<OrphanedScope[]>
  /**
   * After an accepted push: check again once the response is on its way (a
   * later turn of the event loop, asynchronous), so it neither delays nor can
   * fail the push.
   */
  scheduleCheck(): void
}
