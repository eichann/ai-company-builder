import type Database from 'better-sqlite3'
import type { ScopeRepository } from '../../ports/scopes'
import {
  deleteDepartmentScopes,
  deleteUserRules,
  ensureCompanyScope,
  ensureDepartmentScope,
  listDepartmentManagerIds,
  listScopesWithRules,
  managedDepartmentIds,
  moveScopeSubtree,
  removeManagerFromCompany,
  replaceDepartmentManagers,
  syncCompanyScopes,
} from '../../lib/permission-store'

/** lib/permission-store.ts (which db/index.ts also runs at startup), behind the port. */
export function sqliteScopeRepository(conn: Database.Database): ScopeRepository {
  return {
    listWithRules: companyId => listScopesWithRules(conn, companyId),
    managedDepartmentIds: (companyId, userId) => managedDepartmentIds(conn, companyId, userId),
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
