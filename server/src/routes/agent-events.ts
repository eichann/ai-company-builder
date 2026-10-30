/**
 * The AI action log (monitoring M1). Mounted at /api/companies/:companyId.
 * Shapes: shared/types/agent-events.ts; rules: services/agent-events.ts.
 *
 *   POST /agent-events                              any member: their app's events
 *                                                   ({ events }, ≤ 200; user = session)
 *   GET  /agent-events?from&to&userId&category&decision&conversationId&q&cursor&limit
 *                                                   page, newest first (owner/admin;
 *                                                   managers when the settings allow,
 *                                                   their departments' part, masked)
 *   GET  /agent-events/summary?from&to&tzOffsetMinutes
 *                                                   counts per member and day
 *   GET  /agent-events/sandbox?from&to              what the AI sandbox blocks / would block,
 *                                                   by host, skill, secret place (owner/admin)
 *   GET  /agent-events/settings                     retention + viewers + history (owner/admin)
 *   PUT  /agent-events/settings                     { retentionDays?, viewers? } (owner/admin)
 *   GET  /agent-events/settings/retention-preview?days=N   what N days would delete
 *   GET  /agent-events/viewers?mode=                who would see the log (owner/admin)
 *
 * Non-members get 404 like every company route. Event contents are never logged.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { CLIENT_VERSION_HEADER } from '../lib/client-activity'
import { services } from '../composition'
import type { Member } from '../services/access'
import { refusal } from './respond'

export const agentEventsRoute = new Hono()
const { access, agentEvents } = services

/** 200 events of metadata are far below this; anything larger is not from the app. */
const MAX_BODY_BYTES = 1024 * 1024

async function authAndAuthorize(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

agentEventsRoute.post('/agent-events', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const declared = Number(c.req.header('Content-Length') ?? 0)
  if (declared > MAX_BODY_BYTES) return c.json({ error: 'Request body too large' }, 413)
  const text = await c.req.text()
  if (text.length > MAX_BODY_BYTES) return c.json({ error: 'Request body too large' }, 413)
  let body: unknown
  try { body = JSON.parse(text) } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
  const result = agentEvents.ingest(member, body, c.req.header(CLIENT_VERSION_HEADER) ?? null)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentEventsRoute.get('/agent-events', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentEvents.list(member, c.req.query())
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentEventsRoute.get('/agent-events/summary', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentEvents.summary(member, c.req.query())
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentEventsRoute.get('/agent-events/sandbox', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentEvents.sandboxImpact(member, c.req.query())
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentEventsRoute.get('/agent-events/settings', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentEvents.settings(member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentEventsRoute.put('/agent-events/settings', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  let body: unknown = null
  try { body = await c.req.json() } catch { /* the service answers 400 */ }
  const result = agentEvents.updateSettings(member, body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentEventsRoute.get('/agent-events/settings/retention-preview', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentEvents.retentionPreview(member, c.req.query('days'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentEventsRoute.get('/agent-events/viewers', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentEvents.viewers(member, c.req.query('mode'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
