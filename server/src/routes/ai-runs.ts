/**
 * Execution runs of 「AI の番」 (stage 2 S10b, `.claude/rules/records.md`
 * "Execution runs"). Mounted at /api/companies/:companyId; the member's
 * session only (their app's main process claims, renews and finishes; the
 * member presses 「もう一度」 and reconciles). Contract: shared/types/ai-runs.ts;
 * rules: services/ai-runs.ts. A run is its member's: anyone else, another
 * company's id and a missing one get the same 404. Non-members get 404 like
 * every company route.
 *
 *   GET  /ai-runs                                    the member's open runs
 *   POST /ai-run-claims                              claim (or re-claim) a record's AI step
 *   GET  /ai-runs/:runId
 *   POST /ai-runs/:runId/renew                       { generation }
 *   POST /ai-runs/:runId/finish                      { generation, outcome, failure? }
 *   POST /ai-runs/:runId/retry                       「もう一度」
 *   POST /ai-runs/:runId/operations/:key/reconcile   { done }
 *
 * `/ai-run-claims`, not `/ai-runs/claim`: a static segment next to `:runId`
 * makes Hono change routers (records.md).
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const aiRunsRoute = new Hono()
const { access, aiRuns } = services

async function memberOf(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

function answer<T>(c: Context, result: Outcome<T>, status: 200 | 201 = 200) {
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, status)
}

aiRunsRoute.get('/ai-runs', async (c) => {
  const m = await memberOf(c)
  return m instanceof Response ? m : answer(c, aiRuns.list(m))
})

aiRunsRoute.post('/ai-run-claims', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  const r = aiRuns.claim(m, await jsonBody(c))
  return answer(c, r, r.ok && r.value.created ? 201 : 200)
})

aiRunsRoute.get('/ai-runs/:runId', async (c) => {
  const m = await memberOf(c)
  return m instanceof Response ? m : answer(c, aiRuns.get(m, c.req.param('runId')))
})

aiRunsRoute.post('/ai-runs/:runId/renew', async (c) => {
  const m = await memberOf(c)
  return m instanceof Response ? m : answer(c, aiRuns.renew(m, c.req.param('runId'), await jsonBody(c)))
})

aiRunsRoute.post('/ai-runs/:runId/finish', async (c) => {
  const m = await memberOf(c)
  return m instanceof Response ? m : answer(c, aiRuns.finish(m, c.req.param('runId'), await jsonBody(c)))
})

aiRunsRoute.post('/ai-runs/:runId/retry', async (c) => {
  const m = await memberOf(c)
  return m instanceof Response ? m : answer(c, aiRuns.retry(m, c.req.param('runId')))
})

aiRunsRoute.post('/ai-runs/:runId/operations/:key/reconcile', async (c) => {
  const m = await memberOf(c)
  return m instanceof Response ? m : answer(c, aiRuns.reconcile(m, c.req.param('runId'), c.req.param('key'), await jsonBody(c)))
})
