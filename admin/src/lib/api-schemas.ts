// What the admin checks in the server's answers before rendering them (api.ts getData: every
// call passes one of these; there is no unchecked path).
//
// The server is the authority, but a proxy's error page, an older or newer server, or a bug
// can answer with a different shape; rendering that as if it were right shows broken or
// misleading data (a member list without roles, an empty overview). Each schema checks the
// fields the pages rely on and lets extra fields through (servers add fields over time).
// Each is typed against the interface in api.ts, so the two cannot drift apart unnoticed.
//
// zod/mini keeps the bundle small (tree-shaken functions instead of the chained classes).

import * as z from 'zod/mini'

import type { AbsenceCreated, MemberAbsencesView } from '../../../shared/types/absences'
import type {
  AgentEventPage,
  AgentEventRetentionPreview,
  AgentEventSettings,
  AgentEventSummary,
  AgentEventViewers,
  SandboxImpact,
} from '../../../shared/types/agent-events'
import type { AgentSandboxView } from '../../../shared/types/agent-sandbox'
import type { AgentStopView } from '../../../shared/types/agent-stop'
import type { CoreConnectorsView } from '../../../shared/types/core-connectors'
import type { GoogleAdminView } from '../../../shared/types/google'
import type { InboxSettingsView } from '../../../shared/types/inbox'
import type { BrokerView } from '../../../shared/types/key-broker'
import type { MinutesFolderSetting } from '../../../shared/types/minutes'
import type { MeetingDuplicates, MeetingDuplicatesMerged } from '../../../shared/types/meeting-outputs'
import type {
  ImportReport,
  PluginDetail,
  PluginListItem,
  PluginMappingCheck,
  PluginRolesView,
  PluginStepSkillsView,
} from '../../../shared/types/plugins'
import type { SlackAdminView } from '../../../shared/types/slack'
import type { DepartmentMembersView, TaskSettingsView } from '../../../shared/types/task-settings'
import type {
  Capabilities,
  ClientActivity,
  Company,
  CreatedInvitation,
  DeletePrivateFolderResult,
  Department,
  DepartmentManager,
  EffectiveAccess,
  Invitation,
  InvitationPreview,
  Member,
  OrphanedScope,
  AdminHome,
  Overview,
  OverviewMember,
  OrphanedScopeSummary,
  PermissionScope,
  PrivateFolderDetail,
  PrivateFolderSummary,
  PushRejection,
  PushRejectionPage,
  RepoFolder,
  Role,
  ScopeRulesResult,
  User,
} from './api'

const str = z.string()
const nullableStr = z.nullable(z.string())
const role = z.enum(['owner', 'admin', 'member'])
const summary = z.enum(['everyone-rw', 'everyone-r', 'restricted'])

export const userSchema: z.ZodMiniType<User> = z.looseObject({
  id: str,
  email: str,
  name: nullableStr,
  createdAt: z.optional(str),
  canCreateCompany: z.optional(z.boolean()),
})

export const configSchema: z.ZodMiniType<{ name: string; version: string; setupComplete: boolean; appDownloadUrl?: string | null }> = z.looseObject({
  name: str,
  version: str,
  setupComplete: z.boolean(),
  // Older servers do not send it (the invitation page then says to get the app from the admin).
  appDownloadUrl: z.optional(nullableStr),
})

export const companySchema: z.ZodMiniType<Company> = z.looseObject({
  id: str,
  name: str,
  slug: str,
  ownerId: str,
  repoPath: nullableStr,
  createdAt: str,
  updatedAt: str,
  role: z.optional(role),
})

export const companiesSchema = z.array(companySchema)

const memberSchema: z.ZodMiniType<Member> = z.looseObject({
  id: str,
  userId: str,
  companyId: str,
  role,
  email: nullableStr,
  name: nullableStr,
  createdAt: str,
})

export const membersSchema = z.array(memberSchema)

export const capabilitiesSchema: z.ZodMiniType<Capabilities> = z.looseObject({
  role,
  managedDepartmentIds: z.array(str),
  canViewAgentEvents: z.boolean(),
})

