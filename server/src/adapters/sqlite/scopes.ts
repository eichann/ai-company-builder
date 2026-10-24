import type Database from 'better-sqlite3'
import type { ScopeRepository } from '../../ports/scopes'
import {
  deleteUserRules,
  ensureCompanyScope,
  removeManagerFromCompany,
  syncCompanyScopes,
} from '../../lib/permission-store'

/** lib/permission-store.ts (which db/index.ts also runs at startup), behind the port. */
export function sqliteScopeRepository(conn: Database.Database): ScopeRepository {
  return {
    ensureCompanyScope: (companyId, createdBy) => ensureCompanyScope(conn, companyId, createdBy),
    syncCompanyScopes: companyId => syncCompanyScopes(conn, companyId),
    deleteUserRules: (companyId, userId) => deleteUserRules(conn, companyId, userId),
    removeManagerFromCompany: (companyId, userId) => removeManagerFromCompany(conn, companyId, userId),
  }
}
