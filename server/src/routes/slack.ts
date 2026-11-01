/**
 * Slack's event receiver (stage 3 A2, `.claude/rules/slack-connector.md`),
 * to be mounted at /api/slack by A3:
 *
 *   POST /events/:companyId   public: no ACB session — Slack's signature with the
 *                             company's own signing secret is the proof
 *
 * The URL is fixed: each company registers `<PUBLIC_URL>/api/slack/events/<id>`
 * in its Slack app, so it must never change. The body is read as text (the
 * signature covers the exact bytes) and handed to services/slack-events.ts;
 * nothing here logs or stores it. The answer is empty, Slack's URL check's
 * challenge, or a bare status.
 *
 * A factory, not a module-level app: the service is created in the
 * composition (A3), which then mounts `createSlackRoute(services.slackEvents)`.
 */
import { Hono } from 'hono'
import { SLACK_EVENT_MAX_BYTES, type SlackEvents } from '../services/slack-events'

export function createSlackRoute(events: Pick<SlackEvents, 'receive'>): Hono {
  const route = new Hono()
  route.post('/events/:companyId', async (c) => {
    c.header('Cache-Control', 'no-store')
    const declared = Number(c.req.header('content-length') ?? '0')
    if (declared > SLACK_EVENT_MAX_BYTES) return c.body(null, 413)
    const raw = await c.req.text()
    const answer = await events.receive(c.req.param('companyId'), {
      timestamp: c.req.header('x-slack-request-timestamp'),
      signature: c.req.header('x-slack-signature'),
    }, raw)
    if (answer.status === 200 && 'json' in answer && answer.json) return c.json(answer.json, 200)
    return c.body(null, answer.status)
  })
  return route
}
