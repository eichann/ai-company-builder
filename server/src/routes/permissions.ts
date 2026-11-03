/**
 * Read APIs for the admin panel's permission / overview screens.
 * Mounted at /api/companies/:companyId.
 *
 *   GET /overview           owner/admin
 *   GET /permissions        owner/admin (all scopes); department managers
 *                           (the subtrees of the departments they manage)
 *   GET /me/capabilities    any member: role, managed departments (ids and folders),
 *                           whether they may read the AI action log (canViewAgentEvents)
 *   GET /me/write-access    any member: where they may write (for the desktop
 *                           app's AI guard; ETag / If-None-Match → 304)
 *
 * /overview (attention.orphanedScopes) and /permissions (orphanedScopes) list
 * scopes with rules whose folder no longer exists on the shared branch
 * (adapters/orphaned-scopes.ts).
 *
 * Department managers are in routes/departments.ts (/:id/managers).
 * The views are built in services/permission-views.ts; semantics of scopes
 * and rules: shared/core/permissions.ts.
 */
import { createHash } from 'crypto'
import { Hono } from 'hono'
import { services } from '../composition'
import { requireFullAccess } from '../services/access'
import { refusal } from './respond'
import { companyMember } from './guards'

export const permissionsRoute = new Hono()
const { permissionViews, agentEvents } = services

// GET /api/companies/:companyId/overview
permissionsRoute.get('/overview', companyMember, async (c) => {
  const member = c.var.member
  const actor = requireFullAccess(member, 'Only owners and admins can view the overview')
  if (!actor.ok) return refusal(c, actor)

  return c.json({ success: true, data: await permissionViews.overview(actor.value) })
})

// GET /api/companies/:companyId/permissions
permissionsRoute.get('/permissions', companyMember, async (c) => {
  const member = c.var.member

  const view = await permissionViews.permissions(member)
  if (!view.ok) return refusal(c, view)
  return c.json({ success: true, data: view.value })
})

// GET /api/companies/:companyId/me/capabilities
permissionsRoute.get('/me/capabilities', companyMember, async (c) => {
  const member = c.var.member
  return c.json({
    success: true,
    // The admin console shows 「AI の操作の記録」 in its navigation from this flag
    // (owner/admin; a department manager while the log's viewer setting allows).
    data: { ...permissionViews.capabilities(member), canViewAgentEvents: agentEvents.canRead(member) },
  })
})

// GET /api/companies/:companyId/me/write-access
// The caller's write access as data the client evaluates per path with
// resolveAccess()'s semantics (see writeAccessSummary in shared/core/permissions.ts).
// `version` (also the ETag) changes whenever the answer changes.
permissionsRoute.get('/me/write-access', companyMember, async (c) => {
  const member = c.var.member
  const summary = permissionViews.writeAccess(member)
  const version = createHash('sha256').update(JSON.stringify({ role: member.role, ...summary })).digest('hex').slice(0, 32)
  const etag = `"${version}"`
  c.header('ETag', etag)
  c.header('Cache-Control', 'private, no-cache')
  const inm = c.req.header('If-None-Match')
  if (inm && inm.split(',').some(t => t.trim() === etag)) return c.body(null, 304)
  return c.json({ success: true, data: { version, role: member.role, ...summary } })
})
