/**
 * The HTTP application: middleware and every route, mounted in one place.
 * src/index.ts starts it (database, repositories, listener);
 * tests/integration/permission-matrix.test.ts walks its routes.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth, authDb } from './lib/auth'
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
import { clientActivityMiddleware } from './routes/client-activity-middleware'
import { agentEventsRoute } from './routes/agent-events'
import { agentSandboxRoute } from './routes/agent-sandbox'
import { agentStopsRoute } from './routes/agent-stops'
import { keyBrokerRoute } from './routes/key-broker'
import { brokerRelayRoute } from './routes/broker-relay'
import { requestLog } from './lib/request-log'
import { services } from './composition'

export const app = new Hono()

// Middleware
// One line per request: method, route pattern, status, duration, request id
// (X-Request-Id), company and user ids — never the URL, its query or a path
// a member sent (lib/request-log.ts).
app.use('*', requestLog())
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
      // (single-use: the sign-up claims it — services/invitations.ts)
      const invitationToken = c.req.header('X-Invitation-Token')
      if (invitationToken) {
        const res = await services.invitations.signUp(invitationToken, () => auth.handler(c.req.raw))
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
