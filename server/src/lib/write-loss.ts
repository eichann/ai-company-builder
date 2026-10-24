/**
 * Who would lose write access because of a rule change — the input of the
 * outdated-app guard in routes/permission-rules.ts.
 *
 * Pure: takes the company's scopes before and after the change.
 */
import {
  FULL_ACCESS_ROLES,
  isSameOrAncestorPath,
  resolveAccess,
  type PermissionRepository,
  type ScopeWithRules,
} from '../../shared/core/permissions'

export interface MemberRole {
  userId: string
  role: string
}

/**
 * Members who can write somewhere under one of `roots` before the change but
 * not after. Access only changes where the governing scope changes, so it is
 * enough to compare at each root and at every scope path (before or after)
 * inside a root: every place in the subtree is governed by one of those.
 * Owners and admins never lose write (resolveAccess, reason 'role').
 */
export function membersLosingWrite(
  companyId: string,
  members: MemberRole[],
  before: ScopeWithRules[],
  after: ScopeWithRules[],
  roots: string[],
): string[] {
  const points = new Set(roots)
  for (const s of [...before, ...after]) {
    if (roots.some(root => isSameOrAncestorPath(root, s.path))) points.add(s.path)
  }
  const roles = new Map(members.map(m => [m.userId, m.role]))
  const repoOf = (scopes: ScopeWithRules[]): PermissionRepository => ({
    getMemberRole: (_companyId, userId) => roles.get(userId) ?? null,
    listScopes: () => scopes,
  })
  const was = repoOf(before)
  const will = repoOf(after)
  const losing: string[] = []
  for (const m of members) {
    if (FULL_ACCESS_ROLES.has(m.role)) continue
    for (const path of points) {
      if (resolveAccess(companyId, m.userId, path, was).write && !resolveAccess(companyId, m.userId, path, will).write) {
        losing.push(m.userId)
        break
      }
    }
  }
  return losing
}
