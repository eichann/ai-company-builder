/**
 * 「ブラウザ操作」 plans (PR 6a; agent-browser.md "Plans, executions, permits and locks"). Rules:
 * services/browser-plans.ts; shapes: shared/types/browser-plans.ts. Nothing in the app calls these
 * yet (6b). A person's session only — no record-token route exists — except the report, which the
 * execution's secret alone proves.
 *
 * The steps the server gates (register, approve, claim, send-permit) also take this PC's key header
 * (`X-ACB-Browser-Device`, agent-browser.md "This PC's registration").
 *
 * Mounted at /api/companies/:companyId:
 *   POST /browser-plans                                   register a candidate + facts (draft)
 *   GET  /browser-plans-open                              the member's own draft / approved plans, newest first
 *   GET  /browser-plans/:planId                           the member's own plan
 *   POST /browser-plans/:planId/approve                   { contentHash } the content the member saw
 *   POST /browser-plans/:planId/cancel                    「やめる」
 *   POST /browser-plans/:planId/claim                     once: the execution, its secret, the fixed plan
 *   POST /browser-executions/:executionId/send-permit     X-ACB-Browser-Execution: <secret>; once, 5 s
 *   POST /browser-executions/:executionId/confirm         { result: done | not_done } 済んでいた / されていなかった
 *   GET  /browser-executions-waiting?after=               「確かめ待ち」, a page at a time
 *   GET  /browser-type-grants                             owner/admin: types and who may use them
 *   PUT  /browser-type-grants/:userId                     owner/admin: { connector, operation, declarationHash, allowed }
 * Mounted at /api:
 *   POST /browser-executions/report                       X-ACB-Browser-Execution: <secret>; { result, reason? }
 */
import { Hono } from 'hono'
import { BROWSER_DEVICE_HEADER } from '../../shared/core/browser-device'
import { services } from '../composition'
import { CLIENT_VERSION_HEADER } from '../lib/client-activity'
import { refusal } from './respond'
import { companyMember, ownCredential, serviceBody } from './guards'

/** The header carrying an execution's secret (never a URL: it would reach logs). */
export const BROWSER_EXECUTION_HEADER = 'X-ACB-Browser-Execution'

export const browserPlansRoute = new Hono()
const { browserPlans } = services

browserPlansRoute.post('/browser-plans', companyMember, serviceBody, (c) => {
  const r = browserPlans.register(c.var.member, c.var.body, c.req.header(CLIENT_VERSION_HEADER), c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }, 201) : refusal(c, r)
})

// Its own segment (not /browser-plans/open beside /browser-plans/:planId): keeps Hono's RegExpRouter (server.md).
browserPlansRoute.get('/browser-plans-open', companyMember, (c) => {
  const r = browserPlans.open(c.var.member)
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserPlansRoute.get('/browser-plans/:planId', companyMember, (c) => {
  const r = browserPlans.get(c.var.member, c.req.param('planId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserPlansRoute.post('/browser-plans/:planId/approve', companyMember, serviceBody, (c) => {
  const r = browserPlans.approve(c.var.member, c.req.param('planId'), c.var.body, c.req.header(CLIENT_VERSION_HEADER), c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserPlansRoute.post('/browser-plans/:planId/cancel', companyMember, (c) => {
  const r = browserPlans.cancel(c.var.member, c.req.param('planId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserPlansRoute.post('/browser-plans/:planId/claim', companyMember, (c) => {
  const r = browserPlans.claim(c.var.member, c.req.param('planId'), c.req.header(CLIENT_VERSION_HEADER), c.req.header(BROWSER_DEVICE_HEADER))
  if (!r.ok) return refusal(c, r)
  // The secret is answered this once: never stored, never cached on the way.
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserPlansRoute.post('/browser-executions/:executionId/send-permit', companyMember, (c) => {
  const r = browserPlans.permit(c.var.member, c.req.param('executionId'), c.req.header(BROWSER_EXECUTION_HEADER), c.req.header(CLIENT_VERSION_HEADER), c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserPlansRoute.post('/browser-executions/:executionId/confirm', companyMember, serviceBody, (c) => {
  const r = browserPlans.confirm(c.var.member, c.req.param('executionId'), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserPlansRoute.get('/browser-executions-waiting', companyMember, (c) => {
  const r = browserPlans.waiting(c.var.member, c.req.query('after'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserPlansRoute.get('/browser-type-grants', companyMember, (c) => {
  const r = browserPlans.grants(c.var.member)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserPlansRoute.put('/browser-type-grants/:userId', companyMember, serviceBody, (c) => {
  const r = browserPlans.setGrant(c.var.member, c.req.param('userId'), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

/** The report: the execution's secret finds its company (the member may have left since). */
export const browserReportRoute = new Hono()

browserReportRoute.post('/browser-executions/report', ownCredential('the execution secret of a browser plan (agent-browser.md)'), serviceBody, (c) => {
  const r = browserPlans.report(c.req.header(BROWSER_EXECUTION_HEADER), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})
