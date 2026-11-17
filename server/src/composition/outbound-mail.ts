/**
 * Outbound mail's wiring (outbound-mail.md): a person sends with their own permission (the role
 * メールを送る), the AI drafts only. Part of the composition root (src/composition.ts calls
 * `wireOutboundMail` once, right after `wireMeetings`; the inbox's `onReplySent` /
 * `onAwaitingReply` hooks stay bound there, next to the lanes); like composition.ts, this module
 * may import adapters.
 */
import { sha256Bytes, sha256TokenDigest } from '../adapters/system'
import type { CompanyRepository } from '../ports/companies'
import type { MembershipRepository } from '../ports/memberships'
import type { Member } from '../services/access'
import type { MinutesService } from '../services/minutes'
import { createOutboundMailService, type OutboundMailDeps } from '../services/outbound-mail'
import type { PluginImportService } from '../services/plugin-import'
import type { ServiceRecordWriter } from '../services/record-engine'
import type { SourceSlots } from '../services/source-slots'
import type { TaskSettingsService } from '../services/task-settings'
import type { CoreConnectorsWiring } from './connectors'
import type { CompositionShared } from './shared'

export interface OutboundMailWiringDeps {
  shared: CompositionShared
  companies: Pick<CompanyRepository, 'allIds'>
  memberships: Pick<MembershipRepository, 'listByCompany'>
  memberOf(companyId: string, userId: string): Member | null
  sourceSlots: SourceSlots
  /** The engine's service writer (records.md "Service writer"). */
  serviceRecords: ServiceRecordWriter
  fixedPayloads: OutboundMailDeps['payloads']
  minutes: Pick<MinutesService, 'meetingAttendees'>
  pluginImport: Pick<PluginImportService, 'recordContacts'>
  /** The core roles メールを送る / メールを読む / チャットに返す (connector-roles.md). */
  roleProviders: Pick<CoreConnectorsWiring['roleProviders'], 'mailSender' | 'mailReader' | 'chatSender'>
  taskSettings: Pick<TaskSettingsService, 'settingsOf'>
  /** 「使う機能」 受信の振り分け・返事のお願い (records.md "Features on and off"). */
  inboxOn: (companyId: string) => boolean
}

export function wireOutboundMail(deps: OutboundMailWiringDeps) {
  const { shared, sourceSlots, serviceRecords, fixedPayloads, minutes, pluginImport, taskSettings } = deps
  const repos = { companies: deps.companies, memberships: deps.memberships }
  const access = { memberOf: deps.memberOf }
  const coreConnectors = { roleProviders: deps.roleProviders }

  // Outbound mail (milestone 4 G8, outbound-mail.md): a person sends with their own permission
  // (the role メールを送る); the AI drafts only (records-ai routes have no send).
  const outboundMail = createOutboundMailService({
    ...shared,
    slots: sourceSlots,
    writer: serviceRecords,
    payloads: fixedPayloads,
    digest: text => sha256TokenDigest.digest(text),
    digestBytes: sha256Bytes,
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
    // 「返事を待つ」's default day counts the company's business days (task settings).
    holidaysOf: companyId => taskSettings.settingsOf(companyId).companyHolidays.map(h => h.date),
    // 「返事を待つ」 needs the inbox to see their answer (records.md "Features on and off").
    inboxOn: deps.inboxOn,
  })

  return { outboundMail }
}
