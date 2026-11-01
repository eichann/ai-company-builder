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
import { taskSettingsRoute } from './routes/task-settings'
import { absencesRoute } from './routes/absences'
import { recordsRoute } from './routes/records'
import { aiRunsRoute } from './routes/ai-runs'
import { skillUsesRoute } from './routes/skill-uses'
import { recordsAiRoute } from './routes/records-ai'
import { googleDriveAiRoute, googleDriveRoute, googlePickerPageRoute } from './routes/google-drive'
import { outboundMailRoute } from './routes/outbound-mail'
import { pluginsRoute } from './routes/plugins'
import { approvalsRoute } from './routes/approvals'
import { agentStopsRoute } from './routes/agent-stops'
import { keyBrokerRoute } from './routes/key-broker'
import { brokerRelayRoute } from './routes/broker-relay'
import { googleRoute } from './routes/google'
import { minutesRoute } from './routes/minutes'
import { notificationsRoute } from './routes/notifications'
import { calendarRoute } from './routes/calendar'
import { oauthRoute } from './routes/oauth'
// Lanes (server.md "Lane markers"): add only right under your lane's ▼.
// lane A ▼
import { coreConnectorsRoute } from './routes/core-connectors'
import { slackEventsRoute, slackRoute } from './routes/slack-connection'
import { threadsRoute } from './routes/threads'
// lane A ▲
// lane B ▼
import { identitiesRoute } from './routes/identities'
import { recordsAiIdentitiesRoute } from './routes/records-ai-identities'
import { inboxRoute } from './routes/inbox'
import { recordsAiInboxRoute } from './routes/records-ai-inbox'
// lane B ▲
// lane C ▼
// lane C ▲
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
app.route('/api/companies/:companyId', taskSettingsRoute)
app.route('/api/companies/:companyId', absencesRoute)
app.route('/api/companies/:companyId', agentStopsRoute)
app.route('/api/companies/:companyId', keyBrokerRoute)
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', aiRunsRoute)
app.route('/api/companies/:companyId', skillUsesRoute)
app.route('/api/companies/:companyId', outboundMailRoute)
app.route('/api/companies/:companyId', pluginsRoute)
app.route('/api/companies/:companyId', googleRoute)
// Google Drive through the Google connection (google-drive.md).
app.route('/api/companies/:companyId', googleDriveRoute)
app.route('/api/companies/:companyId', minutesRoute)
// The member's notices (知らせ, notifications.md).
app.route('/api/companies/:companyId', notificationsRoute)
app.route('/api/companies/:companyId', calendarRoute)
// Google sends the browser back here (public: the state finds the company; google-connector.md).
app.route('/api/oauth', oauthRoute)
// Approval requests: a person's session only (no AI or admin-API route; approvals.md).
app.route('/api/companies/:companyId', approvalsRoute)
app.route('/api/records-ai/google/drive', googleDriveAiRoute)
app.route('/api/records-ai', recordsAiRoute)
app.route('/api/google-picker', googlePickerPageRoute)
app.route('/api/broker', brokerRelayRoute)
app.route('/api/git', gitRoute)
app.route('/api/git-http', gitHttpRoute)
app.route('/api', invitationsRoute)
// Lanes (server.md "Lane markers"): add only right under your lane's ▼.
// lane A ▼
// 「つないでいるサービス」: the core connectors and the roles they serve (connector-roles.md).
app.route('/api/companies/:companyId', coreConnectorsRoute)
// The Slack connection (slack-connector.md): the company's app, a member's own permission.
app.route('/api/companies/:companyId', slackRoute)
// Slack's events (public: the company's own signing secret is the proof; the URL never changes).
app.route('/api/slack', slackEventsRoute)
// The card's 元のスレッド (outbound-mail.md "Replies"): read now with the caller's own permission, never stored.
app.route('/api/companies/:companyId', threadsRoute)
// lane A ▲
// lane B ▼
// Matching people and companies (名寄せ, identity.md): members decide, the AI only proposes.
app.route('/api/companies/:companyId', identitiesRoute)
app.route('/api/records-ai/identities', recordsAiIdentitiesRoute)
// Messages that came in (来た連絡, inbox.md): a member's own; the AI judges by its record token.
app.route('/api/companies/:companyId', inboxRoute)
app.route('/api/records-ai/inbox', recordsAiInboxRoute)
// lane B ▲
// lane C ▼
// lane C ▲
