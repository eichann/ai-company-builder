// Typed client for the API server.
//
// Requests use relative URLs: in production Caddy routes /api/* to the API
// server, and without a reverse proxy the admin's own /api/* proxy
// (src/proxy.ts) forwards them. Either way the session cookie is first-party.

import type { ZodMiniType } from 'zod/mini'

import type { ClientBuild } from '../../../shared/core/client-version'
import {
  absenceCreatedSchema,
  absenceRemovedSchema,
  agentEventPageSchema,
  agentEventRetentionPreviewSchema,
  agentEventSettingsSchema,
  agentEventSummarySchema,
  agentEventViewersSchema,
  agentSandboxSchema,
  agentStopSchema,
  brokerSchema,
  capabilitiesSchema,
  clientActivitiesSchema,
  companiesSchema,
  companySchema,
  configSchema,
  connectionRenewSchema,
  coreConnectorsSchema,
  createdInvitationSchema,
  deletePrivateFolderSchema,
  departmentMembersSchema,
  departmentSchema,
  departmentsSchema,
  departmentStatsSchema,
  effectiveAccessSchema,
  googleSchema,
  importReportSchema,
  inboxSettingsSchema,
  invitationAcceptSchema,
  invitationsSchema,
  invitationValidateSchema,
  makePublicSchema,
  managersSchema,
  memberAbsencesSchema,
  memberRoleSchema,
  membersSchema,
  minutesFolderSchema,
  meetingDuplicatesSchema,
  meetingDuplicatesMergedSchema,
  overviewSchema,
  permissionsSchema,
  pluginListSchema,
  pluginMappingCheckSchema,
  pluginRolesSchema,
  pluginSchema,
  pluginStepSkillsSchema,
  privateFolderSchema,
  privateFoldersSchema,
  pushRejectionPageSchema,
  repoFoldersSchema,
  sandboxImpactSchema,
  scopeMoveSchema,
  scopeResetSchema,
  scopeRulesResultSchema,
  slackSchema,
  taskSettingsSchema,
  userSchema,
} from './api-schemas'
import type {
  AgentEventQuery,
  AgentEventSettingsUpdate,
  AgentEventViewerMode,
} from '../../../shared/types/agent-events'

const API_BASE = ''

/** An HTTP error from the API, keeping the status so the UI can explain it. */
export class ApiError extends Error {
  readonly status: number
  /** The machine-readable `code` of the error body, when the API sent one. */
  readonly code: string | undefined
  /** The whole JSON error body (for errors that carry details, e.g. OUTDATED_CLIENTS). */
  readonly body: Record<string, unknown> | null
  constructor(status: number, message: string, body: Record<string, unknown> | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.code = typeof body?.code === 'string' ? body.code : undefined
  }
}

/** `ApiError.code` of an answer that is not JSON or not the shape the page expects (describeError). */
export const INVALID_RESPONSE = 'INVALID_RESPONSE'

function invalidResponse(status: number, issues: string[] = []): ApiError {
  // Only where the shape broke (field paths), never the values.
  return new ApiError(status, 'Invalid response from the server', { code: INVALID_RESPONSE, issues })
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: unknown
  headers?: Record<string, string>
}

/** The server did not answer in time (a hung proxy or server): the request was abandoned. */
export class ApiTimeoutError extends Error {
  constructor() {
    super('The server did not answer in time')
    this.name = 'ApiTimeoutError'
  }
}

/** How long a request may take before it is abandoned (a page would otherwise spin forever). */
export const API_TIMEOUT_MS = 30_000

