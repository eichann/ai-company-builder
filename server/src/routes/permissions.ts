/**
 * Read APIs for the admin panel's permission / overview screens.
 * Mounted at /api/companies/:companyId.
 *
 *   GET /overview           owner/admin
 *   GET /permissions        owner/admin (all scopes); department managers
 *                           (the subtrees of the departments they manage)
 *   GET /me/capabilities    any member: role, managed departments (ids and folders)
 *   GET /me/write-access    any member: where they may write (for the desktop
 *                           app's AI guard; ETag / If-None-Match → 304)
 *
 * /overview (attention.orphanedScopes) and /permissions (orphanedScopes) list
 * scopes with rules whose folder no longer exists on the shared branch
 * (lib/orphaned-scopes.ts).
 *
 * Department managers are in routes/departments.ts (/:id/managers).
 * The views are built in services/permission-views.ts; semantics of scopes
 * and rules: shared/core/permissions.ts.
 */
import { createHash } from 'crypto'
import { Hono } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import { requireFullAccess, type Member } from '../services/access'
import { refusal } from './respond'

export const permissionsRoute = new Hono()
const { access, permissionViews } = services

async function authenticateMember(c: { req: { raw: Request; param: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response }): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

// GET /api/companies/:companyId/overview
permissionsRoute.get('/overview', async (c) => {
  const member = await authenticateMember(c)
  if (member instanceof Response) return member
  const actor = requireFullAccess(member, 'Only owners and admins can view the overview')
  if (!actor.ok) return refusal(c, actor)

  return c.json({ success: true, data: await permissionViews.overview(actor.value) })
})

// GET /api/companies/:companyId/permissions
permissionsRoute.get('/permissions', async (c) => {
  const member = await authenticateMember(c)
  if (member instanceof Response) return member

  const view = await permissionViews.permissions(member)
  if (!view.ok) return refusal(c, view)
  return c.json({ success: true, data: view.value })
})

// GET /api/companies/:companyId/me/capabilities
permissionsRoute.get('/me/capabilities', async (c) => {
  const member = await authenticateMember(c)
  if (member instanceof Response) return member
  return c.json({ success: true, data: permissionViews.capabilities(member) })
})

// GET /api/companies/:companyId/me/write-access
// The caller's write access as data the client evaluates per path with
// resolveAccess()'s semantics (see writeAccessSummary in shared/core/permissions.ts).
// `version` (also the ETag) changes whenever the answer changes.
permissionsRoute.get('/me/write-access', async (c) => {
  const member = await authenticateMember(c)
  if (member instanceof Response) return member
  const summary = permissionViews.writeAccess(member)
  const version = createHash('sha256').update(JSON.stringify({ role: member.role, ...summary })).digest('hex').slice(0, 32)
  const etag = `"${version}"`
  c.header('ETag', etag)
  c.header('Cache-Control', 'private, no-cache')
  const inm = c.req.header('If-None-Match')
  if (inm && inm.split(',').some(t => t.trim() === etag)) return c.body(null, 304)
  return c.json({ success: true, data: { version, role: member.role, ...summary } })
})
