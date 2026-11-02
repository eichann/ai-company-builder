/**
 * The minutes intake (milestone 4 G7, `.claude/rules/minutes.md`), mounted at
 * /api/companies/:companyId. Contract: shared/types/minutes.ts; rules:
 * services/minutes.ts. The member's AI has its twins in routes/records-ai.ts.
 *
 *   GET|PUT /google/minutes-folder          owner/admin: the department folder meetings go to
 *                                            ({ folder?: string | null; never a private folder,
 *                                            meetings?: 'external' | 'all' — which meetings are read })
 *   POST    /me/minutes/check               any member: look at my calendar now (the app calls
 *                                            it at start, every 10 minutes and on a button)
 *   GET     /me/minutes/item/:recordId/text      the assignee or an attendee: the minutes as outside
 *                                            text, read now from Google with my own permission
 *   POST    /me/minutes/item/:recordId/bundle    the assignee or an admin: { bundleId, expectedVersion? }
 *                                            (which まとまり the meeting belongs to)
 *   POST    /me/minutes/item/:recordId/no-bundle the assignee or an admin: { expectedVersion? }
 *                                            (「まとまりはない」: the question closed for good)
 *   GET     /me/minutes/item/:recordId/bundle-question   a reader of the meeting: may a まとまり be chosen
 *   GET     /me/minutes/bundle-questions        any member: my 「どのまとまりの会議ですか？」 items
 *
 * The text is never stored, logged or cached: `Cache-Control: no-store`.
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const minutesRoute = new Hono()
const { minutes } = services

function answer<T>(c: Context, result: Outcome<T>) {
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

minutesRoute.get('/google/minutes-folder', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, minutes.folderSetting(member))
})

minutesRoute.put('/google/minutes-folder', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, minutes.setFolder(member, c.var.body))
})

minutesRoute.post('/me/minutes/check', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await minutes.check(member))
})

minutesRoute.get('/me/minutes/item/:recordId/text', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await minutes.text(member, c.req.param('recordId')))
})

minutesRoute.post('/me/minutes/item/:recordId/bundle', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, minutes.linkBundle(member, { kind: 'human', source: null }, c.req.param('recordId'), c.var.body))
})

minutesRoute.post('/me/minutes/item/:recordId/no-bundle', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, minutes.noBundle(member, { kind: 'human', source: null }, c.req.param('recordId'), c.var.body))
})

minutesRoute.get('/me/minutes/item/:recordId/bundle-question', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, minutes.bundleQuestion(member, c.req.param('recordId')))
})

minutesRoute.get('/me/minutes/bundle-questions', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, minutes.bundleQuestions(member))
})
