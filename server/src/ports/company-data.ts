/**
 * The company handle (「会社つきの手形」): the one way services reach a
 * company's own rows. A handle is opened for ONE company id; the repositories
 * it carries take no company parameter and every statement they run is
 * limited to that company, so a call with another company's object id finds,
 * changes or deletes nothing. Cross-company access cannot be written through
 * it — not "is checked before", but has no signature to express it.
 *
 * Where the company id comes from: always from the server, never from what a
 * client sent. In a request it is `member.companyId`, the company of a
 * membership `services/access.ts` just looked up for the signed-in account;
 * otherwise the company the service itself just created, the company a key
 * broker token row belongs to, or a startup / retention loop over the
 * companies registry. Routes never see a handle (composition.ts does not hand
 * the source to them).
 *
 * Today every handle reads the one SQLite database (案 A, 2026-10-31). Moving
 * to a database per company (B) or PostgreSQL with row-level security (C)
 * changes only where `forCompany` opens its connection.
 *
 * Tables still reached outside a handle (to be migrated, or the control plane:
 * the companies registry, memberships, accounts) are listed with their reason
 * in tests/unit/company-scoped-sql.test.ts, which fails on any new statement
 * that touches a company's rows without a company condition.
 */
import type { AiRunRepository } from './ai-runs'
import type { ConnectorRepository } from './connectors'
import type { DepartmentRepository } from './departments'
import type { GoogleDriveRepository } from './google-drive'
import type { FixedPayloadRepository } from './fixed-payloads'
import type { GroupRepository, PermissionHistoryRepository } from './groups'
import type { InvitationRepository } from './invitations'
import type { JobRepository } from './jobs'
import type { NotificationRepository } from './notifications'
import type { OrphanedScopeReader } from './orphaned-scopes'
import type { OutboundMailRepository } from './outbound-mail'
import type { PluginRepository } from './plugins'
import type { PrivateFolderRepository } from './private-folders'
import type { RecordRepository } from './records'
import type { ScopeRepository } from './scopes'
import type { SecondOpinionSettingRepository } from './second-opinion'
import type { SecurityAlertRepository } from './security-alerts'
import type { SkillUseRepository } from './skill-uses'
import type { SkillShelfRepository } from './skill-shelf'
import type { TaskSettingsRepository } from './task-settings'

// Lanes (server.md "Lane markers"): add only right under your lane's ▼.
// lane A ▼
// lane A ▲
// lane B ▼
import type { IdentityRepository } from './identities'
import type { InboxRepository } from './inbox'
// lane B ▲
// lane C ▼
import type { PluginStepRepository } from './plugin-steps'
import type { PluginRoleRepository } from './plugin-roles'
// lane C ▲
export interface CompanyData {
  /** The company this handle is limited to. */
  readonly companyId: string
  readonly departments: DepartmentRepository
  readonly invitations: InvitationRepository
  /** Permission scopes, rules and department managers. */
  readonly scopes: ScopeRepository
  readonly privateFolders: PrivateFolderRepository
  /** 見える人のまとまり: groups and who is in them (ports/groups.ts). */
  readonly groups: GroupRepository
  /** Who changed groups and permission rules, when, what (append-only, ports/groups.ts). */
  readonly permissionHistory: PermissionHistoryRepository
  /** Rules whose folder disappeared from the shared branch (git + orphaned_scopes). */
  readonly orphanedScopes: OrphanedScopeReader
  /** The company map of the light ontology: switch, types, record index, links, state (ports/records.ts). */
  readonly records: RecordRepository
  /** Connector plugins: installs, mapping versions, history (ports/plugins.ts). */
  readonly plugins: PluginRepository
  /** The Google connection: the OAuth client, members' grants, pending starts (ports/connectors.ts). */
  readonly connectors: ConnectorRepository
  /** Google Drive: what members picked with Google Picker, and the puts' receipts (ports/google-drive.ts). */
  readonly googleDrive: GoogleDriveRepository
  /** Outbound mail: drafts, their recipients per version, typed addresses, send attempts (ports/outbound-mail.ts). */
  readonly outbound: OutboundMailRepository
  /** Fixed content of approval requests and outbound mail, per version (ports/fixed-payloads.ts). */
  readonly fixedPayloads: FixedPayloadRepository
  /** Notices per member, their read state and kind switches (ports/notifications.ts). */
  readonly notifications: NotificationRepository
  /** Task settings (task list departments, reply 目安, auto-run) and department membership (ports/task-settings.ts). */
  readonly tasks: TaskSettingsRepository
  /** Execution runs of 「AI の番」 and their outside operations by idempotency key (ports/ai-runs.ts, S10b). */
  readonly aiRuns: AiRunRepository
  /** Scheduled jobs: definitions, their append-only versions, the company's stop switch (ports/jobs.ts, jobs.md). */
  readonly jobs: JobRepository
  /** Which company Skills members' consultations used (ports/skill-uses.ts, records.md "Which Skill"). */
  readonly skillUses: SkillUseRepository
  /** 「もう一方の AI に聞く」: allowed for this company or not (ports/second-opinion.ts). */
  readonly secondOpinion: SecondOpinionSettingRepository
  /** 「気になる動き」: alerts, their setting, download counters, and the rules' reads (ports/security-alerts.ts). */
  readonly securityAlerts: SecurityAlertRepository
  /** The Skill shelf of a company without the shared folder: Skills, instruction texts, rule files and their versions (ports/skill-shelf.ts). */
  readonly skillShelf: SkillShelfRepository
  // Lanes (server.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  // lane A ▲
  // lane B ▼
  /** Matching people and companies (名寄せ): identities, proposals, history (ports/identities.ts, identity.md). */
  readonly identities: IdentityRepository
  /** The inbox (来た連絡): settings, messages seen, connections and unchecked gaps (ports/inbox.ts, inbox.md). */
  readonly inbox: InboxRepository
  // lane B ▲
  // lane C ▼
  /** A business plugin's steps: each work's pinned procedure, the company's Skill per step (ports/plugin-steps.ts, plugin-steps.md). */
  readonly pluginSteps: PluginStepRepository
  /** Business roles (役割): the company's assignments, まとまり overrides, history (ports/plugin-roles.ts, plugin-roles.md). */
  readonly pluginRoles: PluginRoleRepository
  // lane C ▲
  /** Every row of the company, table by table (the per-company export, src/cli/company-archive.ts). */
  readonly archive: CompanyRowsExport
}

/** Rows by table name; blobs as { $base64 }. */
export type ArchivedRows = Record<string, Array<Record<string, unknown>>>

export interface CompanyRowsExport {
  /** The company's row in the registry and its rows of every company table, read in one transaction. */
  exportRows(): ArchivedRows
}

export interface CompanyDataSource {
  /** The handle for one company (see above for where `companyId` may come from). */
  forCompany(companyId: string): CompanyData
}
