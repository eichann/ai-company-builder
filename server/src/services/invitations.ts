/**
 * Invitation links: created by owners/admins, single-use, accepted by a
 * signed-in account.
 *
 * After the first account exists, sign-up (POST /api/auth/sign-up/email) is
 * allowed only with a valid invitation token in X-Invitation-Token, and the
 * invitee then accepts it (POST /api/invitations/:token/accept) to join.
 * Before 2026-10-22 the sign-up only *checked* the token, so one link let
 * anyone who saw it create any number of accounts until someone accepted it.
 *
 * Now the sign-up CLAIMS the invitation atomically (signup_claimed_at) before
 * the account is created — a second sign-up with the same token is refused —
 * and records the new account (signup_user_id). If the sign-up fails, the
 * claim is released. Accepting is a compare-and-set on used_by, and a
 * claimed invitation can only be accepted by the account that claimed it
 * (an existing member accepting a link they were sent never signs up, so
 * unclaimed invitations stay acceptable by any signed-in user, once).
 */
import type { AccountDirectory, AccountSummary } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyRepository, CompanyRow } from '../ports/companies'
import type { CompanyDataSource } from '../ports/company-data'
import type { InvitationTokenLookup, InvitationWithCompany } from '../ports/invitations'
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
  /** By token (control plane): finds the invitation and its company. */
  invitationTokens: InvitationTokenLookup
  companyData: CompanyDataSource
  companies: CompanyRepository
  memberships: MembershipRepository
  accounts: AccountDirectory
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
}

export function createInvitationService(deps: InvitationServiceDeps) {
  const { invitationTokens, companyData, companies, memberships, accounts, transactions, clock, ids } = deps
  // The company's invitations: the member's company, or the one the token row names.
  const invitationsOf = (companyId: string) => companyData.forCompany(companyId).invitations

  const isExpired = (inv: InvitationWithCompany) => new Date(inv.expires_at).getTime() < clock.nowMs()

  /** A link that can still be used: exists, unused, unexpired. */
  function usable(token: string): Outcome<InvitationWithCompany> {
    const invitation = invitationTokens.findByToken(token)
    if (!invitation) return refuse('not-found', 'Invalid invitation link')
    if (invitation.used_by) return refuse('gone', 'This invitation has already been used')
    if (isExpired(invitation)) return refuse('gone', 'This invitation has expired')
    return ok(invitation)
  }

  return {
    list(member: Member): InvitationListItem[] {
      const rows = invitationsOf(member.companyId).list()
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
      invitationsOf(member.companyId).insert({ id, token, role, createdBy: member.userId, expiresAt, createdAt })
      return { id, token, companyId: member.companyId, role, expiresAt, createdAt }
    },

    delete(member: Member, invitationId: string): Outcome<void> {
      const invitations = invitationsOf(member.companyId)
      if (!invitations.exists(invitationId)) {
        return refuse('not-found', 'Invitation not found')
      }
      invitations.delete(invitationId)
      return ok(undefined)
    },

    /** The public check behind the invitation page. */
    check: usable,

    /**
     * Run a sign-up that carries an invitation token: claim → sign up → record
     * the account (or release the claim when the sign-up did not succeed).
     * Returns null when the token cannot be claimed (the caller answers 403).
     */
    async signUp(token: string, signUp: () => Promise<Response>): Promise<Response | null> {
      const claimed = invitationTokens.claimForSignup(token)
      if (!claimed) return null
      const { id } = claimed
      const invitations = invitationsOf(claimed.companyId)
      let res: Response
      try {
        res = await signUp()
      } catch (err) {
        invitations.releaseSignupClaim(id)
        throw err
      }
      if (!res.ok) {
        invitations.releaseSignupClaim(id)
        return res
      }
      try {
        const body = await res.clone().json() as { user?: { id?: unknown } } | null
        if (typeof body?.user?.id === 'string') invitations.recordSignupUser(id, body.user.id)
      } catch {
        // Not JSON: the claim stays (the link cannot sign anyone else up); any
        // signed-in user may still accept it once.
      }
      return res
    },

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
        if (!invitationsOf(invitation.company_id).consume(invitation.id, userId)) return false
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
