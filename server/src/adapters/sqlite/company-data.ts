import type Database from 'better-sqlite3'
import type { CompanyData, CompanyDataSource } from '../../ports/company-data'
import { gitOrphanedScopeReader } from '../orphaned-scopes'
import { sqlitePrivateFolderRepository } from '../private-folders'
import { sqliteAiRunRepository } from './ai-runs'
import { sqliteCompanyRowsExport } from './company-archive'
import { sqliteConnectorRepository } from './connectors'
import { sqliteDepartmentRepository } from './departments'
import { sqliteGoogleDriveRepository } from './google-drive'
import { sqliteFixedPayloadRepository } from './fixed-payloads'
import { sqliteInvitationRepository } from './invitations'
import { sqliteNotificationRepository } from './notifications'
import { sqliteOutboundMailRepository } from './outbound-mail'
import { sqlitePluginRepository } from './plugins'
import { sqliteRecordRepository } from './records'
import { sqliteScopeRepository } from './scopes'
import { sqliteSecondOpinionSettingRepository } from './second-opinion'
import { sqliteSkillUseRepository } from './skill-uses'
import { sqliteTaskSettingsRepository } from './task-settings'

// Lanes (server.md "Lane markers"): add only right under your lane's ▼.
// lane A ▼
// lane A ▲
// lane B ▼
import { sqliteIdentityRepository } from './identities'
import { sqliteInboxRepository } from './inbox'
// lane B ▲
// lane C ▼
import { sqlitePluginStepRepository } from './plugin-steps'
import { sqlitePluginRoleRepository } from './plugin-roles'
// lane C ▲
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
        googleDrive: sqliteGoogleDriveRepository(conn, companyId),
        outbound: sqliteOutboundMailRepository(conn, companyId),
        fixedPayloads: sqliteFixedPayloadRepository(conn, companyId),
        notifications: sqliteNotificationRepository(conn, companyId),
        tasks: sqliteTaskSettingsRepository(conn, companyId),
        aiRuns: sqliteAiRunRepository(conn, companyId),
        skillUses: sqliteSkillUseRepository(conn, companyId),
        secondOpinion: sqliteSecondOpinionSettingRepository(conn, companyId),
        // Lanes (server.md "Lane markers"): add only right under your lane's ▼.
        // lane A ▼
        // lane A ▲
        // lane B ▼
        identities: sqliteIdentityRepository(conn, companyId),
        inbox: sqliteInboxRepository(conn, companyId),
        // lane B ▲
        // lane C ▼
        pluginSteps: sqlitePluginStepRepository(conn, companyId),
        pluginRoles: sqlitePluginRoleRepository(conn, companyId),
        // lane C ▲
        archive: sqliteCompanyRowsExport(conn, companyId),
      }
      return Object.freeze(handle)
    },
  }
}
