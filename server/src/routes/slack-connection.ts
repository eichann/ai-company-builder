/**
 * The Slack connection (stage 3 A3, `.claude/rules/slack-connector.md`).
 * Shapes: shared/types/slack.ts; rules: services/slack-connector.ts.
 *
 * `slackRoute`, mounted at /api/companies/:companyId:
 *
 * Owner / admin (the admin console's 「つなぎ先」→「Slack」):
 *   GET    /slack                       the company's Slack app (workspace, client id, last 4,
 *                                       bot set, on/off), the addresses to register, grants, history
 *   PUT    /slack/app                   { teamId, clientId, clientSecret?, signingSecret?, botToken? }
 *                                       (secrets sent once, never answered; the bot token checked with Slack)
 *   PUT    /slack/enabled               { enabled }
 *   DELETE /slack/grants/:userId        stop a member's permission (revoked at Slack too)
 *
 * Any member (the desktop app's 設定 → Slack):
 *   GET    /me/slack                    my permission
 *   POST   /me/slack/connect            { features } → { authorizeUrl } (opened in the system browser)
 *   PUT    /me/slack/features           { feature, on } — e.g. 知らせの DM off / on
 *   DELETE /me/slack                    「許可をやめる」 (revoked at Slack too)
 *
 * `slackEventsRoute`, mounted at /api/slack: `POST /events/:companyId` —
 * public (Slack sends no ACB session): the company's own signing secret is the
 * proof (routes/slack.ts, services/slack-events.ts). The URL never changes.
 *
 * No answer ever carries a secret, a token or a code. Non-members get 404.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { createSlackRoute } from './slack'

export const slackRoute = new Hono()
const { access, slackConnector } = services

export const slackEventsRoute = createSlackRoute(services.slackEvents)

async function authAndAuthorize(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

function answer<T>(c: Context, result: Outcome<T>) {
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

slackRoute.get('/slack', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await slackConnector.adminView(member))
})

slackRoute.put('/slack/app', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await slackConnector.saveApp(member, await jsonBody(c)))
})

slackRoute.put('/slack/enabled', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await slackConnector.setEnabled(member, await jsonBody(c)))
})

slackRoute.delete('/slack/grants/:userId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await slackConnector.stopGrant(member, c.req.param('userId')))
})

slackRoute.get('/me/slack', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await slackConnector.my(member))
})

slackRoute.post('/me/slack/connect', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await slackConnector.connect(member, await jsonBody(c)))
})

slackRoute.put('/me/slack/features', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await slackConnector.setFeature(member, await jsonBody(c)))
})

slackRoute.delete('/me/slack', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await slackConnector.disconnect(member))
})
