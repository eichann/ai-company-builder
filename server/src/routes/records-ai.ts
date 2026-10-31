/**
 * The company map for the member's AI (`.claude/rules/records.md` "Who is
 * acting"). Mounted at /api/records-ai. Authenticated by a record token
 * (`Authorization: Bearer acb_rec_…`, issued to the member's app per chat
 * turn — routes/records.ts `POST /me/record-tokens`), never by a session:
 * everything done here is recorded as the member's AI (actor kind `ai`),
 * whatever the request body says. A `read` token only looks up.
 *
 *   GET  /types   GET /my-turn   GET /ai-turn   POST /query   GET /item/:recordId
 *   GET  /item/:recordId/history
 *   POST /item                                  (act)
 *   POST /decisions                             (act) record a decision (services/decisions.ts)
 *   POST /item/:recordId/actions/:action         (act)
 *
 *   GET  /minutes/:recordId/text          the minutes as outside text (tool minutes_read; G7, minutes.md):
 *                                         the assignee or an attendee, read now from Google with
 *                                         the member's own permission; never stored or logged
 *   POST /minutes/:recordId/deal          (act) { dealId, expectedVersion? } — the assignee / an admin's AI
 *
 *   GET  /plugins                         the running plugins' operations this AI may call (tools, P7)
 *   POST /plugins/:pluginId/records/:recordId/operations/:operation   a plugin's typed operation
 *        (refresh: read; update and log_meeting: act — Codex's read tokens cannot write)
 *   POST /plugins/:pluginId/create/:operation   a create of a record (create_deal; act) — never auto:
 *        it becomes an approval request (202) that a person approves
 *   GET  /plugins/:pluginId/operations/:operationId
 *   GET  /approvals   GET /approvals/:approvalId   approval requests, read only (approvals.md)
 *
 * No undo, no 「もう一度作る」 and nothing it can approve, send back or withdraw for
 * the AI: a person does those (their app's screens; routes/approvals.ts, session
 * only). A create is never re-sent.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import type { RecordTokenHolder } from '../services/record-ai-tokens'
import { noteRequestUser } from '../lib/request-log'
import { refusal } from './respond'

export const recordsAiRoute = new Hono()
const { records, recordEngine, recordAiTokens, pluginOperations, decisions, approvals, minutes } = services

function holderOf(c: Context, needs: 'read' | 'act'): RecordTokenHolder | Response {
  const auth = recordAiTokens.authenticate(c.req.header('Authorization'))
  if (!auth.ok) return refusal(c, auth)
  noteRequestUser(c.req.raw, auth.value.member.userId)
  if (needs === 'act' && auth.value.scope !== 'act') {
    return c.json({ error: 'この AI は記録を読むことだけができます', code: 'READ_ONLY_TOKEN' }, 403)
  }
  return auth.value
}

// The conversation comes from the token, never the body (a body's proposedBy / conversationId is ignored here).
const aiActor = (h: RecordTokenHolder) => ({ kind: 'ai' as const, source: h.agent, conversationId: h.conversationId })

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

function answer<T>(c: Context, result: Outcome<T>, status: 200 | 201 | 202 = 200) {
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, status)
}

recordsAiRoute.get('/types', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, records.types(h.member))
})

recordsAiRoute.get('/my-turn', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, records.myTurn(h.member))
})

recordsAiRoute.get('/ai-turn', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, records.aiTurn(h.member))
})

recordsAiRoute.post('/decisions', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  const result = await decisions.record(h.member, aiActor(h), await jsonBody(c))
  return answer(c, result, result.ok && result.value.created ? 201 : 200)
})

recordsAiRoute.get('/minutes/:recordId/text', async (c) => {
  const h = holderOf(c, 'read')
  if (h instanceof Response) return h
  c.header('Cache-Control', 'no-store')
  return answer(c, await minutes.text(h.member, c.req.param('recordId')))
})

recordsAiRoute.post('/minutes/:recordId/deal', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  const { kind, source, conversationId } = aiActor(h)
  return answer(c, minutes.linkDeal(h.member, { kind, source, conversationId }, c.req.param('recordId'), await jsonBody(c)))
})

recordsAiRoute.post('/query', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, records.query(h.member, await jsonBody(c)))
})

recordsAiRoute.get('/item/:recordId', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, records.get(h.member, c.req.param('recordId')))
})

recordsAiRoute.get('/item/:recordId/history', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, recordEngine.history(h.member, c.req.param('recordId')))
})

recordsAiRoute.post('/item', async (c) => {
  const h = holderOf(c, 'act')
  return h instanceof Response ? h : answer(c, recordEngine.create(h.member, aiActor(h), await jsonBody(c)), 201)
})

recordsAiRoute.post('/item/:recordId/actions/:action', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  return answer(c, await recordEngine.act(h.member, aiActor(h), c.req.param('recordId'), c.req.param('action'), await jsonBody(c)))
})

// The operations the app turns into this AI's tools (a read token: reads only).
recordsAiRoute.get('/plugins', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await services.plugins.aiTools(h.member, h.scope))
})

// A plugin's typed operation: a read token may only run operations that read (refresh).
recordsAiRoute.post('/plugins/:pluginId/records/:recordId/operations/:operation', async (c) => {
  const h = holderOf(c, 'read')
  if (h instanceof Response) return h
  if (h.scope !== 'act' && services.plugins.operationKind(h.member.companyId, c.req.param('pluginId'), c.req.param('operation')) !== 'read') {
    return c.json({ error: 'この AI は読むことだけができます', code: 'READ_ONLY_TOKEN' }, 403)
  }
  // Needing approval: the request is made (202) — the AI asks, a person approves (routes/approvals.ts, session only).
  const r = await approvals.runOrRequest(h.member, aiActor(h), c.req.param('pluginId'), c.req.param('recordId'), c.req.param('operation'), await jsonBody(c))
  const requested = r.ok && typeof r.value === 'object' && r.value !== null && (r.value as { outcome?: unknown }).outcome === 'approval-requested'
  return answer(c, r, requested ? 202 : 200)
})

// Approval requests, read only: the AI lists and shows them (「承認待ちを見せて」); it has no way to approve.
recordsAiRoute.get('/approvals', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await approvals.list(h.member, { scope: c.req.query('scope'), state: c.req.query('state') }))
})

recordsAiRoute.get('/approvals/:approvalId', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await approvals.get(h.member, c.req.param('approvalId')))
})

// A create of a record (create_deal; milestone 4): writes, so an act token only. Never auto: an approval request (202).
recordsAiRoute.post('/plugins/:pluginId/create/:operation', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  const r = await approvals.createOrRequest(h.member, aiActor(h), c.req.param('pluginId'), c.req.param('operation'), await jsonBody(c))
  const requested = r.ok && typeof r.value === 'object' && r.value !== null && (r.value as { outcome?: unknown }).outcome === 'approval-requested'
  return answer(c, r, requested ? 202 : 200)
})

recordsAiRoute.get('/plugins/:pluginId/operations/:operationId', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await pluginOperations.get(h.member, c.req.param('pluginId'), c.req.param('operationId')))
})
