/**
 * A business plugin's steps (plan C5, `.claude/rules/plugin-steps.md`).
 * Mounted at /api/companies/:companyId. Contract: shared/types/plugins.ts;
 * rules: services/plugin-steps.ts. Non-members get 404 like every company
 * route; another company's record or plugin is the same 404 as none.
 *
 *   GET  /plugins/:pluginId/step-skills                             owner/admin: each step, overridable, the company's Skill
 *   PUT  /plugins/:pluginId/step-skills/:step                       owner/admin: { skill: name | null } (overridable steps only)
 *   GET  /me/plugin-step-turns                                      the member's records waiting at a `start: ai_turn` step
 *   GET  /me/plugin-steps/records/:recordId                         the steps at the record's state (its card)
 *   POST /me/plugin-steps/records/:recordId/:pluginId/:step/start   a `start: person` step: pins the work's procedure, answers it
 *   POST /me/plugin-steps/consultations                         { conversationId, recordId, pluginId, step }: that consultation's
 *                                                               plugin power is the step's, for good (the C4 gate)
 *
 * The automatic steps are claimed through POST /ai-run-claims (routes/ai-runs.ts)
 * as `<pluginId>__<step>`.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { companyMember, serviceBody } from './guards'
import { refusal } from './respond'

export const pluginStepsRoute = new Hono()
const { pluginSteps } = services

function answer<T>(c: Context, result: Outcome<T>) {
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
}

pluginStepsRoute.get('/plugins/:pluginId/step-skills', companyMember, (c) =>
  answer(c, pluginSteps.stepSkills(c.var.member, c.req.param('pluginId'))))

// The role is checked before the body (a member's 403, not 400): the service reads its own input.
pluginStepsRoute.put('/plugins/:pluginId/step-skills/:step', companyMember, serviceBody, async (c) =>
  answer(c, await pluginSteps.setStepSkill(c.var.member, c.req.param('pluginId'), c.req.param('step'), c.var.body)))

pluginStepsRoute.get('/me/plugin-step-turns', companyMember, (c) =>
  answer(c, pluginSteps.turns(c.var.member)))

pluginStepsRoute.get('/me/plugin-steps/records/:recordId', companyMember, (c) =>
  answer(c, pluginSteps.stepsOn(c.var.member, c.req.param('recordId'))))

pluginStepsRoute.post('/me/plugin-steps/records/:recordId/:pluginId/:step/start', companyMember, async (c) =>
  answer(c, await pluginSteps.startPerson(c.var.member, c.req.param('recordId'), c.req.param('pluginId'), c.req.param('step'))))

pluginStepsRoute.post('/me/plugin-steps/consultations', companyMember, serviceBody, (c) =>
  answer(c, pluginSteps.bindConsultation(c.var.member, c.var.body)))
