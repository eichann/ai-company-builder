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
 *
 * 所属 (2026-11-02, 管理画面の見直し 2-2): who invites may name the departments
 * the invitee will belong to. Accepting adds those rows to department_members
 * in the same transaction, so the app's first setup can download exactly
 * those departments without asking (download-choices.md "First setup").
 * Only departments of the inviting company are accepted (another company's id
 * answers like an unknown one); a department deleted meanwhile is skipped.
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

/** At most this many departments on one invitation (a company has a handful). */
export const MAX_INVITATION_DEPARTMENTS = 50
export const INVITATION_DEPARTMENTS_INVALID = 'departmentIds must be a list of department IDs of this company'

/** What the public invitation page shows before an account exists. */
export interface InvitationPreview {
  invitation: InvitationWithCompany
  /** Who created the link (their name, else their email); null when the account is gone. */
  inviterName: string | null
  /** The 所属 departments' names, in the order chosen (deleted ones left out). */
  departmentNames: string[]
}

/** The stored JSON list, tolerant of anything unexpected (→ none). */
function storedDepartmentIds(json: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export interface InvitationListItem {
  invitation: InvitationWithCompany
  isExpired: boolean
  isUsed: boolean
  createdBy: AccountSummary | undefined
  usedBy: AccountSummary | undefined | null
  /** The 所属 the link carries (ids as chosen; a department deleted since is still listed). */
  departmentIds: string[]
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
        departmentIds: storedDepartmentIds(inv.department_ids),
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

    /**
     * The 所属 departments of a new invitation (`departmentIds`, optional): unique ids of
     * this company's departments. Another company's id is refused like one that does not exist.
     */
    departmentsFor(member: Member, departmentIds: unknown): Outcome<string[]> {
      if (departmentIds === undefined) return ok([])
      if (!Array.isArray(departmentIds) || !departmentIds.every(id => typeof id === 'string' && id.length > 0)) {
        return refuse('bad-request', INVITATION_DEPARTMENTS_INVALID)
      }
      const unique = [...new Set(departmentIds as string[])]
      if (unique.length > MAX_INVITATION_DEPARTMENTS) return refuse('bad-request', INVITATION_DEPARTMENTS_INVALID)
      const departments = companyData.forCompany(member.companyId).departments
      if (!unique.every(id => departments.exists(id))) return refuse('bad-request', INVITATION_DEPARTMENTS_INVALID)
      return ok(unique)
    },

    create(member: Member, role: 'admin' | 'member', expiresInDays: number, departmentIds: string[] = []) {
      const id = ids.newId()
      const token = ids.newToken()
      const createdAt = clock.now()
      const expiresAt = new Date(clock.nowMs() + expiresInDays * DAY_MS).toISOString()
      invitationsOf(member.companyId).insert({ id, token, role, createdBy: member.userId, expiresAt, createdAt, departmentIds })
      return { id, token, companyId: member.companyId, role, expiresAt, createdAt, departmentIds }
    },

    delete(member: Member, invitationId: string): Outcome<void> {
      const invitations = invitationsOf(member.companyId)
      if (!invitations.exists(invitationId)) {
        return refuse('not-found', 'Invitation not found')
      }
      invitations.delete(invitationId)
      return ok(undefined)
    },

    /** The public check behind the invitation page: the link, who sent it and the 所属 it carries. */
    check(token: string): Outcome<InvitationPreview> {
      const found = usable(token)
      if (!found.ok) return found
      const invitation = found.value
      const inviter = accounts.byIds([invitation.created_by]).get(invitation.created_by)
      const departments = companyData.forCompany(invitation.company_id).departments
      const departmentNames = storedDepartmentIds(invitation.department_ids)
        .map(id => departments.find(id)?.name)
        .filter((name): name is string => !!name)
      return ok({ invitation, inviterName: inviter?.name || inviter?.email || null, departmentNames })
    },

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
        // 所属 chosen by who invited them (departments deleted since are skipped).
        const departmentIds = storedDepartmentIds(invitation.department_ids)
        if (departmentIds.length > 0) {
          companyData.forCompany(invitation.company_id).tasks.addDepartmentMember(userId, departmentIds, invitation.created_by, timestamp)
        }
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
