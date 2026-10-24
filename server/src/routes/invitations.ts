import { Hono } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { toCamelCase } from '../lib/camel-case'
import { services } from '../composition'
import { MAX_INVITATION_DAYS, MIN_INVITATION_DAYS } from '../services/invitations'
import { refusal } from './respond'

export { MAX_INVITATION_DAYS, MIN_INVITATION_DAYS }

export const invitationsRoute = new Hono()
const { access, invitations } = services

// List invitations for a company (owner/admin)
invitationsRoute.get('/companies/:companyId/invitations', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const actor = access.fullAccessMember(c.req.param('companyId'), user.id, 'Only owners and admins can view invitations')
  if (!actor.ok) return refusal(c, actor)

  return c.json({
    success: true,
    data: invitations.list(actor.value).map(item => ({
      ...toCamelCase(item.invitation),
      isExpired: item.isExpired,
      isUsed: item.isUsed,
      createdByName: item.createdBy?.name ?? null,
      createdByEmail: item.createdBy?.email ?? null,
      usedByName: item.usedBy?.name ?? null,
      usedByEmail: item.usedBy?.email ?? null,
    })),
  })
})

// Create a new invitation link (owner/admin; admin links owners only)
invitationsRoute.post('/companies/:companyId/invitations', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const actor = access.fullAccessMember(c.req.param('companyId'), user.id, 'Only owners and admins can create invitations')
  if (!actor.ok) return refusal(c, actor)

  const company = invitations.company(actor.value)
  if (!company.ok) return refusal(c, company)

  const body = await c.req.json().catch(() => ({}))
  const { role = 'member', expiresInDays = 7 } = (body ?? {}) as { role?: unknown; expiresInDays?: unknown }

  if (role !== 'admin' && role !== 'member') {
    return c.json({ error: 'Invalid role. Must be "admin" or "member"' }, 400)
  }
  const allowed = invitations.mayInvite(actor.value, role)
  if (!allowed.ok) return refusal(c, allowed)
  if (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays)
    || expiresInDays < MIN_INVITATION_DAYS || expiresInDays > MAX_INVITATION_DAYS) {
    return c.json({ error: `expiresInDays must be an integer from ${MIN_INVITATION_DAYS} to ${MAX_INVITATION_DAYS}` }, 400)
  }

  const created = invitations.create(actor.value, role, expiresInDays)

  return c.json({
    success: true,
    data: {
      id: created.id,
      token: created.token,
      companyId: created.companyId,
      companyName: company.value.name,
      role: created.role,
      expiresAt: created.expiresAt,
      createdAt: created.createdAt,
    },
  }, 201)
})

// Delete an invitation (owner/admin)
invitationsRoute.delete('/companies/:companyId/invitations/:invitationId', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const actor = access.fullAccessMember(c.req.param('companyId'), user.id, 'Only owners and admins can delete invitations')
  if (!actor.ok) return refusal(c, actor)

  const deleted = invitations.delete(actor.value, c.req.param('invitationId'))
  if (!deleted.ok) return refusal(c, deleted)

  return c.json({
    success: true,
    message: 'Invitation deleted',
  })
})

// Validate an invitation token (public endpoint)
invitationsRoute.get('/invitations/:token', async (c) => {
  const found = invitations.check(c.req.param('token'))
  if (!found.ok) return refusal(c, found)

  return c.json({
    success: true,
    data: {
      companyName: found.value.company_name,
      role: found.value.role,
      expiresAt: found.value.expires_at,
    },
  })
})

// Accept an invitation (requires authentication)
invitationsRoute.post('/invitations/:token/accept', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized. Please log in first.' }, 401)
  }

  const joined = invitations.accept(user.id, c.req.param('token'))
  if (!joined.ok) return refusal(c, joined)

  return c.json({
    success: true,
    data: {
      companyId: joined.value.company_id,
      companyName: joined.value.company_name,
      role: joined.value.role,
    },
  })
})

