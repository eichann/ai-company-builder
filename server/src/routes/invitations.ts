import { Hono } from 'hono'
import { toCamelCase } from '../lib/camel-case'
import { services } from '../composition'
import { MAX_INVITATION_DAYS, MIN_INVITATION_DAYS } from '../services/invitations'
import { refusal } from './respond'
import { companyAdmin, publicRoute, serviceBody, signedInOr } from './guards'

export { MAX_INVITATION_DAYS, MIN_INVITATION_DAYS }

export const invitationsRoute = new Hono()
const { invitations } = services

// List invitations for a company (owner/admin)
invitationsRoute.get('/companies/:companyId/invitations', companyAdmin('Only owners and admins can view invitations'), (c) => {
  const actor = c.var.member

  return c.json({
    success: true,
    data: invitations.list(actor).map(item => ({
      ...toCamelCase(item.invitation),
      departmentIds: item.departmentIds,
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
invitationsRoute.post('/companies/:companyId/invitations', companyAdmin('Only owners and admins can create invitations'), serviceBody, (c) => {
  const actor = c.var.member

  const company = invitations.company(actor)
  if (!company.ok) return refusal(c, company)

  const body = c.var.body
  const { role = 'member', expiresInDays = 7, departmentIds } = (body ?? {}) as { role?: unknown; expiresInDays?: unknown; departmentIds?: unknown }

  if (role !== 'admin' && role !== 'member') {
    return c.json({ error: 'Invalid role. Must be "admin" or "member"' }, 400)
  }
  const allowed = invitations.mayInvite(actor, role)
  if (!allowed.ok) return refusal(c, allowed)
  if (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays)
    || expiresInDays < MIN_INVITATION_DAYS || expiresInDays > MAX_INVITATION_DAYS) {
    return c.json({ error: `expiresInDays must be an integer from ${MIN_INVITATION_DAYS} to ${MAX_INVITATION_DAYS}` }, 400)
  }
  const departments = invitations.departmentsFor(actor, departmentIds)
  if (!departments.ok) return refusal(c, departments)

  const created = invitations.create(actor, role, expiresInDays, departments.value)

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
      departmentIds: created.departmentIds,
    },
  }, 201)
})

// Delete an invitation (owner/admin)
invitationsRoute.delete('/companies/:companyId/invitations/:invitationId', companyAdmin('Only owners and admins can delete invitations'), (c) => {
  const actor = c.var.member

  const deleted = invitations.delete(actor, c.req.param('invitationId'))
  if (!deleted.ok) return refusal(c, deleted)

  return c.json({
    success: true,
    message: 'Invitation deleted',
  })
})

// Validate an invitation token (public endpoint)
invitationsRoute.get('/invitations/:token', publicRoute('the sign-up page checks an invitation link before an account exists'), (c) => {
  const found = invitations.check(c.req.param('token'))
  if (!found.ok) return refusal(c, found)

  const { invitation, inviterName, departmentNames } = found.value
  return c.json({
    success: true,
    data: {
      companyName: invitation.company_name,
      role: invitation.role,
      expiresAt: invitation.expires_at,
      // The page's 「〇〇さんが、（会社名）に招待しています」 and 「（部署）のメンバーとして参加します」.
      inviterName,
      departmentNames,
    },
  })
})

// Accept an invitation (requires authentication)
invitationsRoute.post('/invitations/:token/accept', signedInOr('Unauthorized. Please log in first.'), (c) => {
  const { user } = c.var

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

