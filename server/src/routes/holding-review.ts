/**
 * The holding place — the review (private-folders.md "Holding: review"; contract
 * shared/types/private-holding.ts; rules services/holding-review.ts). Mounted at
 * /api/companies/:companyId.
 *
 *   GET  /holding                              the items the caller may review
 *   GET  /holding/:itemId                      its entries and how each stands against the folder now
 *   GET  /holding/:itemId/files/:idx?version=  one entry's bytes: held (default) | base | current
 *   POST /holding/:itemId/take                 { files: idx[], whenChanged? } → one commit as the caller
 *   POST /holding/:itemId/discard              → { state: 'discarded' }
 *
 * An item the caller may not review is the same 404 as one that does not exist.
 */
import { Hono } from 'hono'
import { services } from '../composition'
import { companyMember, serviceBody } from './guards'
import { refusal } from './respond'

export const holdingReviewRoute = new Hono()
const { holdingReview } = services

holdingReviewRoute.get('/holding', companyMember, (c) => {
  const result = holdingReview.list(c.var.member)
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
})

holdingReviewRoute.get('/holding/:itemId', companyMember, async (c) => {
  const result = await holdingReview.detail(c.var.member, c.req.param('itemId'))
  if (!result.ok) return refusal(c, result)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: result.value })
})

holdingReviewRoute.get('/holding/:itemId/files/:idx', companyMember, async (c) => {
  const result = await holdingReview.content(c.var.member, c.req.param('itemId'), c.req.param('idx'), c.req.query('version'))
  if (!result.ok) return refusal(c, result)
  const { bytes, name } = result.value
  // Always a download, never rendered: the member's bytes are not trusted as a page.
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store',
    },
  })
})

holdingReviewRoute.post('/holding/:itemId/take', companyMember, serviceBody, async (c) => {
  const result = await holdingReview.take(c.var.member, c.req.param('itemId'), c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

holdingReviewRoute.post('/holding/:itemId/discard', companyMember, async (c) => {
  const result = await holdingReview.discard(c.var.member, c.req.param('itemId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
