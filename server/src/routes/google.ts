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
 *   PUT    /google/features             { feature, on } — a feature off / on for the whole company (never asked when off)
 *   PUT    /google/picker               { apiKey?, appId } Google Picker (Drive, google-drive.md); appId null removes it
 *   DELETE /google/grants/:userId       stop a member's permission (revoked at Google too)
 *   GET    /google/relay                「本人の許可で中継する」: services, cap, stop, who allowed, records
 *   PUT    /google/relay                { services?, capPerMemberPerDay?, stopped? }
 *   PUT    /google/relay/members/:userId { stopped } — one member's relay
 *   POST   /google/relay/shared-drives  { drive, name? } — a shared drive the relay may write into
 *   DELETE /google/relay/shared-drives/:driveId
 *
 * Any member (the desktop app's 設定 → Google):
 *   GET    /me/google                   my permission: connected, account, what is allowed
 *   POST   /me/google/connect           { features } | { all: true } → { authorizeUrl } (opened in the system browser)
 *   PUT    /me/google/seen              「あとで」 on 「仕事の道具をつなぐ」: what the company offers now is marked shown
 *   PUT    /me/google/features          { feature, on } — the member turns an allowed feature off / on (受信を読む …)
 *   DELETE /me/google                   「許可をやめる」 (revoked at Google too)
 *   GET    /me/google/relay             the relay as the member sees it, with their own records
 *
 * No answer ever carries a client secret, a token, a code or a PKCE value.
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const googleRoute = new Hono()
const { googleConnector, googleRelay } = services

function answer<T>(c: Context, result: Outcome<T>) {
  c.header('Cache-Control', 'no-store')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

googleRoute.get('/google', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await googleConnector.adminView(member))
})

googleRoute.put('/google/client', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await googleConnector.saveClient(member, c.var.body))
})

googleRoute.put('/google/enabled', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await googleConnector.setEnabled(member, c.var.body))
})

// The role is checked in the service before the body (who → body → rules).
googleRoute.put('/google/features', companyMember, serviceBody, async (c) =>
  answer(c, await googleConnector.setCompanyFeature(c.var.member, c.var.body)))

googleRoute.put('/google/picker', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await googleConnector.savePicker(member, c.var.body))
})

googleRoute.delete('/google/grants/:userId', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await googleConnector.stopGrant(member, c.req.param('userId')))
})

googleRoute.get('/me/google', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await googleConnector.my(member))
})

googleRoute.post('/me/google/connect', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await googleConnector.connect(member, c.var.body))
})

googleRoute.put('/me/google/features', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, await googleConnector.setFeature(member, c.var.body))
})

googleRoute.put('/me/google/seen', companyMember, async (c) => answer(c, await googleConnector.markSeen(c.var.member)))

googleRoute.delete('/me/google', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await googleConnector.disconnect(member))
})

// The relay with the member's own permission (google-connector.md "The relay"); the role is checked first.
googleRoute.get('/google/relay', companyMember, async (c) => answer(c, await googleRelay.adminView(c.var.member)))

googleRoute.put('/google/relay', companyMember, serviceBody, async (c) => answer(c, await googleRelay.save(c.var.member, c.var.body)))

googleRoute.put('/google/relay/members/:userId', companyMember, serviceBody, async (c) =>
  answer(c, await googleRelay.setMemberStopped(c.var.member, c.req.param('userId'), c.var.body)))

googleRoute.post('/google/relay/shared-drives', companyMember, serviceBody, async (c) =>
  answer(c, await googleRelay.addSharedDrive(c.var.member, c.var.body)))

googleRoute.delete('/google/relay/shared-drives/:driveId', companyMember, async (c) =>
  answer(c, await googleRelay.removeSharedDrive(c.var.member, c.req.param('driveId'))))

googleRoute.get('/me/google/relay', companyMember, async (c) => answer(c, await googleRelay.my(c.var.member)))
