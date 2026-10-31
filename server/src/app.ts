/**
 * The HTTP application: middleware and every route, mounted in one place.
 * src/index.ts starts it (database, repositories, listener);
 * tests/integration/permission-matrix.test.ts walks its routes.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { auth, authDb } from './lib/auth'
import { db } from './db'
import { signUpWithInvitation } from './lib/invitation-signup'
import { meRoute } from './routes/me'
import { companiesRoute } from './routes/companies'
import { departmentsRoute } from './routes/departments'
import { folderSizesRoute } from './routes/folder-sizes'
import { companyFilesRoute } from './routes/company-files'
import { gitRoute } from './routes/git'
import { gitHttpRoute } from './routes/git-http'
import { invitationsRoute } from './routes/invitations'
import { permissionsRoute } from './routes/permissions'
import { permissionRulesRoute } from './routes/permission-rules'
import { privateFoldersRoute } from './routes/private-folders'
import { clientActivityMiddleware } from './lib/client-activity-middleware'
import { agentEventsRoute } from './routes/agent-events'
import { agentSandboxRoute } from './routes/agent-sandbox'
import { agentStopsRoute } from './routes/agent-stops'
import { keyBrokerRoute } from './routes/key-broker'
import { brokerRelayRoute } from './routes/broker-relay'
import { redactBrokerQuery } from './lib/log-redaction'

export const app = new Hono()

// Middleware
// The relay accepts a token in ?key= (Gemini's form): request lines never show a query there.
app.use('*', logger((line, ...rest) => console.log(redactBrokerQuery(line), ...rest)))
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
  const result = authDb.prepare('SELECT COUNT(*) as count FROM user').get() as { count: number }

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
    const result = authDb.prepare('SELECT COUNT(*) as count FROM user').get() as { count: number }

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
app.route('/api/companies/:companyId', agentStopsRoute)
app.route('/api/companies/:companyId', keyBrokerRoute)
app.route('/api/broker', brokerRelayRoute)
app.route('/api/git', gitRoute)
app.route('/api/git-http', gitHttpRoute)
app.route('/api', invitationsRoute)
