/**
 * Read APIs for the admin panel's permission / overview screens.
 * Mounted at /api/companies/:companyId.
 *
 *   GET /overview           owner/admin
 *   GET /permissions        owner/admin (all scopes); department managers
 *                           (the subtrees of the departments they manage)
 *   GET /me/capabilities    any member
 *
 * Department managers are in routes/departments.ts (/:id/managers).
 * Semantics of scopes and rules: lib/permissions.ts. Nothing here enforces
 * anything — Phase 1 only stores and exposes the model.
 */
import { Hono } from 'hono'
import { db } from '../db'
import { getUserFromRequest, getUsersByIds } from '../lib/auth'
import { getClientActivityForCompany } from '../lib/client-activity'
import { computeAttention, type OverviewMember } from '../lib/overview'
import { listScopesWithRules, managedDepartmentIds, getMemberRole } from '../lib/permission-store'
import {
  compareScopePaths,
  findGoverningScope,
  FULL_ACCESS_ROLES,
  isSameOrAncestorPath,
  summarizeRules,
  type ScopeRule,
} from '../lib/permissions'
import { listRecentPushRejections } from '../lib/push-rejections'

export const permissionsRoute = new Hono()

const ROLE_LABELS: Record<string, string> = {
  owner: 'オーナー',
  admin: '管理者',
  member: 'メンバー',
}

type Authed = { userId: string; role: string } | Response

async function authenticateMember(c: { req: { raw: Request; param: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response }): Promise<Authed> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const role = getMemberRole(db, companyId, user.id)
  if (!role) return c.json({ error: 'Company not found or access denied' }, 404)
  return { userId: user.id, role }
}

// GET /api/companies/:companyId/overview
permissionsRoute.get('/overview', async (c) => {
  const auth = await authenticateMember(c)
  if (auth instanceof Response) return auth
  if (!FULL_ACCESS_ROLES.has(auth.role)) {
    return c.json({ error: 'Only owners and admins can view the overview' }, 403)
  }
  const companyId = c.req.param('companyId')!

  const memberships = db.prepare(`
    SELECT user_id, role FROM memberships WHERE company_id = ? ORDER BY created_at ASC
  `).all(companyId) as Array<{ user_id: string; role: string }>
  const departmentCount = (db.prepare(`SELECT COUNT(*) AS n FROM departments WHERE company_id = ?`)
    .get(companyId) as { n: number }).n
  const activity = getClientActivityForCompany(companyId)
  const rejections = listRecentPushRejections(companyId, 20)
  const users = getUsersByIds([...new Set([...memberships.map(m => m.user_id), ...rejections.map(r => r.userId)])])

  const members: OverviewMember[] = memberships.map(m => {
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

  return c.json({
    success: true,
    data: {
      memberCount: memberships.length,
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
      },
    },
  })
})

// GET /api/companies/:companyId/permissions
permissionsRoute.get('/permissions', async (c) => {
  const auth = await authenticateMember(c)
  if (auth instanceof Response) return auth
  const companyId = c.req.param('companyId')!

  const all = listScopesWithRules(db, companyId).sort((a, b) => compareScopePaths(a.path, b.path))

  let visible = all
  if (!FULL_ACCESS_ROLES.has(auth.role)) {
    const managed = new Set(managedDepartmentIds(db, companyId, auth.userId))
    if (managed.size === 0) {
      return c.json({ error: 'Only owners, admins and department managers can view permissions' }, 403)
    }
    const roots = all.filter(s => s.departmentId !== null && managed.has(s.departmentId)).map(s => s.path)
    visible = all.filter(s => roots.some(root => isSameOrAncestorPath(root, s.path)))
  }

  const userIds = new Set<string>()
  for (const s of visible) for (const r of s.rules) if (r.subjectType === 'user' && r.subjectId) userIds.add(r.subjectId)
  const users = getUsersByIds([...userIds])
  const label = (r: ScopeRule): string => {
    if (r.subjectType === 'everyone') return '全員'
    if (r.subjectType === 'role') return ROLE_LABELS[r.subjectId ?? ''] ?? r.subjectId ?? ''
    const u = r.subjectId ? users.get(r.subjectId) : undefined
    return u?.name || u?.email || r.subjectId || ''
  }

  return c.json({
    success: true,
    data: {
      scopes: visible.map(s => ({
        id: s.id,
        path: s.path,
        kind: s.kind,
        departmentId: s.departmentId,
        repoId: s.repoId,
        inherited: s.rules.length === 0,
        rules: s.rules.map(r => ({
          id: r.id,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          subjectLabel: label(r),
          canRead: r.canRead,
          canWrite: r.canWrite,
        })),
        effectiveSummary: summarizeRules(findGoverningScope(all, s.path)?.rules ?? []),
      })),
    },
  })
})

// GET /api/companies/:companyId/me/capabilities
permissionsRoute.get('/me/capabilities', async (c) => {
  const auth = await authenticateMember(c)
  if (auth instanceof Response) return auth
  const companyId = c.req.param('companyId')!
  return c.json({
    success: true,
    data: {
      role: auth.role,
      managedDepartmentIds: managedDepartmentIds(db, companyId, auth.userId),
    },
  })
})
