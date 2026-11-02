/**
 * Composition root: the one place that picks the adapters (SQLite, the local
 * repository store, the system clock) and hands them to the services. Routes
 * get their services from here; nothing else imports src/adapters.
 *
 * Built at import time from the process's database connection (src/db),
 * which tests point at a temporary DATA_DIR. Repositories prepare their
 * statements per call, so building them before initDatabase() is safe.
 */
import { createHash } from 'crypto'
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
import { sqliteRecordContentEraser } from './adapters/sqlite/record-contents'
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
import { BROKER_DAY_UTC_OFFSET_MINUTES, BROKER_KEK_FILE, BROKER_KEY_CHECK, BROKER_MAX_REQUEST_MB, BROKER_TOKEN_TTL_MINUTES, BROKER_UPSTREAM_TIMEOUT_SECONDS, COMPANY_CREATION_POLICY, DATA_DIR, PLUGINS_DIR, PRACTICE_UPSTREAMS, operatorUserIds, publicUrl, type PracticeUpstreams } from './lib/config'
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
import { createTaskSettingsService } from './services/task-settings'
import { createAbsenceService } from './services/absences'
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
import { createPeopleNames } from './services/people-names'
import { createRecordEngine, type RecordChange } from './services/record-engine'
import { createNotificationService } from './services/notifications'
import { createAiRunService } from './services/ai-runs'
import { createSkillUseService } from './services/skill-uses'
import { createServerClock } from './services/server-clock'
import { createTaskAcceptance } from './services/task-acceptance'
import { logError } from './lib/error-log'
import { createRecordAiTokenService } from './services/record-ai-tokens'
import { createPluginShelf } from './services/plugin-shelf'
import { createPluginService } from './services/plugins'
import { createPluginConnector } from './services/plugin-connector'
import { createPluginImportService } from './services/plugin-import'
import { createPluginOperationService } from './services/plugin-operations'
import { createPluginMappingCheckService } from './services/plugin-mapping-check'
import { createExternalRecordWriter, createServiceRecordWriter } from './services/record-engine'
import { createMeetingOutputService } from './services/meeting-outputs'
import { createDecisionService } from './services/decisions'
import { createCalendarService } from './services/calendar'
import { DEFAULT_COMPANY_TIME_ZONE } from '../shared/core/calendar'
import { createMinutesService } from './services/minutes'
import { createOutboundMailService } from './services/outbound-mail'
import { createFixedPayloads } from './services/fixed-payloads'
import { createGoogleClient } from './services/google-client'
import { createGoogleConnector } from './services/google-connector'
import { createGoogleDriveService } from './services/google-drive'
import { createMemberOAuth, oauthCallbackPath } from './services/member-oauth'
import { createApprovalService } from './services/approvals'
import { builtinBrokerService, relayCredentialValue } from '../shared/core/key-broker'
import { GOOGLE_AUTHORIZE_HOST, GOOGLE_CALLBACK_PATH } from '../shared/core/google'
import { GOOGLE_PICKER_PAGE_PATH } from '../shared/core/google-drive'
import { replyAsIncoming, wireConnectorsLane, wireCoreConnectors } from './composition/connectors'
import { wireInboxLane } from './composition/inbox'
import { wirePluginsLane } from './composition/plugins'

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
    // Only the key broker's services (the Google and Slack connections check their own practice values).
    practiceServices: practiceList.filter(u => u.service !== 'google' && u.service !== 'slack').map(u => u.service),
    checkKey: (companyId, service, secret, hosts) => keyCheck!.check(companyId, service, secret, hosts),
    // A connection a plugin manages keeps the relay read-only (plugins.md); bound below.
    managedByPlugin: (companyId, service) => plugins.manages(companyId, service),
    // 「すべての鍵を止める」 stops members' permissions at every OAuth provider too (bound below).
    onStopAll: (companyId, by) => { void memberOAuth.stopAll(companyId, by) },
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
  const recordFiles = gitRecordFileSource()
  const recordIndexer = createRecordIndexer({ ...shared, recordFiles })

  const access = createAccessPolicy(repos.memberships)
  // The state engine (4-3): the only writer of record_state / record_ledger.
  // Notices (知らせ, notifications.md): written at the engine's notify points, pushed as a bare version.
  const taskSettings = createTaskSettingsService({ ...repos, ...shared })
  // Absence and the delegate (代わりの人, records.md): the ONE resolution of who acts for whom
  // today, handed to my-turn / AI turn, the engine's `who`, approvals and the notices below.
  const absences = createAbsenceService({
    ...repos, ...shared,
    // No per-company zone yet (calendar.md): the one place a setting would replace.
    timeZoneOf: () => DEFAULT_COMPANY_TIME_ZONE,
    delegateCannotRead: (companyId, absenteeId, delegateId, setterId) => notifications.delegateCannotRead(companyId, absenteeId, delegateId, setterId),
  })
  const actsFor = (companyId: string, userId: string) => absences.actsFor(companyId, userId)
  const notifications = createNotificationService({
    ...shared,
    coverOf: (companyId, userId) => absences.coverOf(companyId, userId),
    managersOf: (companyId, userId) => absences.managersOf(companyId, userId),
    activeAbsences: companyId => absences.activeToday(companyId),
    push: (companyId, userIds) => push.notify(companyId, userIds, { kind: 'notifications', version: shared.ids.newToken().slice(0, 32) }),
    // No per-company zone yet (calendar.md): the one place a setting would replace.
    timeZoneOf: () => DEFAULT_COMPANY_TIME_ZONE,
    holidaysOf: companyId => taskSettings.settingsOf(companyId).companyHolidays.map(h => h.date),
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
    // 大事な知らせを Slack の DM で (lane A, composition/connectors.ts): called after construction only.
    outside: (companyId, rows) => connectorsLane.noticesOutside(companyId, rows),
  })
  /** The engine's notify: the `records` signal (「あなたの番」 may have changed) and, for an entry, the notices. */
  const notifyRecords = (companyId: string, userIds: string[], change?: RecordChange) => {
    push.notify(companyId, userIds, { kind: 'records', version: shared.ids.newToken().slice(0, 32) })
    if (!change) return
    try { notifications.recordChange(companyId, userIds, change) } catch (err) { logError('notifications', 'Writing notices failed', err, { company: companyId }) }
  }
  // Acceptance (引き受け, records.md "Acceptance"): the company's setting decides when a request waits.
  const taskAcceptance = createTaskAcceptance({ ...shared, settingsOf: companyId => taskSettings.settingsOf(companyId) })
  const recordEngine = createRecordEngine({
    ...shared,
    files: gitRecordFileWriter(),
    managedFolders: (companyId, userId) => permissionViews.managedFolders(companyId, userId),
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
    notify: notifyRecords,
    actsFor,
    autoAccepts: taskAcceptance.autoAccepts,
    // A meeting output's item key → its id: what one reading made is made once (minutes.md).
    tokenDigest: sha256TokenDigest,
    // 「もう返した」 drops the prepared reply drafts (inbox.md; lane B, built below; called after construction only).
    afterAct: (companyId, change) => inboxLane.inbox.afterAct(companyId, change),
  })

  // The engine's entry for the core services of milestone 4 (minutes, approvals, outbound mail,
  // decisions): handed to those services only, never to a route (records.md "Service writer").
  const serviceRecords = createServiceRecordWriter({
    ...shared,
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
    notify: notifyRecords,
  })
  // The content store's eraser: only the server clock's retention run here (no route; records.md).
  const contentEraser = sqliteRecordContentEraser(conn)
  const decisions = createDecisionService({
    ...shared,
    writer: serviceRecords,
    tokenDigest: sha256TokenDigest,
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
    notify: notifyRecords,
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

  // Approval requests with fixed content (milestone 4 G6, approvals.md): the service writer and the
  // operations' approval seam are handed to it only; its routes take a session (no AI route approves).
  const fixedPayloads = createFixedPayloads(shared)
  const approvals = createApprovalService({
    ...shared,
    writer: serviceRecords,
    fixed: fixedPayloads,
    operations: pluginOperations,
    decisions,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
    admins: companyId => repos.memberships.listByCompany(companyId).filter(m => m.role === 'owner' || m.role === 'admin').map(m => m.user_id),
    managedFolders: (companyId, userId) => permissionViews.managedFolders(companyId, userId),
    actsFor,
    plugin: async (companyId, pluginId) => {
      const r = await plugins.active(companyId, pluginId, { collectingFacts: true })
      return r.ok ? r.plugin : null
    },
  })

  // 「HubSpot に聞いて確かめる」 (P8): the outside property list, read through the connector.
  const pluginMappingCheck = createPluginMappingCheckService({
    ...shared, plugins, connector: pluginConnector,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
  })

  // The Google connection (milestone 4 G3, google-connector.md): google-client.ts is the one
  // place that talks to Google; on staging every Google host may go to the fake Google.
  const practiceGoogle = practiceList.find(u => u.service === 'google' && u.host === GOOGLE_AUTHORIZE_HOST)
  const googleClient = createGoogleClient({
    companyData: shared.companyData,
    brokerVault,
    upstream,
    clock: shared.clock,
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    operatorStopped: () => pluginShelf.isStopped('google', ''),
    record: (companyId, userId, e) => {
      try {
        agentEvents.recordServerEvent(companyId, userId, {
          agent: 'script',
          tool: `google:${e.operation.slice(0, 60)}`,
          category: 'broker',
          target: { kind: 'broker', service: 'google', host: e.host, path: e.operation.slice(0, 200), ...(e.status !== null ? { status: e.status } : {}) },
          decision: 'auto-allowed',
          outcome: e.ok ? 'ok' : 'error',
        })
      } catch {
        console.warn('[google] a call could not be recorded')
      }
    },
    practiceGoogle: practiceGoogle !== undefined,
    authorizeOrigin: practiceGoogle
      ? `${practiceGoogle.target.protocol}//${practiceGoogle.target.hostname === 'host.docker.internal' ? 'localhost' : practiceGoogle.target.hostname}:${practiceGoogle.target.port}`
      : `https://${GOOGLE_AUTHORIZE_HOST}`,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  })
  // Members' own OAuth permissions, provider-neutral (member-oauth.md); Google registers below.
  const memberOAuth = createMemberOAuth({
    ...shared,
    brokerVault,
    tokenDigest: sha256TokenDigest,
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    redirectUri: provider => `${publicUrl()}${oauthCallbackPath(provider)}`,
  })
  const googleConnector = createGoogleConnector({
    ...shared,
    brokerVault,
    google: googleClient,
    memberOAuth,
    redirectUri: () => `${publicUrl()}${GOOGLE_CALLBACK_PATH}`,
    pickerPageUrl: () => `${publicUrl()}${GOOGLE_PICKER_PAGE_PATH}`,
    practiceGoogle: practiceGoogle !== undefined,
    operatorStopped: () => pluginShelf.isStopped('google', ''),
  })

  // Google Drive (google-drive.md): picked files and folders only (drive.file), through the one Google client.
  const googleDrive = createGoogleDriveService({
    ...shared,
    google: googleClient,
    operatorStopped: () => pluginShelf.isStopped('google', ''),
    vaultEnabled: () => brokerVault.status().enabled,
    sha256: bytes => createHash('sha256').update(bytes).digest('hex'),
    // The practice Google serves a stand-in Picker script on staging (tests/fakes/google).
    pickerScriptOrigin: practiceGoogle
      ? `${practiceGoogle.target.protocol}//${practiceGoogle.target.hostname === 'host.docker.internal' ? 'localhost' : practiceGoogle.target.hostname}:${practiceGoogle.target.port}`
      : 'https://apis.google.com',
  })

  // The core roles (connector-roles.md): Google registers as a built-in core connector; the core
  // services below ask a role (予定を読む, 会議の記録を読む, メールを送る), never Google (composition/connectors.ts).
  const coreConnectors = wireCoreConnectors({ ...shared, googleClient, googleConnector })

  // The minutes intake (milestone 4 G7, minutes.md): reads meetings through the role 会議の記録を読む
  // with the member's own permission; makes `meeting` records through the service writer.
  const minutes = createMinutesService({
    ...shared,
    writer: serviceRecords,
    meetings: coreConnectors.roleProviders.meetings,
    tokenDigest: sha256TokenDigest,
    // 名寄せ (identity.md): built below with the inbox lane; called only after construction.
    resolveAddress: (member, address) => inboxLane.identities.resolveAddress(member, address),
    members: companyId => {
      const rows = repos.memberships.listByCompany(companyId)
      const accounts = shared.accounts.byIds(rows.map(m => m.user_id))
      return rows.flatMap(m => {
        const a = accounts.get(m.user_id)
        return a ? [{ userId: m.user_id, email: a.email, name: a.name ?? '', role: m.role }] : []
      })
    },
  })

  // 「これと同じ…です（作らない）」 may also make the request's meeting belong to that record (plugins.md "Similar records").
  approvals.useMeetingLink((member, meetingId, bundleId) => minutes.linkBundle(member, { kind: 'human', source: null }, meetingId, { bundleId }))

  // 「今日の予定」 (stage 2 S7a, calendar.md): the member's own calendar, read now through the role
  // 予定を読む (Google's specifics stay in google-calendar.ts).
  const calendar = createCalendarService({
    clock: shared.clock,
    reader: coreConnectors.roleProviders.calendar,
    timeZoneOf: () => DEFAULT_COMPANY_TIME_ZONE,
  })

  // Outbound mail (milestone 4 G8, outbound-mail.md): a person sends with their own permission
  // (the role メールを送る); the AI drafts only (records-ai routes have no send).
  const outboundMail = createOutboundMailService({
    ...shared,
    writer: serviceRecords,
    payloads: fixedPayloads,
    digest: text => sha256TokenDigest.digest(text),
    members: companyId => {
      const ids = repos.memberships.listByCompany(companyId).map(m => m.user_id)
      const accounts = shared.accounts.byIds(ids)
      return ids.flatMap(userId => {
        const a = accounts.get(userId)
        return a?.email ? [{ userId, email: a.email, name: a.name }] : []
      })
    },
    // The meeting's attendees, re-read from Google now (minutes.md); unreadable → null (nothing offered).
    meetingAttendees: async (companyId, userId, meetingId) => {
      const role = access.memberOf(companyId, userId)?.role
      if (!role) return null
      const r = await minutes.meetingAttendees(companyId, userId, role, meetingId)
      return r.ok ? r.value : null
    },
    bundleContacts: (member, bundleId) => pluginImport.recordContacts(member, bundleId),
    // The role メールを送る (the member's own permission at the company's mail connector).
    mail: coreConnectors.roleProviders.mailSender,
    // A reply into its 連絡's thread (outbound-mail.md "Replies"): the thread read through メールを読む; Slack's チャットに返す.
    mailReader: coreConnectors.roleProviders.mailReader,
    chat: coreConnectors.roleProviders.chatSender,
    companyIds: () => repos.companies.allIds(),
  })

  const records = createRecordService({ ...shared, indexer: recordIndexer, recordFiles, actsFor })
  // Execution runs of 「AI の番」 (S10b, records.md "Execution runs"): the server stores and checks; the AI runs on the PC.
  const aiRuns = createAiRunService({
    ...shared, tokenDigest: sha256TokenDigest, aiTurnOf: (member, recordId, step) => records.aiTurnOf(member, recordId, step),
    // An unfinished minutes reading goes back to 「届いた」 at once, as the run's doing (the app's step name).
    afterFailedRun: (member, run) => { if (run.step === 'minutes-reading' || run.step === 'minutes-bundle') minutes.putBackAfterRun(member, run.recordId, run.id) },
  })

  // The parallel lanes (A connectors, B inbox, C plugins) wire their services in their own files
  // under composition/ (.claude/rules/server.md "Lane markers"); each lane edits
  // only its own call, and the marker lines keep the three calls apart for git.
  // lane A ▼
  const connectorsLane = wireConnectorsLane({
    conn, core: coreConnectors, ...shared, brokerVault, upstream, practiceList, memberOAuth,
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    operatorStopped: connectorId => pluginShelf.isStopped(connectorId, ''),
    recordCall: (companyId, userId, e) => {
      try {
        agentEvents.recordServerEvent(companyId, userId ?? 'acb:slack-bot', {
          agent: 'script',
          tool: `slack:${e.operation.slice(0, 60)}`,
          category: 'broker',
          target: { kind: 'broker', service: 'slack', host: e.host, path: e.operation.slice(0, 200), ...(e.status !== null ? { status: e.status } : {}) },
          decision: 'auto-allowed',
          outcome: e.ok ? 'ok' : 'error',
        })
      } catch {
        console.warn('[slack] a call could not be recorded')
      }
    },
    publicUrl,
  })
  // A reply sent from the card (A4) is the company's own message in its 連絡's thread: the inbox (lane B,
  // built below; called only after construction) moves the 返事のお願い as for any reply of ours.
  outboundMail.onReplySent(reply => { inboxLane.inbox.receive(reply.companyId, reply.userId, replyAsIncoming(reply)) })
  // lane B ▼
  const inboxLane = wireInboxLane({
    conn, ...shared, memberships: repos.memberships, serviceRecords,
    roleOf: (companyId, userId) => access.memberOf(companyId, userId)?.role ?? null,
    taskSettings: companyId => taskSettings.settingsOf(companyId),
    roles: connectorsLane.connectorRoles,
    onSlackSignal: listen => connectorsLane.onSlackSignal(listen),
    bridge: {
      // Lane C's list (built below; called only after construction): what the company's apps may keep now.
      listed: companyId => pluginsLane.pluginDistribution.pluginsFor(companyId),
      shelf: pluginShelf,
      records: { query: (m, b) => records.query(m, b), get: (m, id) => records.get(m, id) },
      act: (m, actor, recordId, action, b) => recordEngine.act(m, actor, recordId, action, b),
      requestApproval: (m, actor, pluginId, recordId, operation, b) => approvals.request(m, actor, pluginId, recordId, operation, b),
    },
  })
  // lane C ▼
  const pluginsLane = wirePluginsLane({
    conn, companyData: shared.companyData, clock: shared.clock, pluginShelf, agentPolicy, recordEngine, approvals, pluginOperations, aiRuns, actsFor,
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    managedFolders: (companyId, userId) => permissionViews.managedFolders(companyId, userId),
  })
  // lanes ▲

  return {
    ...connectorsLane,
    ...inboxLane,
    ...pluginsLane,
    access,
    outboundMail,
    googleClient,
    googleConnector,
    googleDrive,
    memberOAuth,
    minutes,
    calendar,
    pluginShelf,
    plugins,
    pluginImport,
    pluginOperations,
    pluginMappingCheck,
    approvals,
    fixedPayloads,
    companies: createCompanyService({ ...repos, ...shared, repoStore,
      creationPolicy: companyCreationPolicyFromEnv(),
      isOperator: userId => operatorUserIds().has(userId),
    }),
    invitations: createInvitationService({ ...repos, ...shared }),
    departments: createDepartmentService({ ...repos, ...shared, repoStore }),
    taskSettings,
    // The server clock (notifications.md "The server clock"): started once per process by index.ts.
    serverClock: createServerClock({
      ...shared,
      companyIds: () => repos.companies.allIds(),
      writer: serviceRecords,
      notifications,
      taskSettings: companyId => taskSettings.settingsOf(companyId),
      timeZoneOf: () => DEFAULT_COMPANY_TIME_ZONE,
      // The content store's retention (records.md "The content store"): reason `retention`, per company.
      expireContent: companyId => contentEraser.eraseExpired(companyId, shared.clock.now()).length,
      yieldNow: () => new Promise<void>(resolve => setImmediate(resolve)),
    }),
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
    records,
    // The names behind person ids in the AI's record answers (records.md "Typed tools in the app").
    peopleNames: createPeopleNames({ memberships: repos.memberships, accounts: shared.accounts }),
    absences,
    aiRuns,
    recordEngine,
    // Which company Skill a consultation used (records.md "Which Skill").
    skillUses: createSkillUseService(shared),
    notifications,
    decisions,
    // What one meeting's reading made twice: owner/admin list and merge (minutes.md "Outputs made once").
    meetingOutputs: createMeetingOutputService({ companyData: shared.companyData, act: (...a) => recordEngine.act(...a) }),
    recordAiTokens: createRecordAiTokenService({
      ...shared, tokenDigest: sha256TokenDigest, memberOf: access.memberOf, companyStopped: agentStops.companyStopped, runs: aiRuns,
    }),
    accounts: shared.accounts,
    repoStore,
  }
}

export type Services = ReturnType<typeof createServices>

export const services: Services = createServices(db)
