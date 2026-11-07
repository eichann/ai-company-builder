/**
 * The company's task settings and department membership (所属する部署),
 * stage 2 S6 (.claude/rules/tasks.md). Shapes and validation:
 * shared/core/task-settings.ts; wire: shared/types/task-settings.ts.
 *
 * - Settings: every member reads them (the app needs them to show the task
 *   list and the reply 目安); only owners and admins change them.
 * - Membership: every member sees who belongs to a department; owners, admins
 *   and that department's managers change it. Belonging is also a rule
 *   subject (shared/core/permissions.ts 'department'): a department created
 *   since 2026-11-06 lets only the people who belong to it write, so changing
 *   who belongs changes who writes there. The change therefore runs under the
 *   permission editor's outdated-app guard (409 OUTDATED_CLIENTS, `force`
 *   for owners/admins), like a rule change. In departments without such a
 *   rule (older ones) belonging changes nobody's folder access.
 */
import { defaultTaskSettings, parseTaskSettings, type TaskSettings } from '../../shared/core/task-settings'
import type { DepartmentMembersView, TaskSettingsView } from '../../shared/types/task-settings'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import { hasFullAccess, requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const TASK_SETTINGS_FORBIDDEN = 'Only owners and admins can change the task settings'
export const DEPARTMENT_MEMBERS_FORBIDDEN = 'Only owners, admins and this department\'s managers can change who belongs to it'
export const MAX_DEPARTMENT_MEMBERS = 1000
/** The permission editor's answer to a manager's `force` (routes/permission-rules.ts parseForce). */
export const FORCE_NOT_ALLOWED_ERROR = 'Only owners and admins can save despite outdated apps'

export interface TaskSettingsDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  accounts: AccountDirectory
  clock: Clock
  /**
   * The permission editor's outdated-app guard (services/permission-editor.ts
   * guardWrite): runs `mutate` in a transaction and refuses with 409
   * OUTDATED_CLIENTS when someone losing write access under `roots` is on an
   * app that cannot recover from [WRITE_DENIED].
   */
  guardWrite<T>(actor: Member, force: boolean, roots: string[], mutate: () => T): Outcome<T>
}

