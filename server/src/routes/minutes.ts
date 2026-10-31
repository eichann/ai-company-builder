/**
 * The minutes intake (milestone 4 G7, `.claude/rules/minutes.md`), mounted at
 * /api/companies/:companyId. Contract: shared/types/minutes.ts; rules:
 * services/minutes.ts. The member's AI has its twins in routes/records-ai.ts.
 *
 *   GET|PUT /google/minutes-folder          owner/admin: the department folder minutes go to
 *                                            ({ folder: string | null }; never a private folder)
 *   POST    /me/minutes/check               any member: look at my calendar now (the app calls
 *                                            it at start, every 10 minutes and on a button)
 *   GET     /me/minutes/item/:recordId/text      the assignee or an attendee: the minutes as outside
 *                                            text, read now from Google with my own permission
 *   POST    /me/minutes/item/:recordId/deal      the assignee or an admin: { dealId, expectedVersion? }
 *
 * The text is never stored, logged or cached: `Cache-Control: no-store`.
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const minutesRoute = new Hono()
const { access, minutes } = services

async function authAndAuthorize(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

function answer<T>(c: Context, result: Outcome<T>) {
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

minutesRoute.get('/google/minutes-folder', async (c) => {
  const member = await authAndAuthorize(c)
  return member instanceof Response ? member : answer(c, minutes.folderSetting(member))
})

minutesRoute.put('/google/minutes-folder', async (c) => {
  const member = await authAndAuthorize(c)
  return member instanceof Response ? member : answer(c, minutes.setFolder(member, await jsonBody(c)))
})

minutesRoute.post('/me/minutes/check', async (c) => {
  const member = await authAndAuthorize(c)
  return member instanceof Response ? member : answer(c, await minutes.check(member))
})

minutesRoute.get('/me/minutes/item/:recordId/text', async (c) => {
  const member = await authAndAuthorize(c)
  return member instanceof Response ? member : answer(c, await minutes.text(member, c.req.param('recordId')))
})

minutesRoute.post('/me/minutes/item/:recordId/deal', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, minutes.linkDeal(member, { kind: 'human', source: null }, c.req.param('recordId'), await jsonBody(c)))
})