export async function apiClient<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: controller.signal,
    })
    // An empty body (204, or a proxy's empty error page) is not a parse error.
    const text = await res.text()
    let raw: unknown = null
    if (text.trim() !== '') {
      try { raw = JSON.parse(text) } catch { raw = undefined }
    }

    if (!res.ok) {
      const error = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
      const message = typeof error?.error === 'string' ? error.error : typeof error?.message === 'string' ? error.message : ''
      throw new ApiError(res.status, message || `Request failed (${res.status})`, error)
    }
    if (raw === undefined) throw invalidResponse(res.status)
    return raw as T
  } catch (err) {
    if (controller.signal.aborted) throw new ApiTimeoutError()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The `data` of a `{ success, data }` envelope, checked against `schema` (api-schemas.ts): an
 * answer of another shape is refused with INVALID_RESPONSE instead of being rendered. There is
 * no unchecked variant; a new call adds its schema there.
 */
async function getData<T>(endpoint: string, schema: ZodMiniType<T>, options?: RequestOptions): Promise<T> {
  const res = await apiClient<unknown>(endpoint, options)
  const data = res !== null && typeof res === 'object' && !Array.isArray(res) ? (res as { data?: unknown }).data : undefined
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw invalidResponse(200, parsed.error.issues.slice(0, 10).map(i => ['data', ...i.path.map(String)].join('.')))
  return parsed.data
}

const enc = encodeURIComponent

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface User {
  id: string
  email: string
  name: string | null
  createdAt?: string
}

export const authApi = {
  signIn: (email: string, password: string) =>
    apiClient('/api/auth/sign-in/email', {
      method: 'POST',
      body: { email, password },
    }),

  /**
   * After the first user exists the server only accepts sign-ups that carry a
   * valid invitation token in X-Invitation-Token (server/src/index.ts).
   */
  signUp: (email: string, password: string, name: string, invitationToken?: string) =>
    apiClient('/api/auth/sign-up/email', {
      method: 'POST',
      body: { email, password, name },
      headers: invitationToken ? { 'X-Invitation-Token': invitationToken } : {},
    }),

  signOut: () => apiClient('/api/auth/sign-out', { method: 'POST', body: {} }),
}

export const meApi = {
  getMe: () => getData('/api/me', userSchema),
}

export const configApi = {
  get: () => getData('/api/config', configSchema),
}

// ---------------------------------------------------------------------------
// Companies & members
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'admin' | 'member'

export interface Company {
  id: string
  name: string
  slug: string
  ownerId: string
  repoPath: string | null
  createdAt: string
  updatedAt: string
  role?: Role
}

export interface Member {
  id: string
  userId: string
  companyId: string
  role: Role
  email: string | null
  name: string | null
  createdAt: string
}

export const companiesApi = {
  list: () => getData('/api/companies', companiesSchema),

  create: (name: string, slug?: string) =>
    getData('/api/companies', companySchema, { method: 'POST', body: { name, slug } }),

  get: (id: string) => getData(`/api/companies/${enc(id)}`, companySchema),

  getMembers: (id: string) => getData(`/api/companies/${enc(id)}/members`, membersSchema),

  /** owner / admin. Only the display name changes. */
  rename: (id: string, name: string) =>
    getData(`/api/companies/${enc(id)}`, companySchema, { method: 'PATCH', body: { name } }),

  /** owner only; the last owner cannot be demoted. */
  setMemberRole: (companyId: string, userId: string, role: Role) =>
    getData(
      `/api/companies/${enc(companyId)}/members/${enc(userId)}/role`, memberRoleSchema,
      { method: 'PUT', body: { role } }
    ),

  removeMember: (companyId: string, userId: string) =>
    apiClient<{ success: boolean }>(`/api/companies/${enc(companyId)}/members/${enc(userId)}`, {
      method: 'DELETE',
    }),
}

// ---------------------------------------------------------------------------
// Capabilities (what the signed-in user may do in a company)
// ---------------------------------------------------------------------------

export interface Capabilities {
  role: Role
  managedDepartmentIds: string[]
  /** May open 「AI の操作の記録」 (owner/admin; a manager while the log's viewer setting allows). */
  canViewAgentEvents: boolean
}

export const capabilitiesApi = {
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/me/capabilities`, capabilitiesSchema),
}

// ---------------------------------------------------------------------------
// Overview (owner / admin)
// ---------------------------------------------------------------------------

export interface OverviewMember {
  userId: string
  name: string | null
  email: string | null
  role: Role
  clientVersion: string | null
  lastSeenAt: string | null
  lastFetchAt: string | null
  lastPushAt: string | null
}

export interface PushRejection {
  id: string
  userId: string
  name: string | null
  marker: string
  paths: string[]
  createdAt: string
}

export interface Overview {
  memberCount: number
  departmentCount: number
  attention: {
    outdatedClients: OverviewMember[]
    unknownClients: OverviewMember[]
    notSyncedRecently: OverviewMember[]
    recentRejections: PushRejection[]
    /** Absent from servers older than the orphaned-rules check. */
    orphanedScopes?: OrphanedScopeSummary[]
  }
}

/** Rules whose folder is gone from the shared branch (renamed or removed by a sync). */
export interface OrphanedScopeSummary {
  scopeId: string
  path: string
  kind: PermissionScope['kind']
  ruleCount: number
  summary: EffectiveSummary
  /** When the folder was first noticed missing. */
  since: string
}

export const overviewApi = {
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/overview`, overviewSchema),
}

// ---------------------------------------------------------------------------
// Client activity (#102; owner / admin)
// ---------------------------------------------------------------------------

export type { ClientBuild } from '../../../shared/core/client-version'

export interface ClientActivity {
  userId: string
  role: Role
  email: string | null
  name: string | null
  clientVersion: string | null
  build: ClientBuild | null
  clientPlatform: string | null
  lastSeenAt: string | null
  lastFetchAt: string | null
  lastPushAt: string | null
  /** Does this build send the AI action log (server cutoff AGENT_EVENTS_CLIENT_COMMIT_DATE)? false for unknown builds. */
  supportsAgentEvents: boolean
}

export const clientActivityApi = {
  list: (companyId: string) => getData(`/api/companies/${enc(companyId)}/client-activity`, clientActivitiesSchema),
}

// ---------------------------------------------------------------------------
// Permissions (read-only in Phase 1)
// ---------------------------------------------------------------------------

export type EffectiveSummary = 'everyone-rw' | 'everyone-r' | 'restricted'

export interface PermissionRule {
  id: string
  subjectType: 'everyone' | 'role' | 'user'
  subjectId: string | null
  subjectLabel: string
  canRead: boolean
  canWrite: boolean
}

export interface PermissionScope {
  id: string
  path: string
  kind: 'company' | 'department' | 'folder'
  departmentId: string | null
  repoId: string | null
  inherited: boolean
  rules: PermissionRule[]
  effectiveSummary: EffectiveSummary
  /**
   * What this place follows when it has no rules of its own (上の階層と同じ):
   * the nearest ancestor with rules. null for the company root. Absent from
   * servers older than the per-folder choice.
   */
  inheritedFrom?: InheritedRules | null
}

export interface InheritedRules {
  scopeId: string
  path: string
  rules: PermissionRule[]
  summary: EffectiveSummary
}

/** One rule of a complete rule set sent to replaceScope (read is always allowed). */
export type RuleInput = RuleSubject & { canWrite: boolean }

/** Who a rule is for. Rules for owners/admins are refused: they can always edit. */
export type RuleSubject =
  | { subjectType: 'everyone'; subjectId: null }
  | { subjectType: 'role'; subjectId: 'member' }
  | { subjectType: 'user'; subjectId: string }

export interface ScopeRulesResult {
  /** null when the folder's last rule was removed (it inherits again). */
  scope: { id: string; path: string; kind: PermissionScope['kind']; inherited: boolean } | null
  rules: PermissionRule[]
}

export interface EffectiveMember {
  userId: string
  name: string | null
  email: string | null
  role: Role
  read: boolean
  write: boolean
  reason: 'role' | 'rule' | 'no-rule' | 'not-member'
  decidedBy: { scopeId: string; path: string; subjectType: PermissionRule['subjectType']; subjectLabel: string } | null
}

export interface EffectiveAccess {
  path: string
  governingScope: { id: string; path: string; inherited: boolean } | null
  /** false until read restriction ships: everyone can read regardless. */
  readRestrictionEnforced: boolean
  members: EffectiveMember[]
}

export interface RepoFolder {
  name: string
  path: string
  scopeId: string | null
  hasRules: boolean
  /** A private folder (its own repository); absent from older servers. */
  private?: boolean
}

