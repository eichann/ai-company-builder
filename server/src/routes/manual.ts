/**
 * The user manual (取説) at `/manual/` — for signed-in accounts only (owner decision
 * 2026-11-23, replacing the earlier public manual): any account with a session on this
 * server, whatever its company, since the manual is the same for every company. Each
 * server serves the manual built into its own image (`src/cli/build-manual.ts`), so a
 * self-hosted server shows its own version. server.md "The user manual".
 *
 * Without a session every path — `/manual`, a page, a picture, the manifest, a path that
 * names nothing — gets the same answer, so nothing tells which files exist: a browser
 * opening a page (`Accept: text/html`) is sent to the admin console's sign-in page
 * (`/login?redirect=…`, which goes back only to a same-origin path), back to that page when
 * it is one of the manual's file names, else to the index; anything else is 401.
 *
 * Only files the built manifest names are answered (`lib/manual-site.ts`); every
 * other path is the same 404. The pages run no script and load nothing from
 * elsewhere: a strict CSP (own styles and pictures only), nosniff, no framing,
 * no referrer — on every answer, the refusals too. `private, no-cache` + ETag: no shared
 * cache keeps a copy for someone not signed in; a browser asks again each time and gets
 * 304 while the file is unchanged, so a new version shows at once.
 */
import { Hono, type Context } from 'hono'
import { signedInElse } from './guards'
import { manualDir } from '../lib/config'
import { readManualFile } from '../lib/manual-site'
import { isManualFilePath, manualPageFile, MANUAL_INDEX_PAGE } from '../../shared/core/manual'

export const MANUAL_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const SAFE_HEADERS = {
  'Content-Security-Policy': MANUAL_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

function safeHeaders(c: Context) {
  for (const [name, value] of Object.entries(SAFE_HEADERS)) c.header(name, value)
}

function notFound(c: Context) {
  safeHeaders(c)
  c.header('Cache-Control', 'no-store')
  return c.text('Not found', 404)
}

/** What follows `/manual/` in the request, or null when the path is not under it. */
function requestedFile(c: Context): string | null {
  const prefix = c.req.routePath.replace(/\*$/, '')
  return c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : null
}

/**
 * Where the sign-in page sends the browser back: the requested file when it is one of the
 * manual's file names (`isManualFilePath`: a flat page, `manual.css` or `images/<name>`; no
 * `..`, `%`, `/` at the start or backslash), else the index — never anything outside `/manual/`.
 */
export function manualReturnPath(requested: string | null): string {
  return `/manual/${requested !== null && isManualFilePath(requested) ? requested : manualPageFile(MANUAL_INDEX_PAGE)}`
}

/** No session: the same answer for every path, whether or not it names a file. */
function signedOut(c: Context) {
  safeHeaders(c)
  c.header('Cache-Control', 'no-store')
  c.header('Vary', 'Accept')
  if ((c.req.header('Accept') ?? '').includes('text/html')) {
    const requested = c.req.routePath.endsWith('*') ? requestedFile(c) : null
    return c.redirect(`/login?redirect=${encodeURIComponent(manualReturnPath(requested))}`, 302)
  }
  return c.text('Unauthorized', 401)
}

const signedInReader = signedInElse(signedOut)

export const manualRoute = new Hono()

// `/manual` → the index page, so the pages' relative links resolve inside the manual. Not `/manual/`:
// the admin console (which forwards /manual to the API behind Caddy) would send that back to `/manual`.
manualRoute.get('/', signedInReader, (c) => {
  safeHeaders(c)
  c.header('Cache-Control', 'private, no-cache')
  return c.redirect('/manual/index.html', 301)
})

manualRoute.get('/*', signedInReader, async (c) => {
  const requested = requestedFile(c)
  if (requested === null) return notFound(c)
  const answer = await readManualFile(manualDir(), requested)
  if (!answer) return notFound(c)
  const etag = `"${answer.etag}"`
  safeHeaders(c)
  c.header('Cache-Control', 'private, no-cache')
  c.header('ETag', etag)
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
  c.header('Content-Type', answer.contentType)
  return c.body(answer.bytes as Uint8Array<ArrayBuffer>, 200)
})
