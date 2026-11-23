/**
 * The holding place — the member's upload (private-folders.md "Holding: the member's upload";
 * contract shared/types/private-holding.ts). Mounted at /api/me/holding.
 *
 * `signedIn`, no company membership: a person removed from the company still hands over what
 * their PC never sent. The company is found from the caller's own ticket (services/private-holding.ts);
 * a ticket or item that is not theirs is the same 404 as one that does not exist.
 *
 *   GET  /tickets                              the caller's tickets
 *   POST /tickets/:ticketId/items              { deviceKey, baseCommit, manifest } → { itemId, missing, namesOnly }
 *   PUT  /items/:itemId/blobs/:sha256          raw body ≤ 50 MB (413 above) → 204
 *   POST /items/:itemId/finish                 → { state: 'waiting' }
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HOLDING_CODES, HOLDING_LIMITS } from '../../shared/types/private-holding'
import { services } from '../composition'
import { refusal } from './respond'
import { serviceBody, signedIn } from './guards'

export const privateHoldingRoute = new Hono()
const { privateHolding } = services

/** One content: the file cap (the only route that takes more than a JSON body). */
const blobBodyLimit = bodyLimit({
  maxSize: HOLDING_LIMITS.fileBytes,
  onError: c => c.json({ error: 'The content is too large', code: HOLDING_CODES.tooLarge }, 413),
})

/** A manifest: JSON, 1 MB. */
const manifestBodyLimit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: c => c.json({ error: 'The request is too large', code: HOLDING_CODES.tooLarge }, 413),
})

privateHoldingRoute.get('/tickets', signedIn, (c) => {
  const result = privateHolding.tickets(c.var.user.id)
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
})

privateHoldingRoute.post('/tickets/:ticketId/items', signedIn, manifestBodyLimit, serviceBody, (c) => {
  const result = privateHolding.startItem(c.var.user.id, c.req.param('ticketId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

privateHoldingRoute.put('/items/:itemId/blobs/:sha256', signedIn, blobBodyLimit, async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  const result = await privateHolding.putBlob(c.var.user.id, c.req.param('itemId'), c.req.param('sha256'), bytes)
  if (!result.ok) return refusal(c, result)
  return c.body(null, 204)
})

privateHoldingRoute.post('/items/:itemId/finish', signedIn, (c) => {
  const result = privateHolding.finish(c.var.user.id, c.req.param('itemId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