export interface OrphanedScope {
  scopeId: string
  path: string
  kind: PermissionScope['kind']
  departmentId: string | null
  rules: PermissionRule[]
  summary: EffectiveSummary
  since: string
}

/**
 * A member who would lose edit access but runs a desktop app that cannot
 * recover from it (409 OUTDATED_CLIENTS from any rule change).
 */
export interface OutdatedMember {
  userId: string
  name: string | null
  email: string | null
  role: Role
  clientVersion: string | null
  /** clientVersion, or 不明. */
  version: string
  lastSeenAt: string | null
}

export interface OutdatedClients {
  members: OutdatedMember[]
  /** Owners/admins may save anyway (force); managers may not. */
  canForce: boolean
}

/** The details of a 409 OUTDATED_CLIENTS, or null for any other error. */
export function outdatedClientsOf(err: unknown): OutdatedClients | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'OUTDATED_CLIENTS') return null
  const members = Array.isArray(err.body?.members) ? (err.body.members as OutdatedMember[]) : []
  return { members, canForce: err.body?.canForce === true }
}

/** Save anyway although some members' apps are outdated (owner/admin only). */
export type ForceOption = { force?: boolean }

const permBase = (companyId: string) => `/api/companies/${enc(companyId)}/permissions`

export const permissionsApi = {
  get: (companyId: string) =>
    getData(permBase(companyId), permissionsSchema),

  /**
   * Replace a place's whole rule set in one step (what the 権限 screen saves).
   * [] = 上の階層と同じ (not allowed for the company root).
   */
  replaceScope: (companyId: string, path: string, rules: RuleInput[], { force = false }: ForceOption = {}) =>
    getData(`${permBase(companyId)}/scopes/by-path`, scopeRulesResultSchema, {
      method: 'PUT',
      body: force ? { path, rules, force } : { path, rules },
    }),

  /** Move the rules of a place (and of the places inside it) to another existing folder. */
  moveScope: (companyId: string, scopeId: string, toPath: string, { force = false }: ForceOption = {}) =>
    getData(`${permBase(companyId)}/scopes/${enc(scopeId)}/move`, scopeMoveSchema, {
      method: 'POST',
      body: force ? { toPath, force } : { toPath },
    }),

  /** Set (create or update) a subject's rule on a folder; the folder stops inheriting. */
  setRule: (companyId: string, path: string, subject: RuleSubject, canWrite: boolean) =>
    getData(`${permBase(companyId)}/rules`, scopeRulesResultSchema, {
      method: 'POST',
      body: { path, ...subject, canWrite },
    }),

  updateRule: (companyId: string, ruleId: string, canWrite: boolean) =>
    getData(`${permBase(companyId)}/rules/${enc(ruleId)}`, scopeRulesResultSchema, { method: 'PATCH', body: { canWrite } }),

  deleteRule: (companyId: string, ruleId: string) =>
    getData(`${permBase(companyId)}/rules/${enc(ruleId)}`, scopeRulesResultSchema, { method: 'DELETE' }),

  /** Remove every rule of the scope so it inherits from its parent again. */
  resetScope: (companyId: string, scopeId: string, { force = false }: ForceOption = {}) =>
    getData(`${permBase(companyId)}/scopes/${enc(scopeId)}/rules${force ? '?force=true' : ''}`, scopeResetSchema, { method: 'DELETE' }),

  effective: (companyId: string, path: string) =>
    getData(`${permBase(companyId)}/effective?path=${enc(path)}`, effectiveAccessSchema),

  folders: (companyId: string, path: string) =>
    getData(`${permBase(companyId)}/folders?path=${enc(path)}`, repoFoldersSchema),
}

// ---------------------------------------------------------------------------
// Private folders (permission plan stage 3; shared/types/private-folders.ts)
// ---------------------------------------------------------------------------

export interface PrivateFolderSummary {
  scopeId: string
  path: string
  /** Department whose folder contains it, or null (company root). */
  departmentId: string | null
  /** Members who can read it (owners/admins included). */
  viewerCount: number
  /** Members who can edit it (owners/admins included). */
  editorCount: number
  createdAt: string
  createdBy: string | null
  createdByName: string | null
}

export interface PrivateFolderMember {
  userId: string
  name: string | null
  email: string | null
  role: string
  canWrite: boolean
  /** 'role' = owner/admin (always), 'rule' = named on the folder. */
  via: 'role' | 'rule'
}

export interface PrivateFolderDetail extends PrivateFolderSummary {
  members: PrivateFolderMember[]
}

export interface CreatePrivateFolderInput {
  /** Existing folder; '' = the company root (owner/admin only). */
  parentPath: string
  name: string
  /** Omitted = the creator + the department's managers. */
  viewers?: string[]
  /** Subset of viewers; omitted = every viewer. */
  editors?: string[]
}

const privBase = (companyId: string) => `/api/companies/${enc(companyId)}/private-folders`

export const privateFoldersApi = {
  /** owner/admin: all; managers: their departments'. */
  list: (companyId: string) => getData(privBase(companyId), privateFoldersSchema),

  get: (companyId: string, scopeId: string) => getData(`${privBase(companyId)}/${enc(scopeId)}`, privateFolderSchema),

  /** 409 FOLDER_NAME_UNAVAILABLE / OUTDATED_CLIENTS, 400 PARENT_NOT_FOUND / ALREADY_PRIVATE / INVALID_MEMBERS. */
  create: (companyId: string, input: CreatePrivateFolderInput, { force = false }: ForceOption = {}) =>
    getData(privBase(companyId), privateFolderSchema, { method: 'POST', body: force ? { ...input, force } : input }),

  updateMembers: (companyId: string, scopeId: string, viewers: string[], editors?: string[]) =>
    getData(`${privBase(companyId)}/${enc(scopeId)}/members`, privateFolderSchema, {
      method: 'PUT',
      body: editors ? { viewers, editors } : { viewers },
    }),

  /** 公開に戻す (owner/admin): the contents go to everyone. */
  makePublic: (companyId: string, scopeId: string) =>
    getData(`${privBase(companyId)}/${enc(scopeId)}/make-public`, makePublicSchema, { method: 'POST', body: {} }),

  /**
   * 削除 (owner/admin): the folder disappears from its viewers' PCs at their
   * next sync; the server keeps an archive of its repository for the operator.
   * `confirm` is the folder's name as typed (400 CONFIRMATION_REQUIRED otherwise).
   */
  remove: (companyId: string, scopeId: string, confirm: string) =>
    getData(`${privBase(companyId)}/${enc(scopeId)}?confirm=${enc(confirm)}`, deletePrivateFolderSchema, { method: 'DELETE' }),
}

