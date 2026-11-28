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
 *   GET  /inbox/items/:recordId/contact       「連絡」1枚: the contact, its 返事のお願い and やること as the member reads them
 *   POST /inbox/items/:recordId/finish        { interaction, replyRequest } the 返事のお願い's end + 「済んだ」, both or neither
 *   POST /inbox/items/:recordId/finish/undo   { interaction?, replyRequest } that finish taken back, both or neither
 *                                             (inbox.md "One contact"; services/contact-threads.ts)
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import { selfReportedProvenance } from '../services/record-engine'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const inboxRoute = new Hono()
const { inbox, contactThreads } = services
/** A person on their own screen (the session): actor kind human; provenance as the app reports it, never authorizing. */
const person = (body: unknown) => ({ kind: 'human' as const, ...selfReportedProvenance(body) })

function answer<T>(c: Context, r: Outcome<T>) {
  if (!r.ok) return refusal(c, r)
  return c.json({ success: true, data: r.value }, 200)
}

inboxRoute.get('/inbox-settings', companyMember, async (c) => {
  const m = c.var.member
  return c.json({ success: true, data: inbox.view(m) })
})

inboxRoute.put('/inbox-settings', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, inbox.update(m, c.var.body))
})

inboxRoute.get('/inbox/status', companyMember, async (c) => {
  const m = c.var.member
  return c.json({ success: true, data: inbox.status(m) })
})

inboxRoute.post('/inbox/backfill', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, inbox.backfill(m, c.var.body))
})

inboxRoute.get('/inbox/set-aside', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, inbox.setAside(m))
})

inboxRoute.get('/inbox/department', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, inbox.department(m))
})

inboxRoute.post('/inbox/items/:recordId/claim', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, inbox.claim(m, c.req.param('recordId'), c.var.body))
})

inboxRoute.get('/inbox/items/:recordId/contact', companyMember, async (c) => {
  const m = c.var.member
  return answer(c, contactThreads.view(m, c.req.param('recordId')))
})

inboxRoute.post('/inbox/items/:recordId/finish', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, await contactThreads.finish(m, person(c.var.body), c.req.param('recordId'), c.var.body))
})

inboxRoute.post('/inbox/items/:recordId/finish/undo', companyMember, serviceBody, async (c) => {
  const m = c.var.member
  return answer(c, contactThreads.undo(m, person(c.var.body), c.req.param('recordId'), c.var.body))
})
