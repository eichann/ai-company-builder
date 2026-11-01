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
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { selfReportedProvenance } from '../services/record-engine'
import { refusal } from './respond'

export const outboundMailRoute = new Hono()
const { access, outboundMail } = services

async function member(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const m = access.memberOf(companyId, user.id)
  if (!m) return c.json({ error: 'Company not found or access denied' }, 404)
  return m
}

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

function answer<T>(c: Context, result: Outcome<T>, status: 200 | 201 = 200) {
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, status)
}

/** A person's change, with the provenance their app reports (informational only). */
const humanWith = (body: unknown) => ({ kind: 'human' as const, ...selfReportedProvenance(body) })

outboundMailRoute.post('/outbound-recipients', async (c) => {
  const m = await member(c)
  return m instanceof Response ? m : answer(c, await outboundMail.recipients(m, await jsonBody(c)))
})

outboundMailRoute.post('/outbound', async (c) => {
  const m = await member(c)
  if (m instanceof Response) return m
  const body = await jsonBody(c)
  return answer(c, await outboundMail.create(m, humanWith(body), body), 201)
})

outboundMailRoute.get('/outbound/:messageId', async (c) => {
  const m = await member(c)
  return m instanceof Response ? m : answer(c, outboundMail.get(m, c.req.param('messageId')))
})

outboundMailRoute.put('/outbound/:messageId', async (c) => {
  const m = await member(c)
  if (m instanceof Response) return m
  const body = await jsonBody(c)
  return answer(c, await outboundMail.update(m, humanWith(body), c.req.param('messageId'), body))
})

outboundMailRoute.get('/outbound/:messageId/recipients', async (c) => {
  const m = await member(c)
  return m instanceof Response ? m : answer(c, await outboundMail.draftRecipients(m, c.req.param('messageId')))
})

outboundMailRoute.post('/outbound/:messageId/recipients', async (c) => {
  const m = await member(c)
  return m instanceof Response ? m : answer(c, outboundMail.addTyped(m, c.req.param('messageId'), await jsonBody(c)))
})

outboundMailRoute.post('/outbound/:messageId/send', async (c) => {
  const m = await member(c)
  return m instanceof Response ? m : answer(c, await outboundMail.send(m, c.req.param('messageId'), await jsonBody(c)))
})

outboundMailRoute.post('/outbound/:messageId/resolve', async (c) => {
  const m = await member(c)
  return m instanceof Response ? m : answer(c, outboundMail.resolve(m, c.req.param('messageId'), await jsonBody(c)))
})

outboundMailRoute.post('/outbound/:messageId/discard', async (c) => {
  const m = await member(c)
  return m instanceof Response ? m : answer(c, outboundMail.discard(m, c.req.param('messageId')))
})
