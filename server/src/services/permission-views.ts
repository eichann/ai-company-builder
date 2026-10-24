/**
 * Read side of the permission model for the admin panel and the desktop app
 * (routes/permissions.ts): the overview, the scopes with their rules, the
 * caller's capabilities and write access. Semantics of scopes and rules:
 * shared/core/permissions.ts. Nothing here changes anything.
 */
import type { AccountDirectory } from '../ports/accounts'
import type { ClientActivityRepository } from '../ports/client-activity'
import type { DepartmentRepository } from '../ports/departments'
import type { MembershipRepository } from '../ports/memberships'
import type { OrphanedScopeReader } from '../ports/orphaned-scopes'
import type { PushRejectionRepository } from '../ports/push-rejections'
import type { ScopeRepository } from '../ports/scopes'
import { computeAttention, type OverviewMember } from '../lib/overview'
import {
  compareScopePaths,
  findGoverningScope,
  FULL_ACCESS_ROLES,
  isSameOrAncestorPath,
  summarizeRules,
  writeAccessSummary,
  type ScopeRule,
  type WriteAccessSummary,
} from '../../shared/core/permissions'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

const ROLE_LABELS: Record<string, string> = {
  owner: 'オーナー',
  admin: '管理者',
  member: 'メンバー',
}

export interface PermissionViewDeps {
  memberships: MembershipRepository
  departments: DepartmentRepository
  scopes: ScopeRepository
  clientActivity: ClientActivityRepository
  pushRejections: PushRejectionRepository
  orphanedScopes: OrphanedScopeReader
  accounts: AccountDirectory
}

