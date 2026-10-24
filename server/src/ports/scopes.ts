/**
 * Permission scopes, rules and department managers — the writes the
 * services make. Access decisions read through shared/core's
 * PermissionRepository.
 */
export interface ScopeRepository {
  /** The company scope, created with `everyone: read + write` the first time. Returns its id. */
  ensureCompanyScope(companyId: string, createdBy: string | null): string
  /** One scope per department; repairs drift. */
  syncCompanyScopes(companyId: string): void
  /** Remove every rule naming the user in the company (private folders included). Returns how many. */
  deleteUserRules(companyId: string, userId: string): number
  /** The user manages no department of the company any more. */
  removeManagerFromCompany(companyId: string, userId: string): void
}
