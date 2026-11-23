/**
 * The user manual (取説) at `/manual/` — public on purpose (owner decision
 * 2026-11-23): it holds no secret and members need it when they cannot sign
 * in. Each server serves the manual built into its own image
 * (`src/cli/build-manual.ts`), so a self-hosted server shows its own version.
 * server.md "The user manual".
 *
 * Only files the built manifest names are answered (`lib/manual-site.ts`); every
 * other path is the same 404. The pages run no script and load nothing from
 * elsewhere: a strict CSP (own styles and pictures only), nosniff, no framing,
 * no referrer. `no-cache` + ETag: a browser asks again each time and gets 304
 * while the file is unchanged, so a new version shows at once.
 */
import { Hono, type Context } from 'hono'
import { publicRoute } from './guard-tags'
import { manualDir } from '../lib/config'
import { readManualFile } from '../lib/manual-site'

export const MANUAL_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const SAFE_HEADERS = {
  'Content-Security-Policy': MANUAL_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

function notFound(c: Context) {
  for (const [name, value] of Object.entries(SAFE_HEADERS)) c.header(name, value)
  c.header('Cache-Control', 'no-store')
  return c.text('Not found', 404)
}

const PUBLIC = 'the user manual: static pages holding no secret, needed by members who cannot sign in (owner decision 2026-11-23)'

export const manualRoute = new Hono()

// `/manual` → the index page, so the pages' relative links resolve inside the manual. Not `/manual/`:
// the admin console (which forwards /manual to the API behind Caddy) would send that back to `/manual`.
manualRoute.get('/', publicRoute(PUBLIC), (c) => c.redirect('/manual/index.html', 301))

manualRoute.get('/*', publicRoute(PUBLIC), async (c) => {
  const prefix = c.req.routePath.replace(/\*$/, '')
  const requested = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : null
  if (requested === null) return notFound(c)
  const answer = await readManualFile(manualDir(), requested)
  if (!answer) return notFound(c)
  const etag = `"${answer.etag}"`
  for (const [name, value] of Object.entries(SAFE_HEADERS)) c.header(name, value)
  c.header('Cache-Control', 'no-cache')
  c.header('ETag', etag)
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
  c.header('Content-Type', answer.contentType)
  return c.body(answer.bytes as Uint8Array<ArrayBuffer>, 200)
})
