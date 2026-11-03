import { Hono } from 'hono'
import { z } from 'zod'
import { toCamelCase } from '../lib/camel-case'
import { services } from '../composition'
import { requireFullAccess, requireOwner } from '../services/access'
import { MAX_COMPANY_NAME_LENGTH } from '../services/companies'
import { refusal } from './respond'
import { companyAdmin, companyMember, serviceBody, signedIn } from './guards'

export const companiesRoute = new Hono()
const { companies } = services

const ROLE = z.enum(['owner', 'admin', 'member'])
const CreateCompanyBody = z.object({ name: z.string().refine(v => v.trim().length > 0), slug: z.unknown().optional() })
const AddMemberBody = z.object({ userId: z.string().min(1).max(200), role: ROLE.nullish().transform(r => r ?? 'member') })
const RenameBody = z.object({ name: z.string() })
const RoleBody = z.object({ role: ROLE })

// List companies for the current user
companiesRoute.get('/', signedIn, (c) => {
  const { user } = c.var
  return c.json({
    success: true,
    data: companies.listForUser(user.id).map(toCamelCase),
  })
})

// Get a specific company
companiesRoute.get('/:companyId', companyMember, (c) => {
  const member = c.var.member
  const company = companies.get(member)!

  return c.json({
    success: true,
    data: {
      ...toCamelCase(company),
      role: member.role,
    },
  })
})

// Create a new company: server operators only, except the first company of a
// fresh server (services/companies.ts mayCreate)
companiesRoute.post('/', signedIn, serviceBody, async (c) => {
  const { user } = c.var
  const allowed = companies.mayCreate(user.id)
  if (!allowed.ok) return refusal(c, allowed)

  const parsed = CreateCompanyBody.safeParse(c.var.body)
  if (!parsed.success) return c.json({ error: 'Company name is required' }, 400)
  const { name, slug } = parsed.data

  // All or nothing: a failed step answers 503 COMPANY_CREATION_FAILED and keeps nothing
  const created = await companies.tryCreate(user.id, name, slug)
  if (!created.ok) return refusal(c, created)
  const company = created.value

  return c.json({
    success: true,
    data: {
      ...toCamelCase(company),
      role: 'owner',
    },
  }, 201)
})

// Get company members (any member may view the list)
companiesRoute.get('/:companyId/members', companyMember, (c) => {
  const member = c.var.member
  return c.json({
    success: true,
    data: companies.members(member),
  })
})

// Which desktop-app build each member last used and when they last synced
// (owner/admin only). See lib/client-activity.ts for what is recorded when.
companiesRoute.get('/:companyId/client-activity', companyMember, (c) => {
  const member = c.var.member
  const admin = requireFullAccess(member, 'Only owners and admins can view client activity')
  if (!admin.ok) return refusal(c, admin)

  return c.json({
    success: true,
    data: companies.clientActivity(admin.value),
  })
})

// Add an existing account to the company (owner/admin): only one that once
// accepted an invitation to this company; everyone else gets an invitation link
companiesRoute.post('/:companyId/members', companyAdmin('Only owners and admins can invite members'), serviceBody, (c) => {
  const actor = c.var.member

  const parsed = AddMemberBody.safeParse(c.var.body ?? {})
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.path[0] === 'role' ? 'Invalid role' : 'userId is required' }, 400)
  }
  const { userId, role } = parsed.data

  const added = companies.addMember(actor, userId, role)
  if (!added.ok) return refusal(c, added)

  return c.json({ success: true, data: added.value }, 201)
})

// Rename a company (owner/admin). Only the display name changes: the slug,
// repository and folders stay as they are.
companiesRoute.patch('/:companyId', companyMember, serviceBody, (c) => {
  const member = c.var.member
  const actor = requireFullAccess(member, 'Only owners and admins can rename the company')
  if (!actor.ok) return refusal(c, actor)

  if (c.var.body === null) return c.json({ error: 'Invalid JSON body' }, 400)
  const raw = RenameBody.safeParse(c.var.body)
  const name = raw.success ? raw.data.name.normalize('NFC').trim() : ''
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
companiesRoute.put('/:companyId/members/:userId/role', companyMember, serviceBody, (c) => {
  const member = c.var.member
  const actor = requireOwner(member, 'Only owners can change member roles')
  if (!actor.ok) return refusal(c, actor)

  if (c.var.body === null) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = RoleBody.safeParse(c.var.body)
  if (!parsed.success) return c.json({ error: 'Invalid role' }, 400)
  const { role } = parsed.data

  const changed = companies.changeRole(actor.value, c.req.param('userId'), role)
  if (!changed.ok) return refusal(c, changed)

  return c.json({ success: true, data: changed.value })
})

// Remove a member from company (owner/admin; never an owner)
companiesRoute.delete('/:companyId/members/:userId', companyAdmin('Only owners and admins can remove members'), (c) => {
  const actor = c.var.member

  const removed = companies.removeMember(actor, c.req.param('userId'))
  if (!removed.ok) return refusal(c, removed)

  return c.json({
    success: true,
    message: 'Member removed',
  })
})

