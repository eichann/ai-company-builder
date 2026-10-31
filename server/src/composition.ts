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
import { sqliteInvitationTokens } from './adapters/sqlite/invitations'
import { sqliteCompanyData } from './adapters/sqlite/company-data'
import { sqliteClientActivityRepository } from './adapters/sqlite/client-activity'
import { sqlitePushRejectionRepository } from './adapters/sqlite/push-rejections'
import { sqliteAgentEventRepository, sqliteAgentEventSettingsRepository } from './adapters/sqlite/agent-events'
import { sqliteAgentSandboxRepository } from './adapters/sqlite/agent-sandbox'
import { sqliteAgentStopRepository } from './adapters/sqlite/agent-stops'
import { sqliteBrokerTokenRepository, sqliteKeyBrokerRepository } from './adapters/sqlite/key-broker'
import { sqliteTransactions } from './adapters/sqlite/transactions'
import { betterAuthAccountDirectory } from './adapters/accounts'
import { localRepoStore } from './adapters/git-repo-store'
import { companyFileViews } from './adapters/company-files'
import { gitRecordFileSource, gitRecordFileWriter } from './adapters/record-files'
import { processCompanyLock, randomIds, sha256TokenDigest, systemClock } from './adapters/system'
import { loadKekFile } from './adapters/kek-file'
import { localSecretCipher } from './adapters/local-secret-cipher'
import { httpsUpstream } from './adapters/upstream-https'
import { practiceUpstream } from './adapters/upstream-practice'
import { diskPluginShelf } from './adapters/plugin-shelf'
import { BROKER_DAY_UTC_OFFSET_MINUTES, BROKER_KEK_FILE, BROKER_KEY_CHECK, BROKER_MAX_REQUEST_MB, BROKER_TOKEN_TTL_MINUTES, BROKER_UPSTREAM_TIMEOUT_SECONDS, COMPANY_CREATION_POLICY, DATA_DIR, PLUGINS_DIR, PRACTICE_UPSTREAMS, operatorUserIds, type PracticeUpstreams } from './lib/config'
import type { BrokerCipherState } from './ports/key-broker'
import type { UpstreamClient } from './ports/upstream'
import { createAccessPolicy } from './services/access'
import { createCompanyService } from './services/companies'
import { parseCompanyCreationPolicy, type CompanyCreationPolicy } from './services/company-creation-policy'
import { createInvitationService } from './services/invitations'
import { createClientActivityService } from './services/client-activity'
import { createPushRejectionRecorder } from './services/push-rejections'
import { createDepartmentService } from './services/departments'
import { createPermissionViewService } from './services/permission-views'
import { createPermissionEditorService } from './services/permission-editor'
import { createPrivateFolderService } from './services/private-folders'
import { createCompanyScopeService } from './services/company-scopes'
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
import { createRecordIndexer } from './services/record-index'
import { createRecordService } from './services/records'
import { createRecordEngine } from './services/record-engine'
import { createRecordAiTokenService } from './services/record-ai-tokens'
import { createPluginShelf } from './services/plugin-shelf'
import { createPluginService } from './services/plugins'
import { createPluginConnector } from './services/plugin-connector'
import { createPluginImportService } from './services/plugin-import'
import { createPluginOperationService } from './services/plugin-operations'
import { createPluginMappingCheckService } from './services/plugin-mapping-check'
import { createExternalRecordWriter } from './services/record-engine'
import { builtinBrokerService, relayCredentialValue } from '../shared/core/key-broker'

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

/**
 * COMPANY_CREATION_POLICY as configured. An unknown or not-yet-implemented
 * policy stops the server at startup (this module is imported by index.ts)
 * instead of running with a rule nobody chose.
 */
function companyCreationPolicyFromEnv(): CompanyCreationPolicy {
  const parsed = parseCompanyCreationPolicy(COMPANY_CREATION_POLICY)
  if (!parsed.ok) throw new Error(`Refusing to start: ${parsed.error}`)
  return parsed.policy
}

/** A broker key row's destination hosts (JSON of BrokerDestinations); none when unreadable. */
function keyHosts(destinations: string): string[] {
  try {
    const hosts = (JSON.parse(destinations) as { hosts?: unknown }).hosts
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string') : []
  } catch {
    return []
  }
}

export interface ServiceOptions {
  /** The relay's way out (tests: a fake upstream). */
  upstream?: UpstreamClient
  /** Check keys once when they are saved (default: BROKER_KEY_CHECK). */
  keyCheck?: boolean
  /** Staging's practice upstreams (default: PRACTICE_UPSTREAMS from the environment, lib/config.ts). */
  practiceUpstreams?: PracticeUpstreams
  /** The plugin shelf's folder (default: PLUGINS_DIR). */
  pluginsDir?: string | null
}

