/**
 * The Google connection (milestone 4 G3, `.claude/rules/google-connector.md`),
 * mounted at /api/companies/:companyId. Shapes: shared/types/google.ts; rules:
 * services/google-connector.ts.
 *
 * Owner / admin (the admin console's 「つなぎ先」→「Google」):
 *   GET    /google                      client id, last 4 of the secret, domain, on/off,
 *                                       the redirect URI to register, members' grants, history
 *   PUT    /google/client               { clientId, clientSecret?, domain } (the secret: sent once, never answered)
 *   PUT    /google/enabled              { enabled }
 *   DELETE /google/grants/:userId       stop a member's permission (revoked at Google too)
 *
 * Any member (the desktop app's 設定 → Google):
 *   GET    /me/google                   my permission: connected, account, what is allowed
 *   POST   /me/google/connect           { features } → { authorizeUrl } (opened in the system browser)
 *   DELETE /me/google                   「許可をやめる」 (revoked at Google too)
 *
 * No answer ever carries a client secret, a token, a code or a PKCE value.
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const googleRoute = new Hono()
const { access, googleConnector } = services

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

googleRoute.get('/google', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await googleConnector.adminView(member))
})

googleRoute.put('/google/client', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await googleConnector.saveClient(member, await jsonBody(c)))
})

googleRoute.put('/google/enabled', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await googleConnector.setEnabled(member, await jsonBody(c)))
})

googleRoute.delete('/google/grants/:userId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await googleConnector.stopGrant(member, c.req.param('userId')))
})

googleRoute.get('/me/google', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await googleConnector.my(member))
})

googleRoute.post('/me/google/connect', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await googleConnector.connect(member, await jsonBody(c)))
})

googleRoute.delete('/me/google', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, await googleConnector.disconnect(member))
})
