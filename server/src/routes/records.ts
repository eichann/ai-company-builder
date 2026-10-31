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
 *
 * Non-members get 404 like every company route.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import type { Outcome } from '../services/outcome'
import { refusal } from './respond'

export const recordsRoute = new Hono()
const { access, records } = services

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
