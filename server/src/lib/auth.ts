import { betterAuth } from 'better-auth'
import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

// Ensure data directory exists
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const dbPath = path.join(dataDir, 'auth.sqlite')

export const auth = betterAuth({
  database: new Database(dbPath),
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

// Direct access to auth database for user lookups
const authDb = new Database(dbPath)

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

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    emailVerified: session.user.emailVerified,
  }
}
