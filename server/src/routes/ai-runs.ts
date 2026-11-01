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
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const aiRunsRoute = new Hono()
const { aiRuns } = services

function answer<T>(c: Context, result: Outcome<T>, status: 200 | 201 = 200) {
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, status)
}

aiRunsRoute.get('/ai-runs', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, aiRuns.list(m))
})

aiRunsRoute.post('/ai-run-claims', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  // The app build that claims (the header every app request carries): part of the run's procedure.
  const r = await aiRuns.claim(m, c.var.body, c.req.header('X-ACB-Client-Version') ?? null)
  return answer(c, r, r.ok && r.value.created ? 201 : 200)
})

aiRunsRoute.get('/ai-runs/:runId', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, aiRuns.get(m, c.req.param('runId')))
})

aiRunsRoute.post('/ai-runs/:runId/renew', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, aiRuns.renew(m, c.req.param('runId'), c.var.body))
})

aiRunsRoute.post('/ai-runs/:runId/finish', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, aiRuns.finish(m, c.req.param('runId'), c.var.body))
})

aiRunsRoute.post('/ai-runs/:runId/retry', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, aiRuns.retry(m, c.req.param('runId')))
})

aiRunsRoute.post('/ai-runs/:runId/operations/:key/reconcile', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, aiRuns.reconcile(m, c.req.param('runId'), c.req.param('key'), c.var.body))
})
