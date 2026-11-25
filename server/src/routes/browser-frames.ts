/**
 * 「ブラウザ操作」's writes within frames (redesign step ⑤a; agent-browser.md "Writes within frames"). Rules:
 * services/browser-frames.ts; shapes: shared/types/browser-frames.ts. The member's session only; start, approve, permit
 * and a sure report also take this PC's key header (`X-ACB-Browser-Device`). Nothing in the app calls them yet (step ⑤b).
 *
 * Mounted at /api/companies/:companyId:
 *   POST /browser-frame-runs                    { skill } | { plan: { domain, writes } } (+ conversationId): a run and its
 *                                               frames; a waiting run's one-time `approvalToken` is answered here only
 *   GET  /browser-frame-runs/:runId             the member's own (never the approval value)
 *   POST /browser-frame-runs/:runId/approve     { planHash, approvalToken }: the person approved the plan the card showed
 *   POST /browser-frame-runs/:runId/permit      { frame, request: { method, path, fields } }: one write that fits that frame
 *   POST /browser-frame-runs/:runId/report      { write, result: done | not_sent | unknown, reason? }
 *   POST /browser-frame-runs/:runId/end         the run ends; its unused frames vanish
 */
import { Hono } from 'hono'
import { BROWSER_DEVICE_HEADER } from '../../shared/core/browser-device'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const browserFramesRoute = new Hono()
const { browserFrames } = services

browserFramesRoute.post('/browser-frame-runs', companyMember, serviceBody, async (c) => {
  const r = await browserFrames.start(c.var.member, c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value }, 201)
})

browserFramesRoute.get('/browser-frame-runs/:runId', companyMember, (c) => {
  const r = browserFrames.get(c.var.member, c.req.param('runId'))
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserFramesRoute.post('/browser-frame-runs/:runId/approve', companyMember, serviceBody, async (c) => {
  const r = await browserFrames.approve(c.var.member, c.req.param('runId'), c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserFramesRoute.post('/browser-frame-runs/:runId/permit', companyMember, serviceBody, async (c) => {
  const r = await browserFrames.permit(c.var.member, c.req.param('runId'), c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserFramesRoute.post('/browser-frame-runs/:runId/report', companyMember, serviceBody, (c) => {
  const r = browserFrames.report(c.var.member, c.req.param('runId'), c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserFramesRoute.post('/browser-frame-runs/:runId/end', companyMember, (c) => {
  const r = browserFrames.end(c.var.member, c.req.param('runId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})
