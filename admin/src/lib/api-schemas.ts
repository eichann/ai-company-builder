// What the admin checks in the server's answers before rendering them (api.ts getData).
//
// The server is the authority, but a proxy's error page, an older or newer server, or a bug
// can answer with a different shape; rendering that as if it were right shows broken or
// misleading data (a member list without roles, an empty overview). Each schema checks the
// fields the pages rely on and lets extra fields through (servers add fields over time).
// Each is typed against the interface in api.ts, so the two cannot drift apart unnoticed.
//
// zod/mini keeps the bundle small (tree-shaken functions instead of the chained classes).

import * as z from 'zod/mini'

import type {
  Capabilities,
  ClientActivity,
  Company,
  Department,
  Member,
  Overview,
  OverviewMember,
  OrphanedScopeSummary,
  PushRejection,
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
})

export const configSchema: z.ZodMiniType<{ name: string; version: string; setupComplete: boolean }> = z.looseObject({
  name: str,
  version: str,
  setupComplete: z.boolean(),
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
