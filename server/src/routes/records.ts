/**
 * The company map of the light ontology (stage 4-2). Mounted at
 * /api/companies/:companyId. Contract: shared/types/records.ts; rules:
 * services/records.ts, `.claude/rules/records.md`.
 *
 *   GET|PUT /records/settings     owner/admin: the per-company switch (off by default)
 *   GET     /records/problems     owner/admin: what the index could not take
 *   POST    /records/reindex      owner/admin: { full: true } rebuilds the index from the files
 *   GET     /records/types        any member: type definitions in force
 *   GET     /records/bundle-kinds any member: the 束ねる種類 each department makes, and their names
 *   POST    /records/query        any member: the fixed-shape query
 *   POST    /records/find         any member: 探す — records found by words, with department, mine, 案件, summaries
 *   POST    /records/find-home    any member: 探す with nothing typed — their unfinished 案件, this week's meetings
 *   GET     /records/item/:recordId  any member: one record and its links
 *   GET     /records/my-turn      any member: 「あなたの番」 across types implementing request
 *   GET     /records/ai-turn      any member: 「AI の番」 — their records waiting for an AI-only action
 *   POST    /records/decisions    any member: record a decision (the server writes its file;
 *                                 services/decisions.ts)
 *   POST    /records/item         any member: a server-only record (state engine, 4-3); the same item of
 *                                 the same meeting answers the existing one (200, `reused`)
 *   GET     /records/meeting-duplicates        owner/admin: what one meeting made twice (same type, title)
 *   POST    /records/meeting-duplicates/merge  owner/admin: { keepId, duplicateIds } cancel / retract the
 *                                 duplicates with a note naming the kept one (nothing deleted)
 *   POST    /records/item/:recordId/actions/:action   run an action of the record's type
 *   POST    /records/item/:recordId/undo              reverse an earlier change (a new entry)
 *   POST    /records/item/:recordId/file-links        { path, link?, expectedVersion, note? } link a file later
 *   POST    /records/item/:recordId/file-links/remove { path, link?, expectedVersion, note? } remove that link
 *   POST    /records/item/:recordId/record-links        { link, target, expectedVersion, note? } link a record later
 *   POST    /records/item/:recordId/record-links/remove { link, target, expectedVersion, note? } remove that link
 *   POST    /records/item/:recordId/share             { folder, expectedVersion, note? } the owner shows their
 *                                                     owner-only or members-only record to a folder's readers (session only)
 *   POST    /records/item/:recordId/members           { add, expectedVersion, note? } a listed member adds members
 *                                                     to a members-only record (session only)
 *   POST    /records/item/:recordId/opened            the app opened the record: the first opening of the
 *                                                     turn by its holder is kept (session only, records.md)
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
import { services } from '../composition'
import type { Outcome } from '../services/outcome'
import { selfReportedProvenance } from '../services/record-engine'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const recordsRoute = new Hono()
/** A call with the member's session is the member's own (their AI calls with a record token: records-ai.ts). */
const HUMAN = { kind: 'human' } as const
/** A person's action, with the provenance their app reports (informational only, never authorizes: record-engine.ts). */
const humanWith = (body: unknown) => ({ ...HUMAN, ...selfReportedProvenance(body) })
const { records, recordEngine, recordAiTokens, decisions, meetingOutputs, bundleKinds, recordFind } = services

function answer<T>(c: Context, result: Outcome<T>) {
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
}

recordsRoute.get('/records/settings', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, records.settings(member))
})

recordsRoute.put('/records/settings', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, records.updateSettings(member, c.var.body))
})

recordsRoute.get('/records/problems', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, records.problems(member))
})

recordsRoute.post('/records/reindex', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, records.reindex(member, c.var.body))
})

recordsRoute.get('/records/types', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, records.types(member))
})

recordsRoute.get('/records/bundle-kinds', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, bundleKinds.kinds(member))
})

recordsRoute.post('/records/query', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  return answer(c, records.query(member, c.var.body))
})

recordsRoute.post('/records/find', companyMember, serviceBody, async (c) => {
  return answer(c, recordFind.find(c.var.member, c.var.body))
})

recordsRoute.post('/records/find-home', companyMember, serviceBody, async (c) => {
  return answer(c, recordFind.home(c.var.member, c.var.body))
})

recordsRoute.get('/records/item/:recordId', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, await records.get(member, c.req.param('recordId')))
})

recordsRoute.get('/records/my-turn', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, records.myTurn(member))
})

recordsRoute.get('/records/ai-turn', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, records.aiTurn(member))
})

recordsRoute.post('/records/decisions', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  const result = await decisions.record(member, humanWith(body), body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, result.value.created ? 201 : 200)
})

recordsRoute.post('/records/item', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  const result = recordEngine.create(member, humanWith(body), body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, result.value.reused ? 200 : 201)
})

recordsRoute.get('/records/meeting-duplicates', companyMember, (c) => {
  const result = meetingOutputs.duplicates(c.var.member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

recordsRoute.post('/records/meeting-duplicates/merge', companyMember, serviceBody, async (c) => {
  const result = await meetingOutputs.merge(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

recordsRoute.post('/records/item/:recordId/actions/:action', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  return answer(c, await recordEngine.act(member, humanWith(body), c.req.param('recordId'), c.req.param('action'), body))
})

recordsRoute.post('/records/item/:recordId/undo', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  return answer(c, recordEngine.undo(member, humanWith(body), c.req.param('recordId'), body))
})

recordsRoute.post('/records/item/:recordId/file-links', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  return answer(c, recordEngine.fileLink(member, humanWith(body), c.req.param('recordId'), 'link', body))
})

recordsRoute.post('/records/item/:recordId/file-links/remove', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  return answer(c, recordEngine.fileLink(member, humanWith(body), c.req.param('recordId'), 'unlink', body))
})

recordsRoute.post('/records/item/:recordId/record-links', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  return answer(c, recordEngine.recordLink(member, humanWith(body), c.req.param('recordId'), 'link', body))
})

recordsRoute.post('/records/item/:recordId/record-links/remove', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  return answer(c, recordEngine.recordLink(member, humanWith(body), c.req.param('recordId'), 'unlink', body))
})

recordsRoute.post('/records/item/:recordId/opened', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, records.opened(member, c.req.param('recordId')))
})

// Owner-only / members-only → a folder's readers (records.md "Owner-only records", "Members-only
// records"), and adding members to a members-only record: the person's own steps, so no AI route.
recordsRoute.post('/records/item/:recordId/share', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  return answer(c, recordEngine.share(member, humanWith(body), c.req.param('recordId'), body))
})

recordsRoute.post('/records/item/:recordId/members', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const body = c.var.body
  return answer(c, recordEngine.invite(member, humanWith(body), c.req.param('recordId'), body))
})

recordsRoute.get('/records/item/:recordId/history', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, recordEngine.history(member, c.req.param('recordId')))
})

recordsRoute.get('/records/item/:recordId/versions/:version', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, recordEngine.atVersion(member, c.req.param('recordId'), c.req.param('version')))
})

recordsRoute.post('/me/record-tokens', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = recordAiTokens.issue(member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, 201)
})

recordsRoute.delete('/me/record-tokens/:tokenId', companyMember, async (c) => {
  const member = c.var.member
  return answer(c, recordAiTokens.revoke(member, c.req.param('tokenId')))
})
