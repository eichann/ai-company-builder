/**
 * 「返事の下書きを、わたしの書き方に合わせる」 (contract shared/types/writing-style.ts; rules in
 * services/writing-samples.ts): a member's own newest sent messages, read now with their own permission and
 * handed to their PC, which makes and keeps the summary. Nothing is stored; nothing of a message is logged.
 *
 *   GET /me/writing-sources                         the connectors that could hand them, readable or not
 *   GET /me/writing-sources/:connectorId/samples    that connector's samples
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { companyMember, type CompanyEnv } from './guards'
import { refusal } from './respond'

export const writingSamplesRoute = new Hono<CompanyEnv>()
const { writingSamples } = services

writingSamplesRoute.get('/me/writing-sources', companyMember, async (c) => {
  const r = await writingSamples.sources(c.var.member)
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
})

writingSamplesRoute.get('/me/writing-sources/:connectorId/samples', companyMember, async (c) => {
  const r = await writingSamples.samples(c.var.member, c.req.param('connectorId'))
  if (!r.ok) return refusal(c, r)
  // The member's own words: never kept by a cache on the way.
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value }, 200)
})
