/**
 * Who may act in a company: membership and role, decided in one place with
 * shared/core's role rules. Routes pick the check an endpoint has always made
 * and pass the endpoint's own error text (part of the API).
 *
 * - `member`: not a member → 404 `Company not found or access denied` (a
 *   non-member learns nothing about the company).
 * - `fullAccessMember`: not a member OR not owner/admin → 403 with the
 *   endpoint's text (endpoints that never distinguished the two).
 * - `requireFullAccess` / `requireOwner`: a member already known, wrong role → 403.
 */
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import type { MembershipRepository } from '../ports/memberships'
import { ok, refuse, type Outcome } from './outcome'

/** A signed-in user acting in a company they belong to. */
export interface Member {
  companyId: string
  userId: string
  role: string
}

export const NOT_MEMBER_ERROR = 'Company not found or access denied'

/** Owners and admins read, write and manage everything. */
export function hasFullAccess(role: string): boolean {
  return FULL_ACCESS_ROLES.has(role)
}

export function isOwner(role: string): boolean {
  return role === 'owner'
}

export function requireFullAccess(member: Member, error: string): Outcome<Member> {
  return hasFullAccess(member.role) ? ok(member) : refuse('forbidden', error)
}

export function requireOwner(member: Member, error: string): Outcome<Member> {
  return isOwner(member.role) ? ok(member) : refuse('forbidden', error)
}

export interface AccessPolicy {
  /** The membership, or null. */
  memberOf(companyId: string, userId: string): Member | null
  member(companyId: string, userId: string): Outcome<Member>
  fullAccessMember(companyId: string, userId: string, error: string): Outcome<Member>
}

export function createAccessPolicy(memberships: MembershipRepository): AccessPolicy {
  function memberOf(companyId: string, userId: string): Member | null {
    const role = memberships.roleOf(companyId, userId)
    return role === null ? null : { companyId, userId, role }
  }
  return {
    memberOf,
    member(companyId, userId) {
      const m = memberOf(companyId, userId)
      return m ? ok(m) : refuse('not-found', NOT_MEMBER_ERROR)
    },
    fullAccessMember(companyId, userId, error) {
      const m = memberOf(companyId, userId)
      return m && hasFullAccess(m.role) ? ok(m) : refuse('forbidden', error)
    },
  }
}
