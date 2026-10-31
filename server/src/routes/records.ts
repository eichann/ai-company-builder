/**
 * The company map of the light ontology (stage 4-2). Mounted at
 * /api/companies/:companyId. Contract: shared/types/records.ts; rules:
 * services/records.ts, `.claude/rules/records.md`.
 *
 *   GET|PUT /records/settings     owner/admin: the per-company switch (off by default)
 *   GET     /records/problems     owner/admin: what the index could not take
 *   POST    /records/reindex      owner/admin: { full: true } rebuilds the index from the files
 *   GET     /records/types        any member: type definitions in force
 *   POST    /records/query        any member: the fixed-shape query
 *   GET     /records/item/:recordId  any member: one record and its links
 *   GET     /records/my-turn      any member: 「あなたの番」 across types implementing request
 *   GET     /records/ai-turn      any member: 「AI の番」 — their records waiting for an AI-only action
 *   POST    /records/decisions    any member: record a decision (the server writes its file;
 *                                 services/decisions.ts)
 *   POST    /records/item         any member: a server-only record (state engine, 4-3)
 *   POST    /records/item/:recordId/actions/:action   run an action of the record's type
 *   POST    /records/item/:recordId/undo              reverse an earlier change (a new entry)
 *   GET     /records/item/:recordId/history           the ledger
 *   GET     /records/item/:recordId/versions/:version the server values at that version
 *   POST    /me/record-tokens     any member: a record token for their AI (one chat turn;
 *                                 routes/records-ai.ts), { conversationId, agent, scope }
 *   DELETE  /me/record-tokens/:tokenId  end one of the member's own tokens
 *
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { selfReportedProvenance } from '../services/record-engine'
import { refusal } from './respond'

export const recordsRoute = new Hono()
/** A call with the member's session is the member's own (their AI calls with a record token: records-ai.ts). */
const HUMAN = { kind: 'human' } as const
/** A person's action, with the provenance their app reports (informational only, never authorizes: record-engine.ts). */
const humanWith = (body: unknown) => ({ ...HUMAN, ...selfReportedProvenance(body) })
const { access, records, recordEngine, recordAiTokens, decisions } = services

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
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

recordsRoute.get('/records/settings', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, records.settings(member))
})

recordsRoute.put('/records/settings', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, records.updateSettings(member, await jsonBody(c)))
})

recordsRoute.get('/records/problems', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, records.problems(member))
})

recordsRoute.post('/records/reindex', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, records.reindex(member, await jsonBody(c)))
})

recordsRoute.get('/records/types', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, records.types(member))
})

recordsRoute.post('/records/query', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, records.query(member, await jsonBody(c)))
})

recordsRoute.get('/records/item/:recordId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, records.get(member, c.req.param('recordId')))
})

recordsRoute.get('/records/my-turn', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, records.myTurn(member))
})

recordsRoute.get('/records/ai-turn', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, records.aiTurn(member))
})

recordsRoute.post('/records/decisions', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const body = await jsonBody(c)
  const result = await decisions.record(member, humanWith(body), body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, result.value.created ? 201 : 200)
})

recordsRoute.post('/records/item', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const body = await jsonBody(c)
  const result = recordEngine.create(member, humanWith(body), body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, 201)
})

recordsRoute.post('/records/item/:recordId/actions/:action', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const body = await jsonBody(c)
  return answer(c, await recordEngine.act(member, humanWith(body), c.req.param('recordId'), c.req.param('action'), body))
})

recordsRoute.post('/records/item/:recordId/undo', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const body = await jsonBody(c)
  return answer(c, recordEngine.undo(member, humanWith(body), c.req.param('recordId'), body))
})

recordsRoute.get('/records/item/:recordId/history', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, recordEngine.history(member, c.req.param('recordId')))
})

recordsRoute.get('/records/item/:recordId/versions/:version', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, recordEngine.atVersion(member, c.req.param('recordId'), c.req.param('version')))
})

recordsRoute.post('/me/record-tokens', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = recordAiTokens.issue(member, await jsonBody(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, 201)
})

recordsRoute.delete('/me/record-tokens/:tokenId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  return answer(c, recordAiTokens.revoke(member, c.req.param('tokenId')))
})
