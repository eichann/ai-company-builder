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
 *   PUT  /items/:itemId/blobs/:sha256          raw body, Content-Length = the entry's size (≤ 50 MB) → 204;
 *                                              every refusal is decided before the body is read
 *   POST /items/:itemId/finish                 → { state: 'waiting' }
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HOLDING_CODES } from '../../shared/types/private-holding'
import { services } from '../composition'
import { refusal } from './respond'
import { serviceBody, signedIn } from './guards'

export const privateHoldingRoute = new Hono()
const { privateHolding } = services

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

/** A request body as chunks, read only when the service asks (never all at once in memory). */
async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

// The service checks everything (owner, states, the content wanted, Content-Length and the file
// cap, uploads running) before it asks for the body; no body limit middleware reads ahead.
privateHoldingRoute.put('/items/:itemId/blobs/:sha256', signedIn, async (c) => {
  const raw = c.req.raw.body
  const result = await privateHolding.putBlob(c.var.user.id, c.req.param('itemId'), c.req.param('sha256'),
    c.req.header('content-length'), () => (raw ? chunksOf(raw) : null))
  if (!result.ok) return refusal(c, result)
  return c.body(null, 204)
})

privateHoldingRoute.post('/items/:itemId/finish', signedIn, (c) => {
  const result = privateHolding.finish(c.var.user.id, c.req.param('itemId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
