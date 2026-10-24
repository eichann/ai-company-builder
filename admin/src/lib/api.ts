// Typed client for the API server.
//
// Requests use relative URLs: in production Caddy routes /api/* to the API
// server, and without a reverse proxy the admin's own /api/* proxy
// (src/proxy.ts) forwards them. Either way the session cookie is first-party.

import type {
  AgentEventPage,
  AgentEventQuery,
  AgentEventRetentionPreview,
  AgentEventSettings,
  AgentEventSettingsUpdate,
  AgentEventSummary,
  AgentEventViewerMode,
  AgentEventViewers,
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

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: unknown
  headers?: Record<string, string>
}

export async function apiClient<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
  })

  if (!res.ok) {
    const raw: unknown = await res.json().catch(() => null)
    const error = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
    const message = typeof error?.error === 'string' ? error.error : typeof error?.message === 'string' ? error.message : ''
    throw new ApiError(res.status, message || `Request failed (${res.status})`, error)
  }

  return res.json() as Promise<T>
}

/** `{ success, data }` envelope used by every company-scoped endpoint. */
type Envelope<T> = { success: boolean; data: T }

async function getData<T>(endpoint: string, options?: RequestOptions): Promise<T> {
  const res = await apiClient<Envelope<T>>(endpoint, options)
  return res.data
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
  getMe: () => getData<User>('/api/me'),
}

