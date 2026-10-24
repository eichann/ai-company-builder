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

export interface NewInvitation {
  id: string
  companyId: string
  token: string
  role: string
  createdBy: string
  expiresAt: string
  createdAt: string
}

export interface InvitationRepository {
  /** The company's invitations, newest first. */
  listByCompany(companyId: string): InvitationWithCompany[]
  findByToken(token: string): InvitationWithCompany | undefined
  existsInCompany(invitationId: string, companyId: string): boolean
  insert(invitation: NewInvitation): void
  delete(invitationId: string): void
  /**
   * Mark the invitation used by `userId` (compare-and-set). False when it was
   * used meanwhile, or claimed by a sign-up of another account
   * (lib/invitation-signup.ts).
   */
  consume(invitationId: string, userId: string): boolean
}
