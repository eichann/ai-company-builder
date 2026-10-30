/**
 * Composition root: the one place that picks the adapters (SQLite, the local
 * repository store, the system clock) and hands them to the services. Routes
 * get their services from here; nothing else imports src/adapters.
 *
 * Built at import time from the process's database connection (src/db),
 * which tests point at a temporary DATA_DIR. Repositories prepare their
 * statements per call, so building them before initDatabase() is safe.
 */
import type Database from 'better-sqlite3'
import { db } from './db'
import { sqliteCompanyRepository } from './adapters/sqlite/companies'
import { sqliteMembershipRepository } from './adapters/sqlite/memberships'
import { sqliteInvitationRepository } from './adapters/sqlite/invitations'
import { sqliteDepartmentRepository } from './adapters/sqlite/departments'
import { sqliteScopeRepository } from './adapters/sqlite/scopes'
import { sqlitePrivateFolderRepository } from './adapters/sqlite/private-folders'
import { sqliteClientActivityRepository } from './adapters/sqlite/client-activity'
import { sqlitePushRejectionRepository } from './adapters/sqlite/push-rejections'
import { sqliteAgentEventRepository, sqliteAgentEventSettingsRepository } from './adapters/sqlite/agent-events'
import { sqliteAgentSandboxRepository } from './adapters/sqlite/agent-sandbox'
import { sqliteBrokerTokenRepository, sqliteKeyBrokerRepository } from './adapters/sqlite/key-broker'
import { sqliteTransactions } from './adapters/sqlite/transactions'
import { gitOrphanedScopeReader } from './adapters/orphaned-scopes'
import { betterAuthAccountDirectory } from './adapters/accounts'
import { localRepoStore } from './adapters/git-repo-store'
import { companyFileViews } from './adapters/company-files'
import { processCompanyLock, randomIds, sha256TokenDigest, systemClock } from './adapters/system'
import { loadKekFile } from './adapters/kek-file'
import { localSecretCipher } from './adapters/local-secret-cipher'
import { BROKER_KEK_FILE, BROKER_TOKEN_TTL_MINUTES, DATA_DIR } from './lib/config'
import type { BrokerCipherState } from './ports/key-broker'
import { createAccessPolicy } from './services/access'
import { createCompanyService } from './services/companies'
import { createInvitationService } from './services/invitations'
import { createDepartmentService } from './services/departments'
import { createPermissionViewService } from './services/permission-views'
import { createPermissionEditorService } from './services/permission-editor'
import { createPrivateFolderService } from './services/private-folders'
import { createAgentEventService } from './services/agent-events'
import { createAgentSandboxService } from './services/agent-sandbox'
import { createBrokerVault } from './services/broker-vault'
import { createKeyBrokerService } from './services/key-broker'
import { createBrokerTokenService } from './services/broker-tokens'
import { createOwnBrokerKeyService } from './services/own-broker-keys'

/**
 * The key broker's cipher: envelope encryption under the KEK file named by
 * BROKER_KEK_FILE, or "off" with the reason (the server runs without it).
 */
export function brokerCipherFromEnv(): BrokerCipherState {
  const loaded = loadKekFile(BROKER_KEK_FILE, DATA_DIR)
  if (!loaded.ok) return { enabled: false, reason: loaded.reason, detail: loaded.detail }
  const cipher = localSecretCipher(loaded.kek)
  loaded.kek.fill(0)
  return { enabled: true, cipher }
}

export function createServices(conn: Database.Database, brokerCipher: BrokerCipherState = brokerCipherFromEnv()) {
  const repos = {
    companies: sqliteCompanyRepository(conn),
    memberships: sqliteMembershipRepository(conn),
    invitations: sqliteInvitationRepository(conn),
    departments: sqliteDepartmentRepository(conn),
    scopes: sqliteScopeRepository(conn),
    privateFolders: sqlitePrivateFolderRepository(conn),
    clientActivity: sqliteClientActivityRepository(),
    pushRejections: sqlitePushRejectionRepository(),
    agentEvents: sqliteAgentEventRepository(conn),
    agentEventSettings: sqliteAgentEventSettingsRepository(conn),
    agentSandbox: sqliteAgentSandboxRepository(conn),
    brokerKeys: sqliteKeyBrokerRepository(conn),
    brokerTokens: sqliteBrokerTokenRepository(conn),
    orphanedScopes: gitOrphanedScopeReader(),
  }
  const shared = {
    accounts: betterAuthAccountDirectory(),
    transactions: sqliteTransactions(conn),
    clock: systemClock,
    ids: randomIds,
  }
  const repoStore = localRepoStore()

  const permissionViews = createPermissionViewService({ ...repos, ...shared })
  const brokerVault = createBrokerVault({ ...repos, brokerCipher })
  const keyBroker = createKeyBrokerService({ ...repos, ...shared, brokerVault })

  return {
    access: createAccessPolicy(repos.memberships),
    companies: createCompanyService({ ...repos, ...shared, repoStore }),
    invitations: createInvitationService({ ...repos, ...shared }),
    departments: createDepartmentService({ ...repos, ...shared, repoStore }),
    permissionViews,
    permissionEditor: createPermissionEditorService({
      ...repos,
      ...shared,
      repoStore,
      managedFolders: permissionViews.managedFolders,
    }),
    privateFolders: createPrivateFolderService({ ...repos, ...shared, repoStore, companyLock: processCompanyLock }),
    agentEvents: createAgentEventService({ ...repos, ...shared, yieldNow: () => new Promise<void>(resolve => setImmediate(resolve)) }),
    agentSandbox: createAgentSandboxService({ ...repos, ...shared }),
    brokerVault,
    keyBroker,
    brokerTokens: createBrokerTokenService({
      ...repos, ...shared, brokerVault, keyBroker, tokenDigest: sha256TokenDigest, ttlMinutes: BROKER_TOKEN_TTL_MINUTES,
    }),
    ownBrokerKeys: createOwnBrokerKeyService({ ...repos, ...shared, brokerVault, keyBroker }),
    companyFiles: companyFileViews(conn),
    accounts: shared.accounts,
    repoStore,
  }
}

export type Services = ReturnType<typeof createServices>

export const services: Services = createServices(db)
