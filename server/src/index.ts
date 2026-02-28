import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import Database from 'better-sqlite3'
import path from 'path'
import { auth } from './lib/auth'
import { db, initDatabase } from './db'
import { meRoute } from './routes/me'
import { sshKeysRoute } from './routes/ssh-keys'
import { companiesRoute } from './routes/companies'
import { departmentsRoute } from './routes/departments'
import { syncRoute } from './routes/sync'
import { gitRoute } from './routes/git'
import { gitHttpRoute } from './routes/git-http'
import { invitationsRoute } from './routes/invitations'

// Initialize database
initDatabase()

// Clean up expired sessions on startup
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const authDb = new Database(path.join(dataDir, 'auth.sqlite'))
const deleted = authDb.prepare('DELETE FROM session WHERE expiresAt < ?').run(new Date().toISOString())
if (deleted.changes > 0) {
  console.log(`Cleaned up ${deleted.changes} expired session(s)`)
}
authDb.close()

const app = new Hono()

// Middleware
app.use('*', logger())
app.use('*', cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3100',
    ...(process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : []),
    'app://',
  ],
  credentials: true,
}))

// Health check
app.get('/', (c) => {
  return c.json({ status: 'ok', name: 'AI Company Builder API' })
})

// Public config endpoint (no auth required) - used by Electron client to validate server URL
app.get('/api/config', (c) => {
  const authDbConn = new Database(path.join(dataDir, 'auth.sqlite'))
  const result = authDbConn.prepare('SELECT COUNT(*) as count FROM user').get() as { count: number }
  authDbConn.close()

  return c.json({
    success: true,
    data: {
      name: 'AI Company Builder',
      version: '1.0.0',
      setupComplete: result.count > 0,
    },
  })
})

// Better Auth routes (with signup restriction)
app.on(['GET', 'POST'], '/api/auth/**', async (c) => {
  // Block signup after initial setup (first user created)
  if (c.req.method === 'POST' && c.req.path === '/api/auth/sign-up/email') {
    const authDbConn = new Database(path.join(dataDir, 'auth.sqlite'))
    const result = authDbConn.prepare('SELECT COUNT(*) as count FROM user').get() as { count: number }
    authDbConn.close()

    if (result.count > 0) {
      // Allow signup only with valid invitation token
      const invitationToken = c.req.header('X-Invitation-Token')
      if (invitationToken) {
        const invitation = db.prepare(
          "SELECT id FROM invitations WHERE token = ? AND used_by IS NULL AND expires_at > datetime('now')"
        ).get(invitationToken)
        if (invitation) {
          return auth.handler(c.req.raw)
        }
      }
      return c.json({ error: 'Signup is disabled. Please use an invitation link.' }, 403)
    }
  }

  return auth.handler(c.req.raw)
})

// Routes
app.route('/api/me', meRoute)
app.route('/api/users/me/ssh-keys', sshKeysRoute)
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api/sync', syncRoute)
app.route('/api/git', gitRoute)
app.route('/api/git-http', gitHttpRoute)
app.route('/api', invitationsRoute)

// Start server
const port = Number(process.env.PORT) || 3001

console.log(`Server starting on port ${port}...`)

serve({
  fetch: app.fetch,
  port,
})

console.log(`Server is running on http://localhost:${port}`)
