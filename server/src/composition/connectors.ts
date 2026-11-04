/**
 * Lane A (connectors) wiring: the services this lane adds, built here so the
 * lane does not edit the shared body of src/composition.ts
 * (.claude/rules/server.md "Lane markers"). Like composition.ts, this module
 * may import adapters.
 *
 * - `wireCoreConnectors` (called once from the Google block of composition.ts,
 *   before the core services that use the roles): the core roles
 *   (connector-roles.md) — the role resolver with the admin's choice, Google
 *   registered as a built-in core connector (shared/core/builtin-connectors.ts)
 *   and its role implementations, and the routed role ports the core services
 *   take (calendar, minutes, outbound mail; the inbox later).
 * - `wireConnectorsLane` (the lane's line under `// lane A ▼`): what the lane
 *   adds to `services` — Slack (A3, slack-connector.md: the client, the
 *   connector registered with member-oauth and as the `chat` role's
 *   connector, the events receiver, notice DMs) and 「つないでいるサービス」
 *   with both built-in connectors' switches.
 */
import type Database from 'better-sqlite3'
import { BUILTIN_CONNECTORS } from '../../shared/core/builtin-connectors'
import { SLACK_CALLBACK_PATH, SLACK_HOST, slackEventsPath } from '../../shared/core/slack'
import { nodeHmacSigner } from '../adapters/hmac'
import { sqliteSlackData } from '../adapters/sqlite/slack'
import type { PracticeUpstream } from '../lib/config'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { InboxSource } from '../ports/inbox'
import type { NotificationRow } from '../ports/notifications'
import type { UpstreamClient } from '../ports/upstream'
import type { BrokerVault } from '../services/broker-vault'
import type { MemberOAuth } from '../services/member-oauth'
import { createSlackChat } from '../services/slack-chat'
import { createSlackClient } from '../services/slack-client'
import { createSlackConnector } from '../services/slack-connector'
import { createSlackEvents, type SlackSignal } from '../services/slack-events'
import { createSlackNames } from '../services/slack-names'
import { createSlackNotices } from '../services/slack-notices'
import { createThreadService } from '../services/threads'
import type { ReplySent } from '../services/outbound-mail'
import type { ConnectorRoleChoiceRepository } from '../ports/connector-roles'
import { createConnectorRoles } from '../services/connector-roles'
import { createRoleProviders } from '../services/connector-role-providers'
import { createCoreConnectors } from '../services/core-connectors'
import { createGoogleCalendar } from '../services/google-calendar'
import type { GoogleClient } from '../services/google-client'
import type { GoogleConnector } from '../services/google-connector'
import { createGoogleMail, googleMailInboxSource } from '../services/google-mail'
import { createGoogleMeetings, type GoogleRequester } from '../services/google-meetings'

/**
 * A reply sent from the card (outbound-mail.md "Replies") as the inbox's message: the company's
 * own (`outgoing`), answering the 連絡's own message id — pointers only, never the text.
 */
export function replyAsIncoming(r: ReplySent) {
  return {
    channel: r.channel,
    messageId: r.messageId,
    references: r.references,
    sourceRef: r.sourceRef,
    occurredAt: r.occurredAt,
    from: { address: r.from, memberId: r.userId },
    to: [],
    outgoing: true,
  }
}

export interface CoreConnectorsWiringDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  googleClient: GoogleClient
  googleConnector: GoogleConnector
}

export function wireCoreConnectors(deps: CoreConnectorsWiringDeps) {
  const { companyData, clock, ids, googleClient, googleConnector } = deps
  // The admin's choice per role lives behind the company handle (connectors repository).
  const choices: ConnectorRoleChoiceRepository = {
    choice: (companyId, role) => companyData.forCompany(companyId).connectors.roleChoice(role),
    setChoice: (companyId, role, connectorId, by, at) => companyData.forCompany(companyId).connectors.setRoleChoice(role, connectorId, at, by, ids.newId()),
  }
  const connectorRoles = createConnectorRoles({ choices, clock })

  // Google: a built-in core connector (its code stays where it is: google-*.ts).
  connectorRoles.register({ id: BUILTIN_CONNECTORS.google.id, servings: BUILTIN_CONNECTORS.google.servings, usable: companyId => googleConnector.usable(companyId) })
  const request: GoogleRequester = (companyId, userId, req) => googleClient.request(companyId, userId, req)
  const googleMail = createGoogleMail({ request, companyData })
  const roleProviders = createRoleProviders(connectorRoles, {
    google: {
      calendar: createGoogleCalendar({ request, internalDomain: companyId => companyData.forCompany(companyId).connectors.client()?.domain ?? null }),
      meetings: createGoogleMeetings(request),
      mailReader: googleMail,
      mailSender: googleMail,
    },
  })

  // The inbox's source per connector (inbox.md "Receiving"): the server clock's poll reads Gmail through it.
  const inboxSources: Record<string, InboxSource> = { [BUILTIN_CONNECTORS.google.id]: googleMailInboxSource(googleMail, () => clock.nowMs()) }

  return { connectorRoles, roleProviders, googleConnector, inboxSources }
}

export type CoreConnectorsWiring = ReturnType<typeof wireCoreConnectors>

