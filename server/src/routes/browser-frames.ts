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
 *   POST /browser-frame-runs/:runId/promise     { values, binds, decisions }: the run's promise, once, before its first
 *                                               permit (this PC's key; agent-browser.md "The run's promise")
 *   POST /browser-frame-runs/:runId/promise-add { frame, fields, targets, binds }: the person's 「書いてよい」 on the card
 *   POST /browser-frame-runs/:runId/permit      { frame, request: { method, path, fields }, check? }: one write that fits
 *                                               that frame (and keeps the run's promise, when it has one)
 *   POST /browser-frame-runs/:runId/report      { write, result: done | not_sent | unknown | refused, reason?, created?,
 *                                               checked? }
 *   POST /browser-frame-runs/:runId/confirm     { write, answer: done | not_done }: the person's answer about a write in
 *                                               doubt, from the card (this PC's key; it never moves the write or the run)
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

browserFramesRoute.post('/browser-frame-runs/:runId/promise', companyMember, serviceBody, (c) => {
  const r = browserFrames.promise(c.var.member, c.req.param('runId'), c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserFramesRoute.post('/browser-frame-runs/:runId/promise-add', companyMember, serviceBody, (c) => {
  const r = browserFrames.promiseAdd(c.var.member, c.req.param('runId'), c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
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

browserFramesRoute.post('/browser-frame-runs/:runId/confirm', companyMember, serviceBody, (c) => {
  const r = browserFrames.confirm(c.var.member, c.req.param('runId'), c.var.body, c.req.header(BROWSER_DEVICE_HEADER))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserFramesRoute.post('/browser-frame-runs/:runId/end', companyMember, (c) => {
  const r = browserFrames.end(c.var.member, c.req.param('runId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})