const overviewMemberSchema: z.ZodMiniType<OverviewMember> = z.looseObject({
  userId: str,
  name: nullableStr,
  email: nullableStr,
  role,
  clientVersion: nullableStr,
  lastSeenAt: nullableStr,
  lastFetchAt: nullableStr,
  lastPushAt: nullableStr,
})

const pushRejectionSchema: z.ZodMiniType<PushRejection> = z.looseObject({
  id: str,
  userId: str,
  name: nullableStr,
  marker: str,
  paths: z.array(str),
  createdAt: str,
})

const orphanedScopeSummarySchema: z.ZodMiniType<OrphanedScopeSummary> = z.looseObject({
  scopeId: str,
  path: str,
  kind: z.enum(['company', 'department', 'folder']),
  ruleCount: z.number(),
  summary,
  since: str,
})

export const overviewSchema: z.ZodMiniType<Overview> = z.looseObject({
  memberCount: z.number(),
  departmentCount: z.number(),
  attention: z.looseObject({
    outdatedClients: z.array(overviewMemberSchema),
    unknownClients: z.array(overviewMemberSchema),
    notSyncedRecently: z.array(overviewMemberSchema),
    recentRejections: z.array(pushRejectionSchema),
    orphanedScopes: z.optional(z.array(orphanedScopeSummarySchema)),
  }),
})

export const adminHomeSchema: z.ZodMiniType<AdminHome> = z.looseObject({
  view: z.enum(['admin', 'manager']),
  setup: z.nullable(z.looseObject({
    steps: z.array(z.looseObject({
      id: z.enum(['departments', 'members', 'department-members', 'google', 'minutes-folder', 'holidays']),
      done: z.boolean(),
      byOperator: z.optional(z.boolean()),
      departmentsWithoutMembers: z.optional(z.number()),
      departmentsWithoutManager: z.optional(z.number()),
    })),
    done: z.number(),
    total: z.number(),
  })),
  departments: z.array(z.looseObject({ id: str, name: str })),
  attention: z.looseObject({
    outdatedClients: z.array(overviewMemberSchema),
    unknownClients: z.array(overviewMemberSchema),
    notSyncedRecently: z.array(overviewMemberSchema),
    recentRejections: z.array(pushRejectionSchema),
    orphanedScopes: z.array(orphanedScopeSummarySchema),
    meetingDuplicates: z.number(),
    stoppedPlugins: z.array(z.looseObject({ id: str, label: str, problem: str })),
  }),
  counts: z.looseObject({ members: z.number(), departments: z.number() }),
})

const clientActivitySchema: z.ZodMiniType<ClientActivity> = z.looseObject({
  userId: str,
  role,
  email: nullableStr,
  name: nullableStr,
  clientVersion: nullableStr,
  build: z.nullable(z.looseObject({ semver: str, sha: nullableStr, commitDate: nullableStr, dev: z.boolean() })),
  clientPlatform: nullableStr,
  lastSeenAt: nullableStr,
  lastFetchAt: nullableStr,
  lastPushAt: nullableStr,
  supportsAgentEvents: z.boolean(),
})

export const clientActivitiesSchema = z.array(clientActivitySchema)

export const departmentSchema: z.ZodMiniType<Department> = z.looseObject({
  id: str,
  companyId: str,
  parentId: nullableStr,
  name: str,
  nameEn: nullableStr,
  folder: str,
  icon: str,
  color: str,
  description: nullableStr,
  sortOrder: z.number(),
  isActive: z.boolean(),
  createdAt: str,
  updatedAt: str,
  createdBy: nullableStr,
})

export const departmentsSchema = z.array(departmentSchema)

// ---------------------------------------------------------------------------
// The other answers: every top-level field is checked for its kind (text, number, yes/no, list,
// object, or missing/null where the type allows it). What is inside a list or object is not
// checked here; those shapes come from shared/types and the server's real answers are held to
// them by server/tests/integration/admin-contract.test.ts. `topLevel` makes the compiler insist
// on every field of the type, so a field added to the type cannot be left unchecked.
// ---------------------------------------------------------------------------

