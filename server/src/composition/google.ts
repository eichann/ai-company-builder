/**
 * The Google connection's wiring (google-connector.md, google-drive.md, member-oauth.md): the one
 * Google client, members' own OAuth permissions (provider-neutral; built here because Google's
 * connector registers with it), the connector, the relay with the member's own permission, Drive,
 * and a scheduled job's deliverable places outside ACB (jobs.md). Part of the composition root
 * (src/composition.ts calls `wireGoogle` once, in its Google block, right before
 * `wireCoreConnectors`); like composition.ts, this module may import adapters.
 *
 * What is built later in createServices (the execution runs) is reached through the closures
 * composition.ts passes, called only after construction.
 */
import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import type { JobDeliveryPlace } from '../../shared/core/jobs'
import { GOOGLE_AUTHORIZE_HOST, GOOGLE_CALLBACK_PATH } from '../../shared/core/google'
import { GOOGLE_PICKER_PAGE_PATH } from '../../shared/core/google-drive'
import { sqlitePickTicketDirectory } from '../adapters/sqlite/google-drive'
import { sha256TokenDigest } from '../adapters/system'
import { driveDocTiming, type PracticeUpstream } from '../lib/config'
import { logError } from '../lib/error-log'
import type { AgentEventRepository } from '../ports/agent-events'
import type { BrokerKeyRepository } from '../ports/key-broker'
import type { UpstreamClient } from '../ports/upstream'
import type { Member } from '../services/access'
import type { AgentEventService } from '../services/agent-events'
import type { AgentStopService } from '../services/agent-stops'
import type { BrokerVault } from '../services/broker-vault'
import { createGoogleClient, type GoogleClientDeps } from '../services/google-client'
import { createGoogleConnector } from '../services/google-connector'
import { createGoogleDriveService, type GoogleDriveDeps } from '../services/google-drive'
import { createGoogleRelay, GOOGLE_RELAY_TOOL } from '../services/google-relay'
import { createMemberOAuth, oauthCallbackPath } from '../services/member-oauth'
import type { PluginShelf } from '../services/plugin-shelf'
import type { RecordEngine } from '../services/record-engine'
import type { TaskSettingsService } from '../services/task-settings'
import type { WorkSwitches } from '../services/work-switches'
import type { CompositionShared } from './shared'

/** The Google relay's per-member daily count in `broker_usage` (a key id no registered key can have). */
const GOOGLE_RELAY_USAGE_KEY = 'person-relay:google'
/** Its refused calls per member and day (only how many are recorded). */
const GOOGLE_RELAY_REFUSED_KEY = 'person-relay:google:refused'

export interface GoogleWiringDeps {
  conn: Database.Database
  shared: CompositionShared
  brokerVault: BrokerVault
  /** The server's way out (with staging's practice redirects). */
  upstream: UpstreamClient
  /** Staging's practice upstreams that are on: every Google host may go to the fake Google. */
  practiceList: readonly PracticeUpstream[]
  brokerKeys: Pick<BrokerKeyRepository, 'usage' | 'addUsage'>
  agentEventRows: Pick<AgentEventRepository, 'page'>
  agentEvents: Pick<AgentEventService, 'recordServerEvent'>
  agentStops: Pick<AgentStopService, 'companyStopped'>
  pluginShelf: Pick<PluginShelf, 'isStopped'>
  memberOf(companyId: string, userId: string): Member | null
  readIncoming: GoogleClientDeps['readIncoming']
  taskSettings: Pick<TaskSettingsService, 'setReadIncomingAllowed'>
  workSwitches: Pick<WorkSwitches, 'set'>
  recordEngine: Pick<RecordEngine, 'linkDrivePut'>
  /** The relay's day for daily caps (composition.ts `brokerDayOf`). */
  dayOf(ms: number): string
  publicUrl(): string
  /** The execution run's fence right before a put leaves (built later in createServices; called only after construction). */
  runFence: NonNullable<GoogleDriveDeps['runFence']>
}

