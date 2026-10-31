import type { ScopeKind, ScopeRule, ScopeWithRules } from '../../shared/core/permissions'

/** A scope row without its rules. */
export interface ScopeRecord {
  id: string
  companyId: string
  path: string
  kind: ScopeKind
  departmentId: string | null
}

export type NewRule = Omit<ScopeRule, 'id'>

/**
 * One company's permission scopes, rules and department managers, from its
 * handle (`CompanyData.scopes`, ports/company-data.ts;
 * adapters/sqlite/permission-store.ts). Every method is limited to that
 * company: another company's scope, rule or department id is not found and
 * nothing of it changes. Semantics: shared/core/permissions.ts. Every write
 * that touches several rows is atomic by itself (nested inside a caller's
 * transaction, it joins it).
 */
export interface ScopeRepository {
  /** Every scope with its rules (rules oldest first). */
  listWithRules(): ScopeWithRules[]
  /** Department ids the user manages, by the departments' sort_order. */
  managedDepartmentIds(userId: string): string[]
  getById(scopeId: string): ScopeRecord | null
  getByPath(path: string): ScopeRecord | null
  /** The scope's rules, oldest first. */
  rulesOf(scopeId: string): ScopeRule[]
  ruleWithScope(ruleId: string): { rule: ScopeRule; scope: ScopeRecord } | null

  // Rule editing (the permission editor)
  /** Replace the path's whole rule set ([] = inherit again). Returns the scope, or null when none is left. */
  replaceRules(path: string, rules: NewRule[], createdBy: string): ScopeRecord | null
  /** Set one subject's rule on the path; the first rule copies the inherited ones in. */
  upsertRule(path: string, rule: NewRule, createdBy: string): { ruleId: string; created: boolean; scope: ScopeRecord }
  updateRuleAccess(ruleId: string, canRead: boolean, canWrite: boolean): void
  deleteRule(ruleId: string, scope: ScopeRecord): void
  /** Back to inheriting. Returns how many rules were removed. */
  clearRules(scope: ScopeRecord): number
  /** Move the rules of a folder (and the folders inside it) to another folder. Returns how many scopes moved. */
  moveRules(fromPath: string, toPath: string, createdBy: string | null): number

  /** The company scope, created with `everyone: read + write` the first time. Returns its id. */
  ensureCompanyScope(createdBy: string | null): string
  /** The department's scope at its folder (no rules: inherits). */
  ensureDepartmentScope(departmentId: string, folder: string, createdBy: string | null): void
  /** One scope per department; repairs drift. */
  syncCompanyScopes(): void
  /** A department folder was renamed: its scope and every scope under it move (rules stay attached). */
  moveScopeSubtree(fromPath: string, toPath: string): void
  /** A department was deleted: its scope subtree, their rules and its managers go. */
  deleteDepartmentScopes(departmentId: string, folder: string): void
  /** Remove every rule naming the user (private folders included). Returns how many. */
  deleteUserRules(userId: string): number
  /** Current managers of a department, oldest first. */
  departmentManagerIds(departmentId: string): string[]
  /** Replace the department's managers (kept rows keep their created_at/by). */
  replaceDepartmentManagers(departmentId: string, userIds: string[], createdBy: string): void
  /** The user manages no department of the company any more. */
  removeManagerFromCompany(userId: string): void
}
