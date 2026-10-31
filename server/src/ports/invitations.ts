/**
 * An `invitations` row joined with its company's name, column names as
 * stored (`i.*, c.name AS company_name`). The admin panel's list returns
 * every column, so rows are passed through whole.
 */
export type InvitationWithCompany = {
  id: string
  company_id: string
  token: string
  role: string
  created_by: string
  used_by: string | null
  used_at: string | null
  expires_at: string
  created_at: string
  signup_claimed_at: string | null
  signup_user_id: string | null
  company_name: string
}

/** A new invitation; its company is the handle's. */
export interface NewInvitation {
  id: string
  token: string
  role: string
  createdBy: string
  expiresAt: string
  createdAt: string
}

/**
 * One company's invitations, from its handle (`CompanyData.invitations`).
 * Another company's invitation id is not found and nothing of it changes.
 */
export interface InvitationRepository {
  /** The invitations, newest first. */
  list(): InvitationWithCompany[]
  exists(invitationId: string): boolean
  /** Whether `userId` once accepted an invitation to this company (the person agreed to join it). */
  acceptedBy(userId: string): boolean
  insert(invitation: NewInvitation): void
  delete(invitationId: string): void
  /**
   * Mark the invitation used by `userId` (compare-and-set). False when it was
   * used meanwhile, or claimed by a sign-up of another account.
   */
  consume(invitationId: string, userId: string): boolean
  /** Undo a claim whose sign-up did not succeed (an accepted invitation stays as it is). */
  releaseSignupClaim(invitationId: string): void
  /** The account the claiming sign-up created. */
  recordSignupUser(invitationId: string, userId: string): void
}

/**
 * The control plane of invitation links: a token is all the caller has
 * before the company is known, so these two find the invitation (and its
 * company) by token. Everything after goes through that company's handle.
 */
export interface InvitationTokenLookup {
  findByToken(token: string): InvitationWithCompany | undefined
  /** Claim an unused, unexpired, unclaimed invitation for a sign-up (atomic). Its id and company, or null. */
  claimForSignup(token: string): { id: string; companyId: string } | null
}
