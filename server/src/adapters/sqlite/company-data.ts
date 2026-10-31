import type Database from 'better-sqlite3'
import type { CompanyData, CompanyDataSource } from '../../ports/company-data'
import { sqliteDepartmentRepository } from './departments'

/**
 * Company handles over the one application database (案 A). Moving to a
 * database per company (B), or to PostgreSQL with row-level security (C),
 * replaces only this function: it is where a handle opens its connection.
 */
export function sqliteCompanyData(conn: Database.Database): CompanyDataSource {
  return {
    forCompany(companyId) {
      if (typeof companyId !== 'string' || companyId === '') throw new Error('A company handle needs a company id')
      const handle: CompanyData = {
        companyId,
        departments: sqliteDepartmentRepository(conn, companyId),
      }
      return Object.freeze(handle)
    },
  }
}