/** DELETE /private-folders/:scopeId?confirm=<name> (shared/types/private-folders.ts). */
export interface DeletePrivateFolderResult {
  path: string
  archived: true
}

// ---------------------------------------------------------------------------
// Push rejection history (owner / admin)
// ---------------------------------------------------------------------------

export interface PushRejectionRecord {
  id: string
  userId: string
  name: string | null
  email: string | null
  marker: string
  paths: string[]
  createdAt: string
}

export interface PushRejectionPage {
  total: number
  /** Every marker recorded for this company, for the filter. */
  markers: string[]
  rejections: PushRejectionRecord[]
}

export const pushRejectionsApi = {
  list: (companyId: string, q: { userId?: string; marker?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams()
    if (q.userId) params.set('userId', q.userId)
    if (q.marker) params.set('marker', q.marker)
    if (q.limit !== undefined) params.set('limit', String(q.limit))
    if (q.offset) params.set('offset', String(q.offset))
    const qs = params.toString()
    return getData(`/api/companies/${enc(companyId)}/push-rejections${qs ? `?${qs}` : ''}`, pushRejectionPageSchema)
  },
}

// ---------------------------------------------------------------------------
// The AI action log (monitoring M1; shared/types/agent-events.ts)
// ---------------------------------------------------------------------------

// One copy of these shapes: the server builds them from the same file, and
// server/tests/integration/admin-contract.test.ts checks its answers against
// the names below.
export type {
  AgentEventDailyCount,
  AgentEventPage,
  AgentEventQuery,
  AgentEventRecord,
  AgentEventRetentionPreview,
  AgentEventSettings,
  AgentEventSettingsChange,
  AgentEventSettingsUpdate,
  AgentEventSettingsValues,
  AgentEventSummary,
  AgentEventTarget,
  AgentEventViewer,
  AgentEventViewerMode,
  AgentEventViewers,
  AgentKind,
  GuardReason,
  SandboxImpact,
  SandboxMark,
  SensitiveLocation,
  ShownFileTarget,
  ToolCategory,
  ToolDecision,
  ToolOutcome,
} from '../../../shared/types/agent-events'

export const agentEventsApi = {
  /** Newest first; pass `nextCursor` back as `cursor` for older events. */
  list: (companyId: string, q: AgentEventQuery = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(q)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    const qs = params.toString()
    return getData(`/api/companies/${enc(companyId)}/agent-events${qs ? `?${qs}` : ''}`, agentEventPageSchema)
  },
  /** Counts per member and day; `tzOffsetMinutes` = minutes east of UTC (540 for Japan). */
  summary: (companyId: string, q: { from?: string; to?: string; tzOffsetMinutes?: number } = {}) => {
    const params = new URLSearchParams()
    if (q.from) params.set('from', q.from)
    if (q.to) params.set('to', q.to)
    if (q.tzOffsetMinutes !== undefined) params.set('tzOffsetMinutes', String(q.tzOffsetMinutes))
    const qs = params.toString()
    return getData(`/api/companies/${enc(companyId)}/agent-events/summary${qs ? `?${qs}` : ''}`, agentEventSummarySchema)
  },
  settings: (companyId: string) =>
    getData(`/api/companies/${enc(companyId)}/agent-events/settings`, agentEventSettingsSchema),
  updateSettings: (companyId: string, update: AgentEventSettingsUpdate) =>
    getData(`/api/companies/${enc(companyId)}/agent-events/settings`, agentEventSettingsSchema, { method: 'PUT', body: update }),
  /** How many events a retention of `days` would delete (confirm before shortening). */
  retentionPreview: (companyId: string, days: number) =>
    getData(`/api/companies/${enc(companyId)}/agent-events/settings/retention-preview?days=${days}`, agentEventRetentionPreviewSchema),
  /** What the AI sandbox blocks / would block, by host, skill and secret place (「AI の囲い」). */
  sandboxImpact: (companyId: string, q: { from?: string; to?: string } = {}) => {
    const params = new URLSearchParams()
    if (q.from) params.set('from', q.from)
    if (q.to) params.set('to', q.to)
    const qs = params.toString()
    return getData(`/api/companies/${enc(companyId)}/agent-events/sandbox${qs ? `?${qs}` : ''}`, sandboxImpactSchema)
  },
  /** Who would see the log under `mode`, with their scope (the settings card's live list). */
  viewers: (companyId: string, mode: AgentEventViewerMode) =>
    getData(`/api/companies/${enc(companyId)}/agent-events/viewers?mode=${enc(mode)}`, agentEventViewersSchema),
}

// ---------------------------------------------------------------------------
// AI sandbox (「AI の囲い」): shapes from shared/types/agent-sandbox.ts
// ---------------------------------------------------------------------------

export type {
  AgentSandboxChange,
  AgentSandboxOverride,
  AgentSandboxView,
} from '../../../shared/types/agent-sandbox'
export type { AgentSandboxMode, AgentSandboxSettings, AgentSandboxUnavailable } from '../../../shared/core/agent-sandbox'

import type { AgentSandboxMode, AgentSandboxSettings } from '../../../shared/core/agent-sandbox'

export const agentSandboxApi = {
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/agent-sandbox`, agentSandboxSchema),
  update: (companyId: string, settings: AgentSandboxSettings) =>
    getData(`/api/companies/${enc(companyId)}/agent-sandbox`, agentSandboxSchema, { method: 'PUT', body: settings }),
  /** A member's own mode (staged rollout); null = follow the company again. */
  setOverride: (companyId: string, userId: string, mode: AgentSandboxMode | null) =>
    getData(`/api/companies/${enc(companyId)}/agent-sandbox/overrides/${enc(userId)}`, agentSandboxSchema, { method: 'PUT', body: { mode } }),
}

// ---------------------------------------------------------------------------
// Emergency stop (「AI の緊急停止」, M2): shapes from shared/types/agent-stop.ts
// ---------------------------------------------------------------------------

export type {
  AgentStopEntry,
  AgentStopRequest,
  AgentStopToolKind,
  AgentStopUnsupportedMember,
  AgentStopView,
} from '../../../shared/types/agent-stop'

import type { AgentStopRequest } from '../../../shared/types/agent-stop'

export const agentStopApi = {
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/agent-stops`, agentStopSchema),
  stop: (companyId: string, request: AgentStopRequest) =>
    getData(`/api/companies/${enc(companyId)}/agent-stops`, agentStopSchema, { method: 'POST', body: request }),
  release: (companyId: string, stopId: string) =>
    getData(`/api/companies/${enc(companyId)}/agent-stops/${enc(stopId)}`, agentStopSchema, { method: 'DELETE' }),
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface Invitation {
  id: string
  companyId: string
  companyName: string
  token: string
  role: Role
  createdBy: string
  createdByName: string | null
  createdByEmail: string | null
  usedBy: string | null
  usedByName: string | null
  usedByEmail: string | null
  usedAt: string | null
  expiresAt: string
  createdAt: string
  isExpired: boolean
  isUsed: boolean
}

/** POST /companies/:id/invitations (201): the new link only — no creator/use details yet. */
export type CreatedInvitation = Pick<Invitation, 'id' | 'token' | 'companyId' | 'companyName' | 'role' | 'expiresAt' | 'createdAt'>

export const invitationsApi = {
  list: (companyId: string) => getData(`/api/companies/${enc(companyId)}/invitations`, invitationsSchema),

  create: (companyId: string, role: 'admin' | 'member' = 'member', expiresInDays: number = 7) =>
    getData(`/api/companies/${enc(companyId)}/invitations`, createdInvitationSchema, {
      method: 'POST',
      body: { role, expiresInDays },
    }),

  delete: (companyId: string, invitationId: string) =>
    apiClient<{ success: boolean }>(`/api/companies/${enc(companyId)}/invitations/${enc(invitationId)}`, {
      method: 'DELETE',
    }),

  validate: (token: string) =>
    getData(`/api/invitations/${enc(token)}`, invitationValidateSchema),

  accept: (token: string) =>
    getData(`/api/invitations/${enc(token)}/accept`, invitationAcceptSchema, {
      method: 'POST',
    }),
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export interface Department {
  id: string
  companyId: string
  parentId: string | null
  name: string
  nameEn: string | null
  folder: string
  icon: string
  color: string
  description: string | null
  sortOrder: number
  isActive: boolean
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

export interface CreateDepartmentInput {
  name: string
  nameEn?: string
  folder: string
  icon?: string
  color?: string
  description?: string
}

export interface UpdateDepartmentInput {
  name?: string
  nameEn?: string | null
  folder?: string
  icon?: string
  color?: string
  description?: string | null
}

export interface DepartmentManager {
  userId: string
  name: string | null
  email: string | null
}

const deptBase = (companyId: string) => `/api/companies/${enc(companyId)}/departments`

export const departmentsApi = {
  list: (companyId: string) => getData(`${deptBase(companyId)}?flat=true`, departmentsSchema),

  create: (companyId: string, data: CreateDepartmentInput) =>
    getData(deptBase(companyId), departmentSchema, { method: 'POST', body: data }),

  update: (companyId: string, departmentId: string, data: UpdateDepartmentInput) =>
    getData(`${deptBase(companyId)}/${enc(departmentId)}`, departmentSchema, { method: 'PUT', body: data }),

  delete: (companyId: string, departmentId: string) =>
    apiClient<{ success: boolean; deletedFiles?: number; deletedFolders?: number }>(
      `${deptBase(companyId)}/${enc(departmentId)}`,
      { method: 'DELETE' }
    ),

  reorder: (companyId: string, items: Array<{ id: string; sortOrder: number }>) =>
    apiClient<{ success: boolean }>(`${deptBase(companyId)}/reorder`, { method: 'POST', body: { items } }),

  stats: (companyId: string, departmentId: string) =>
    getData(
      `${deptBase(companyId)}/${enc(departmentId)}/stats`, departmentStatsSchema
    ),

  /** Register top-level folders that exist in the repository but not as departments. */
  sync: (companyId: string) =>
    apiClient<{ success: boolean; added: number; removed: number }>(`${deptBase(companyId)}/sync`, {
      method: 'POST',
    }),

  getManagers: (companyId: string, departmentId: string) =>
    getData(`${deptBase(companyId)}/${enc(departmentId)}/managers`, managersSchema),

  setManagers: (companyId: string, departmentId: string, userIds: string[]) =>
    getData(`${deptBase(companyId)}/${enc(departmentId)}/managers`, managersSchema, {
      method: 'PUT',
      body: { userIds },
    }),

  /** Who belongs to the department (所属する部署); changes nobody's folder access. */
  getMembers: (companyId: string, departmentId: string) =>
    getData(`${deptBase(companyId)}/${enc(departmentId)}/members`, departmentMembersSchema),

  /** Owner/admin, or a manager of this department; replaces the set. */
  setMembers: (companyId: string, departmentId: string, userIds: string[]) =>
    getData(`${deptBase(companyId)}/${enc(departmentId)}/members`, departmentMembersSchema, {
      method: 'PUT',
      body: { userIds },
    }),
}

// ---------------------------------------------------------------------------
// Task settings (やることの一覧の設定) and department membership: shapes from
// shared/types/task-settings.ts, rules in shared/core/task-settings.ts.
// ---------------------------------------------------------------------------

export type { DepartmentMember, DepartmentMembersView, TaskSettingsView } from '../../../shared/types/task-settings'
export type { CompanyHoliday, ReplyRule, TaskSettings } from '../../../shared/core/task-settings'

import type { TaskSettings } from '../../../shared/core/task-settings'

export const taskSettingsApi = {
  /** Every member reads; canEdit says whether the caller may change them. */
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/task-settings`, taskSettingsSchema),
  /** Owner/admin: the whole document. */
  update: (companyId: string, settings: TaskSettings) =>
    getData(`/api/companies/${enc(companyId)}/task-settings`, taskSettingsSchema, { method: 'PUT', body: settings }),
}

// The intake settings (来た連絡の細かい決まり, inbox.md): shapes from shared/types/inbox.ts,
// rules in shared/core/intake-settings.ts.
export type { InboxSettingsView } from '../../../shared/types/inbox'
export type { IntakeSettings, SharedAddress } from '../../../shared/core/intake-settings'

import type { IntakeSettings } from '../../../shared/core/intake-settings'

// What one meeting's reading made twice (minutes.md "Outputs made once"): owner/admin list them and
// merge (each duplicate cancelled / retracted with a note naming the kept one; nothing is deleted).
export type { MeetingDuplicateGroup, MeetingDuplicates, MeetingDuplicatesMerged } from '../../../shared/types/meeting-outputs'

export const meetingDuplicatesApi = {
  list: (companyId: string) => getData(`/api/companies/${enc(companyId)}/records/meeting-duplicates`, meetingDuplicatesSchema),
  merge: (companyId: string, keepId: string, duplicateIds: string[]) =>
    getData(`/api/companies/${enc(companyId)}/records/meeting-duplicates/merge`, meetingDuplicatesMergedSchema, { method: 'POST', body: { keepId, duplicateIds } }),
}

export const inboxSettingsApi = {
  /** Every member reads; canEdit says whether the caller may change them. */
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/inbox-settings`, inboxSettingsSchema),
  /** Owner/admin: the whole document. */
  update: (companyId: string, settings: IntakeSettings) =>
    getData(`/api/companies/${enc(companyId)}/inbox-settings`, inboxSettingsSchema, { method: 'PUT', body: settings }),
}

// ---------------------------------------------------------------------------
// Absence and the delegate (不在・代わりの人): shapes from shared/types/absences.ts,
// rules in shared/core/absences.ts. The member, owner/admin, or a manager of a
// department the member belongs to.
// ---------------------------------------------------------------------------

export type { AbsenceCreated, AbsenceCreateRequest, AbsenceView, CoveringView, MemberAbsencesView } from '../../../shared/types/absences'

import type { AbsenceCreateRequest } from '../../../shared/types/absences'

export const absencesApi = {
  /** Absences of `userId` that have not ended yet, soonest first. */
  list: (companyId: string, userId: string) =>
    getData(`/api/companies/${enc(companyId)}/absences?userId=${enc(userId)}`, memberAbsencesSchema),
  /** 400 / 409 carry a Japanese `error` meant to be shown as is. */
  create: (companyId: string, body: AbsenceCreateRequest & { userId: string }) =>
    getData(`/api/companies/${enc(companyId)}/absences`, absenceCreatedSchema, { method: 'POST', body }),
  remove: (companyId: string, absenceId: string) =>
    getData(`/api/companies/${enc(companyId)}/absences/${enc(absenceId)}`, absenceRemovedSchema, { method: 'DELETE' }),
}

// ---------------------------------------------------------------------------
// API keys (key broker, 「API キー」): shapes from shared/types/key-broker.ts.
// Write-only: a key's value is sent to the server and never comes back.
// ---------------------------------------------------------------------------

export type {
  BrokerChange,
  BrokerChangeDetail,
  BrokerKeyCheck,
  BrokerKeyCreate,
  BrokerKeySnapshot,
  BrokerKeySummary,
  BrokerKeyUpdate,
  BrokerKeyUser,
  BrokerRelayServiceSave,
  BrokerServiceSetting,
  BrokerServiceView,
  BrokerSettings,
  BrokerView,
} from '../../../shared/types/key-broker'
export type {
  BrokerAudience,
  BrokerCaps,
  BrokerDestinations,
  BrokerKeyCheckResult,
  BrokerKeyRule,
  BrokerKeyStatus,
  BrokerRelayDefinition,
  BrokerServiceCategory,
  BrokerStatusReason,
} from '../../../shared/core/key-broker'

import type { BrokerDefaultKeyChoice, BrokerKeyCreate, BrokerKeyUpdate, BrokerOwnKeysSwitch, BrokerRelayServiceSave, BrokerServiceSetting } from '../../../shared/types/key-broker'

export const keyBrokerApi = {
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/broker`, brokerSchema),
  create: (companyId: string, key: BrokerKeyCreate) =>
    getData(`/api/companies/${enc(companyId)}/broker/keys`, brokerSchema, { method: 'POST', body: key }),
  replaceSecret: (companyId: string, keyId: string, secret: string) =>
    getData(`/api/companies/${enc(companyId)}/broker/keys/${enc(keyId)}/secret`, brokerSchema, { method: 'PUT', body: { secret } }),
  update: (companyId: string, keyId: string, update: BrokerKeyUpdate) =>
    getData(`/api/companies/${enc(companyId)}/broker/keys/${enc(keyId)}`, brokerSchema, { method: 'PATCH', body: update }),
  remove: (companyId: string, keyId: string) =>
    getData(`/api/companies/${enc(companyId)}/broker/keys/${enc(keyId)}`, brokerSchema, { method: 'DELETE' }),
  setService: (companyId: string, service: string, setting: BrokerServiceSetting) =>
    getData(`/api/companies/${enc(companyId)}/broker/services/${enc(service)}`, brokerSchema, { method: 'PUT', body: setting }),
  /** The one switch 「メンバーが自分の鍵を使ってよい」 for a service whose destination is known (the server sets rule and hosts). */
  setOwnKeys: (companyId: string, service: string, allowed: boolean) =>
    getData(`/api/companies/${enc(companyId)}/broker/services/${enc(service)}/own-keys`, brokerSchema, { method: 'PUT', body: { allowed } satisfies BrokerOwnKeysSwitch }),
  /** 「このサービスは、この鍵を使う」: which company key the service uses when several exist (null: none chosen). */
  setDefaultKey: (companyId: string, service: string, keyId: string | null) =>
    getData(`/api/companies/${enc(companyId)}/broker/services/${enc(service)}/default-key`, brokerSchema, { method: 'PUT', body: { keyId } satisfies BrokerDefaultKeyChoice }),
  /** A generic service (K9): register or change its destination and how the key travels. */
  saveRelayService: (companyId: string, service: string, definition: BrokerRelayServiceSave) =>
    getData(`/api/companies/${enc(companyId)}/broker/relay-services/${enc(service)}`, brokerSchema, { method: 'PUT', body: definition }),
  removeRelayService: (companyId: string, service: string) =>
    getData(`/api/companies/${enc(companyId)}/broker/relay-services/${enc(service)}`, brokerSchema, { method: 'DELETE' }),
  setMemberKeysAllowed: (companyId: string, memberKeysAllowed: boolean) =>
    getData(`/api/companies/${enc(companyId)}/broker/settings`, brokerSchema, { method: 'PUT', body: { memberKeysAllowed } }),
  /** Emergency stop: every key disabled and every live token revoked, now. */
  stopAll: (companyId: string) => getData(`/api/companies/${enc(companyId)}/broker/stop-all`, brokerSchema, { method: 'POST' }),
  /** The relay's exception: hosts allowed to resolve to an internal address. */
  setInternalHosts: (companyId: string, internalHosts: string[]) =>
    getData(`/api/companies/${enc(companyId)}/broker/settings`, brokerSchema, { method: 'PUT', body: { internalHosts } }),
}

// ---------------------------------------------------------------------------
// Connections to outside systems (「つなぎ先」, connector plugins, milestone 3):
// shapes from shared/types/plugins.ts. Owner/admin only. No answer holds a
// key value: an install names its key by id (the page shows the key's last 4
// characters from GET /broker).
// ---------------------------------------------------------------------------

export type {
  ImportObjectReport,
  ImportReport,
  PluginDetail,
  PluginFieldPolicyView,
  PluginInstallView,
  PluginListItem,
  PluginMappingCheck,
  PluginOperationView,
  PluginPackageView,
  PluginProblem,
  PluginReadScopeView,
  PluginRolesView,
  PluginStepSkillsView,
} from '../../../shared/types/plugins'
export type { FieldPolicy } from '../../../shared/core/plugins'

import type { PluginReadScopeView } from '../../../shared/types/plugins'

const pluginPath = (companyId: string, pluginId: string) => `/api/companies/${enc(companyId)}/plugins/${enc(pluginId)}`

export const pluginsApi = {
  list: (companyId: string) => getData(`/api/companies/${enc(companyId)}/plugins`, pluginListSchema),
  get: (companyId: string, pluginId: string) => getData(pluginPath(companyId, pluginId), pluginSchema),
  /** Install (first time) or choose another version / key. */
  install: (companyId: string, pluginId: string, version: string, keyId: string | null) =>
    getData(pluginPath(companyId, pluginId), pluginSchema, { method: 'PUT', body: { version, keyId } }),
  setEnabled: (companyId: string, pluginId: string, enabled: boolean) =>
    getData(`${pluginPath(companyId, pluginId)}/enabled`, pluginSchema, { method: 'PUT', body: { enabled } }),
  /** Who may read the outside system through the relay (departments / members; empty = nobody). */
  setReadScope: (companyId: string, pluginId: string, scope: PluginReadScopeView) =>
    getData(`${pluginPath(companyId, pluginId)}/read-scope`, pluginSchema, { method: 'PUT', body: scope }),
  /** A new mapping version; `acknowledgeAuto` = the fields the admin confirmed trigger no HubSpot workflow. */
  saveMapping: (companyId: string, pluginId: string, text: string, acknowledgeAuto: string[] = []) =>
    getData(`${pluginPath(companyId, pluginId)}/mapping`, pluginSchema, { method: 'PUT', body: { text, acknowledgeAuto } }),
  restoreMapping: (companyId: string, pluginId: string, version: number, acknowledgeAuto: string[] = []) =>
    getData(`${pluginPath(companyId, pluginId)}/mapping/restore`, pluginSchema, { method: 'POST', body: { version, acknowledgeAuto } }),
  /** 「HubSpot に聞いて確かめる」: the text being edited (or the mapping in force) against the outside property list. */
  checkMapping: (companyId: string, pluginId: string, text?: string) =>
    getData(`${pluginPath(companyId, pluginId)}/mapping/check`, pluginMappingCheckSchema, { method: 'POST', body: text === undefined ? {} : { text } }),
  import: (companyId: string, pluginId: string) =>
    getData(`${pluginPath(companyId, pluginId)}/import`, importReportSchema, { method: 'POST', body: {} }),
  /** The outside account changed on purpose: start a new connection. */
  renewConnection: (companyId: string, pluginId: string) =>
    getData(`${pluginPath(companyId, pluginId)}/connection/renew`, connectionRenewSchema, { method: 'POST', body: {} }),
  /** A business plugin's roles (役割, plan C3): declared roles, the company's holders, まとまり overrides, history. */
  roles: (companyId: string, pluginId: string) => getData(`${pluginPath(companyId, pluginId)}/roles`, pluginRolesSchema),
  /** The company's holders of one role (empty = nobody; an approval then goes to an owner / admin). */
  assignRole: (companyId: string, pluginId: string, role: string, userIds: string[]) =>
    getData(`${pluginPath(companyId, pluginId)}/roles/${enc(role)}`, pluginRolesSchema, { method: 'PUT', body: { userIds } }),
  /** A business plugin's steps a company may run with one of its Skills (plan C5): each step and the company's Skill. */
  stepSkills: (companyId: string, pluginId: string) => getData(`${pluginPath(companyId, pluginId)}/step-skills`, pluginStepSkillsSchema),
  /** The company's Skill for an overridable step (null = the business's own procedure). */
  setStepSkill: (companyId: string, pluginId: string, step: string, skill: string | null) =>
    getData(`${pluginPath(companyId, pluginId)}/step-skills/${enc(step)}`, pluginStepSkillsSchema, { method: 'PUT', body: { skill } }),
}

// The Google connection (「つなぎ先」→「Google」, milestone 4 G3): shapes from shared/types/google.ts.
// The client secret is sent once in `saveClient` and never answered (last 4 only).
export type {
  GoogleAdminView,
  GoogleChange,
  GoogleChangeAction,
  GoogleClientSave,
  GoogleFeature,
  GoogleGrantStatus,
  GoogleGrantSummary,
  GooglePickerSave,
  GooglePickerView,
} from '../../../shared/types/google'

import type { GoogleClientSave, GoogleFeature, GooglePickerSave } from '../../../shared/types/google'

export const googleApi = {
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/google`, googleSchema),
  /** `clientSecret` only when the admin typed one (left out = keep the stored one). */
  saveClient: (companyId: string, save: GoogleClientSave) =>
    getData(`/api/companies/${enc(companyId)}/google/client`, googleSchema, { method: 'PUT', body: save }),
  setEnabled: (companyId: string, enabled: boolean) =>
    getData(`/api/companies/${enc(companyId)}/google/enabled`, googleSchema, { method: 'PUT', body: { enabled } }),
  /** A feature on / off for the whole company (never asked of members while off). */
  setFeature: (companyId: string, feature: GoogleFeature, on: boolean) =>
    getData(`/api/companies/${enc(companyId)}/google/features`, googleSchema, { method: 'PUT', body: { feature, on } }),
  /** Google Picker (Drive, google-drive.md): the API key (left out = keep) and the project number; `appId: null` removes it. */
  savePicker: (companyId: string, save: GooglePickerSave) =>
    getData(`/api/companies/${enc(companyId)}/google/picker`, googleSchema, { method: 'PUT', body: save }),
  /** 「止める」: stops a member's permission (revoked at Google too). */
  stopGrant: (companyId: string, userId: string) =>
    getData(`/api/companies/${enc(companyId)}/google/grants/${enc(userId)}`, googleSchema, { method: 'DELETE' }),
}

// The Slack connection (「つなぎ先」→「Slack」, stage 3 A3, slack-connector.md): shapes from shared/types/slack.ts.
// The secrets and the bot token are sent once in `saveApp` and never answered (last 4 / "registered" only).
export type {
  MySlack,
  SlackAdminView,
  SlackAppSave,
  SlackFeature,
  SlackGrantStatus,
  SlackGrantSummary,
} from '../../../shared/types/slack'

import type { SlackAppSave } from '../../../shared/types/slack'

export const slackApi = {
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/slack`, slackSchema),
  /** Secrets and the bot token only when the admin typed them (left out = keep the stored ones). */
  saveApp: (companyId: string, save: SlackAppSave) =>
    getData(`/api/companies/${enc(companyId)}/slack/app`, slackSchema, { method: 'PUT', body: save }),
  setEnabled: (companyId: string, enabled: boolean) =>
    getData(`/api/companies/${enc(companyId)}/slack/enabled`, slackSchema, { method: 'PUT', body: { enabled } }),
  /** 「止める」: stops a member's permission (revoked at Slack too). */
  stopGrant: (companyId: string, userId: string) =>
    getData(`/api/companies/${enc(companyId)}/slack/grants/${enc(userId)}`, slackSchema, { method: 'DELETE' }),
}

// 「つないでいるサービス」 (stage 3, connector-roles.md): the core connectors built into ACB (Google),
// the roles they serve and the admin's choice when two could serve one. Shapes from shared/types/core-connectors.ts.
export type {
  CoreConnectorStatus,
  CoreConnectorView,
  CoreConnectorsView,
  CoreRoleView,
} from '../../../shared/types/core-connectors'


export const coreConnectorsApi = {
  get: (companyId: string) => getData(`/api/companies/${enc(companyId)}/connectors`, coreConnectorsSchema),
  /** The connector's own on / off (Google: the same switch as 「Google」's 「オンにする / オフにする」). */
  setEnabled: (companyId: string, connectorId: string, enabled: boolean) =>
    getData(`/api/companies/${enc(companyId)}/connectors/${enc(connectorId)}/enabled`, coreConnectorsSchema, { method: 'PUT', body: { enabled } }),
  /** Which connector serves a role when two could (null clears the choice). */
  chooseRole: (companyId: string, role: string, connectorId: string | null) =>
    getData(`/api/companies/${enc(companyId)}/connector-roles/${enc(role)}`, coreConnectorsSchema, { method: 'PUT', body: { connectorId } }),
}

// The minutes folder (「つなぎ先」→「Google」, milestone 4 G7, minutes.md): the department folder
// meeting records go to (never a private folder), and which meetings are read. Shapes from
// shared/types/minutes.ts and shared/core/minutes.ts.
export type { MinutesFolderSetting } from '../../../shared/types/minutes'
export type { MeetingIntake } from '../../../shared/core/minutes'

import type { MeetingIntake } from '../../../shared/core/minutes'

export const minutesApi = {
  folder: (companyId: string) => getData(`/api/companies/${enc(companyId)}/google/minutes-folder`, minutesFolderSchema),
  /** `null`: no folder (nothing is read until one is chosen). */
  setFolder: (companyId: string, folder: string | null) =>
    getData(`/api/companies/${enc(companyId)}/google/minutes-folder`, minutesFolderSchema, { method: 'PUT', body: { folder } }),
  /** Which meetings are read: `external` (only with someone from outside; the default) or `all`. */
  setMeetings: (companyId: string, meetings: MeetingIntake) =>
    getData(`/api/companies/${enc(companyId)}/google/minutes-folder`, minutesFolderSchema, { method: 'PUT', body: { meetings } }),
  /** Days 「どのまとまりの会議ですか？」 stays in a member's あなたの番 after a meeting is read (1–30). */
  setBundleQuestionDays: (companyId: string, bundleQuestionDays: number) =>
    getData(`/api/companies/${enc(companyId)}/google/minutes-folder`, minutesFolderSchema, { method: 'PUT', body: { bundleQuestionDays } }),
}
