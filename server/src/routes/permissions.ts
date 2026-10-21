/**
 * Read APIs for the admin panel's permission / overview screens.
 * Mounted at /api/companies/:companyId.
 *
 *   GET /overview           owner/admin
 *   GET /permissions        owner/admin (all scopes); department managers
 *                           (the subtrees of the departments they manage)
 *   GET /me/capabilities    any member
 *   GET /me/write-access    any member: where they may write (for the desktop
 *                           app's AI guard; ETag / If-None-Match → 304)
 *
 * /overview (attention.orphanedScopes) and /permissions (orphanedScopes) list
 * scopes with rules whose folder no longer exists on the shared branch
 * (lib/orphaned-scopes.ts).
 *
 * Department managers are in routes/departments.ts (/:id/managers).
 * Semantics of scopes and rules: lib/permissions.ts. Nothing here enforces
 * anything — Phase 1 only stores and exposes the model.
 */
import { createHash } from 'crypto'
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
  writeAccessSummary,
  type ScopeRule,
} from '../lib/permissions'
import { listRecentPushRejections } from '../lib/push-rejections'
import { findOrphanedScopes } from '../lib/orphaned-scopes'

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
  const orphaned = await findOrphanedScopes(companyId)
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

  // What each scope would follow without rules of its own ("上の階層と同じ"):
  // the governing scope among its ancestors. Included even when that ancestor
  // is outside what a manager receives, so the panel can name what a
  // department inherits from the company root.
  const parentOf = new Map(visible.map(s => [s.id, findGoverningScope(all.filter(o => o.id !== s.id && o.path !== s.path), s.path)]))

  const userIds = new Set<string>()
  for (const s of [...visible, ...[...parentOf.values()].filter(p => p !== null)]) {
    for (const r of s.rules) if (r.subjectType === 'user' && r.subjectId) userIds.add(r.subjectId)
  }
  const users = getUsersByIds([...userIds])
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
  const orphaned = (await findOrphanedScopes(companyId)).filter(o => visibleIds.has(o.scope.id))

  return c.json({
    success: true,
    data: {
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

// GET /api/companies/:companyId/me/write-access
// The caller's write access as data the client evaluates per path with
// resolveAccess()'s semantics (see writeAccessSummary in lib/permissions.ts).
// `version` (also the ETag) changes whenever the answer changes.
permissionsRoute.get('/me/write-access', async (c) => {
  const auth = await authenticateMember(c)
  if (auth instanceof Response) return auth
  const companyId = c.req.param('companyId')!
  const summary = writeAccessSummary(listScopesWithRules(db, companyId), auth.userId, auth.role)
  const version = createHash('sha256').update(JSON.stringify({ role: auth.role, ...summary })).digest('hex').slice(0, 32)
  const etag = `"${version}"`
  c.header('ETag', etag)
  c.header('Cache-Control', 'private, no-cache')
  const inm = c.req.header('If-None-Match')
  if (inm && inm.split(',').some(t => t.trim() === etag)) return c.body(null, 304)
  return c.json({ success: true, data: { version, role: auth.role, ...summary } })
})
