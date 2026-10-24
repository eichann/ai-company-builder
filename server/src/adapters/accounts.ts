import Database from 'better-sqlite3'
import type { AccountDirectory, SessionUser } from '../ports/accounts'
import { getUsersByIds } from '../lib/auth'
import { AUTH_DB_PATH } from '../lib/config'

/**
 * Better Auth's database. `byIds` goes through lib/auth.ts at call time, so
 * tests that mock lib/auth see their mock; `bySessionToken` reads the session
 * and user tables directly (git-http's lookup, moved here unchanged) on its
 * own connection, opened on first use.
 */
export function betterAuthAccountDirectory(): AccountDirectory {
  let authDb: Database.Database | null = null
  const conn = () => (authDb ??= new Database(AUTH_DB_PATH))

  return {
    byIds: userIds => getUsersByIds(userIds),

    bySessionToken(token): SessionUser | null {
      const session = conn().prepare(
        'SELECT userId FROM session WHERE token = ? AND expiresAt > ?'
      ).get(token, new Date().toISOString()) as { userId: string } | undefined
      if (!session) return null

      const user = conn().prepare(
        'SELECT id, email, name, image, emailVerified FROM user WHERE id = ?'
      ).get(session.userId) as { id: string; email: string; name: string | null; image: string | null; emailVerified: boolean } | undefined
      if (!user) return null

      return {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        image: user.image ?? null,
        emailVerified: !!user.emailVerified,
      }
    },
  }
}
