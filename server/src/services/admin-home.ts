/**
 * The admin console's home (管理画面の見直し 2-1 / 2-3, server.md "Admin home"): 「最初にやること」 —
 * six steps, each judged from what the company already has — and 「対応が必要なこと」, the things
 * that were spread over several screens (blocked syncs, old apps, members not syncing, rules
 * without a folder, the same meeting's outputs made twice, business plugins that stopped).
 *
 * - Owner / admin: the steps and the whole company's attention.
 * - A department manager (部署の管理役) who is not an owner / admin: no steps; the attention of the
 *   members who belong to (所属) the departments they manage only — sync and app state, and a
 *   blocked sync's kind without its paths (a path may name a private folder the manager does not
 *   read). Nothing about other departments, rules or plugins.
 * - Anyone else: 403.
 *
 * The one mark set by hand is 「会社の休みを確かめた」 (`holidays-checked`): adding the summer
 * holidays, or saying there is nothing to add, cannot be read from the settings themselves.
 */
import type { SecurityAlertView } from '../../shared/types/security-alerts'
import type { AccountDirectory } from '../ports/accounts'
import type { ClientActivityRepository } from '../ports/client-activity'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import type { Clock } from '../ports/clock'
import { computeAttention, type OverviewMember } from '../lib/overview'
import { hasFullAccess, requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const HOME_FORBIDDEN = 'Only owners, admins and department managers can view the home'
export const HOLIDAYS_CHECKED = 'holidays-checked'

/** `minutes-folder` is no longer answered (meetings need no folder since 2026-11-04); kept for older admin consoles' types. */
export type SetupStepId = 'departments' | 'members' | 'department-members' | 'google' | 'minutes-folder' | 'holidays'

export interface SetupStep {
  id: SetupStepId
  done: boolean
  /** The company registration is the operator's work (owner decision 2026-11-02): the home shows 「運用担当者に頼む」. */
  byOperator?: true
  /** department-members: departments nobody belongs to yet / without a 部署の管理役 (recommended only). */
  departmentsWithoutMembers?: number
  departmentsWithoutManager?: number
}

/** The overview's attention lists (permission-views.ts `overview`), as the home passes them on. */
export interface OverviewAttentionView {
  recentRejections: Array<{ id: string; userId: string; name: string | null; marker: string; paths: string[]; createdAt: string }>
  orphanedScopes: Array<{ scopeId: string; path: string; kind: string; ruleCount: number; summary: string; since: string }>
  outdatedClients: OverviewMember[]
  unknownClients: OverviewMember[]
  notSyncedRecently: OverviewMember[]
}

export interface AdminHome {
  view: 'admin' | 'manager'
  /** Owner / admin: null once every step is done is not used — the steps always come, `done` says. Manager: null. */
  setup: { steps: SetupStep[]; done: number; total: number } | null
  /** Manager: the departments they manage (the home names them). Owner / admin: empty. */
  departments: Array<{ id: string; name: string }>
  attention: OverviewAttentionView & {
    /** Groups of one meeting's outputs made twice (owner / admin; 0 while the records feature is off). */
    meetingDuplicates: number
    /** Business plugins and connectors that are on but cannot run now (owner / admin). */
    stoppedPlugins: Array<{ id: string; label: string; problem: string }>
    /** 「気になる動き」 of the last 7 days (owner / admin; a manager []; security-alerts.md). */
    securityAlerts: SecurityAlertView[]
  }
  counts: { members: number; departments: number }
}

export interface AdminHomeDeps {
  memberships: MembershipRepository
  clientActivity: ClientActivityRepository
  companyData: CompanyDataSource
  accounts: AccountDirectory
  clock: Clock
  /** The overview's attention (owner / admin). */
  overview: (member: Member) => Promise<{ attention: OverviewAttentionView }>
  /** Google set up, on and usable (services/google-connector.ts `state`). */
  googleUsable: (companyId: string) => Promise<boolean>
  /** Number of duplicate groups, or null when the list cannot be read (records off). */
  meetingDuplicates: (member: Member) => number | null
  /** 「気になる動き」 for the home (services/security-alerts.ts `forHome`). */
  securityAlerts?: (member: Member) => SecurityAlertView[]
  /** Installed plugins that are on and have a problem. */
  stoppedPlugins: (member: Member) => Promise<Array<{ id: string; label: string; problem: string }>>
  /** The company has the shared company folder (services/company-folder.ts `has`). */
  hasCompanyFolder: (companyId: string) => boolean
}

export function createAdminHomeService(deps: AdminHomeDeps) {
  const { memberships, clientActivity, companyData, accounts, clock } = deps

  async function setupSteps(member: Member): Promise<SetupStep[]> {
    const handle = companyData.forCompany(member.companyId)
    const departments = handle.departments.list()
    const withoutMembers = departments.filter(d => handle.tasks.departmentMemberIds(d.id).length === 0).length
    const withoutManager = departments.filter(d => handle.scopes.departmentManagerIds(d.id).length === 0).length
    return [
      { id: 'departments', done: departments.length > 0 },
      // Someone invited has joined: the company is more than its first account.
      { id: 'members', done: memberships.listByCompany(member.companyId).length >= 2 },
      // Every department has someone; a 部署の管理役 is recommended, not required.
      { id: 'department-members', done: departments.length > 0 && withoutMembers === 0, departmentsWithoutMembers: withoutMembers, departmentsWithoutManager: withoutManager },
      { id: 'google', done: await deps.googleUsable(member.companyId), byOperator: true },
      // No 「議事録の置き場所」 step since meetings are seen by their attendees only (minutes.md, 2026-11-04).
      { id: 'holidays', done: handle.tasks.setupMark(HOLIDAYS_CHECKED) !== null },
    ]
  }

  /** Sync and app state of the members of the manager's departments; blocked syncs without their paths. */
  function managerAttention(member: Member, departmentIds: string[]): OverviewAttentionView {
    const handle = companyData.forCompany(member.companyId)
    const userIds = new Set(departmentIds.flatMap(id => handle.tasks.departmentMemberIds(id)))
    const rows = memberships.listByCompany(member.companyId).filter(m => userIds.has(m.user_id))
    const activity = clientActivity.forCompany(member.companyId)
    const users = accounts.byIds(rows.map(m => m.user_id))
    const members: OverviewMember[] = rows.map(m => {
      const a = activity.get(m.user_id)
      const u = users.get(m.user_id)
      return {
        userId: m.user_id, name: u?.name ?? null, email: u?.email ?? null, role: m.role,
        clientVersion: a?.client_version ?? null, lastSeenAt: a?.last_seen_at ?? null,
        lastFetchAt: a?.last_fetch_at ?? null, lastPushAt: a?.last_push_at ?? null,
      }
    })
    return { ...computeAttention(members, new Date(clock.nowMs())), recentRejections: [], orphanedScopes: [] }
  }

  /** Nobody syncs in a company without the shared folder: 「しばらく同期していません」 would name everyone. */
  function syncAttention<T extends { notSyncedRecently: OverviewMember[] }>(companyId: string, attention: T): T {
    return deps.hasCompanyFolder(companyId) ? attention : { ...attention, notSyncedRecently: [] }
  }

  async function view(member: Member): Promise<Outcome<AdminHome>> {
    const handle = companyData.forCompany(member.companyId)
    const counts = { members: memberships.listByCompany(member.companyId).length, departments: handle.departments.count() }
    if (hasFullAccess(member.role)) {
      const [steps, overview, stoppedPlugins] = await Promise.all([setupSteps(member), deps.overview(member), deps.stoppedPlugins(member)])
      return ok({
        view: 'admin',
        setup: { steps, done: steps.filter(s => s.done).length, total: steps.length },
        departments: [],
        attention: { ...syncAttention(member.companyId, overview.attention), meetingDuplicates: deps.meetingDuplicates(member) ?? 0, stoppedPlugins, securityAlerts: deps.securityAlerts?.(member) ?? [] },
        counts,
      })
    }
    const managed = new Set(handle.scopes.managedDepartmentIds(member.userId))
    if (managed.size === 0) return refuse('forbidden', HOME_FORBIDDEN)
    const departments = handle.departments.list().filter(d => managed.has(d.id)).map(d => ({ id: d.id, name: d.name }))
    return ok({
      view: 'manager',
      setup: null,
      departments,
      attention: { ...syncAttention(member.companyId, managerAttention(member, departments.map(d => d.id))), meetingDuplicates: 0, stoppedPlugins: [], securityAlerts: [] },
      counts,
    })
  }

  return {
    /** GET /home */
    view,

    /** PUT /home/holidays-checked { checked: true } — owner/admin: 「会社の休みを確かめた」 (the first time is kept). */
    async checkHolidays(member: Member, body: unknown): Promise<Outcome<AdminHome>> {
      const allowed = requireFullAccess(member, 'Only owners and admins can do this')
      if (!allowed.ok) return allowed
      if (typeof body !== 'object' || body === null || (body as { checked?: unknown }).checked !== true) {
        return refuse('bad-request', 'Body: { checked: true }')
      }
      companyData.forCompany(member.companyId).tasks.saveSetupMark(HOLIDAYS_CHECKED, member.userId, clock.now())
      return view(member)
    },
  }
}

export type AdminHomeService = ReturnType<typeof createAdminHomeService>
