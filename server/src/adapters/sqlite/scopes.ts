import type Database from 'better-sqlite3'
import type { ScopeRepository } from '../../ports/scopes'
import {
  clearScopeRules,
  deleteDepartmentScopes,
  deleteRule,
  deleteUserRules,
  ensureCompanyScope,
  ensureDepartmentScope,
  getRuleWithScope,
  getScopeById,
  getScopeByPath,
  listDepartmentManagerIds,
  listScopeRules,
  listScopesWithRules,
  managedDepartmentIds,
  moveScopeRules,
  moveScopeSubtree,
  removeManagerFromCompany,
  replaceDepartmentManagers,
  replaceScopeRules,
  syncCompanyScopes,
  updateRuleAccess,
  upsertScopeRule,
} from './permission-store'

/**
 * One company's scopes: ./permission-store.ts (which db/index.ts also runs at
 * startup) behind the port, bound to `companyId`. Built only by the company
 * handle (./company-data.ts).
 */
export function sqliteScopeRepository(conn: Database.Database, companyId: string): ScopeRepository {
  return {
    listWithRules: () => listScopesWithRules(conn, companyId),
    managedDepartmentIds: userId => managedDepartmentIds(conn, companyId, userId),
    getById: scopeId => getScopeById(conn, companyId, scopeId),
    getByPath: path => getScopeByPath(conn, companyId, path),
    rulesOf: scopeId => listScopeRules(conn, companyId, scopeId),
    ruleWithScope: ruleId => getRuleWithScope(conn, companyId, ruleId),

    replaceRules: (path, rules, createdBy) => replaceScopeRules(conn, companyId, path, rules, createdBy),
    upsertRule: (path, rule, createdBy) => upsertScopeRule(conn, companyId, path, rule, createdBy),
    updateRuleAccess: (ruleId, canRead, canWrite) => updateRuleAccess(conn, companyId, ruleId, canRead, canWrite),
    deleteRule: (ruleId, scope) => deleteRule(conn, companyId, ruleId, scope),
    clearRules: scope => clearScopeRules(conn, companyId, scope),
    moveRules: (fromPath, toPath, createdBy) => moveScopeRules(conn, companyId, fromPath, toPath, createdBy),

    ensureCompanyScope: createdBy => ensureCompanyScope(conn, companyId, createdBy),
    ensureDepartmentScope: (departmentId, folder, createdBy) => {
      ensureDepartmentScope(conn, companyId, departmentId, folder, createdBy)
    },
    syncCompanyScopes: () => syncCompanyScopes(conn, companyId),
    moveScopeSubtree: (fromPath, toPath) => moveScopeSubtree(conn, companyId, fromPath, toPath),
    deleteDepartmentScopes: (departmentId, folder) => deleteDepartmentScopes(conn, companyId, departmentId, folder),
    deleteUserRules: userId => deleteUserRules(conn, companyId, userId),
    departmentManagerIds: departmentId => listDepartmentManagerIds(conn, companyId, departmentId),
    replaceDepartmentManagers: (departmentId, userIds, createdBy) => replaceDepartmentManagers(conn, companyId, departmentId, userIds, createdBy),
    removeManagerFromCompany: userId => removeManagerFromCompany(conn, companyId, userId),
  }
}
