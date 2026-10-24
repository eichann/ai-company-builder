/**
 * services/access.ts: the membership and role checks every company endpoint
 * starts with. The status codes are the API's (routes/respond.ts maps the
 * refusal kinds); a non-member never learns more than "not found" from
 * `member`, and `fullAccessMember` answers non-members and plain members
 * alike.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createAccessPolicy, requireFullAccess, requireOwner } from '../../src/services/access'
import type { MembershipRepository } from '../../src/ports/memberships'
import { refusal } from '../../src/routes/respond'

const roles: Record<string, string> = { owner: 'owner', admin: 'admin', member: 'member', manager: 'member' }
const memberships = { roleOf: (_companyId: string, userId: string) => roles[userId] ?? null } as MembershipRepository
const access = createAccessPolicy(memberships)

async function status(outcome: ReturnType<typeof access.member>) {
  const app = new Hono().get('/', c => (outcome.ok ? c.json({ ok: true }) : refusal(c, outcome)))
  const res = await app.request('/')
  return { status: res.status, body: await res.json() }
}

describe('access policy', () => {
  it('member: 404 for non-members, the role otherwise', async () => {
    expect(await status(access.member('c', 'stranger'))).toEqual({ status: 404, body: { error: 'Company not found or access denied' } })
    expect(access.member('c', 'member')).toEqual({ ok: true, value: { companyId: 'c', userId: 'member', role: 'member' } })
  })

  it('fullAccessMember: owners and admins pass; members and non-members get the same 403', async () => {
    for (const user of ['owner', 'admin']) expect(access.fullAccessMember('c', user, 'no').ok).toBe(true)
    for (const user of ['member', 'stranger']) {
      expect(await status(access.fullAccessMember('c', user, 'Only owners and admins can x'))).toEqual({ status: 403, body: { error: 'Only owners and admins can x' } })
    }
  })

  it('requireFullAccess / requireOwner', () => {
    const m = (role: string) => ({ companyId: 'c', userId: 'u', role })
    expect(requireFullAccess(m('admin'), 'x').ok).toBe(true)
    expect(requireFullAccess(m('member'), 'x')).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(requireOwner(m('owner'), 'x').ok).toBe(true)
    expect(requireOwner(m('admin'), 'x')).toMatchObject({ ok: false, kind: 'forbidden', body: { error: 'x' } })
  })
})
