/**
 * Companies and their members: creating a company (repository, rows, default
 * departments, permission scopes, seeded folders), renaming it, and who
 * belongs to it with which role.
 *
 * Role rules (.claude/rules/server.md "Accounts and roles"): only owners grant owner/admin;
 * the last owner can never be demoted; removing a member — or promoting them
 * to owner/admin — deletes every rule naming them in the company.
 */
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { ClientActivityRepository } from '../ports/client-activity'
import type { CompanyRepository, CompanyRow } from '../ports/companies'
import type { DepartmentRepository } from '../ports/departments'
import type { MembershipRepository } from '../ports/memberships'
import type { RepoStore } from '../ports/repo-store'
import type { ScopeRepository } from '../ports/scopes'
import type { Transactions } from '../ports/transactions'
import { parseClientVersion, supportsAgentEvents } from '../lib/client-version'
import { isOwner, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

// Default departments for new companies
// Folder names are intentionally the same as the Japanese department names —
// the department folder pattern allows Japanese (shared/core/names.ts)
export const DEFAULT_DEPARTMENTS = [
  { name: '営業部', nameEn: 'Sales', folder: '営業部', icon: 'Storefront', color: '#3b82f6', description: '顧客対応、提案書作成、売上管理' },
  { name: '経理部', nameEn: 'Accounting', folder: '経理部', icon: 'ChartPie', color: '#10b981', description: '経費処理、月次決算、予算管理' },
  { name: '人事部', nameEn: 'HR', folder: '人事部', icon: 'Users', color: '#ec4899', description: '採用、労務管理、研修企画' },
  { name: 'コンテンツ', nameEn: 'Contents', folder: 'コンテンツ', icon: 'Article', color: '#8b5cf6', description: 'ブログ、SNS、マーケティング資料' },
  { name: '開発部', nameEn: 'Development', folder: '開発部', icon: 'Code', color: '#6366f1', description: 'プロダクト開発、技術調査' },
  { name: '総務', nameEn: 'General Affairs', folder: '総務', icon: 'Buildings', color: '#f59e0b', description: '社内調整、備品管理、総合窓口' },
]

export const MAX_COMPANY_NAME_LENGTH = 100

export type MemberRole = 'owner' | 'admin' | 'member'

export interface MemberView {
  id: string
  userId: string
  companyId: string
  role: string
  createdAt: string
  email: string | null
  name: string | null
}

export interface MemberActivityView {
  userId: string
  role: string
  email: string | null
  name: string | null
  clientVersion: string | null
  build: { semver: string; sha: string | null; commitDate: string | null; dev: boolean } | null
  clientPlatform: string | null
  lastSeenAt: string | null
  lastFetchAt: string | null
  lastPushAt: string | null
  /** Does this build send the AI action log (lib/client-version.ts)? Unknown = false. */
  supportsAgentEvents: boolean
}

export interface CompanyServiceDeps {
  companies: CompanyRepository
  memberships: MembershipRepository
  departments: DepartmentRepository
  scopes: ScopeRepository
  clientActivity: ClientActivityRepository
  accounts: AccountDirectory
  repoStore: RepoStore
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
}

// Slug from a name: lowercase ASCII words joined by '-'
function createSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function createCompanyService(deps: CompanyServiceDeps) {
  const { companies, memberships, departments, scopes, clientActivity, accounts, repoStore, transactions, clock, ids } = deps

  // A unique slug. Japanese-only names produce an empty base slug, so fall
  // back to the company id; collisions get a numeric suffix instead of
  // rejecting creation (the client has no slug input to fix it). An
  // explicitly requested slug (admin panel) is sanitized and honored.
  function buildUniqueSlug(name: string, requestedSlug: unknown, companyId: string): string {
    const base =
      (typeof requestedSlug === 'string' && createSlug(requestedSlug)) ||
      createSlug(name) ||
      `company-${companyId.slice(0, 8)}`

    let slug = base
    for (let n = 2; ; n++) {
      if (!companies.isSlugTaken(slug)) return slug
      slug = `${base}-${n}`
    }
  }

  function initializeDefaultDepartments(companyId: string, userId: string): void {
    const timestamp = clock.now()
    DEFAULT_DEPARTMENTS.forEach((dept, index) => {
      departments.insert({
        id: ids.newId(),
        companyId,
        name: dept.name,
        nameEn: dept.nameEn,
        folder: dept.folder,
        icon: dept.icon,
        color: dept.color,
        description: dept.description,
        sortOrder: index,
        createdAt: timestamp,
        createdBy: userId,
      })
    })
  }

  return {
    listForUser(userId: string): Array<CompanyRow & { role: string }> {
      return companies.listForUser(userId)
    },

    /** The company a member belongs to (undefined only if the row vanished). */
    get(member: Member): CompanyRow | undefined {
      return companies.findById(member.companyId)
    },

    /**
     * Create a company owned by `ownerId`. Each step after the rows is best
     * effort, as it always was: a company without its repository, default
     * departments, scopes or seeded folders is still created (startup seeding
     * and the departments API repair the rest).
     */
    async create(ownerId: string, name: string, requestedSlug: unknown): Promise<CompanyRow> {
      const id = ids.newId()
      const slug = buildUniqueSlug(name, requestedSlug, id)
      const timestamp = clock.now()

      let repoPath: string | null = null
      try {
        repoPath = await repoStore.createCompanyRepo(id)
      } catch (e) {
        console.error('Failed to create repo:', e)
        // Continue without repo - can be created later
      }

      companies.insert({ id, name: name.trim(), slug, ownerId, repoPath, createdAt: timestamp })
      memberships.insert({ id: ids.newId(), userId: ownerId, companyId: id, role: 'owner', createdAt: timestamp })

      try {
        initializeDefaultDepartments(id, ownerId)
      } catch (e) {
        console.error('Failed to initialize departments:', e)
        // Continue - company is created, departments can be added later
      }

      // Permission scopes: company-wide `everyone: read + write` (today's fully
      // open behaviour) and one inheriting scope per department
      try {
        scopes.ensureCompanyScope(id, ownerId)
        scopes.syncCompanyScopes(id)
      } catch (e) {
        console.error('Failed to initialize permission scopes:', e)
        // Continue - startup seeding creates them on the next restart
      }

      // Seed the matching folders into the repo (filesystem = source of truth)
      if (repoPath) {
        try {
          await repoStore.seedCompanyRepo(id, repoPath, DEFAULT_DEPARTMENTS.map(d => d.folder))
        } catch (e) {
          console.error('Failed to seed department folders:', e)
          // Continue - folders can be created later via the departments API
        }
      }

      return companies.findById(id)!
    },

    /** Only the display name changes: the slug, repository and folders stay. */
    rename(member: Member, name: string): CompanyRow {
      companies.rename(member.companyId, name, clock.now())
      return companies.findById(member.companyId)!
    },

    members(member: Member): MemberView[] {
      const rows = memberships.listByCompany(member.companyId)
      const users = accounts.byIds(rows.map(m => m.user_id))
      return rows.map(m => {
        const userInfo = users.get(m.user_id)
        return {
          id: m.id,
          userId: m.user_id,
          companyId: m.company_id,
          role: m.role,
          createdAt: m.created_at,
          email: userInfo?.email ?? null,
          name: userInfo?.name ?? null,
        }
      })
    },

    /** Which app build each member last used and when they last synced (lib/client-activity.ts). */
    clientActivity(member: Member): MemberActivityView[] {
      const rows = memberships.listByCompany(member.companyId)
      const activity = clientActivity.forCompany(member.companyId)
      const users = accounts.byIds(rows.map(m => m.user_id))
      return rows.map(m => {
        const row = activity.get(m.user_id)
        const parsed = parseClientVersion(row?.client_version)
        const userInfo = users.get(m.user_id)
        return {
          userId: m.user_id,
          role: m.role,
          email: userInfo?.email ?? null,
          name: userInfo?.name ?? null,
          clientVersion: row?.client_version ?? null,
          build: parsed
            ? { semver: `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join('.')}` : ''}`, sha: parsed.sha, commitDate: parsed.commitDate, dev: parsed.dev }
            : null,
          clientPlatform: row?.client_platform ?? null,
          lastSeenAt: row?.last_seen_at ?? null,
          lastFetchAt: row?.last_fetch_at ?? null,
          lastPushAt: row?.last_push_at ?? null,
          supportsAgentEvents: supportsAgentEvents(row?.client_version),
        }
      })
    },

    /**
     * Add an existing account (an owner/admin acting). Only owners may hand
     * out owner/admin (as with changeRole): an admin who could add an owner
     * could add a second account of their own as owner and take the company
     * over. The account must exist — a membership for an unknown id would be
     * claimed by whoever later signs up with that id.
     */
    addMember(actor: Member, userId: string, role: MemberRole): Outcome<{ id: string; userId: string; companyId: string; role: MemberRole; createdAt: string }> {
      if (role !== 'member' && !isOwner(actor.role)) {
        return refuse('forbidden', 'Only owners can add owners or admins')
      }
      if (!accounts.byIds([userId]).has(userId)) {
        return refuse('not-found', 'User not found')
      }
      if (memberships.roleOf(actor.companyId, userId) !== null) {
        return refuse('conflict', 'User is already a member')
      }
      const id = ids.newId()
      const timestamp = clock.now()
      memberships.insert({ id, userId, companyId: actor.companyId, role, createdAt: timestamp })
      return ok({ id, userId, companyId: actor.companyId, role, createdAt: timestamp })
    },

    /**
     * Change a member's role (an owner acting). The last owner can never be
     * demoted — not by another owner (there is none) and not by themselves —
     * so a company always keeps someone who can manage it.
     */
    changeRole(actor: Member, targetUserId: string, role: MemberRole): Outcome<{ userId: string; companyId: string; role: MemberRole }> {
      const companyId = actor.companyId
      const current = memberships.roleOf(companyId, targetUserId)
      if (current === null) {
        return refuse('not-found', 'Member not found')
      }
      if (current !== role) {
        const changed = transactions.run(() => {
          if (current === 'owner' && memberships.countOwners(companyId) <= 1) return false
          memberships.updateRole(companyId, targetUserId, role, clock.now())
          // Owner/admin read and write everything; rules naming them are moot
          // and must not come back unnoticed if they are demoted later.
          if (role === 'owner' || role === 'admin') scopes.deleteUserRules(companyId, targetUserId)
          return true
        })
        if (!changed) {
          return refuse('bad-request', 'The last owner cannot be demoted. Make another member an owner first.')
        }
      }
      return ok({ userId: targetUserId, companyId, role })
    },

    /**
     * Remove a member (an owner/admin acting; never an owner). Membership,
     * management rights and every rule naming them (private folders
     * included) go together: re-adding the account later starts from nothing
     * instead of silently restoring their old access.
     */
    removeMember(actor: Member, targetUserId: string): Outcome<void> {
      const companyId = actor.companyId
      if (memberships.roleOf(companyId, targetUserId) === 'owner') {
        return refuse('forbidden', 'Cannot remove the owner')
      }
      transactions.run(() => {
        memberships.delete(companyId, targetUserId)
        scopes.removeManagerFromCompany(companyId, targetUserId)
        scopes.deleteUserRules(companyId, targetUserId)
      })
      return ok(undefined)
    },
  }
}

export type CompanyService = ReturnType<typeof createCompanyService>
