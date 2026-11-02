/**
 * Outbound mail for the member's own screens (milestone 4 G8,
 * `.claude/rules/outbound-mail.md`; contract shared/types/outbound-mail.ts).
 * Mounted at /api/companies/:companyId. The member's **session** only: these
 * are the only routes that send, add a typed address, resolve or discard. The
 * member's AI drafts through /api/records-ai/outbound (records-ai.ts), which
 * has none of them.
 *
 *   POST /outbound-recipients               verified recipients of a minutes / deal
 *   POST /outbound                          a new draft
 *   GET  /outbound/:messageId               the author's draft
 *   PUT  /outbound/:messageId               a new version
 *   GET  /outbound/:messageId/recipients    the draft's candidates (typed ones included)
 *   POST /outbound/:messageId/recipients    「あなたが入力」 an address
 *   POST /outbound/:messageId/send          「確かめて送る」 { hash }
 *   POST /outbound/:messageId/resolve       { sent } after an unknown send
 *   POST /outbound/:messageId/discard       「捨てる」
 *
 * The recipients of a context are `/outbound-recipients`, not
 * `/outbound/recipients`: a static segment next to `/outbound/:messageId`
 * would make Hono fall back to another router (records.md).
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { selfReportedProvenance } from '../services/record-engine'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const outboundMailRoute = new Hono()
const { outboundMail } = services

function answer<T>(c: Context, result: Outcome<T>, status: 200 | 201 = 200) {
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, status)
}

/** A person's change, with the provenance their app reports (informational only). */
const humanWith = (body: unknown) => ({ kind: 'human' as const, ...selfReportedProvenance(body) })

outboundMailRoute.post('/outbound-recipients', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, await outboundMail.recipients(m, c.var.body))
})

outboundMailRoute.post('/outbound', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  const body = c.var.body
  const result = await outboundMail.create(m, humanWith(body), body)
  return answer(c, result, result.ok && result.value.reused ? 200 : 201)
})

outboundMailRoute.get('/outbound/:messageId', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, outboundMail.get(m, c.req.param('messageId')))
})

outboundMailRoute.put('/outbound/:messageId', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  const body = c.var.body
  return answer(c, await outboundMail.update(m, humanWith(body), c.req.param('messageId'), body))
})

outboundMailRoute.get('/outbound/:messageId/recipients', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, await outboundMail.draftRecipients(m, c.req.param('messageId')))
})

outboundMailRoute.post('/outbound/:messageId/recipients', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, outboundMail.addTyped(m, c.req.param('messageId'), c.var.body))
})

outboundMailRoute.post('/outbound/:messageId/send', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, await outboundMail.send(m, c.req.param('messageId'), c.var.body))
})

outboundMailRoute.post('/outbound/:messageId/resolve', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, outboundMail.resolve(m, c.req.param('messageId'), c.var.body))
})

outboundMailRoute.post('/outbound/:messageId/discard', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, outboundMail.discard(m, c.req.param('messageId')))
})