export function createTaskSettingsService(deps: TaskSettingsDeps) {
  const { companyData, memberships, accounts, clock, guardWrite } = deps
  const handle = (companyId: string) => companyData.forCompany(companyId)

  /**
   * The settings in force: the stored document re-validated (one that no
   * longer validates falls back to the defaults), departments that are gone
   * left out of the task-list list.
   */
  function settingsOf(companyId: string): TaskSettings {
    const stored = handle(companyId).tasks.get()
    if (!stored) return defaultTaskSettings()
    let parsed: unknown
    try { parsed = JSON.parse(stored.settings) } catch { parsed = null }
    const result = parseTaskSettings(parsed)
    if ('error' in result) {
      console.warn(`[task-settings] stored settings of company ${companyId} are invalid; using the defaults`)
      return defaultTaskSettings()
    }
    const settings = result.value
    if (settings.taskListDepartmentIds) {
      const departments = handle(companyId).departments
      settings.taskListDepartmentIds = settings.taskListDepartmentIds.filter(id => departments.exists(id))
    }
    return settings
  }

  function view(member: Member): TaskSettingsView {
    const stored = handle(member.companyId).tasks.get()
    const by = stored?.updatedBy ?? null
    return {
      settings: settingsOf(member.companyId),
      canEdit: hasFullAccess(member.role),
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: by,
      updatedByName: by ? accounts.byIds([by]).get(by)?.name ?? null : null,
    }
  }

  /** Owners, admins, and managers of this department. */
  function mayEditMembers(member: Member, departmentId: string): boolean {
    return hasFullAccess(member.role) || handle(member.companyId).scopes.managedDepartmentIds(member.userId).includes(departmentId)
  }

  function membersView(member: Member, departmentId: string): DepartmentMembersView {
    const ids = handle(member.companyId).tasks.departmentMemberIds(departmentId)
    const current = new Set(memberships.listByCompany(member.companyId).map(m => m.user_id))
    const people = ids.filter(id => current.has(id))
    const users = accounts.byIds(people)
    return {
      members: people.map(id => ({ userId: id, name: users.get(id)?.name ?? null, email: users.get(id)?.email ?? null })),
      canEdit: mayEditMembers(member, departmentId),
    }
  }

  return {
    /** The settings in force for a company (for the task list and the AI's turn). */
    settingsOf,

    /** GET …/task-settings (any member). */
    get(member: Member): TaskSettingsView {
      return view(member)
    },

    /** PUT …/task-settings (owner/admin): the whole document. */
    update(member: Member, body: unknown): Outcome<TaskSettingsView> {
      const allowed = requireFullAccess(member, TASK_SETTINGS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const parsed = parseTaskSettings(body)
      if ('error' in parsed) return refuse('bad-request', parsed.error)
      const settings = parsed.value
      if (settings.taskListDepartmentIds) {
        const departments = handle(member.companyId).departments
        // Another company's department is "not a department" here (the handle cannot see it).
        if (settings.taskListDepartmentIds.some(id => !departments.exists(id))) {
          return refuse('bad-request', 'taskListDepartmentIds names a department that does not exist')
        }
      }
      handle(member.companyId).tasks.save({ settings: JSON.stringify(settings), updatedAt: clock.now(), updatedBy: member.userId })
      return ok(view(member))
    },

    /**
     * The company's 受信を読む 使ってよいか alone (the admin's Google `inbox` switch writes it:
     * google-connector.md "One consent"); the role check is the caller's.
     */
    setReadIncomingAllowed(companyId: string, allowed: boolean, by: string): void {
      const settings = settingsOf(companyId)
      settings.readIncoming = { ...settings.readIncoming, allowed }
      handle(companyId).tasks.save({ settings: JSON.stringify(settings), updatedAt: clock.now(), updatedBy: by })
    },

    /** GET …/departments/:id/members (any member). */
    departmentMembers(member: Member, departmentId: string): Outcome<DepartmentMembersView> {
      if (!handle(member.companyId).departments.exists(departmentId)) return refuse('not-found', 'Department not found')
      return ok(membersView(member, departmentId))
    },

    /**
     * PUT …/departments/:id/members `{ userIds, force? }` (owner/admin, or a
     * manager of this department): replaces who belongs. Every one must be a
     * member. Who belongs may decide who writes (department rules), so the
     * change runs under the outdated-app guard over the whole company (a
     * department rule may sit on any folder); `force: true` is for
     * owners/admins only (403 FORCE_NOT_ALLOWED otherwise).
     * Check order: who → department → body → rules.
     */
    setDepartmentMembers(member: Member, departmentId: string, body: unknown): Outcome<DepartmentMembersView> {
      if (!mayEditMembers(member, departmentId)) return refuse('forbidden', DEPARTMENT_MEMBERS_FORBIDDEN)
      if (!handle(member.companyId).departments.exists(departmentId)) return refuse('not-found', 'Department not found')
      const userIds = (body as { userIds?: unknown } | null)?.userIds
      if (!Array.isArray(userIds) || !userIds.every(id => typeof id === 'string' && id.length > 0)) {
        return refuse('bad-request', 'userIds must be an array of user IDs')
      }
      const unique = [...new Set(userIds as string[])]
      if (unique.length > MAX_DEPARTMENT_MEMBERS) return refuse('bad-request', `A department can have at most ${MAX_DEPARTMENT_MEMBERS} members`)
      const current = new Set(memberships.listByCompany(member.companyId).map(m => m.user_id))
      if (unique.some(id => !current.has(id))) return refuse('bad-request', 'Every user must be a member of this company')
      // Only owners/admins change who reads a read-restricted place (owner decision 2026-11-07,
      // server.md "Groups"): when a rule there lets this department's people read, a manager may
      // take people off the department but not add them (adding would widen the place's readers).
      if (!hasFullAccess(member.role)) {
        const before = new Set(handle(member.companyId).tasks.departmentMemberIds(departmentId))
        const grantsRestrictedRead = handle(member.companyId).scopes.listWithRules().some(s => s.readRestricted === true
          && s.rules.some(r => r.subjectType === 'department' && r.subjectId === departmentId && r.canRead))
        if (grantsRestrictedRead && unique.some(id => !before.has(id))) {
          return refuse('forbidden', 'この部署の人は見られる人を決めた場所を見られるため、人を足せるのはオーナーと管理者だけです。', { code: 'READERS_OWNER_ONLY' })
        }
      }
      const force = (body as { force?: unknown }).force === true
      if (force && !hasFullAccess(member.role)) return refuse('forbidden', FORCE_NOT_ALLOWED_ERROR, { code: 'FORCE_NOT_ALLOWED' })
      const done = guardWrite(member, force, [''], () => {
        const tasks = handle(member.companyId).tasks
        const before = tasks.departmentMemberIds(departmentId)
        const at = clock.now()
        tasks.replaceDepartmentMembers(departmentId, unique, member.userId, at)
        // Who belongs decides who reads / writes where a rule names the department (server.md
        // "Groups"): recorded with the rule changes, in the same transaction.
        const after = tasks.departmentMemberIds(departmentId)
        if (before.length !== after.length || before.some(id => !after.includes(id))) {
          handle(member.companyId).permissionHistory.append({ action: 'department-members', detail: { departmentId, before, after }, at, byUser: member.userId })
        }
      })
      if (!done.ok) return done
      return ok(membersView(member, departmentId))
    },
  }
}

export type TaskSettingsService = ReturnType<typeof createTaskSettingsService>
