import type { ScopeWithRules } from '../../shared/core/permissions'

/**
 * Permission scopes, rules and department managers (lib/permission-store.ts).
 * Semantics: shared/core/permissions.ts.
 */
export interface ScopeRepository {
  /** Every scope of the company with its rules (rules oldest first). */
  listWithRules(companyId: string): ScopeWithRules[]
  /** Department ids in the company the user manages, by the departments' sort_order. */
  managedDepartmentIds(companyId: string, userId: string): string[]
  /** The company scope, created with `everyone: read + write` the first time. Returns its id. */
  ensureCompanyScope(companyId: string, createdBy: string | null): string
  /** The department's scope at its folder (no rules: inherits). */
  ensureDepartmentScope(companyId: string, departmentId: string, folder: string, createdBy: string | null): void
  /** One scope per department; repairs drift. */
  syncCompanyScopes(companyId: string): void
  /** A department folder was renamed: its scope and every scope under it move (rules stay attached). */
  moveScopeSubtree(companyId: string, fromPath: string, toPath: string): void
  /** A department was deleted: its scope subtree, their rules and its managers go. */
  deleteDepartmentScopes(companyId: string, departmentId: string, folder: string): void
  /** Remove every rule naming the user in the company (private folders included). Returns how many. */
  deleteUserRules(companyId: string, userId: string): number
  /** Current managers of a department, oldest first. */
  departmentManagerIds(departmentId: string): string[]
  /** Replace the department's managers (kept rows keep their created_at/by). */
  replaceDepartmentManagers(departmentId: string, userIds: string[], createdBy: string): void
  /** The user manages no department of the company any more. */
  removeManagerFromCompany(companyId: string, userId: string): void
}
