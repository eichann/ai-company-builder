// Must be the first import: loads .env before lib/auth checks AUTH_SECRET
import './env'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import Database from 'better-sqlite3'
import { auth } from './lib/auth'
import { AUTH_DB_PATH } from './lib/config'
import { db, initDatabase } from './db'
import { signUpWithInvitation } from './lib/invitation-signup'
import { meRoute } from './routes/me'
import { companiesRoute } from './routes/companies'
import { departmentsRoute } from './routes/departments'
import { folderSizesRoute } from './routes/folder-sizes'
import { companyFilesRoute } from './routes/company-files'
import { gitRoute, configureAllBareRepos } from './routes/git'
import { gitHttpRoute } from './routes/git-http'
import { invitationsRoute } from './routes/invitations'
import { permissionsRoute } from './routes/permissions'
import { permissionRulesRoute } from './routes/permission-rules'
import { privateFoldersRoute } from './routes/private-folders'
import { clientActivityMiddleware } from './lib/client-activity-middleware'
import { agentEventsRoute } from './routes/agent-events'
import { agentSandboxRoute } from './routes/agent-sandbox'
import { keyBrokerRoute } from './routes/key-broker'
import { scheduleAgentEventRetention } from './lib/agent-event-retention'
import { services } from './composition'

// Initialize database
initDatabase()

// Bring existing company repos up to the current standard configuration
// (force-push protection, HTTP push, latest pre-receive hook)
{
  const { total, failed } = configureAllBareRepos()
  console.log(`Configured ${total - failed}/${total} bare repositories${failed > 0 ? ` (${failed} failed)` : ''}`)
}

// The key broker (API keys): on only with a usable key-encryption key file.
{
  const broker = services.brokerVault.status()
  console.log(broker.enabled ? `Key broker: on (key-encryption key ${broker.kekId})` : `Key broker: off — ${broker.detail}`)
}

// Clean up expired sessions on startup
const authDb = new Database(AUTH_DB_PATH)

// Ensure Better Auth tables exist (created here so a fresh install boots without
// a manual migration step — mirrors initDatabase() for app.sqlite).
authDb.exec(`
  CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    expiresAt TEXT NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt TEXT,
    refreshTokenExpiresAt TEXT,
    scope TEXT,
    password TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

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

// Record the desktop-app build (X-ACB-Client-Version) per member and company.
app.use('/api/*', clientActivityMiddleware)

// Health check
app.get('/', (c) => {
  return c.json({ status: 'ok', name: 'AI Company Builder API' })
})

// Public config endpoint (no auth required) - used by Electron client to validate server URL
app.get('/api/config', (c) => {
  const authDbConn = new Database(AUTH_DB_PATH)
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
    const authDbConn = new Database(AUTH_DB_PATH)
    const result = authDbConn.prepare('SELECT COUNT(*) as count FROM user').get() as { count: number }
    authDbConn.close()

    if (result.count > 0) {
      // Allow signup only with valid invitation token
      // (single-use: the sign-up claims it — lib/invitation-signup.ts)
      const invitationToken = c.req.header('X-Invitation-Token')
      if (invitationToken) {
        const res = await signUpWithInvitation(db, invitationToken, () => auth.handler(c.req.raw))
        if (res) return res
      }
      return c.json({ error: 'Signup is disabled. Please use an invitation link.' }, 403)
    }
  }

  return auth.handler(c.req.raw)
})

// Routes
app.route('/api/me', meRoute)
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api/companies/:companyId/folder-sizes', folderSizesRoute)
app.route('/api/companies/:companyId/files', companyFilesRoute)
app.route('/api/companies/:companyId', permissionsRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)
app.route('/api/companies/:companyId', privateFoldersRoute)
app.route('/api/companies/:companyId', agentEventsRoute)
app.route('/api/companies/:companyId', agentSandboxRoute)
app.route('/api/companies/:companyId', keyBrokerRoute)
app.route('/api/git', gitRoute)
app.route('/api/git-http', gitHttpRoute)
app.route('/api', invitationsRoute)

// Start server
const port = Number(process.env.PORT) || 3001

console.log(`Server starting on port ${port}...`)

const server = serve({
  fetch: app.fetch,
  port,
})

// Git pushes/clones send the whole pack as one long request. Node's default
// requestTimeout (300s) severs uploads that take longer than 5 minutes on
// slow links, so raise the cap to 1 hour.
;(server as import('node:http').Server).requestTimeout = 60 * 60 * 1000

console.log(`Server is running on http://localhost:${port}`)

// The AI action log: delete events past each company's retention (shortly
// after start, then daily).
scheduleAgentEventRetention(() => services.agentEvents.prune())
