/**
 * 定期の仕事 (scheduled jobs, `.claude/rules/jobs.md`; B PR 3a: definitions and approval; PR 3b: the
 * occurrences the clock made). Rules: services/jobs.ts. Mounted at /api/companies/:companyId.
 *
 *   GET  /jobs                         owner/admin: every job; anyone else: the jobs they are responsible for
 *   GET  /jobs/:jobId                  with every version (404 for anyone else)
 *   GET  /jobs/:jobId/occurrences      its occurrences, newest first (the same people; 404 for anyone else)
 *   POST /jobs { definition }          owner/admin → 201
 *   PUT  /jobs/:jobId { definition }   owner/admin: a new version
 *   POST /jobs/:jobId/approve          owner/admin { version, fingerprint? }
 *   POST /jobs/:jobId/pause | resume   owner/admin; the responsible person for their own
 *   POST /me/jobs/:jobId/accept        the version's responsible person { version, fingerprint? }
 *   POST /me/jobs/:jobId/watch         the responsible person of an event job: the next watched やること { version, recordId } (4a)
 *   PUT  /jobs-stop { stopped }        owner/admin: 「定期の仕事をすべて止める」 (its own segment: server.md "Route paths")
 *   GET  /me/job-turns                 the caller's PC-job occurrences they may claim now (B PR 5a, services/job-runs.ts)
 *   POST /job-run-claims               the responsible person's app claims one { occurrenceId, deviceId, conversationId }
 *                                      (the run core of services/ai-runs.ts; `/job-run-claims`, not `/jobs/…`: its own segment)
 *   POST /jobs/:jobId/occurrences/:occurrenceId/retry                      owner/admin: 「もう一度」 (B PR 5b, services/job-retry.ts)
 *   POST /jobs/:jobId/occurrences/:occurrenceId/operations/:key/reconcile  owner/admin { done }: its run's unknown outside result
 */
import { Hono, type Context } from 'hono'
import { JOB_NEEDS_NEWER_APP, JOB_SCHEMAS_HEADER, parseJobOccurrenceKinds, parseJobSchemasHeader } from '../../shared/core/jobs'
import { services } from '../composition'
import { refusal as respondRefusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const jobsRoute = new Hono()
const { jobs, jobRuns, jobRetry, aiRuns } = services

/** The definition schemas the caller reads (jobs.md "Shapes this build does not know"; absent = schema 1). */
const reads = (c: Context) => parseJobSchemasHeader(c.req.header(JOB_SCHEMAS_HEADER))

/**
 * A refusal as the caller reads it: the desktop app (every build sends `X-ACB-Client-Version`) is told to update the
 * app, not to reload a screen (stage 4a; the code stays `JOB_NEEDS_NEWER_SCREEN`).
 */
const refusal: typeof respondRefusal = (c, r) => {
  const appCaller = typeof c.req.header('X-ACB-Client-Version') === 'string'
  if (appCaller && r.body.code === 'JOB_NEEDS_NEWER_SCREEN') return respondRefusal(c, { ...r, body: { ...r.body, error: `${JOB_NEEDS_NEWER_APP}。` } })
  return respondRefusal(c, r)
}

jobsRoute.get('/jobs', companyMember, async (c) => {
  const result = jobs.list(c.var.member, reads(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.get('/jobs/:jobId', companyMember, async (c) => {
  const result = jobs.get(c.var.member, c.req.param('jobId'), reads(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.get('/jobs/:jobId/occurrences', companyMember, async (c) => {
  const result = jobs.occurrences(c.var.member, c.req.param('jobId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs/:jobId/occurrences/:occurrenceId/retry', companyMember, async (c) => {
  const result = jobRetry.retry(c.var.member, c.req.param('jobId'), c.req.param('occurrenceId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs/:jobId/occurrences/:occurrenceId/operations/:key/reconcile', companyMember, serviceBody, async (c) => {
  const result = jobRetry.reconcile(c.var.member, c.req.param('jobId'), c.req.param('occurrenceId'), c.req.param('key'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs', companyMember, serviceBody, async (c) => {
  const result = await jobs.create(c.var.member, c.var.body, reads(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, 201)
})

jobsRoute.put('/jobs/:jobId', companyMember, serviceBody, async (c) => {
  const result = await jobs.update(c.var.member, c.req.param('jobId'), c.var.body, reads(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs/:jobId/approve', companyMember, serviceBody, async (c) => {
  const result = await jobs.approve(c.var.member, c.req.param('jobId'), c.var.body, reads(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs/:jobId/pause', companyMember, async (c) => {
  const result = jobs.pause(c.var.member, c.req.param('jobId'), reads(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/jobs/:jobId/resume', companyMember, async (c) => {
  const result = await jobs.resume(c.var.member, c.req.param('jobId'), reads(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/me/jobs/:jobId/accept', companyMember, serviceBody, async (c) => {
  const result = await jobs.accept(c.var.member, c.req.param('jobId'), c.var.body, reads(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

// Stage 4a, owner decision ①: the responsible person chooses the next watched やること of their event job.
jobsRoute.post('/me/jobs/:jobId/watch', companyMember, serviceBody, async (c) => {
  const result = await jobs.rewatch(c.var.member, c.req.param('jobId'), c.var.body, reads(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.put('/jobs-stop', companyMember, serviceBody, async (c) => {
  const result = jobs.setStopped(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.get('/me/job-turns', companyMember, async (c) => {
  // The occurrence kinds the app runs (`?kinds=time,event`; absent = time, every app before stage 4-0).
  const kinds = parseJobOccurrenceKinds(c.req.query('kinds'))
  if (kinds === null) return c.json({ error: 'kinds is a list of occurrence kinds', code: 'BAD_REQUEST' }, 400)
  const result = jobRuns.turns(c.var.member, kinds)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

jobsRoute.post('/job-run-claims', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  // The app build that claims (the header every app request carries): part of the run's procedure.
  const result = await aiRuns.claimOccurrence(m, c.var.body, c.req.header('X-ACB-Client-Version') ?? null)
  if (!result.ok) return refusal(c, result)
  const turn = jobRuns.turnOf(m, result.value.run.subject?.id ?? '')
  return c.json({ success: true, data: { ...result.value, turn } }, result.value.created ? 201 : 200)
})