export interface ConnectorsLaneDeps {
  conn: Database.Database
  core: CoreConnectorsWiring
  companyData: CompanyDataSource
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  brokerVault: BrokerVault
  /** The server's way out (with staging's practice redirects). */
  upstream: UpstreamClient
  /** Staging's practice upstreams that are on (`ACB_FAKE_SLACK_URL` → service `slack`). */
  practiceList: readonly PracticeUpstream[]
  memberOAuth: MemberOAuth
  isMember(companyId: string, userId: string): boolean
  /** The operator's stop file names this connector (or `*`). */
  operatorStopped(connectorId: string): Promise<boolean>
  /** One AI-action-log line per Slack call (no content). */
  recordCall(companyId: string, userId: string | null, e: { operation: string; host: string; status: number | null; ok: boolean }): void
  publicUrl(): string
  /** The member's own 受信を読む (services/work-switches.ts): Slack's signals only while it is on. */
  readsIncoming(companyId: string, userId: string): boolean
}

export function wireConnectorsLane(deps: ConnectorsLaneDeps) {
  const { companyData, accounts, clock, ids, brokerVault, memberOAuth, isMember } = deps
  const slackData = sqliteSlackData(deps.conn)
  const operatorStopped = () => deps.operatorStopped(BUILTIN_CONNECTORS.slack.id)

  // Slack (A3, slack-connector.md): slack-client.ts is the one place that talks to Slack;
  // on staging slack.com may go to the fake Slack (`pnpm fake:slack`).
  const practiceSlack = deps.practiceList.find(u => u.service === 'slack' && u.host === SLACK_HOST)
  const slackClient = createSlackClient({
    companyData, slackData, brokerVault, upstream: deps.upstream, hmac: nodeHmacSigner, clock, isMember, operatorStopped,
    record: deps.recordCall,
    practiceSlack: practiceSlack !== undefined,
    authorizeOrigin: practiceSlack
      ? `${practiceSlack.target.protocol}//${practiceSlack.target.hostname === 'host.docker.internal' ? 'localhost' : practiceSlack.target.hostname}:${practiceSlack.target.port}`
      : `https://${SLACK_HOST}`,
  })
  const slackConnector = createSlackConnector({
    companyData, slackData, brokerVault, slack: slackClient, memberOAuth, accounts, clock, ids, isMember, operatorStopped,
    redirectUri: () => `${deps.publicUrl()}${SLACK_CALLBACK_PATH}`,
    eventsUrl: companyId => `${deps.publicUrl()}${slackEventsPath(companyId)}`,
    practiceSlack: practiceSlack !== undefined,
  })
  // Slack serves the core role チャットの連絡を受け取る・返す (resolved per call, so registering here is in time).
  deps.core.connectorRoles.register(slackConnector.roleConnector())
  // Slack users' names (users.info, a day in memory; never a text): a signal's sender, a thread's people.
  const slackNames = createSlackNames({ slack: slackClient, clock })
  // …and implements it: one thread read on demand, a reply into it (slack-chat.ts; the member's own token).
  deps.core.roleProviders.provide(BUILTIN_CONNECTORS.slack.id, (() => {
    const chat = createSlackChat({ slack: slackClient, companyData, slackData, names: slackNames })
    return { chatReader: chat, chatSender: chat }
  })())

  // Events (POST /api/slack/events/:companyId): signals go to whoever subscribed (lane B's 来た連絡);
  // until then they are dropped. A signal never carries the text.
  const signalListeners: Array<(signal: SlackSignal) => void> = []
  const slackEvents = createSlackEvents({
    companyData, slackData, slack: slackClient, clock, isMember, operatorStopped,
    vaultEnabled: () => brokerVault.status().enabled,
    readsIncoming: deps.readsIncoming,
    onSignal: signal => { for (const listen of signalListeners) listen(signal) },
    names: slackNames,
  })

  // 大事な知らせを Slack の DM で (notifications.md `outside`): 「あなたの番」 notices, by the company's bot.
  const slackNotices = createSlackNotices({ companyData, sendNoticeDm: (companyId, userId, text) => slackConnector.sendNoticeDm(companyId, userId, text) })

  // 「つないでいるサービス」: each built-in connector's own switches (its app's / client's on / off, the operator's stop file).
  const coreConnectors = createCoreConnectors({
    roles: deps.core.connectorRoles,
    switches: {
      google: { state: companyId => deps.core.googleConnector.state(companyId), setEnabled: (member, body) => deps.core.googleConnector.setEnabled(member, body) },
      slack: {
        state: async companyId => {
          const app = slackData.forCompany(companyId).app()
          return { configured: app !== null, enabled: app?.enabled ?? false, operatorStopped: await operatorStopped() }
        },
        setEnabled: (member, body) => slackConnector.setEnabled(member, body),
      },
    },
  })

  // The card's 元のスレッド (outbound-mail.md "Replies"): read now through the roles, with the viewer's own permission.
  const threads = createThreadService({
    companyData,
    mailReader: deps.core.roleProviders.mailReader,
    chatReader: deps.core.roleProviders.chatReader,
    emailOf: (_companyId, userId) => accounts.byIds([userId]).get(userId)?.email?.toLowerCase() ?? null,
  })

  return {
    connectorRoles: deps.core.connectorRoles,
    coreConnectors,
    threads,
    slackConnector,
    slackEvents,
    /** Lane B subscribes here for Slack's signals (a DM, a mention, an @channel for a member). */
    onSlackSignal(listen: (signal: SlackSignal) => void): void { signalListeners.push(listen) },
    /** The notices service's `outside` hook (composition.ts). */
    noticesOutside: (companyId: string, rows: NotificationRow[]) => slackNotices.outside(companyId, rows),
    /** メールを読む (the role, routed): the inbox (lane B) reads mail through this, never through Gmail. */
    mailReader: deps.core.roleProviders.mailReader,
    /** チャットの連絡を受け取る・返す (the role, routed): the card's thread and its replies (outbound-mail.md "Replies"). */
    chatReader: deps.core.roleProviders.chatReader,
    chatSender: deps.core.roleProviders.chatSender,
  }
}