export const configApi = {
  get: () => getData<{ name: string; version: string; setupComplete: boolean }>('/api/config'),
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
  list: () => getData<Company[]>('/api/companies'),

  create: (name: string, slug?: string) =>
    getData<Company>('/api/companies', { method: 'POST', body: { name, slug } }),

  get: (id: string) => getData<Company>(`/api/companies/${enc(id)}`),

  getMembers: (id: string) => getData<Member[]>(`/api/companies/${enc(id)}/members`),

  /** owner / admin. Only the display name changes. */
  rename: (id: string, name: string) =>
    getData<Company>(`/api/companies/${enc(id)}`, { method: 'PATCH', body: { name } }),

  /** owner only; the last owner cannot be demoted. */
  setMemberRole: (companyId: string, userId: string, role: Role) =>
    getData<{ userId: string; companyId: string; role: Role }>(
      `/api/companies/${enc(companyId)}/members/${enc(userId)}/role`,
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
  get: (companyId: string) => getData<Capabilities>(`/api/companies/${enc(companyId)}/me/capabilities`),
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
  get: (companyId: string) => getData<Overview>(`/api/companies/${enc(companyId)}/overview`),
}

// ---------------------------------------------------------------------------
// Client activity (#102; owner / admin)
// ---------------------------------------------------------------------------

export interface ClientBuild {
  semver: string
  sha: string | null
  commitDate: string | null
  dev: boolean
}

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
  list: (companyId: string) => getData<ClientActivity[]>(`/api/companies/${enc(companyId)}/client-activity`),
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
    getData<{ scopes: PermissionScope[]; orphanedScopes?: OrphanedScope[] }>(permBase(companyId)),

  /**
   * Replace a place's whole rule set in one step (what the 権限 screen saves).
   * [] = 上の階層と同じ (not allowed for the company root).
   */
  replaceScope: (companyId: string, path: string, rules: RuleInput[], { force = false }: ForceOption = {}) =>
    getData<ScopeRulesResult>(`${permBase(companyId)}/scopes/by-path`, {
      method: 'PUT',
      body: force ? { path, rules, force } : { path, rules },
    }),

  /** Move the rules of a place (and of the places inside it) to another existing folder. */
  moveScope: (companyId: string, scopeId: string, toPath: string, { force = false }: ForceOption = {}) =>
    getData<{ moved: number; toPath: string; scopeId: string | null }>(`${permBase(companyId)}/scopes/${enc(scopeId)}/move`, {
      method: 'POST',
      body: force ? { toPath, force } : { toPath },
    }),

  /** Set (create or update) a subject's rule on a folder; the folder stops inheriting. */
  setRule: (companyId: string, path: string, subject: RuleSubject, canWrite: boolean) =>
    getData<ScopeRulesResult>(`${permBase(companyId)}/rules`, {
      method: 'POST',
      body: { path, ...subject, canWrite },
    }),

  updateRule: (companyId: string, ruleId: string, canWrite: boolean) =>
    getData<ScopeRulesResult>(`${permBase(companyId)}/rules/${enc(ruleId)}`, { method: 'PATCH', body: { canWrite } }),

  deleteRule: (companyId: string, ruleId: string) =>
    getData<ScopeRulesResult>(`${permBase(companyId)}/rules/${enc(ruleId)}`, { method: 'DELETE' }),

  /** Remove every rule of the scope so it inherits from its parent again. */
  resetScope: (companyId: string, scopeId: string, { force = false }: ForceOption = {}) =>
    getData<{ removed: number }>(`${permBase(companyId)}/scopes/${enc(scopeId)}/rules${force ? '?force=true' : ''}`, { method: 'DELETE' }),

  effective: (companyId: string, path: string) =>
    getData<EffectiveAccess>(`${permBase(companyId)}/effective?path=${enc(path)}`),

  folders: (companyId: string, path: string) =>
    getData<{ path: string; folders: RepoFolder[] }>(`${permBase(companyId)}/folders?path=${enc(path)}`),
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
  list: (companyId: string) => getData<PrivateFolderSummary[]>(privBase(companyId)),

  get: (companyId: string, scopeId: string) => getData<PrivateFolderDetail>(`${privBase(companyId)}/${enc(scopeId)}`),

  /** 409 FOLDER_NAME_UNAVAILABLE / OUTDATED_CLIENTS, 400 PARENT_NOT_FOUND / ALREADY_PRIVATE / INVALID_MEMBERS. */
  create: (companyId: string, input: CreatePrivateFolderInput, { force = false }: ForceOption = {}) =>
    getData<PrivateFolderDetail>(privBase(companyId), { method: 'POST', body: force ? { ...input, force } : input }),

  updateMembers: (companyId: string, scopeId: string, viewers: string[], editors?: string[]) =>
    getData<PrivateFolderDetail>(`${privBase(companyId)}/${enc(scopeId)}/members`, {
      method: 'PUT',
      body: editors ? { viewers, editors } : { viewers },
    }),

  /** 公開に戻す (owner/admin): the contents go to everyone. */
  makePublic: (companyId: string, scopeId: string) =>
    getData<{ path: string; commit: string }>(`${privBase(companyId)}/${enc(scopeId)}/make-public`, { method: 'POST', body: {} }),

  /**
   * 削除 (owner/admin): the folder disappears from its viewers' PCs at their
   * next sync; the server keeps an archive of its repository for the operator.
   * `confirm` is the folder's name as typed (400 CONFIRMATION_REQUIRED otherwise).
   */
  remove: (companyId: string, scopeId: string, confirm: string) =>
    getData<DeletePrivateFolderResult>(`${privBase(companyId)}/${enc(scopeId)}?confirm=${enc(confirm)}`, { method: 'DELETE' }),
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
    return getData<PushRejectionPage>(`/api/companies/${enc(companyId)}/push-rejections${qs ? `?${qs}` : ''}`)
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
    return getData<AgentEventPage>(`/api/companies/${enc(companyId)}/agent-events${qs ? `?${qs}` : ''}`)
  },
  /** Counts per member and day; `tzOffsetMinutes` = minutes east of UTC (540 for Japan). */
  summary: (companyId: string, q: { from?: string; to?: string; tzOffsetMinutes?: number } = {}) => {
    const params = new URLSearchParams()
    if (q.from) params.set('from', q.from)
    if (q.to) params.set('to', q.to)
    if (q.tzOffsetMinutes !== undefined) params.set('tzOffsetMinutes', String(q.tzOffsetMinutes))
    const qs = params.toString()
    return getData<AgentEventSummary>(`/api/companies/${enc(companyId)}/agent-events/summary${qs ? `?${qs}` : ''}`)
  },
  settings: (companyId: string) =>
    getData<AgentEventSettings>(`/api/companies/${enc(companyId)}/agent-events/settings`),
  updateSettings: (companyId: string, update: AgentEventSettingsUpdate) =>
    getData<AgentEventSettings>(`/api/companies/${enc(companyId)}/agent-events/settings`, { method: 'PUT', body: update }),
  /** How many events a retention of `days` would delete (confirm before shortening). */
  retentionPreview: (companyId: string, days: number) =>
    getData<AgentEventRetentionPreview>(`/api/companies/${enc(companyId)}/agent-events/settings/retention-preview?days=${days}`),
  /** Who would see the log under `mode`, with their scope (the settings card's live list). */
  viewers: (companyId: string, mode: AgentEventViewerMode) =>
    getData<AgentEventViewers>(`/api/companies/${enc(companyId)}/agent-events/viewers?mode=${enc(mode)}`),
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
  list: (companyId: string) => getData<Invitation[]>(`/api/companies/${enc(companyId)}/invitations`),

  create: (companyId: string, role: 'admin' | 'member' = 'member', expiresInDays: number = 7) =>
    getData<CreatedInvitation>(`/api/companies/${enc(companyId)}/invitations`, {
      method: 'POST',
      body: { role, expiresInDays },
    }),

  delete: (companyId: string, invitationId: string) =>
    apiClient<{ success: boolean }>(`/api/companies/${enc(companyId)}/invitations/${enc(invitationId)}`, {
      method: 'DELETE',
    }),

  validate: (token: string) =>
    getData<{ companyName: string; role: Role; expiresAt: string }>(`/api/invitations/${enc(token)}`),

  accept: (token: string) =>
    getData<{ companyId: string; companyName: string; role: Role }>(`/api/invitations/${enc(token)}/accept`, {
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
  list: (companyId: string) => getData<Department[]>(`${deptBase(companyId)}?flat=true`),

  create: (companyId: string, data: CreateDepartmentInput) =>
    getData<Department>(deptBase(companyId), { method: 'POST', body: data }),

  update: (companyId: string, departmentId: string, data: UpdateDepartmentInput) =>
    getData<Department>(`${deptBase(companyId)}/${enc(departmentId)}`, { method: 'PUT', body: data }),

  delete: (companyId: string, departmentId: string) =>
    apiClient<{ success: boolean; deletedFiles?: number; deletedFolders?: number }>(
      `${deptBase(companyId)}/${enc(departmentId)}`,
      { method: 'DELETE' }
    ),

  reorder: (companyId: string, items: Array<{ id: string; sortOrder: number }>) =>
    apiClient<{ success: boolean }>(`${deptBase(companyId)}/reorder`, { method: 'POST', body: { items } }),

  stats: (companyId: string, departmentId: string) =>
    getData<{ files: number; folders: number; exists: boolean }>(
      `${deptBase(companyId)}/${enc(departmentId)}/stats`
    ),

  /** Register top-level folders that exist in the repository but not as departments. */
  sync: (companyId: string) =>
    apiClient<{ success: boolean; added: number; removed: number }>(`${deptBase(companyId)}/sync`, {
      method: 'POST',
    }),

  getManagers: (companyId: string, departmentId: string) =>
    getData<{ managers: DepartmentManager[] }>(`${deptBase(companyId)}/${enc(departmentId)}/managers`),

  setManagers: (companyId: string, departmentId: string, userIds: string[]) =>
    getData<{ managers: DepartmentManager[] }>(`${deptBase(companyId)}/${enc(departmentId)}/managers`, {
      method: 'PUT',
      body: { userIds },
    }),
}
