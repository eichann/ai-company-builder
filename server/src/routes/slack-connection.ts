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
 *   PUT    /me/slack/seen               「仕事の道具をつなぐ」 showed Slack (「Slack でつなぐ」 or 「あとで」)
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
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'
import { createSlackRoute } from './slack'

export const slackRoute = new Hono()
const { slackConnector } = services

export const slackEventsRoute = createSlackRoute(services.slackEvents)

function answer<T>(c: Context, result: Outcome<T>) {
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

slackRoute.get('/slack', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await slackConnector.adminView(member))
})

slackRoute.put('/slack/app', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await slackConnector.saveApp(member, c.var.body))
})

slackRoute.put('/slack/enabled', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await slackConnector.setEnabled(member, c.var.body))
})

slackRoute.delete('/slack/grants/:userId', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await slackConnector.stopGrant(member, c.req.param('userId')))
})

slackRoute.get('/me/slack', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await slackConnector.my(member))
})

slackRoute.post('/me/slack/connect', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await slackConnector.connect(member, c.var.body))
})

slackRoute.put('/me/slack/features', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await slackConnector.setFeature(member, c.var.body))
})

slackRoute.put('/me/slack/seen', companyMember, async (c) => answer(c, await slackConnector.markSeen(c.var.member)))

slackRoute.delete('/me/slack', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await slackConnector.disconnect(member))
})
