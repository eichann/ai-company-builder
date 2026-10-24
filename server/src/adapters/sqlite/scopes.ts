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
} from '../../lib/permission-store'

/** lib/permission-store.ts (which db/index.ts also runs at startup), behind the port. */
export function sqliteScopeRepository(conn: Database.Database): ScopeRepository {
  return {
    listWithRules: companyId => listScopesWithRules(conn, companyId),
    managedDepartmentIds: (companyId, userId) => managedDepartmentIds(conn, companyId, userId),
    getById: (companyId, scopeId) => getScopeById(conn, companyId, scopeId),
    getByPath: (companyId, path) => getScopeByPath(conn, companyId, path),
    rulesOf: scopeId => listScopeRules(conn, scopeId),
    ruleWithScope: (companyId, ruleId) => getRuleWithScope(conn, companyId, ruleId),

    replaceRules: (companyId, path, rules, createdBy) => replaceScopeRules(conn, companyId, path, rules, createdBy),
    upsertRule: (companyId, path, rule, createdBy) => upsertScopeRule(conn, companyId, path, rule, createdBy),
    updateRuleAccess: (ruleId, canRead, canWrite) => updateRuleAccess(conn, ruleId, canRead, canWrite),
    deleteRule: (ruleId, scope) => deleteRule(conn, ruleId, scope),
    clearRules: scope => clearScopeRules(conn, scope),
    moveRules: (companyId, fromPath, toPath, createdBy) => moveScopeRules(conn, companyId, fromPath, toPath, createdBy),

    ensureCompanyScope: (companyId, createdBy) => ensureCompanyScope(conn, companyId, createdBy),
    ensureDepartmentScope: (companyId, departmentId, folder, createdBy) => {
      ensureDepartmentScope(conn, companyId, departmentId, folder, createdBy)
    },
    syncCompanyScopes: companyId => syncCompanyScopes(conn, companyId),
    moveScopeSubtree: (companyId, fromPath, toPath) => moveScopeSubtree(conn, companyId, fromPath, toPath),
    deleteDepartmentScopes: (companyId, departmentId, folder) => deleteDepartmentScopes(conn, companyId, departmentId, folder),
    deleteUserRules: (companyId, userId) => deleteUserRules(conn, companyId, userId),
    departmentManagerIds: departmentId => listDepartmentManagerIds(conn, departmentId),
    replaceDepartmentManagers: (departmentId, userIds, createdBy) => replaceDepartmentManagers(conn, departmentId, userIds, createdBy),
    removeManagerFromCompany: (companyId, userId) => removeManagerFromCompany(conn, companyId, userId),
  }
}
