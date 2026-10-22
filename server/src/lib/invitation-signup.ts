/**
 * Invitation links are single-use.
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
import type Database from 'better-sqlite3'

type Conn = Database.Database

/** Add the claim columns to an existing invitations table (idempotent). */
export function migrateInvitationClaims(conn: Conn): void {
  const cols = new Set((conn.prepare(`PRAGMA table_info(invitations)`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('signup_claimed_at')) conn.exec(`ALTER TABLE invitations ADD COLUMN signup_claimed_at TEXT`)
  if (!cols.has('signup_user_id')) conn.exec(`ALTER TABLE invitations ADD COLUMN signup_user_id TEXT`)
}

/** Claim an unused, unexpired, unclaimed invitation for a sign-up. Returns its id, or null. */
export function claimInvitationForSignup(conn: Conn, token: string, now = new Date()): string | null {
  const row = conn.prepare(`
    UPDATE invitations SET signup_claimed_at = ?
    WHERE token = ? AND used_by IS NULL AND signup_claimed_at IS NULL AND expires_at > ?
    RETURNING id
  `).get(now.toISOString(), token, now.toISOString()) as { id: string } | undefined
  return row?.id ?? null
}

export function releaseSignupClaim(conn: Conn, invitationId: string): void {
  conn.prepare(`UPDATE invitations SET signup_claimed_at = NULL, signup_user_id = NULL WHERE id = ? AND used_by IS NULL`).run(invitationId)
}

export function recordSignupUser(conn: Conn, invitationId: string, userId: string): void {
  conn.prepare(`UPDATE invitations SET signup_user_id = ? WHERE id = ?`).run(userId, invitationId)
}

/**
 * Run a sign-up that carries an invitation token: claim → sign up → record
 * the account (or release the claim when the sign-up did not succeed).
 * Returns null when the token cannot be claimed (the caller answers 403).
 */
export async function signUpWithInvitation(
  conn: Conn,
  token: string,
  signUp: () => Promise<Response>,
): Promise<Response | null> {
  const id = claimInvitationForSignup(conn, token)
  if (!id) return null
  let res: Response
  try {
    res = await signUp()
  } catch (err) {
    releaseSignupClaim(conn, id)
    throw err
  }
  if (!res.ok) {
    releaseSignupClaim(conn, id)
    return res
  }
  try {
    const body = await res.clone().json() as { user?: { id?: unknown } } | null
    if (typeof body?.user?.id === 'string') recordSignupUser(conn, id, body.user.id)
  } catch {
    // Not JSON: the claim stays (the link cannot sign anyone else up); any
    // signed-in user may still accept it once.
  }
  return res
}

/**
 * Mark the invitation used by `userId`. False when it was used meanwhile,
 * or claimed by a sign-up of another account.
 */
export function consumeInvitation(conn: Conn, invitationId: string, userId: string, now = new Date()): boolean {
  return conn.prepare(`
    UPDATE invitations SET used_by = ?, used_at = ?
    WHERE id = ? AND used_by IS NULL AND (signup_user_id IS NULL OR signup_user_id = ?)
  `).run(userId, now.toISOString(), invitationId, userId).changes === 1
}
