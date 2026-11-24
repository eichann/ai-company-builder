/**
 * A member proposes a time job from the AI chat (「AIへの相談」から定期の仕事, `.claude/rules/jobs.md` "Member proposals").
 * Rules: services/job-proposals.ts (approval: services/jobs.ts).
 *
 * The member's AI — mounted at /api/records-ai/job-proposals-ai (a record token; any token bound to an execution run is refused
 * by the service before anything is read):
 *   GET  /places?under=<path>        the existing folders under `under` the member reads (and whether they write)
 *   POST /candidates                 (act) a candidate for the member alone → 201
 *
 * The member's own session — mounted at /api/companies/:companyId (no record token reaches these):
 *   GET  /me/job-set-watch-skills                     the department Skills the caller reads (「見張りを足す」, 4b-4 PR6b)
 *   POST /me/job-candidates                           { trigger, skill, readSkills } a set watch's candidate → 201 (an app showing schema 5)
 *   GET  /me/job-candidates/:candidateId             the caller's candidate
 *   POST /me/job-candidates/:candidateId/submit       { fingerprint } → 201 (200 when submitted already)
 *   POST /me/job-candidates/:candidateId/discard      「やめる」: the creator's own, not submitted yet
 *   GET  /me/job-proposals                            the caller's proposals
 *   POST /me/job-proposals/:proposalId/withdraw       the proposer, only while it waits
 *   GET  /job-proposals?state=                        owner / admin
 *   POST /job-proposals/:proposalId/return            owner / admin { reason } (a fixed code), only while it waits
 */
import { Hono } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { aiActs, aiReads, companyMember, serviceBody } from './guards'
import type { Context } from 'hono'
import { JOB_SCHEMAS_HEADER, parseJobSchemasHeader } from '../../shared/core/jobs'

const { jobProposals } = services

function answer<T>(c: Context, result: Outcome<T>, status: 200 | 201 = 200) {
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, status)
}

export const jobProposalsAiRoute = new Hono()

jobProposalsAiRoute.get('/places', aiReads, async (c) => {
  const h = c.var.holder
  return answer(c, await jobProposals.places(h.member, h.run, c.req.query('under')))
})

jobProposalsAiRoute.post('/candidates', aiActs, serviceBody, async (c) => {
  const h = c.var.holder
  return answer(c, await jobProposals.createCandidate(h.member, h.run, c.var.body), 201)
})

export const jobProposalsRoute = new Hono()

jobProposalsRoute.get('/me/job-set-watch-skills', companyMember, async (c) => answer(c, await jobProposals.setWatchSkills(c.var.member)))

jobProposalsRoute.post('/me/job-candidates', companyMember, serviceBody, async (c) =>
  answer(c, await jobProposals.createSetWatchCandidate(c.var.member, c.var.body, parseJobSchemasHeader(c.req.header(JOB_SCHEMAS_HEADER))), 201))

jobProposalsRoute.get('/me/job-candidates/:candidateId', companyMember, (c) => answer(c, jobProposals.candidate(c.var.member, c.req.param('candidateId'))))

jobProposalsRoute.post('/me/job-candidates/:candidateId/submit', companyMember, serviceBody, async (c) => {
  const result = await jobProposals.submit(c.var.member, c.req.param('candidateId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, result.value.created ? 201 : 200)
})

jobProposalsRoute.post('/me/job-candidates/:candidateId/discard', companyMember, (c) => answer(c, jobProposals.discard(c.var.member, c.req.param('candidateId'))))

jobProposalsRoute.get('/me/job-proposals', companyMember, (c) => answer(c, jobProposals.mine(c.var.member)))

jobProposalsRoute.post('/me/job-proposals/:proposalId/withdraw', companyMember, (c) => answer(c, jobProposals.withdraw(c.var.member, c.req.param('proposalId'))))

jobProposalsRoute.get('/job-proposals', companyMember, (c) => answer(c, jobProposals.list(c.var.member, c.req.query('state'))))

jobProposalsRoute.post('/job-proposals/:proposalId/return', companyMember, serviceBody, (c) =>
  answer(c, jobProposals.returnProposal(c.var.member, c.req.param('proposalId'), c.var.body)))
