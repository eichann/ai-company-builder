/**
 * 定期の仕事 (scheduled jobs, `.claude/rules/jobs.md`; B PR 3a: definitions and approval only — nothing
 * runs yet). Rules: services/jobs.ts. Mounted at /api/companies/:companyId.
 *
 *   GET  /jobs                         owner/admin: every job; anyone else: the jobs they are responsible for
 *   GET  /jobs/:jobId                  with every version (404 for anyone else)
 *   POST /jobs { definition }          owner/admin → 201
 *   PUT  /jobs/:jobId { definition }   owner/admin: a new version
 *   POST /jobs/:jobId/approve          owner/admin { version, fingerprint? }
 *   POST /jobs/:jobId/pause | resume   owner/admin; the responsible person for their own
 *   POST /me/jobs/:jobId/accept        the version's responsible person { version, fingerprint? }
 *   PUT  /jobs-stop { stopped }        owner/admin: 「定期の仕事をすべて止める」 (its own segment: server.md "Route paths")
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const jobsRoute = new Hono()
const { jobs } = services

jobsRoute.get('/jobs', companyMember, async (c) => {
  const result = jobs.list(c.var.member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.get('/jobs/:jobId', companyMember, async (c) => {
  const result = jobs.get(c.var.member, c.req.param('jobId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs', companyMember, serviceBody, async (c) => {
  const result = await jobs.create(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, 201)
})

jobsRoute.put('/jobs/:jobId', companyMember, serviceBody, async (c) => {
  const result = await jobs.update(c.var.member, c.req.param('jobId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs/:jobId/approve', companyMember, serviceBody, async (c) => {
  const result = await jobs.approve(c.var.member, c.req.param('jobId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs/:jobId/pause', companyMember, async (c) => {
  const result = jobs.pause(c.var.member, c.req.param('jobId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs/:jobId/resume', companyMember, async (c) => {
  const result = await jobs.resume(c.var.member, c.req.param('jobId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/me/jobs/:jobId/accept', companyMember, serviceBody, async (c) => {
  const result = await jobs.accept(c.var.member, c.req.param('jobId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.put('/jobs-stop', companyMember, serviceBody, async (c) => {
  const result = jobs.setStopped(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
