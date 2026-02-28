import { Hono } from 'hono'
import { db, generateId, now } from '../db'
import { getUserFromRequest, getUsersByIds } from '../lib/auth'
import { randomBytes } from 'crypto'

export const invitationsRoute = new Hono()

// Helper: Convert snake_case object to camelCase
function toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    result[camelKey] = value
  }
  return result
}

// Generate a secure token for invitation links
function generateToken(): string {
  return randomBytes(32).toString('hex')
}

// List invitations for a company
invitationsRoute.get('/companies/:companyId/invitations', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')

  // Check if user is admin/owner of this company
  const userMembership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId) as { role: string } | undefined

  if (!userMembership || !['owner', 'admin'].includes(userMembership.role)) {
    return c.json({ error: 'Only owners and admins can view invitations' }, 403)
  }

  const invitations = db.prepare(`
    SELECT i.*, c.name as company_name
    FROM invitations i
    JOIN companies c ON i.company_id = c.id
    WHERE i.company_id = ?
    ORDER BY i.created_at DESC
  `).all(companyId) as Record<string, unknown>[]

  // Enrich with user info for created_by and used_by
  const userIds = invitations
    .flatMap(inv => [inv.created_by as string, inv.used_by as string | null])
    .filter((id): id is string => !!id)
  const usersMap = getUsersByIds([...new Set(userIds)])

  return c.json({
    success: true,
    data: invitations.map(inv => {
      const createdByUser = usersMap.get(inv.created_by as string)
      const usedByUser = inv.used_by ? usersMap.get(inv.used_by as string) : null
      return {
        ...toCamelCase(inv),
        isExpired: new Date(inv.expires_at as string) < new Date(),
        isUsed: !!inv.used_by,
        createdByName: createdByUser?.name ?? null,
        createdByEmail: createdByUser?.email ?? null,
        usedByName: usedByUser?.name ?? null,
        usedByEmail: usedByUser?.email ?? null,
      }
    }),
  })
})

// Create a new invitation link
invitationsRoute.post('/companies/:companyId/invitations', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')

  // Check if user is admin/owner of this company
  const userMembership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId) as { role: string } | undefined

  if (!userMembership || !['owner', 'admin'].includes(userMembership.role)) {
    return c.json({ error: 'Only owners and admins can create invitations' }, 403)
  }

  // Get company details
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as { name: string } | undefined
  if (!company) {
    return c.json({ error: 'Company not found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const { role = 'member', expiresInDays = 7 } = body

  if (!['admin', 'member'].includes(role)) {
    return c.json({ error: 'Invalid role. Must be "admin" or "member"' }, 400)
  }

  const id = generateId()
  const token = generateToken()
  const timestamp = now()
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()

  db.prepare(`
    INSERT INTO invitations (id, company_id, token, role, created_by, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, token, role, user.id, expiresAt, timestamp)

  return c.json({
    success: true,
    data: {
      id,
      token,
      companyId,
      companyName: company.name,
      role,
      expiresAt,
      createdAt: timestamp,
    },
  }, 201)
})

// Delete an invitation
invitationsRoute.delete('/companies/:companyId/invitations/:invitationId', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const invitationId = c.req.param('invitationId')

  // Check if user is admin/owner of this company
  const userMembership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId) as { role: string } | undefined

  if (!userMembership || !['owner', 'admin'].includes(userMembership.role)) {
    return c.json({ error: 'Only owners and admins can delete invitations' }, 403)
  }

  // Check if invitation exists and belongs to this company
  const invitation = db.prepare(`
    SELECT id FROM invitations WHERE id = ? AND company_id = ?
  `).get(invitationId, companyId)

  if (!invitation) {
    return c.json({ error: 'Invitation not found' }, 404)
  }

  db.prepare('DELETE FROM invitations WHERE id = ?').run(invitationId)

  return c.json({
    success: true,
    message: 'Invitation deleted',
  })
})

// Validate an invitation token (public endpoint)
invitationsRoute.get('/invitations/:token', async (c) => {
  const token = c.req.param('token')

  const invitation = db.prepare(`
    SELECT i.*, c.name as company_name
    FROM invitations i
    JOIN companies c ON i.company_id = c.id
    WHERE i.token = ?
  `).get(token) as Record<string, unknown> | undefined

  if (!invitation) {
    return c.json({ error: 'Invalid invitation link' }, 404)
  }

  if (invitation.used_by) {
    return c.json({ error: 'This invitation has already been used' }, 410)
  }

  if (new Date(invitation.expires_at as string) < new Date()) {
    return c.json({ error: 'This invitation has expired' }, 410)
  }

  return c.json({
    success: true,
    data: {
      companyName: invitation.company_name,
      role: invitation.role,
      expiresAt: invitation.expires_at,
    },
  })
})

// Accept an invitation (requires authentication)
invitationsRoute.post('/invitations/:token/accept', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized. Please log in first.' }, 401)
  }

  const token = c.req.param('token')

  const invitation = db.prepare(`
    SELECT i.*, c.name as company_name
    FROM invitations i
    JOIN companies c ON i.company_id = c.id
    WHERE i.token = ?
  `).get(token) as Record<string, unknown> | undefined

  if (!invitation) {
    return c.json({ error: 'Invalid invitation link' }, 404)
  }

  if (invitation.used_by) {
    return c.json({ error: 'This invitation has already been used' }, 410)
  }

  if (new Date(invitation.expires_at as string) < new Date()) {
    return c.json({ error: 'This invitation has expired' }, 410)
  }

  // Check if user is already a member
  const existingMembership = db.prepare(`
    SELECT id FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, invitation.company_id)

  if (existingMembership) {
    return c.json({ error: 'You are already a member of this company' }, 409)
  }

  // Add user as member
  const membershipId = generateId()
  const timestamp = now()

  db.prepare(`
    INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(membershipId, user.id, invitation.company_id, invitation.role, timestamp, timestamp)

  // Mark invitation as used
  db.prepare(`
    UPDATE invitations SET used_by = ?, used_at = ? WHERE id = ?
  `).run(user.id, timestamp, invitation.id)

  return c.json({
    success: true,
    data: {
      companyId: invitation.company_id,
      companyName: invitation.company_name,
      role: invitation.role,
    },
  })
})
