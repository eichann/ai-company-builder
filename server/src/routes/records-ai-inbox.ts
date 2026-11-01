/**
 * The AI's side of the inbox (来た連絡, `.claude/rules/inbox.md`): the member's
 * PC judges an interaction in its 「AI の番」 (B4) — reading the message
 * itself through the role, by the pointers this route answers (the server
 * keeps no body). Mounted at /api/records-ai/inbox with a record token
 * (routes/record-ai-auth.ts); the company and the member come from the
 * token, never the URL or body.
 *
 *   GET  /items/:recordId              the thread's pointers (a read token is enough)
 *   GET  /items/:recordId/thread       the thread's text now, through the role (B4; never stored)
 *   POST /items/:recordId/judgement    { expectedVersion, outcome, reason, … } (an act token; Idempotency-Key within a run)
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { aiActor, connectorRoleRefusal, keyedWrite } from './record-ai-auth'
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

recordsAiInboxRoute.get('/items/:recordId/thread', aiReads, async (c) => {
  const h = c.var.holder
  const recordId = c.req.param('recordId')
  // A business plugin's step may use only the roles it declares (C4): mail or chat, by the record's channel.
  const pointers = inbox.item(h.member, recordId)
  const gate = await connectorRoleRefusal(c, h, pointers.ok && pointers.value.channel === 'chat' ? 'chat' : 'mail')
  if (gate) return gate
  const r = await inbox.thread(h.member, recordId)
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
