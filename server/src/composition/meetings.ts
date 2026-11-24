/**
 * Meetings' wiring: the minutes intake (minutes.md), 「同じ…です」 linking a request's meeting
 * (approvals.md), and 「今日の予定」 (calendar.md). Part of the composition root (src/composition.ts
 * calls `wireMeetings` once, right after `wireCoreConnectors`); like composition.ts, this module
 * may import adapters.
 *
 * What is built later in createServices (the inbox lane's 名寄せ, the execution runs) is reached
 * through the closures composition.ts passes, called only after construction.
 */
import { DEFAULT_COMPANY_TIME_ZONE } from '../../shared/core/calendar'
import { sha256TokenDigest } from '../adapters/system'
import type { MembershipRepository } from '../ports/memberships'
import type { ApprovalService } from '../services/approvals'
import { createCalendarService } from '../services/calendar'
import { createMinutesService, type MinutesServiceDeps } from '../services/minutes'
import type { ServiceRecordWriter } from '../services/record-engine'
import type { CoreConnectorsWiring } from './connectors'
import type { CompositionShared } from './shared'

export interface MeetingsWiringDeps {
  shared: CompositionShared
  memberships: Pick<MembershipRepository, 'listByCompany'>
  /** The engine's service writer (records.md "Service writer"). */
  serviceRecords: ServiceRecordWriter
  /** The core roles 会議の記録を読む and 予定を読む (connector-roles.md). */
  roleProviders: Pick<CoreConnectorsWiring['roleProviders'], 'meetings' | 'calendar'>
  approvals: Pick<ApprovalService, 'useMeetingLink'>
  /** 「使う機能」 会議と議事録 / プロジェクト (records.md "Features on and off"). */
  meetingsOn: (companyId: string) => boolean
  projectsOn: (companyId: string) => boolean
  resolveAddress: NonNullable<MinutesServiceDeps['resolveAddress']>
  afterAction: NonNullable<MinutesServiceDeps['afterAction']>
  readingAskedAgain: NonNullable<MinutesServiceDeps['readingAskedAgain']>
  readingClaimed: NonNullable<MinutesServiceDeps['readingClaimed']>
}

export function wireMeetings(deps: MeetingsWiringDeps) {
  const { shared, serviceRecords, approvals } = deps
  const repos = { memberships: deps.memberships }

  // The minutes intake (milestone 4 G7, minutes.md): reads meetings through the role 会議の記録を読む
  // with the member's own permission; makes `meeting` records through the service writer.
  const minutes = createMinutesService({
    ...shared,
    enabled: deps.meetingsOn,
    projectsOn: deps.projectsOn,
    writer: serviceRecords,
    meetings: deps.roleProviders.meetings,
    tokenDigest: sha256TokenDigest,
    // 名寄せ (identity.md): built later with the inbox lane; called only after construction.
    resolveAddress: deps.resolveAddress,
    // A まとまり chosen after the reading moves to the business plugin's step, as after a reading (plugin-steps.md).
    afterAction: deps.afterAction,
    // Built later; called only after construction.
    readingAskedAgain: deps.readingAskedAgain,
    readingClaimed: deps.readingClaimed,
    members: companyId => {
      const rows = repos.memberships.listByCompany(companyId)
      const accounts = shared.accounts.byIds(rows.map(m => m.user_id))
      return rows.flatMap(m => {
        const a = accounts.get(m.user_id)
        return a ? [{ userId: m.user_id, email: a.email, name: a.name ?? '', role: m.role, joinedAt: m.created_at }] : []
      })
    },
  })

  // 「これと同じ…です（作らない）」 may also make the request's meeting belong to that record (plugins.md "Similar records").
  approvals.useMeetingLink((member, meetingId, bundleId) => minutes.linkBundle(member, { kind: 'human', source: null }, meetingId, { bundleId }))

  // 「今日の予定」 (stage 2 S7a, calendar.md): the member's own calendar, read now through the role
  // 予定を読む (Google's specifics stay in google-calendar.ts).
  const calendar = createCalendarService({
    clock: shared.clock,
    reader: deps.roleProviders.calendar,
    timeZoneOf: () => DEFAULT_COMPANY_TIME_ZONE,
  })

  return { minutes, calendar }
}
