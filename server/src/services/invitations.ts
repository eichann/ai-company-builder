/**
 * Invitation links: created by owners/admins, single-use (the sign-up side is
 * lib/invitation-signup.ts), accepted by a signed-in account.
 */
import type { AccountDirectory, AccountSummary } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyRepository, CompanyRow } from '../ports/companies'
import type { InvitationRepository, InvitationWithCompany } from '../ports/invitations'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import { isOwner, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

/** An invitation link is valid for an integer number of days in this range (default 7). */
export const MIN_INVITATION_DAYS = 1
export const MAX_INVITATION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export interface InvitationListItem {
  invitation: InvitationWithCompany
  isExpired: boolean
  isUsed: boolean
  createdBy: AccountSummary | undefined
  usedBy: AccountSummary | undefined | null
}

export interface InvitationServiceDeps {
  invitations: InvitationRepository
  companies: CompanyRepository
  memberships: MembershipRepository
  accounts: AccountDirectory
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
}

export function createInvitationService(deps: InvitationServiceDeps) {
  const { invitations, companies, memberships, accounts, transactions, clock, ids } = deps

  const isExpired = (inv: InvitationWithCompany) => new Date(inv.expires_at).getTime() < clock.nowMs()

  /** A link that can still be used: exists, unused, unexpired. */
  function usable(token: string): Outcome<InvitationWithCompany> {
    const invitation = invitations.findByToken(token)
    if (!invitation) return refuse('not-found', 'Invalid invitation link')
    if (invitation.used_by) return refuse('gone', 'This invitation has already been used')
    if (isExpired(invitation)) return refuse('gone', 'This invitation has expired')
    return ok(invitation)
  }

  return {
    list(member: Member): InvitationListItem[] {
      const rows = invitations.listByCompany(member.companyId)
      // Who created and who used each one
      const userIds = rows
        .flatMap(inv => [inv.created_by, inv.used_by])
        .filter((id): id is string => !!id)
      const users = accounts.byIds([...new Set(userIds)])
      return rows.map(inv => ({
        invitation: inv,
        isExpired: isExpired(inv),
        isUsed: !!inv.used_by,
        createdBy: users.get(inv.created_by),
        usedBy: inv.used_by ? users.get(inv.used_by) : null,
      }))
    },

    /** The company invitations are created for. */
    company(member: Member): Outcome<CompanyRow> {
      const company = companies.findById(member.companyId)
      return company ? ok(company) : refuse('not-found', 'Company not found')
    },

    /** Only owners hand out admin (as everywhere else roles are granted). */
    mayInvite(member: Member, role: 'admin' | 'member'): Outcome<void> {
      return role === 'admin' && !isOwner(member.role)
        ? refuse('forbidden', 'Only owners can invite admins')
        : ok(undefined)
    },

    create(member: Member, role: 'admin' | 'member', expiresInDays: number) {
      const id = ids.newId()
      const token = ids.newToken()
      const createdAt = clock.now()
      const expiresAt = new Date(clock.nowMs() + expiresInDays * DAY_MS).toISOString()
      invitations.insert({ id, companyId: member.companyId, token, role, createdBy: member.userId, expiresAt, createdAt })
      return { id, token, companyId: member.companyId, role, expiresAt, createdAt }
    },

    delete(member: Member, invitationId: string): Outcome<void> {
      if (!invitations.existsInCompany(invitationId, member.companyId)) {
        return refuse('not-found', 'Invitation not found')
      }
      invitations.delete(invitationId)
      return ok(undefined)
    },

    /** The public check behind the invitation page. */
    check: usable,

    /**
     * Join with the link. Using the invitation is a compare-and-set (once,
     * and — if a sign-up claimed it — only by that account) done together
     * with adding the member.
     */
    accept(userId: string, token: string): Outcome<InvitationWithCompany> {
      const found = usable(token)
      if (!found.ok) return found
      const invitation = found.value

      if (memberships.roleOf(invitation.company_id, userId) !== null) {
        return refuse('conflict', 'You are already a member of this company')
      }

      const membershipId = ids.newId()
      const timestamp = clock.now()
      const joined = transactions.run(() => {
        if (!invitations.consume(invitation.id, userId)) return false
        memberships.insert({ id: membershipId, userId, companyId: invitation.company_id, role: invitation.role, createdAt: timestamp })
        return true
      })
      if (!joined) {
        return refuse('gone', 'This invitation has already been used')
      }
      return ok(invitation)
    },
  }
}

export type InvitationService = ReturnType<typeof createInvitationService>
