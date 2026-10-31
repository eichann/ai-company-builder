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
import { sqliteAgentStopRepository } from './adapters/sqlite/agent-stops'
import { sqliteBrokerTokenRepository, sqliteKeyBrokerRepository } from './adapters/sqlite/key-broker'
import { sqliteTransactions } from './adapters/sqlite/transactions'
import { gitOrphanedScopeReader } from './adapters/orphaned-scopes'
import { betterAuthAccountDirectory } from './adapters/accounts'
import { localRepoStore } from './adapters/git-repo-store'
import { companyFileViews } from './adapters/company-files'
import { processCompanyLock, randomIds, sha256TokenDigest, systemClock } from './adapters/system'
import { loadKekFile } from './adapters/kek-file'
import { localSecretCipher } from './adapters/local-secret-cipher'
import { httpsUpstream } from './adapters/upstream-https'
import { BROKER_DAY_UTC_OFFSET_MINUTES, BROKER_KEK_FILE, BROKER_KEY_CHECK, BROKER_MAX_REQUEST_MB, BROKER_TOKEN_TTL_MINUTES, BROKER_UPSTREAM_TIMEOUT_SECONDS, DATA_DIR } from './lib/config'
import type { BrokerCipherState } from './ports/key-broker'
import type { UpstreamClient } from './ports/upstream'
import { createAccessPolicy } from './services/access'
import { createCompanyService } from './services/companies'
import { createInvitationService } from './services/invitations'
import { createClientActivityService } from './services/client-activity'
import { createPushRejectionRecorder } from './services/push-rejections'
import { createDepartmentService } from './services/departments'
import { createPermissionViewService } from './services/permission-views'
import { createPermissionEditorService } from './services/permission-editor'
import { createPrivateFolderService } from './services/private-folders'
import { createAgentEventService } from './services/agent-events'
import { createAgentSandboxService } from './services/agent-sandbox'
import { createAgentStopService } from './services/agent-stops'
import { createAgentPolicyService } from './services/agent-policy'
import { createPushChannel } from './services/push-channel'
import { createBrokerVault } from './services/broker-vault'
import { createKeyBrokerService } from './services/key-broker'
import { createBrokerTokenService } from './services/broker-tokens'
import { createOwnBrokerKeyService } from './services/own-broker-keys'
import { createBrokerRelay } from './services/broker-relay'
import { createBrokerKeyCheck, type BrokerKeyCheckService } from './services/broker-key-check'

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

/** The relay's day for daily caps (YYYY-MM-DD at BROKER_DAY_UTC_OFFSET_MINUTES, default Japan). */
export function brokerDayOf(ms: number): string {
  return new Date(ms + BROKER_DAY_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10)
}

export interface ServiceOptions {
  /** The relay's way out (tests: a fake upstream). */
  upstream?: UpstreamClient
  /** Check keys once when they are saved (default: BROKER_KEY_CHECK). */
  keyCheck?: boolean
}

export function createServices(conn: Database.Database, brokerCipher: BrokerCipherState = brokerCipherFromEnv(), options: ServiceOptions = {}) {
  const repos = {
    companies: sqliteCompanyRepository(conn),
    memberships: sqliteMembershipRepository(conn),
    invitations: sqliteInvitationRepository(conn),
    departments: sqliteDepartmentRepository(conn),
    scopes: sqliteScopeRepository(conn),
    privateFolders: sqlitePrivateFolderRepository(conn),
    clientActivity: sqliteClientActivityRepository(conn),
    pushRejections: sqlitePushRejectionRepository(conn),
    agentEvents: sqliteAgentEventRepository(conn),
    agentEventSettings: sqliteAgentEventSettingsRepository(conn),
    agentSandbox: sqliteAgentSandboxRepository(conn),
    agentStops: sqliteAgentStopRepository(conn),
    brokerKeys: sqliteKeyBrokerRepository(conn),
    brokerTokens: sqliteBrokerTokenRepository(conn),
    orphanedScopes: gitOrphanedScopeReader(conn),
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
  const upstream = options.upstream ?? httpsUpstream()
  // The key check needs the company's generic services and exceptions (keyBroker); keyBroker asks it before saving.
  let keyCheck: BrokerKeyCheckService | null = null
  const keyBroker = createKeyBrokerService({
    ...repos, ...shared, brokerVault, brokerDay: () => brokerDayOf(shared.clock.nowMs()),
    checkKey: (companyId, service, secret, hosts) => keyCheck!.check(companyId, service, secret, hosts),
  })
  keyCheck = createBrokerKeyCheck({ upstream, keyBroker, enabled: options.keyCheck ?? BROKER_KEY_CHECK })
  const agentEvents = createAgentEventService({ ...repos, ...shared, yieldNow: () => new Promise<void>(resolve => setImmediate(resolve)) })
  // The emergency stop (M2) and the push channel that announces policy changes.
  const push = createPushChannel()
  const agentSandbox = createAgentSandboxService({ ...repos, ...shared })
  const agentStops = createAgentStopService({
    ...repos, ...shared,
    brokerEnabled: () => brokerVault.status().enabled,
    onChange: companyId => agentPolicy.announce(companyId),
  })
  const agentPolicy = createAgentPolicyService({ agentSandbox, agentStops, digest: sha256TokenDigest, push })
  const brokerTokens = createBrokerTokenService({
    ...repos, ...shared, brokerVault, keyBroker, tokenDigest: sha256TokenDigest, ttlMinutes: BROKER_TOKEN_TTL_MINUTES,
  })

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
    agentEvents,
    agentSandbox,
    agentStops,
    agentPolicy,
    push,
    brokerVault,
    keyBroker,
    brokerTokens,
    brokerRelay: createBrokerRelay({
      brokerTokens,
      brokerVault,
      keyBroker,
      upstream,
      brokerKeys: repos.brokerKeys,
      record: agentEvents.recordServerEvent,
      dayOf: brokerDayOf,
      nowMs: () => shared.clock.nowMs(),
      maxRequestBytes: BROKER_MAX_REQUEST_MB * 1024 * 1024,
      headersTimeoutMs: BROKER_UPSTREAM_TIMEOUT_SECONDS * 1000,
      companyStopped: agentStops.companyStopped,
    }),
    ownBrokerKeys: createOwnBrokerKeyService({ ...repos, ...shared, brokerVault, keyBroker }),
    clientActivity: createClientActivityService({ ...repos, ...shared }),
    pushRejections: createPushRejectionRecorder(repos),
    companyFiles: companyFileViews(repos.scopes),
    orphanedScopes: repos.orphanedScopes,
    accounts: shared.accounts,
    repoStore,
  }
}

export type Services = ReturnType<typeof createServices>

export const services: Services = createServices(db)
