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
 *   GET  /plugins                         the running plugins' operations this AI may call (tools, P7)
 *   POST /plugins/:pluginId/records/:recordId/operations/:operation   a plugin's typed operation
 *        (refresh: read; update and log_meeting: act — Codex's read tokens cannot write)
 *   POST /plugins/:pluginId/create/:operation   a create of a record (create_deal; act) — never auto:
 *        409 APPROVAL_REQUIRED until a person approves (milestone 4)
 *   GET  /plugins/:pluginId/operations/:operationId
 *
 * No undo, no 「もう一度作る」 and nothing it can approve for the AI: a person
 * does those (their app's screens). A create is never re-sent.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import type { RecordTokenHolder } from '../services/record-ai-tokens'
import { noteRequestUser } from '../lib/request-log'
import { refusal } from './respond'

export const recordsAiRoute = new Hono()
const { records, recordEngine, recordAiTokens, pluginOperations, decisions } = services

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

function answer<T>(c: Context, result: Outcome<T>, status: 200 | 201 = 200) {
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
  return answer(c, await pluginOperations.run(h.member, aiActor(h), c.req.param('pluginId'), c.req.param('recordId'), c.req.param('operation'), await jsonBody(c)))
})

// A create of a record (create_deal; milestone 4): writes, so an act token only. Never auto: APPROVAL_REQUIRED.
recordsAiRoute.post('/plugins/:pluginId/create/:operation', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  return answer(c, await pluginOperations.createRecord(h.member, aiActor(h), c.req.param('pluginId'), c.req.param('operation'), await jsonBody(c)))
})

recordsAiRoute.get('/plugins/:pluginId/operations/:operationId', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await pluginOperations.get(h.member, c.req.param('pluginId'), c.req.param('operationId')))
})