export function createPermissionViewService(deps: PermissionViewDeps) {
  const { memberships, departments, scopes, clientActivity, pushRejections, orphanedScopes, accounts } = deps

  return {
    /** The overview screen (an owner/admin acting). */
    async overview(member: Member) {
      const { companyId } = member
      const rows = memberships.listByCompany(companyId)
      const departmentCount = departments.count(companyId)
      const activity = clientActivity.forCompany(companyId)
      const rejections = pushRejections.recent(companyId, 20)
      const orphaned = await orphanedScopes.find(companyId)
      const users = accounts.byIds([...new Set([...rows.map(m => m.user_id), ...rejections.map(r => r.userId)])])

      const members: OverviewMember[] = rows.map(m => {
        const a = activity.get(m.user_id)
        const u = users.get(m.user_id)
        return {
          userId: m.user_id,
          name: u?.name ?? null,
          email: u?.email ?? null,
          role: m.role,
          clientVersion: a?.client_version ?? null,
          lastSeenAt: a?.last_seen_at ?? null,
          lastFetchAt: a?.last_fetch_at ?? null,
          lastPushAt: a?.last_push_at ?? null,
        }
      })

      return {
        memberCount: rows.length,
        departmentCount,
        attention: {
          ...computeAttention(members),
          recentRejections: rejections.map(r => ({
            id: r.id,
            userId: r.userId,
            name: users.get(r.userId)?.name ?? null,
            marker: r.marker,
            paths: r.paths,
            createdAt: r.createdAt,
          })),
          // Details (who the rules name) are on GET /permissions.
          orphanedScopes: orphaned.map(o => ({
            scopeId: o.scope.id,
            path: o.scope.path,
            kind: o.scope.kind,
            ruleCount: o.scope.rules.length,
            summary: summarizeRules(o.scope.rules),
            since: o.since,
          })),
        },
      }
    },

    /**
     * Every scope with its rules (owner/admin), or the subtrees of the
     * departments a manager manages; anyone else is refused.
     */
    async permissions(member: Member): Promise<Outcome<unknown>> {
      const { companyId } = member
      const all = scopes.listWithRules(companyId).sort((a, b) => compareScopePaths(a.path, b.path))

      let visible = all
      if (!FULL_ACCESS_ROLES.has(member.role)) {
        const managed = new Set(scopes.managedDepartmentIds(companyId, member.userId))
        if (managed.size === 0) {
          return refuse('forbidden', 'Only owners, admins and department managers can view permissions')
        }
        const roots = all.filter(s => s.departmentId !== null && managed.has(s.departmentId)).map(s => s.path)
        visible = all.filter(s => roots.some(root => isSameOrAncestorPath(root, s.path)))
      }

      // What each scope would follow without rules of its own ("上の階層と同じ"):
      // the governing scope among its ancestors. Included even when that ancestor
      // is outside what a manager receives, so the panel can name what a
      // department inherits from the company root.
      const parentOf = new Map(visible.map(s => [s.id, findGoverningScope(all.filter(o => o.id !== s.id && o.path !== s.path), s.path)]))

      const userIds = new Set<string>()
      for (const s of [...visible, ...[...parentOf.values()].filter(p => p !== null)]) {
        for (const r of s.rules) if (r.subjectType === 'user' && r.subjectId) userIds.add(r.subjectId)
      }
      const users = accounts.byIds([...userIds])
      const label = (r: ScopeRule): string => {
        if (r.subjectType === 'everyone') return '全員'
        if (r.subjectType === 'role') return ROLE_LABELS[r.subjectId ?? ''] ?? r.subjectId ?? ''
        const u = r.subjectId ? users.get(r.subjectId) : undefined
        return u?.name || u?.email || r.subjectId || ''
      }
      const serialize = (r: ScopeRule) => ({
        id: r.id,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        subjectLabel: label(r),
        canRead: r.canRead,
        canWrite: r.canWrite,
      })

      // Rules whose folder is gone from the shared branch (renamed or removed by a
      // sync push): see lib/orphaned-scopes.ts.
      const visibleIds = new Set(visible.map(s => s.id))
      const orphaned = (await orphanedScopes.find(companyId)).filter(o => visibleIds.has(o.scope.id))

      return ok({
        orphanedScopes: orphaned.map(o => ({
          scopeId: o.scope.id,
          path: o.scope.path,
          kind: o.scope.kind,
          departmentId: o.scope.departmentId,
          rules: o.scope.rules.map(serialize),
          summary: summarizeRules(o.scope.rules),
          since: o.since,
        })),
        scopes: visible.map(s => ({
          id: s.id,
          path: s.path,
          kind: s.kind,
          departmentId: s.departmentId,
          repoId: s.repoId,
          inherited: s.rules.length === 0,
          rules: s.rules.map(serialize),
          effectiveSummary: summarizeRules(findGoverningScope(all, s.path)?.rules ?? []),
          inheritedFrom: (() => {
            const p = parentOf.get(s.id)
            return p ? { scopeId: p.id, path: p.path, rules: p.rules.map(serialize), summary: summarizeRules(p.rules) } : null
          })(),
        })),
      })
    },

    /**
     * Role and managed departments — ids and folders: the desktop app's chat
     * guard decides by path (who may change CLAUDE.md / AGENTS.md inside a
     * department) without another round trip.
     */
    capabilities(member: Member) {
      const managed = scopes.managedDepartmentIds(member.companyId, member.userId)
      const folderOf = new Map(
        managed.length === 0
          ? []
          : departments.folders(member.companyId).map(d => [d.id, d.folder.normalize('NFC')] as const),
      )
      return {
        role: member.role,
        managedDepartmentIds: managed,
        managedDepartmentFolders: managed.map(id => folderOf.get(id)).filter((f): f is string => typeof f === 'string'),
      }
    },

    /** Where the member may write, as data the client evaluates per path (writeAccessSummary). */
    writeAccess(member: Member): WriteAccessSummary {
      return writeAccessSummary(scopes.listWithRules(member.companyId), member.userId, member.role)
    },

    /**
     * Folders (NFC) of the departments the user manages, in the departments
     * table's order: the AI instruction files inside them are theirs to
     * change (the push check's managedFolders, the rule editor's reach).
     */
    managedFolders(companyId: string, userId: string): string[] {
      const managed = new Set(scopes.managedDepartmentIds(companyId, userId))
      if (managed.size === 0) return []
      return departments.folders(companyId)
        .filter(d => managed.has(d.id))
        .map(d => d.folder.normalize('NFC'))
    },
  }
}

export type PermissionViewService = ReturnType<typeof createPermissionViewService>