type Kind<V> = V extends string ? string
  : V extends number ? number
  : V extends boolean ? boolean
  : V extends null ? null
  : V extends undefined ? undefined
  : V extends readonly unknown[] ? unknown[]
  : object

type TopLevel<T> = { [K in keyof T]-?: z.ZodMiniType<Kind<T[K]>> }

function topLevel<T extends object>(shape: TopLevel<T>): z.ZodMiniType<T> {
  // The compiler has checked `shape` against every field of T; the nested parts are T's own.
  return z.looseObject(shape as Record<string, z.ZodMiniType>) as unknown as z.ZodMiniType<T>
}

const num = z.number()
const bool = z.boolean()
const list = z.array(z.unknown())
const obj = z.looseObject({})
const nullableObj = z.nullable(obj)
const optionalList = z.optional(list)

// Members, roles and invitations
export const memberRoleSchema = topLevel<{ userId: string; companyId: string; role: Role }>({ userId: str, companyId: str, role })
export const invitationValidateSchema = topLevel<InvitationPreview>({ companyName: str, role, expiresAt: str, inviterName: nullableStr, departmentNames: z.array(str) })
export const invitationAcceptSchema = topLevel<{ companyId: string; companyName: string; role: Role }>({ companyId: str, companyName: str, role })
export const invitationsSchema = z.array(topLevel<Invitation>({
  id: str, companyId: str, companyName: str, token: str, role, createdBy: str,
  createdByName: nullableStr, createdByEmail: nullableStr,
  usedBy: nullableStr, usedByName: nullableStr, usedByEmail: nullableStr, usedAt: nullableStr,
  expiresAt: str, createdAt: str, isExpired: bool, isUsed: bool, departmentIds: z.array(str),
}))
export const createdInvitationSchema = topLevel<CreatedInvitation>({
  id: str, token: str, companyId: str, companyName: str, role, expiresAt: str, createdAt: str, departmentIds: z.array(str),
})

// Permissions
export const permissionsSchema = topLevel<{ scopes: PermissionScope[]; orphanedScopes?: OrphanedScope[] }>({ scopes: list, orphanedScopes: optionalList })
export const scopeRulesResultSchema = topLevel<ScopeRulesResult>({ scope: nullableObj, rules: list })
export const scopeMoveSchema = topLevel<{ moved: number; toPath: string; scopeId: string | null }>({ moved: num, toPath: str, scopeId: nullableStr })
export const scopeResetSchema = topLevel<{ removed: number }>({ removed: num })
export const effectiveAccessSchema = topLevel<EffectiveAccess>({ path: str, governingScope: nullableObj, readRestrictionEnforced: bool, members: list })
export const repoFoldersSchema = topLevel<{ path: string; folders: RepoFolder[] }>({ path: str, folders: list })
export const pushRejectionPageSchema = topLevel<PushRejectionPage>({ total: num, markers: list, rejections: list })

// Private folders
const privateFolderFields = {
  scopeId: str, path: str, departmentId: nullableStr, viewerCount: num, editorCount: num,
  createdAt: str, createdBy: nullableStr, createdByName: nullableStr,
}
export const privateFoldersSchema = z.array(topLevel<PrivateFolderSummary>(privateFolderFields))
export const privateFolderSchema = topLevel<PrivateFolderDetail>({ ...privateFolderFields, members: list })
export const makePublicSchema = topLevel<{ path: string; commit: string }>({ path: str, commit: str })
export const deletePrivateFolderSchema = topLevel<DeletePrivateFolderResult>({ path: str, archived: bool })

// Departments
export const departmentStatsSchema = topLevel<{ files: number; folders: number; exists: boolean }>({ files: num, folders: num, exists: bool })
export const managersSchema = topLevel<{ managers: DepartmentManager[] }>({ managers: list })
export const departmentMembersSchema = topLevel<DepartmentMembersView>({ members: list, canEdit: bool })

