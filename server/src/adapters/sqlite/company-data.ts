import type Database from 'better-sqlite3'
import type { CompanyData, CompanyDataSource } from '../../ports/company-data'
import type { PrivateFolderRepository } from '../../ports/private-folders'
import type { ScopeRepository } from '../../ports/scopes'
import type { ReaderChangeGate } from '../../ports/holding'
import { gitOrphanedScopeReader } from '../orphaned-scopes'
import { sqlitePrivateFolderRepository } from '../private-folders'
import { sqliteAiRunRepository } from './ai-runs'
import { sqliteCompanyRowsExport } from './company-archive'
import { sqliteConnectorRepository } from './connectors'
import { sqliteDepartmentRepository } from './departments'
import { sqliteGoogleDriveRepository } from './google-drive'
import { sqliteFixedPayloadRepository } from './fixed-payloads'
import { sqliteGroupRepository, sqlitePermissionHistoryRepository } from './groups'
import { sqliteHoldingItemRepository, sqliteHoldingTicketRepository } from './holding'
import { sqliteInvitationRepository } from './invitations'
import { sqliteJobRepository } from './jobs'
import { sqliteNotificationRepository } from './notifications'
import { sqliteOutboundMailRepository } from './outbound-mail'
import { sqlitePluginRepository } from './plugins'
import { sqliteRecordRepository } from './records'
import { sqliteScopeRepository } from './scopes'
import { sqliteSecondOpinionSettingRepository } from './second-opinion'
import { sqliteSecurityAlertRepository } from './security-alerts'
import { sqliteSkillUseRepository } from './skill-uses'
import { sqliteSkillShelfRepository } from './skill-shelf'
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
import { sqliteBrowserPlanRepository } from './browser-plans'
import { sqliteBrowserLineRepository } from './browser-lines'
// lane C ▲
/** The scope methods that can take a private folder away from someone: tracked changes only. */
function gatedScopes(scopes: ScopeRepository, gate: ReaderChangeGate, companyId: string): ScopeRepository {
  const ask = (what: string) => gate.assertWithin(companyId, `scopes.${what}`)
  return {
    ...scopes,
    replaceRules: (...a) => { ask('replaceRules'); return scopes.replaceRules(...a) },
    upsertRule: (...a) => { ask('upsertRule'); return scopes.upsertRule(...a) },
    updateRuleAccess: (...a) => { ask('updateRuleAccess'); return scopes.updateRuleAccess(...a) },
    deleteRule: (...a) => { ask('deleteRule'); return scopes.deleteRule(...a) },
    clearRules: (...a) => { ask('clearRules'); return scopes.clearRules(...a) },
    deleteUserRules: (...a) => { ask('deleteUserRules'); return scopes.deleteUserRules(...a) },
  }
}

/**
 * Company handles over the one application database (案 A). Moving to a
 * database per company (B), or to PostgreSQL with row-level security (C),
 * replaces only this function: it is where a handle opens its connection.
 *
 * `options.readerChanges` (the composition root's gate, lib/reader-change-gate.ts): every
 * storage step that can take a private folder away from someone runs only inside
 * holdingTickets.track. Absent (operator commands, unit tests): not asked.
 */
export function sqliteCompanyData(conn: Database.Database, options: { readerChanges?: ReaderChangeGate } = {}): CompanyDataSource {
  const gate = options.readerChanges
  return {
    forCompany(companyId) {
      if (typeof companyId !== 'string' || companyId === '') throw new Error('A company handle needs a company id')
      const handle: CompanyData = {
        companyId,
        departments: sqliteDepartmentRepository(conn, companyId),
        invitations: sqliteInvitationRepository(conn, companyId),
        scopes: gate ? gatedScopes(sqliteScopeRepository(conn, companyId), gate, companyId) : sqliteScopeRepository(conn, companyId),
        privateFolders: sqlitePrivateFolderRepository(conn, companyId, gate) satisfies PrivateFolderRepository,
        groups: sqliteGroupRepository(conn, companyId),
        permissionHistory: sqlitePermissionHistoryRepository(conn, companyId),
        holding: sqliteHoldingTicketRepository(conn, companyId),
        holdingItems: sqliteHoldingItemRepository(conn, companyId),
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
        jobs: sqliteJobRepository(conn, companyId),
        skillUses: sqliteSkillUseRepository(conn, companyId),
        secondOpinion: sqliteSecondOpinionSettingRepository(conn, companyId),
        securityAlerts: sqliteSecurityAlertRepository(conn, companyId),
        skillShelf: sqliteSkillShelfRepository(conn, companyId),
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
        browserPlans: sqliteBrowserPlanRepository(conn, companyId),
        browserLines: sqliteBrowserLineRepository(conn, companyId),
        // lane C ▲
        archive: sqliteCompanyRowsExport(conn, companyId),
      }
      return Object.freeze(handle)
    },
  }
}
