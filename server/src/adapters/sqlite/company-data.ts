import type Database from 'better-sqlite3'
import type { CompanyData, CompanyDataSource } from '../../ports/company-data'
import { gitOrphanedScopeReader } from '../orphaned-scopes'
import { sqlitePrivateFolderRepository } from '../private-folders'
import { sqliteCompanyRowsExport } from './company-archive'
import { sqliteConnectorRepository } from './connectors'
import { sqliteDepartmentRepository } from './departments'
import { sqliteFixedPayloadRepository } from './fixed-payloads'
import { sqliteInvitationRepository } from './invitations'
import { sqlitePluginRepository } from './plugins'
import { sqliteRecordRepository } from './records'
import { sqliteScopeRepository } from './scopes'

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
        invitations: sqliteInvitationRepository(conn, companyId),
        scopes: sqliteScopeRepository(conn, companyId),
        privateFolders: sqlitePrivateFolderRepository(conn, companyId),
        orphanedScopes: gitOrphanedScopeReader(conn, companyId),
        records: sqliteRecordRepository(conn, companyId),
        plugins: sqlitePluginRepository(conn, companyId),
        connectors: sqliteConnectorRepository(conn, companyId),
        fixedPayloads: sqliteFixedPayloadRepository(conn, companyId),
        archive: sqliteCompanyRowsExport(conn, companyId),
      }
      return Object.freeze(handle)
    },
  }
}
