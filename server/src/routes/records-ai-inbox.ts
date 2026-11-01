/**
 * The AI's side of the inbox (来た連絡, `.claude/rules/inbox.md`): the member's
 * PC judges an interaction in its 「AI の番」 (B4) and follows up a 返事のお願い
 * (B5). The thread itself is read through A4's `GET /api/records-ai/threads/:recordId`
 * (the server keeps no body). Mounted at /api/records-ai/inbox with a record token
 * (routes/record-ai-auth.ts); the company and the member come from the
 * token, never the URL or body.
 *
 *   GET  /items/:recordId              state, version, what was made for it; a 返事のお願い's purpose (a read token is enough)
 *   POST /items/:recordId/judgement    { expectedVersion, outcome, reason, … } (an act token; Idempotency-Key within a run)
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { aiActor, keyedWrite } from './record-ai-auth'
import { refusal } from './respond'
import { aiActs, aiReads, serviceBody } from './guards'

export const recordsAiInboxRoute = new Hono()
const { inbox } = services

recordsAiInboxRoute.get('/items/:recordId', aiReads, (c) => {
  const h = c.var.holder
  const r = inbox.item(h.member, c.req.param('recordId'))
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
})

recordsAiInboxRoute.post('/items/:recordId/judgement', aiActs, serviceBody, async (c) => {
  const h = c.var.holder
  const body = c.var.body
  return keyedWrite(c, h, 'inbox-judgement', body, async () => {
    const actor = { id: h.member.userId, ...aiActor(h) }
    const r = inbox.judge(h.member, actor, c.req.param('recordId'), body)
    if (!r.ok) return refusal(c, r)
    return c.json({ success: true, data: r.value }, 200)
  })
})
