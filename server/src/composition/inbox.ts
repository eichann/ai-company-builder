/**
 * Lane B (the inbox: messages that came in) wiring: the services this lane
 * adds, built here so the lane does not edit the shared body of
 * src/composition.ts (.claude/rules/server.md "Lane markers"). createServices
 * calls this once and spreads what it returns into the services. Like
 * composition.ts, this module may import adapters.
 *
 * Add what the lane needs to InboxLaneDeps and pass it at this lane's one call
 * line in composition.ts.
 */
import type Database from 'better-sqlite3'
import type { TaskSettings } from '../../shared/core/task-settings'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import { createIdentityService } from '../services/identities'
import { createInboxService, type InboxDeps } from '../services/inbox'
import type { SlackSignal } from '../services/slack-events'
import type { ServiceRecordWriter } from '../services/record-engine'

export interface InboxLaneDeps {
  conn: Database.Database
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  accounts: AccountDirectory
  memberships: MembershipRepository
  /** The engine's service writer (records.md "Service writer"): the inbox writes interactions and reply requests. */
  serviceRecords: ServiceRecordWriter
  roleOf: (companyId: string, userId: string) => string | null
  taskSettings: (companyId: string) => TaskSettings
  /** Role resolution (connector-roles.md), from lane A. */
  roles?: InboxDeps['roles']
  /** Lane A's hook for Slack's signals (a DM, a mention, an @channel for a member; never the text). */
  onSlackSignal?: (listen: (signal: SlackSignal) => void) => void
}

/** A Slack signal as the inbox's message (chat): ids and pointers only. */
export function slackSignalMessage(s: SlackSignal) {
  return {
    channel: 'chat' as const,
    messageId: `${s.channelId}:${s.ts}`,
    references: s.threadTs && s.threadTs !== s.ts ? [`${s.channelId}:${s.threadTs}`] : [],
    threadRef: `slack:${s.channelId}:${s.threadTs ?? s.ts}`,
    sourceRef: `slack:${s.channelId}:${s.ts}`,
    occurredAt: new Date(Math.floor(Number(s.ts) * 1000)).toISOString(),
    subject: null,
    from: { address: `slack:${s.senderSlackUserId ?? 'unknown'}` },
    to: [{ address: `slack-member:${s.userId}`, memberId: s.userId }],
    cc: [],
  }
}

export function wireInboxLane(deps: InboxLaneDeps) {
  // Matching people and companies (名寄せ, identity.md).
  const identities = createIdentityService(deps)
  // Messages that came in (来た連絡, inbox.md): connectors call `receive` / register a source.
  const inbox = createInboxService({
    companyData: deps.companyData,
    clock: deps.clock,
    ids: deps.ids,
    writer: deps.serviceRecords,
    resolveAddress: (member, address) => identities.resolveAddress(member, address),
    roleOf: deps.roleOf,
    memberAddresses: companyId => {
      const ids = deps.memberships.listByCompany(companyId).map(m => m.user_id)
      const accounts = deps.accounts.byIds(ids)
      return ids.flatMap(userId => {
        const email = accounts.get(userId)?.email
        return email ? [{ userId, email }] : []
      })
    },
    taskSettings: deps.taskSettings,
    roles: deps.roles,
  })
  // Slack's events (A3): each signal is one incoming chat message for that member.
  deps.onSlackSignal?.(signal => {
    try { inbox.receive(signal.companyId, signal.userId, slackSignalMessage(signal)) } catch { /* never fails Slack's answer */ }
  })
  return { identities, inbox }
}
