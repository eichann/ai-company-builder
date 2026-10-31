/**
 * The company map for the member's AI (`.claude/rules/records.md` "Who is
 * acting"). Mounted at /api/records-ai. Authenticated by a record token
 * (`Authorization: Bearer acb_rec_…`, issued to the member's app per chat
 * turn — routes/records.ts `POST /me/record-tokens`), never by a session:
 * everything done here is recorded as the member's AI (actor kind `ai`),
 * whatever the request body says. A `read` token only looks up.
 *
 *   GET  /types   GET /my-turn   POST /query   GET /item/:recordId
 *   GET  /item/:recordId/history
 *   POST /item                                  (act)
 *   POST /item/:recordId/actions/:action         (act)
 *
 * No undo for the AI: a person undoes (their app's screens).
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import type { RecordTokenHolder } from '../services/record-ai-tokens'
import { noteRequestUser } from '../lib/request-log'
import { refusal } from './respond'

export const recordsAiRoute = new Hono()
const { records, recordEngine, recordAiTokens } = services

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
