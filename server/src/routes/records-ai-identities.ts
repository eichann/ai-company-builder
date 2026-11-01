/**
 * The AI's side of matching people and companies (名寄せ,
 * `.claude/rules/identity.md`): it may only propose; a person approves on the
 * member routes (routes/identities.ts). Mounted at /api/records-ai/identities
 * with a record token (routes/record-ai-auth.ts); the company and the member
 * come from the token, never the URL or body.
 *
 *   POST /proposals   { a, b, reason, confidence? }  (an act token)
 *   GET  /records/:recordId   the 相手's identity as the member may see it (a read token is enough)
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { holderOf } from './record-ai-auth'
import { refusal } from './respond'

export const recordsAiIdentitiesRoute = new Hono()
const { identities } = services

recordsAiIdentitiesRoute.post('/proposals', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  let body: unknown = null
  try { body = await c.req.json() } catch { body = null }
  const r = identities.propose(h.member, { kind: 'ai' }, body)
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, r.value.created ? 201 : 200)
})

recordsAiIdentitiesRoute.get('/records/:recordId', (c) => {
  const h = holderOf(c, 'read')
  if (h instanceof Response) return h
  const r = identities.ofRecord(h.member, c.req.param('recordId'))
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
})