export function wireGoogle(deps: GoogleWiringDeps) {
  const { conn, shared, brokerVault, upstream, practiceList, pluginShelf, readIncoming, taskSettings, workSwitches, recordEngine, publicUrl } = deps
  const access = { memberOf: deps.memberOf }
  const repos = { brokerKeys: deps.brokerKeys, agentEvents: deps.agentEventRows }
  const { agentEvents, agentStops } = deps

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
    readIncoming,
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
    readIncoming: {
      ...readIncoming,
      setAllowed: (companyId, allowed, by) => taskSettings.setReadIncomingAllowed(companyId, allowed, by),
      choose: (member, on) => { void workSwitches.set(member, { switch: 'readIncoming', on }) },
    },
  })

  // The Google relay with the member's own permission (google-connector.md "The relay"): the key
  // broker's relay hands /api/broker/google/… to it; it calls Google only through googleClient.
  const googleRelay = createGoogleRelay({
    ...shared,
    google: googleClient,
    unavailable: companyId => googleConnector.unavailable(companyId),
    isMember: (companyId, userId) => access.memberOf(companyId, userId) !== null,
    // The member's daily count, in the key broker's daily use under a key id no key can have.
    usage: {
      count: (companyId, userId, day) => repos.brokerKeys.usage(companyId, GOOGLE_RELAY_USAGE_KEY, userId, day).memberRequests,
      add: (companyId, userId, day) => repos.brokerKeys.addUsage(companyId, GOOGLE_RELAY_USAGE_KEY, userId, day, 1, 0),
    },
    refusals: {
      count: (companyId, userId, day) => repos.brokerKeys.usage(companyId, GOOGLE_RELAY_REFUSED_KEY, userId, day).memberRequests,
      add: (companyId, userId, day) => repos.brokerKeys.addUsage(companyId, GOOGLE_RELAY_REFUSED_KEY, userId, day, 1, 0),
    },
    companyStopped: companyId => agentStops.companyStopped(companyId),
    dayOf: deps.dayOf,
    records: (companyId, userId, limit) => repos.agentEvents.page(companyId, { category: 'broker', tool: GOOGLE_RELAY_TOOL, ...(userId ? { userId } : {}) }, null, limit),
  })

  // Google Drive (google-drive.md): picked files and folders only (drive.file), through the one Google client.
  const googleDrive = createGoogleDriveService({
    ...shared,
    google: googleClient,
    operatorStopped: () => pluginShelf.isStopped('google', ''),
    vaultEnabled: () => brokerVault.status().enabled,
    sha256: bytes => createHash('sha256').update(bytes).digest('hex'),
    memberOf: (companyId, userId) => access.memberOf(companyId, userId),
    pickTickets: sqlitePickTicketDirectory(conn),
    docTiming: () => driveDocTiming(),
    // The practice Google serves a stand-in Picker script on staging (tests/fakes/google).
    // The execution run's fence right before a put leaves (google-drive.md; built later in composition.ts, called only after construction).
    runFence: deps.runFence,
    pickerScriptOrigin: practiceGoogle
      ? `${practiceGoogle.target.protocol}//${practiceGoogle.target.hostname === 'host.docker.internal' ? 'localhost' : practiceGoogle.target.hostname}:${practiceGoogle.target.port}`
      : 'https://apis.google.com',
  })

  // A scheduled job's deliverable place outside ACB (jobs.md "A deliverable place outside"): the job names a connector
  // and a kind of place (never a service's own field); the connector that declares it answers here. Google: a Drive
  // folder the responsible person picked (`drive.file`: their own pick only), and the run's puts linked to its やること.
  const deliveryPlaces = {
    live(companyId: string, userId: string, place: JobDeliveryPlace): { name: string; expiresAt: string } | null {
      return place.connector === 'google' && place.kind === 'drive_folder' ? googleDrive.folderPlace(companyId, userId, place.ref) : null
    },
    linkToTask(member: Member, place: JobDeliveryPlace, runId: string, recordId: string): void {
      if (place.connector !== 'google' || place.kind !== 'drive_folder') return
      for (const file of googleDrive.runDeliverables(member, runId)) {
        try {
          const r = recordEngine.linkDrivePut(member, { kind: 'ai', source: 'job', conversationId: null, runId }, recordId, file)
          if (!r.ok) console.warn(`[jobs] a deliverable was not linked to the job's task: ${typeof r.body.code === 'string' && /^[A-Z_]{1,60}$/.test(r.body.code) ? r.body.code : r.kind}`)
        } catch (error) {
          logError('jobs', 'linking a deliverable to the job\'s task failed', error)
        }
      }
    },
    // After 「もう一度」: an earlier run's put → the Drive file it made in the chosen folder (the member's own receipt,
    // written by one of the occurrence's runs).
    madeFile(member: Member, place: JobDeliveryPlace, ref: { kind: string; id: string }, runIds: ReadonlySet<string>): { id: string; name: string } | null {
      if (place.connector !== 'google' || place.kind !== 'drive_folder' || ref.kind !== 'drive-put' || typeof place.ref !== 'string') return null
      return googleDrive.madeFile(member, place.ref, ref.id, runIds)
    },
  }

  return { googleClient, memberOAuth, googleConnector, googleRelay, googleDrive, deliveryPlaces }
}
