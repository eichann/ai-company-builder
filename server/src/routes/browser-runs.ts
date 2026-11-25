/**
 * The operator's runs of 「ブラウザ操作」 (redesign step ④; agent-browser.md "The operator's window tools"). Rules:
 * services/browser-runs.ts; shapes: shared/types/browser-runs.ts. A person's session only.
 *
 * Mounted at /api/companies/:companyId:
 *   POST /browser-runs                     { host, conversationId? } + this PC's key header: the gate, the company × domain lock
 *   POST /browser-runs/:runId/continue     + this PC's key header: before each step, the gate again; the lease renewed
 *   POST /browser-runs/:runId/finish       { outcome, reason?, steps }: the run's log (no value), the lock released
 *   GET  /browser-runs                     the member's own runs; owner / admin: everyone's
 */
import { Hono } from 'hono'
import { BROWSER_DEVICE_HEADER } from '../../shared/core/browser-device'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const browserRunsRoute = new Hono()
const { browserRuns } = services

browserRunsRoute.post('/browser-runs', companyMember, serviceBody, (c) => {
  const r = browserRuns.start(c.var.member, c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }, 201) : refusal(c, r)
})

browserRunsRoute.post('/browser-runs/:runId/continue', companyMember, (c) => {
  const r = browserRuns.continue(c.var.member, c.req.param('runId'), c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserRunsRoute.post('/browser-runs/:runId/finish', companyMember, serviceBody, (c) => {
  const r = browserRuns.finish(c.var.member, c.req.param('runId'), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserRunsRoute.get('/browser-runs', companyMember, (c) => {
  const r = browserRuns.list(c.var.member)
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})
