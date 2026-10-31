import { betterAuth } from 'better-auth'
import Database from 'better-sqlite3'
import fs from 'fs'
import { AUTH_DB_PATH, DATA_DIR } from './config'
import { noteRequestUser } from './request-log'

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// One connection to auth.sqlite for the whole process (Better Auth, user
// lookups, /api/config, the sign-up check), in WAL mode so the many readers
// (every request's session lookup) never wait behind a sign-in's write.
export const authDb = new Database(AUTH_DB_PATH)
authDb.pragma('journal_mode = WAL')
authDb.pragma('busy_timeout = 5000')

export const auth = betterAuth({
  database: authDb,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },
  secret: (() => {
    const secret = process.env.AUTH_SECRET
    if (!secret) {
      console.error('FATAL: AUTH_SECRET environment variable is not set.')
      console.error('Generate one with: openssl rand -base64 32')
      process.exit(1)
    }
    return secret
  })(),
  trustedOrigins: [
    'http://localhost:5173',
    'http://localhost:3100',
    ...(process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : []),
    'http://api:3001',
    'http://admin:3100',
    'app://',
  ],
  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
  },
})

// User type for the application
export interface AuthUser {
  id: string
  email: string
  name: string | null
  image: string | null
  emailVerified: boolean
}

/** Look up users by IDs from auth.sqlite. Returns a map of userId -> { email, name } */
export function getUsersByIds(userIds: string[]): Map<string, { email: string; name: string | null }> {
  const result = new Map<string, { email: string; name: string | null }>()
  if (userIds.length === 0) return result

  const placeholders = userIds.map(() => '?').join(',')
  const rows = authDb.prepare(
    `SELECT id, email, name FROM user WHERE id IN (${placeholders})`
  ).all(...userIds) as Array<{ id: string; email: string; name: string | null }>

  for (const row of rows) {
    result.set(row.id, { email: row.email, name: row.name })
  }
  return result
}

// Helper to get user from session
export async function getUserFromRequest(request: Request): Promise<AuthUser | null> {
  const session = await auth.api.getSession({
    headers: request.headers,
  })
  if (!session?.user) return null
  noteRequestUser(request, session.user.id) // the request log prints the id (lib/request-log.ts)

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    emailVerified: session.user.emailVerified,
  }
}
