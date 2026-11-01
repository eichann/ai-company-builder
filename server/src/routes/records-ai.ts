/**
 * The company map for the member's AI (`.claude/rules/records.md` "Who is
 * acting"). Mounted at /api/records-ai. Authenticated by a record token
 * (`Authorization: Bearer acb_rec_…`, issued to the member's app per chat
 * turn — routes/records.ts `POST /me/record-tokens`), never by a session:
 * everything done here is recorded as the member's AI (actor kind `ai`),
 * whatever the request body says. A `read` token only looks up.
 *
 *   GET  /types   GET /my-turn   GET /ai-turn   POST /query   GET /item/:recordId
 *   GET  /item/:recordId/history
 *   POST /item                                  (act)
 *   POST /decisions                             (act) record a decision (services/decisions.ts)
 *   POST /item/:recordId/actions/:action         (act)
 *   POST /item/:recordId/file-links (+ /remove)  (act) link a file later / remove it (types letting the AI act)
 *
 *   GET  /minutes/:recordId/text          the minutes as outside text (tool minutes_read; G7, minutes.md):
 *                                         the assignee or an attendee, read now from Google with
 *                                         the member's own permission; never stored or logged
 *   POST /minutes/:recordId/bundle        (act) { bundleId, expectedVersion? } — the assignee / an admin's AI
 *
 *   GET  /plugins                         the running plugins' operations this AI may call (tools, P7)
 *   POST /plugins/:pluginId/records/:recordId/operations/:operation   a plugin's typed operation
 *        (refresh: read; update and log_meeting: act — Codex's read tokens cannot write)
 *   POST /plugins/:pluginId/create/:operation   a create of a record (create_deal; act) — never auto:
 *        it becomes an approval request (202) that a person approves
 *   GET  /plugins/:pluginId/operations/:operationId
 *   GET  /approvals   GET /approvals/:approvalId   approval requests, read only (approvals.md)
 *
 *   POST /outbound-recipients             verified mail recipients of a meeting / まとまり (read; tool mail_recipients)
 *   POST /outbound                        a mail draft (act; mail_draft_create)
 *   GET  /outbound/:messageId             the member's own draft (read; mail_draft_show)
 *   PUT  /outbound/:messageId             a new version of it (act; mail_draft_update)
 *   There is deliberately no send, resolve, discard or typed address here
 *   (outbound-mail.md): sending reaches outside and is a person's, with their session.
 *
 *   /google/drive/*                       Google Drive (picked files only): routes/google-drive.ts,
 *                                         the Google connector's own module (google-drive.md)
 *
 * Execution runs (S10b, records.md "Execution runs"): a token bound to a run is
 * refused as soon as the run is claimed again (its generation is old) — fencing,
 * in recordAiTokens.authenticate; and every create / outside operation made with
 * it needs an `Idempotency-Key` header (keyedWrite): the same key never repeats
 * the effect, and an answer that was lost leaves the run waiting for a person.
 *
 * No undo, no 「もう一度作る」 and nothing it can approve, send back or withdraw for
 * the AI: a person does those (their app's screens; routes/approvals.ts, session
 * only). A create is never re-sent.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { aiActor, holderOf, keyedWrite } from './record-ai-auth'
import { refusal } from './respond'

export const recordsAiRoute = new Hono()
const { records, recordEngine, pluginOperations, decisions, approvals, minutes, outboundMail } = services

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

function answer<T>(c: Context, result: Outcome<T>, status: 200 | 201 | 202 = 200) {
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, status)
}

recordsAiRoute.get('/types', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, records.types(h.member))
})

recordsAiRoute.get('/my-turn', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, records.myTurn(h.member))
})

recordsAiRoute.get('/ai-turn', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, records.aiTurn(h.member))
})

recordsAiRoute.post('/decisions', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  const body = await jsonBody(c)
  return keyedWrite(c, h, 'decision', body, async () => {
    const result = await decisions.record(h.member, aiActor(h), body)
    return answer(c, result, result.ok && result.value.created ? 201 : 200)
  })
})

recordsAiRoute.get('/minutes/:recordId/text', async (c) => {
  const h = holderOf(c, 'read')
  if (h instanceof Response) return h
  c.header('Cache-Control', 'no-store')
  return answer(c, await minutes.text(h.member, c.req.param('recordId')))
})

recordsAiRoute.post('/minutes/:recordId/bundle', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  const { kind, source, conversationId, runId } = aiActor(h)
  return answer(c, minutes.linkBundle(h.member, { kind, source, conversationId, runId }, c.req.param('recordId'), await jsonBody(c)))
})

recordsAiRoute.post('/query', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, records.query(h.member, await jsonBody(c)))
})

recordsAiRoute.get('/item/:recordId', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await records.get(h.member, c.req.param('recordId')))
})

recordsAiRoute.get('/item/:recordId/history', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, recordEngine.history(h.member, c.req.param('recordId')))
})

recordsAiRoute.post('/item', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  const body = await jsonBody(c)
  return keyedWrite(c, h, 'record-create', body, async () => answer(c, recordEngine.create(h.member, aiActor(h), body), 201))
})

recordsAiRoute.post('/item/:recordId/actions/:action', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  return answer(c, await recordEngine.act(h.member, aiActor(h), c.req.param('recordId'), c.req.param('action'), await jsonBody(c)))
})

recordsAiRoute.post('/item/:recordId/file-links', async (c) => {
  const h = holderOf(c, 'act')
  return h instanceof Response ? h : answer(c, recordEngine.fileLink(h.member, aiActor(h), c.req.param('recordId'), 'link', await jsonBody(c)))
})

recordsAiRoute.post('/item/:recordId/file-links/remove', async (c) => {
  const h = holderOf(c, 'act')
  return h instanceof Response ? h : answer(c, recordEngine.fileLink(h.member, aiActor(h), c.req.param('recordId'), 'unlink', await jsonBody(c)))
})

// The operations the app turns into this AI's tools (a read token: reads only).
recordsAiRoute.get('/plugins', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await services.plugins.aiTools(h.member, h.scope))
})

// A plugin's typed operation: a read token may only run operations that read (refresh).
recordsAiRoute.post('/plugins/:pluginId/records/:recordId/operations/:operation', async (c) => {
  const h = holderOf(c, 'read')
  if (h instanceof Response) return h
  const reads = services.plugins.operationKind(h.member.companyId, c.req.param('pluginId'), c.req.param('operation')) === 'read'
  if (h.scope !== 'act' && !reads) {
    return c.json({ error: 'この AI は読むことだけができます', code: 'READ_ONLY_TOKEN' }, 403)
  }
  const body = await jsonBody(c)
  const run = async () => {
    // Needing approval: the request is made (202) — the AI asks, a person approves (routes/approvals.ts, session only).
    const r = await approvals.runOrRequest(h.member, aiActor(h), c.req.param('pluginId'), c.req.param('recordId'), c.req.param('operation'), body)
    const requested = r.ok && typeof r.value === 'object' && r.value !== null && (r.value as { outcome?: unknown }).outcome === 'approval-requested'
    return answer(c, r, requested ? 202 : 200)
  }
  // A read changes nothing outside: no key needed.
  return reads ? run() : keyedWrite(c, h, 'plugin-operation', body, run)
})

// Approval requests, read only: the AI lists and shows them (「承認待ちを見せて」); it has no way to approve.
recordsAiRoute.get('/approvals', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await approvals.list(h.member, { scope: c.req.query('scope'), state: c.req.query('state') }))
})

recordsAiRoute.get('/approvals/:approvalId', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await approvals.get(h.member, c.req.param('approvalId')))
})

// A create of a record (create_deal; milestone 4): writes, so an act token only. Never auto: an approval request (202).
recordsAiRoute.post('/plugins/:pluginId/create/:operation', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  const body = await jsonBody(c)
  return keyedWrite(c, h, 'plugin-create', body, async () => {
    const r = await approvals.createOrRequest(h.member, aiActor(h), c.req.param('pluginId'), c.req.param('operation'), body)
    const requested = r.ok && typeof r.value === 'object' && r.value !== null && (r.value as { outcome?: unknown }).outcome === 'approval-requested'
    return answer(c, r, requested ? 202 : 200)
  })
})

recordsAiRoute.get('/plugins/:pluginId/operations/:operationId', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await pluginOperations.get(h.member, c.req.param('pluginId'), c.req.param('operationId')))
})

// Outbound mail: the AI drafts (refs from mail_recipients only); it can never send.
recordsAiRoute.post('/outbound-recipients', async (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, await outboundMail.recipients(h.member, await jsonBody(c)))
})

recordsAiRoute.post('/outbound', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  const body = await jsonBody(c)
  return keyedWrite(c, h, 'mail-draft', body, async () => answer(c, await outboundMail.create(h.member, aiActor(h), body), 201))
})

recordsAiRoute.get('/outbound/:messageId', (c) => {
  const h = holderOf(c, 'read')
  return h instanceof Response ? h : answer(c, outboundMail.get(h.member, c.req.param('messageId')))
})

recordsAiRoute.put('/outbound/:messageId', async (c) => {
  const h = holderOf(c, 'act')
  if (h instanceof Response) return h
  const body = await jsonBody(c)
  return keyedWrite(c, h, 'mail-draft-version', body, async () => answer(c, await outboundMail.update(h.member, aiActor(h), c.req.param('messageId'), body)))
})
