/**
 * 見える人のまとまり (groups, server.md "Groups"): named sets of members that a
 * rule may name to say who reads a read-restricted place. Owners and admins
 * only (anyone else 403, no group name in the answer). Rules: services/groups.ts.
 * Mounted at /api/companies/:companyId.
 *
 *   GET    /groups                    every group with its members and the places naming it
 *   POST   /groups                    { name, userIds? } → 201
 *   PATCH  /groups/:groupId           { name }
 *   PUT    /groups/:groupId/members   { userIds } (replaces who is in it)
 *   DELETE /groups/:groupId           409 GROUP_IN_USE while a rule names it
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const groupsRoute = new Hono()
const { groups } = services

groupsRoute.get('/groups', companyMember, async (c) => {
  const result = groups.list(c.var.member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: { groups: result.value } })
})

groupsRoute.post('/groups', companyMember, serviceBody, async (c) => {
  const result = groups.create(c.var.member, c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value }, 201)
})

groupsRoute.patch('/groups/:groupId', companyMember, serviceBody, async (c) => {
  const result = groups.rename(c.var.member, c.req.param('groupId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

groupsRoute.put('/groups/:groupId/members', companyMember, serviceBody, async (c) => {
  const result = groups.setMembers(c.var.member, c.req.param('groupId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

groupsRoute.delete('/groups/:groupId', companyMember, async (c) => {
  const result = groups.delete(c.var.member, c.req.param('groupId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