export function createServices(conn: Database.Database, brokerCipher: BrokerCipherState = brokerCipherFromEnv(), options: ServiceOptions = {}) {
  const repos = {
    companies: sqliteCompanyRepository(conn),
    memberships: sqliteMembershipRepository(conn),
    invitationTokens: sqliteInvitationTokens(conn),
    clientActivity: sqliteClientActivityRepository(conn),
    pushRejections: sqlitePushRejectionRepository(conn),
    agentEvents: sqliteAgentEventRepository(conn),
    agentEventSettings: sqliteAgentEventSettingsRepository(conn),
    agentSandbox: sqliteAgentSandboxRepository(conn),
    agentStops: sqliteAgentStopRepository(conn),
    brokerKeys: sqliteKeyBrokerRepository(conn),
    brokerTokens: sqliteBrokerTokenRepository(conn),
  }
  const shared = {
    // Company handles (ports/company-data.ts): services only; routes never get one.
    companyData: sqliteCompanyData(conn),
    accounts: betterAuthAccountDirectory(),
    transactions: sqliteTransactions(conn),
    clock: systemClock,
    ids: randomIds,
  }
  const repoStore = localRepoStore()

  const permissionViews = createPermissionViewService({ ...repos, ...shared })
  const brokerVault = createBrokerVault({ ...repos, brokerCipher })
  // Staging only: HubSpot's connections may go to the fake HubSpot (never in production: lib/config.ts).
  const practice = options.practiceUpstreams ?? PRACTICE_UPSTREAMS
  const practiceList = practice.state === 'on' ? practice.upstreams : []
  const upstream = practiceUpstream(options.upstream ?? httpsUpstream(), practiceList)
  // The key check needs the company's generic services and exceptions (keyBroker); keyBroker asks it before saving.
  let keyCheck: BrokerKeyCheckService | null = null
  const keyBroker = createKeyBrokerService({
    ...repos, ...shared, brokerVault, brokerDay: () => brokerDayOf(shared.clock.nowMs()),
    practiceServices: practiceList.map(u => u.service),
    checkKey: (companyId, service, secret, hosts) => keyCheck!.check(companyId, service, secret, hosts),
    // A connection a plugin manages keeps the relay read-only (plugins.md); bound below.
    managedByPlugin: (companyId, service) => plugins.manages(companyId, service),
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
    // With several company keys, the one a plugin's connection uses (bound below).
    connectionKeyId: (companyId, service) => plugins.connectionKeyId(companyId, service),
  })

  // The company map (light ontology 4-2): indexed from pushes, off per company by default.
  const recordIndexer = createRecordIndexer({ ...shared, recordFiles: gitRecordFileSource() })

  const access = createAccessPolicy(repos.memberships)
  // The state engine (4-3): the only writer of record_state / record_ledger.
  const recordEngine = createRecordEngine({
    ...shared,
    files: gitRecordFileWriter(),
    managedFolders: (companyId, userId) => permissionViews.managedFolders(companyId, userId),
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
    notify: (companyId, userIds) => push.notify(companyId, userIds, { kind: 'records', version: shared.ids.newToken().slice(0, 32) }),
  })

  // Connector plugins (milestone 3): the shelf is shared and read only; installs are behind the company handle.
  const pluginShelf = createPluginShelf(diskPluginShelf(options.pluginsDir !== undefined ? options.pluginsDir : PLUGINS_DIR))
  const plugins = createPluginService({
    ...shared,
    shelf: pluginShelf,
    companyKey: (companyId, keyId) => {
      const row = repos.brokerKeys.find(companyId, keyId)
      return row ? { scope: row.scope, service: row.service, status: row.status, hosts: keyHosts(row.destinations) } : null
    },
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
    relayReadOnly: (member, service) => { keyBroker.setReadOnly(member, service, { readOnly: true }) },
  })

  // The connector (P5): the only part that talks to an outside system for a plugin; the engine's
  // external entry is handed to the plugin services only (never to a route).
  const pluginConnector = createPluginConnector({
    upstream,
    reveal: (companyId, keyId) => brokerVault.reveal(companyId, keyId),
    credential: (companyId, service) => {
      const builtin = builtinBrokerService(service)
      if (builtin) return { header: builtin.credential, value: key => builtin.credential === 'authorization' ? `Bearer ${key}` : key }
      const relay = keyBroker.relayService(companyId, service)
      return relay ? { header: relay.header, value: key => relayCredentialValue(relay.format, key) } : null
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    nowMs: () => shared.clock.nowMs(),
  })
  const externalRecords = createExternalRecordWriter({
    ...shared,
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    notify: (companyId, userIds) => push.notify(companyId, userIds, { kind: 'records', version: shared.ids.newToken().slice(0, 32) }),
  })
  const pluginImport = createPluginImportService({
    ...shared, plugins, connector: pluginConnector, writer: externalRecords,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
  })

  const pluginOperations = createPluginOperationService({
    ...shared, plugins, connector: pluginConnector, writer: externalRecords, importer: pluginImport,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
    managedFolders: (companyId, userId) => permissionViews.managedFolders(companyId, userId),
    aiStopped: companyId => agentStops.companyStopped(companyId),
  })

  // 「HubSpot に聞いて確かめる」 (P8): the outside property list, read through the connector.
  const pluginMappingCheck = createPluginMappingCheckService({
    ...shared, plugins, connector: pluginConnector,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
  })

  return {
    access,
    pluginShelf,
    plugins,
    pluginImport,
    pluginOperations,
    pluginMappingCheck,
    companies: createCompanyService({ ...repos, ...shared, repoStore,
      creationPolicy: companyCreationPolicyFromEnv(),
      isOperator: userId => operatorUserIds().has(userId),
    }),
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
      managedConnection: (companyId, userId, service) => plugins.relayPolicy(companyId, userId, service),
    }),
    ownBrokerKeys: createOwnBrokerKeyService({ ...repos, ...shared, brokerVault, keyBroker }),
    clientActivity: createClientActivityService({ ...repos, ...shared }),
    pushRejections: createPushRejectionRecorder(repos),
    companyFiles: companyFileViews(shared.companyData),
    /** git-http's push snapshot, private-folder lookups and orphan checks, for a member. */
    companyScopes: createCompanyScopeService(shared),
    records: createRecordService({ ...shared, indexer: recordIndexer }),
    recordEngine,
    recordAiTokens: createRecordAiTokenService({
      ...shared, tokenDigest: sha256TokenDigest, memberOf: access.memberOf, companyStopped: agentStops.companyStopped,
    }),
    accounts: shared.accounts,
    repoStore,
  }
}

export type Services = ReturnType<typeof createServices>

export const services: Services = createServices(db)
