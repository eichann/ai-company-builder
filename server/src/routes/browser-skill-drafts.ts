/**
 * A Skill's draft made from a member's own recordings (agent-browser.md "A Skill's draft from a recording"). Rules:
 * services/browser-skill-drafts.ts; shapes: shared/types/browser-skill-drafts.ts. A person's session only — the app's main
 * process calls them for the member's own consultation AI (`browser_skill_draft`); no record-token route. Every route
 * answers the member's own drafts and recordings only: anyone else's (owners and admins too) is the same 404.
 *
 * Mounted at /api/companies/:companyId:
 *   GET    /browser-skill-drafts                the member's drafts and own recordings
 *   POST   /browser-skill-drafts                { recordingIds, name? }: a draft from 1–5 own recordings
 *   GET    /browser-skill-drafts/:draftId       one draft with its own recordings (kept form)
 *   PUT    /browser-skill-drafts/:draftId       { expectedVersion, name?, declaration?, steps? }
 *   DELETE /browser-skill-drafts/:draftId
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { services } from '../composition'
import { BROWSER_SKILL_DRAFT_SERVER_WORDS } from '../services/browser-skill-drafts'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const browserSkillDraftsRoute = new Hono()
const { browserSkillDrafts } = services

/** SKILL.md (32 KiB) and browser.yaml (8 KiB) with room for the envelope and JSON escapes. */
const putBodyLimit = bodyLimit({
  maxSize: 256 * 1024,
  onError: c => c.json({ error: BROWSER_SKILL_DRAFT_SERVER_WORDS.stepsTooLarge, code: 'BROWSER_SKILL_DRAFT_TOO_LARGE' }, 413),
})

browserSkillDraftsRoute.get('/browser-skill-drafts', companyMember, (c) => {
  const r = browserSkillDrafts.list(c.var.member)
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserSkillDraftsRoute.post('/browser-skill-drafts', companyMember, serviceBody, (c) => {
  const r = browserSkillDrafts.create(c.var.member, c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }, 201) : refusal(c, r)
})

browserSkillDraftsRoute.get('/browser-skill-drafts/:draftId', companyMember, (c) => {
  const r = browserSkillDrafts.get(c.var.member, c.req.param('draftId'))
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserSkillDraftsRoute.put('/browser-skill-drafts/:draftId', companyMember, putBodyLimit, serviceBody, (c) => {
  const r = browserSkillDrafts.save(c.var.member, c.req.param('draftId'), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserSkillDraftsRoute.delete('/browser-skill-drafts/:draftId', companyMember, (c) => {
  const r = browserSkillDrafts.remove(c.var.member, c.req.param('draftId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})
