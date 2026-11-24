/**
 * 「ブラウザ操作」's opened lines on the server (generalization PR 4; agent-browser.md "Plans of opened lines on the
 * server"). Rules: services/browser-lines.ts, services/browser-line-steps.ts; shapes: shared/types/browser-lines.ts.
 * The app calls them since PR 5b / 5c (inspect.ts, write-lines.ts). A person's session only, except a write execution's report (its secret).
 *
 * The steps the server gates (create, approve, claim, permit) also take this PC's key header (`X-ACB-Browser-Device`,
 * agent-browser.md "This PC's registration").
 *
 * Mounted at /api/companies/:companyId:
 *   POST /browser-line-plans                                  an inspection of an approved line; with `account`: a plan of writes (draft)
 *   GET  /browser-line-plans/:planId                          the member's own
 *   POST /browser-line-plans/:planId/result                   the inspection's result, once (fixed words)
 *   POST /browser-line-plans/:planId/approve | cancel | claim a plan of writes (only of an approved line that writes)
 *   POST /browser-line-executions/:executionId/permit         X-ACB-Browser-Execution: <secret>; { index }: one write
 *   POST /browser-line-executions/:executionId/confirm        { index, result: done | not_done }
 *   GET  /browser-line-grants                                 owner/admin: approved lines and who may use them
 *   PUT  /browser-line-grants/:userId                         owner/admin: { site, line, meaningHash, mechanicsHash, allowed }
 *   POST /browser-shape-notices                               a thing not read whole (the map's names, a kind, a count)
 *   GET  /browser-shape-notices                               owner/admin: what changed shape
 *   GET  /browser-lines-mine                                  the approved lines the member may use (names only)
 * Mounted at /api:
 *   POST /browser-line-executions/report                      X-ACB-Browser-Execution: <secret>; { index, result, … }
 */
import { Hono } from 'hono'
import { BROWSER_DEVICE_HEADER } from '../../shared/core/browser-device'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, ownCredential, serviceBody } from './guards'
import { BROWSER_EXECUTION_HEADER } from './browser-plans'

export const browserLinesRoute = new Hono()
const { browserLines } = services

browserLinesRoute.post('/browser-line-plans', companyMember, serviceBody, (c) => {
  const r = browserLines.create(c.var.member, c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }, 201) : refusal(c, r)
})

browserLinesRoute.get('/browser-line-plans/:planId', companyMember, (c) => {
  const r = browserLines.get(c.var.member, c.req.param('planId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserLinesRoute.post('/browser-line-plans/:planId/result', companyMember, serviceBody, (c) => {
  const r = browserLines.result(c.var.member, c.req.param('planId'), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserLinesRoute.post('/browser-line-plans/:planId/approve', companyMember, serviceBody, (c) => {
  const r = browserLines.approve(c.var.member, c.req.param('planId'), c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserLinesRoute.post('/browser-line-plans/:planId/cancel', companyMember, (c) => {
  const r = browserLines.cancel(c.var.member, c.req.param('planId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserLinesRoute.post('/browser-line-plans/:planId/claim', companyMember, (c) => {
  const r = browserLines.claim(c.var.member, c.req.param('planId'), c.req.header(BROWSER_DEVICE_HEADER))
  if (!r.ok) return refusal(c, r)
  // The secret is answered this once: never stored, never cached on the way.
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserLinesRoute.post('/browser-line-executions/:executionId/permit', companyMember, serviceBody, (c) => {
  const r = browserLines.permit(c.var.member, c.req.param('executionId'), c.req.header(BROWSER_EXECUTION_HEADER), c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserLinesRoute.post('/browser-line-executions/:executionId/confirm', companyMember, serviceBody, (c) => {
  const r = browserLines.confirm(c.var.member, c.req.param('executionId'), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserLinesRoute.get('/browser-line-grants', companyMember, (c) => {
  const r = browserLines.grants(c.var.member)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserLinesRoute.put('/browser-line-grants/:userId', companyMember, serviceBody, (c) => {
  const r = browserLines.setGrant(c.var.member, c.req.param('userId'), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserLinesRoute.post('/browser-shape-notices', companyMember, serviceBody, (c) => {
  const r = browserLines.shapeNotice(c.var.member, c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

// Its own segment (not /browser-lines/mine): keeps Hono's RegExpRouter (server.md).
browserLinesRoute.get('/browser-lines-mine', companyMember, (c) => {
  const r = browserLines.mine(c.var.member)
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserLinesRoute.get('/browser-shape-notices', companyMember, (c) => {
  const r = browserLines.shapeNotices(c.var.member)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

/** A write's report: the execution's secret finds its company (the member may have left since). */
export const browserLineReportRoute = new Hono()

browserLineReportRoute.post('/browser-line-executions/report', ownCredential('the execution secret of a browser line plan (agent-browser.md)'), serviceBody, (c) => {
  const r = browserLines.report(c.req.header(BROWSER_EXECUTION_HEADER), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})
