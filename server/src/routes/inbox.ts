/**
 * The inbox (来た連絡, `.claude/rules/inbox.md`): a member's session, mounted
 * at /api/companies/:companyId. Rules and the no-leak answers:
 * services/inbox.ts. Messages come in through the connectors (no route here
 * takes a message); a member reads only their own.
 *
 *   GET  /inbox-settings                      any member: the intake settings in force (+ canEdit)
 *   PUT  /inbox-settings                      owner/admin: the whole document
 *   GET  /inbox/status                        the member's own connections and unchecked gaps
 *   POST /inbox/backfill                      { channel } 「過去7日を見直す」 (own connection)
 *   GET  /inbox/set-aside                     「やることにしなかった一覧」 (own)
 *   GET  /inbox/department                    部署の番: shared-address messages the member reads, untaken
 *   POST /inbox/items/:recordId/claim         { expectedVersion } 引き受ける
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const inboxRoute = new Hono()
const { access, inbox } = services

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

async function memberOf(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

function answer<T>(c: Context, r: Outcome<T>) {
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
}

inboxRoute.get('/inbox-settings', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return c.json({ success: true, data: inbox.view(m) })
})

inboxRoute.put('/inbox-settings', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, inbox.update(m, await jsonBody(c)))
})

inboxRoute.get('/inbox/status', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return c.json({ success: true, data: inbox.status(m) })
})

inboxRoute.post('/inbox/backfill', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, inbox.backfill(m, await jsonBody(c)))
})

inboxRoute.get('/inbox/set-aside', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, inbox.setAside(m))
})

inboxRoute.get('/inbox/department', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, inbox.department(m))
})

inboxRoute.post('/inbox/items/:recordId/claim', async (c) => {
  const m = await memberOf(c)
  if (m instanceof Response) return m
  return answer(c, inbox.claim(m, c.req.param('recordId'), await jsonBody(c)))
})
