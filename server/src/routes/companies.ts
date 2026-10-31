import { Hono } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { toCamelCase } from '../lib/camel-case'
import { services } from '../composition'
import { requireFullAccess, requireOwner } from '../services/access'
import { MAX_COMPANY_NAME_LENGTH } from '../services/companies'
import { refusal } from './respond'

export const companiesRoute = new Hono()
const { access, companies } = services

// List companies for the current user
companiesRoute.get('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  return c.json({
    success: true,
    data: companies.listForUser(user.id).map(toCamelCase),
  })
})

// Get a specific company
companiesRoute.get('/:id', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const member = access.member(c.req.param('id'), user.id)
  if (!member.ok) return refusal(c, member)

  const company = companies.get(member.value)!

  return c.json({
    success: true,
    data: {
      ...toCamelCase(company),
      role: member.value.role,
    },
  })
})

// Create a new company: server operators only, except the first company of a
// fresh server (services/companies.ts mayCreate)
companiesRoute.post('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const allowed = companies.mayCreate(user.id)
  if (!allowed.ok) return refusal(c, allowed)

  const body = await c.req.json()
  const { name } = body

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return c.json({ error: 'Company name is required' }, 400)
  }

  const company = await companies.create(user.id, name, body.slug)

  return c.json({
    success: true,
    data: {
      ...toCamelCase(company),
      role: 'owner',
    },
  }, 201)
})

// Get company members (any member may view the list)
companiesRoute.get('/:id/members', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const member = access.member(c.req.param('id'), user.id)
  if (!member.ok) return refusal(c, member)

  return c.json({
    success: true,
    data: companies.members(member.value),
  })
})

// Which desktop-app build each member last used and when they last synced
// (owner/admin only). See lib/client-activity.ts for what is recorded when.
companiesRoute.get('/:id/client-activity', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const member = access.member(c.req.param('id'), user.id)
  if (!member.ok) return refusal(c, member)
  const admin = requireFullAccess(member.value, 'Only owners and admins can view client activity')
  if (!admin.ok) return refusal(c, admin)

  return c.json({
    success: true,
    data: companies.clientActivity(admin.value),
  })
})

// Add an existing account to the company (owner/admin): only one that once
// accepted an invitation to this company; everyone else gets an invitation link
companiesRoute.post('/:id/members', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const actor = access.fullAccessMember(c.req.param('id'), user.id, 'Only owners and admins can invite members')
  if (!actor.ok) return refusal(c, actor)

  const body = await c.req.json().catch(() => null) as { userId?: unknown; role?: unknown } | null
  const userId = body?.userId
  const role = body?.role ?? 'member'

  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 200) {
    return c.json({ error: 'userId is required' }, 400)
  }

  if (role !== 'owner' && role !== 'admin' && role !== 'member') {
    return c.json({ error: 'Invalid role' }, 400)
  }

  const added = companies.addMember(actor.value, userId, role)
  if (!added.ok) return refusal(c, added)

  return c.json({ success: true, data: added.value }, 201)
})

// Rename a company (owner/admin). Only the display name changes: the slug,
// repository and folders stay as they are.
companiesRoute.patch('/:id', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const member = access.member(c.req.param('id'), user.id)
  if (!member.ok) return refusal(c, member)
  const actor = requireFullAccess(member.value, 'Only owners and admins can rename the company')
  if (!actor.ok) return refusal(c, actor)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const raw = (body as { name?: unknown } | null)?.name
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim() : ''
  if (!name) {
    return c.json({ error: 'Company name is required' }, 400)
  }
  if (name.length > MAX_COMPANY_NAME_LENGTH) {
    return c.json({ error: `Company name must be at most ${MAX_COMPANY_NAME_LENGTH} characters` }, 400)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return c.json({ error: 'Company name contains invalid characters' }, 400)
  }

  const company = companies.rename(actor.value, name)
  return c.json({ success: true, data: { ...toCamelCase(company), role: actor.value.role } })
})

// Change a member's role. Owners only: they alone may grant or revoke admin
// (and ownership); the last owner can never be demoted.
companiesRoute.put('/:id/members/:userId/role', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const member = access.member(c.req.param('id'), user.id)
  if (!member.ok) return refusal(c, member)
  const actor = requireOwner(member.value, 'Only owners can change member roles')
  if (!actor.ok) return refusal(c, actor)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const role = (body as { role?: unknown } | null)?.role
  if (role !== 'owner' && role !== 'admin' && role !== 'member') {
    return c.json({ error: 'Invalid role' }, 400)
  }

  const changed = companies.changeRole(actor.value, c.req.param('userId'), role)
  if (!changed.ok) return refusal(c, changed)

  return c.json({ success: true, data: changed.value })
})

// Remove a member from company (owner/admin; never an owner)
companiesRoute.delete('/:id/members/:userId', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const actor = access.fullAccessMember(c.req.param('id'), user.id, 'Only owners and admins can remove members')
  if (!actor.ok) return refusal(c, actor)

  const removed = companies.removeMember(actor.value, c.req.param('userId'))
  if (!removed.ok) return refusal(c, removed)

  return c.json({
    success: true,
    message: 'Member removed',
  })
})