// The AI action log, sandbox and emergency stop
export const agentEventPageSchema = topLevel<AgentEventPage>({ events: list, nextCursor: nullableStr })
export const agentEventSummarySchema = topLevel<AgentEventSummary>({ from: str, to: str, tzOffsetMinutes: num, days: list, members: list })
export const agentEventSettingsSchema = topLevel<AgentEventSettings>({
  updatedAt: nullableStr, updatedBy: nullableStr, history: list, retentionDays: num, viewers: str,
})
export const agentEventRetentionPreviewSchema = topLevel<AgentEventRetentionPreview>({ days: num, olderThan: str, wouldDelete: num })
export const agentEventViewersSchema = topLevel<AgentEventViewers>({ mode: str, viewers: list })
export const sandboxImpactSchema = topLevel<SandboxImpact>({
  from: str, to: str, byHost: list, bySkill: list, byPlace: list, total: num, truncated: bool,
})
export const agentSandboxSchema = topLevel<AgentSandboxView>({
  settings: obj, defaultAllowedDomains: list, overrides: list, updatedAt: nullableStr, updatedBy: nullableStr, history: list,
})
export const agentStopSchema = topLevel<AgentStopView>({ active: list, history: list, unsupported: list, keys: obj })

// Tasks, inbox and absences
export const taskSettingsSchema = topLevel<TaskSettingsView>({
  settings: obj, canEdit: bool, updatedAt: nullableStr, updatedBy: nullableStr, updatedByName: nullableStr,
})
export const inboxSettingsSchema = topLevel<InboxSettingsView>({ settings: obj, canEdit: bool, updatedAt: nullableStr, updatedBy: nullableStr })
export const memberAbsencesSchema = topLevel<MemberAbsencesView>({ userId: str, absences: list, canEdit: bool, covering: list, today: str })
export const absenceCreatedSchema = topLevel<AbsenceCreated>({ absence: obj, delegateCannotRead: num })
export const absenceRemovedSchema = topLevel<{ removed: true }>({ removed: bool })

// API keys, plugins and connectors
export const brokerSchema = topLevel<BrokerView>({
  status: obj, settings: obj, services: list, keys: list, departments: list, history: list, check: z.optional(obj),
})
export const pluginListSchema = topLevel<{ plugins: PluginListItem[] }>({ plugins: list })
export const pluginSchema = topLevel<PluginDetail>({
  plugin: obj, mapping: nullableObj, mappingVersions: list, policies: list, labels: obj,
  mappingErrors: list, autoAcknowledgements: list, history: list, readScope: obj,
})
export const pluginMappingCheckSchema = topLevel<PluginMappingCheck>({ reachable: bool, reason: nullableStr, objects: obj, checkedAt: str })
export const importReportSchema = topLevel<ImportReport>({ status: str, reason: nullableStr, objects: obj, startedAt: str, finishedAt: str })
export const connectionRenewSchema = topLevel<{ connectionId: string }>({ connectionId: str })
export const pluginRolesSchema = topLevel<PluginRolesView>({ pluginId: str, label: str, roles: list, overrides: list, history: list })
export const pluginStepSkillsSchema = topLevel<PluginStepSkillsView>({ steps: list })
export const googleSchema = topLevel<GoogleAdminView>({
  vaultEnabled: bool, configured: bool, clientId: nullableStr, secretLast4: nullableStr, domain: nullableStr,
  enabled: bool, redirectUri: str, practice: bool, operatorStopped: bool, updatedAt: nullableStr,
  updatedBy: nullableStr, grants: list, history: list, picker: obj, featuresOff: list, companyFeatures: list,
})
export const slackSchema = topLevel<SlackAdminView>({
  vaultEnabled: bool, configured: bool, teamId: nullableStr, clientId: nullableStr, clientSecretLast4: nullableStr,
  hasBotToken: bool, enabled: bool, operatorStopped: bool, practice: bool, redirectUri: str, eventsUrl: str,
  grants: list, history: list,
})
export const coreConnectorsSchema = topLevel<CoreConnectorsView>({ connectors: list, roles: list })
export const minutesFolderSchema = topLevel<MinutesFolderSetting>({ folder: nullableStr, choices: list, meetings: str, bundleQuestionDays: num })
export const meetingDuplicatesSchema = topLevel<MeetingDuplicates>({ groups: list })
export const meetingDuplicatesMergedSchema = topLevel<MeetingDuplicatesMerged>({ keptId: str, merged: list, failed: list })
