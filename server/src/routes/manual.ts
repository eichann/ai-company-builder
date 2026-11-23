/**
 * The two static manual sites, built into the server image (`src/cli/build-manual.ts`), so a
 * self-hosted server shows its own version:
 *
 * - `/manual/` — the user manual (取説), for any account signed in on this server, whatever its
 *   company (owner decision 2026-11-23): the manual is the same for every company.
 *   server.md "The user manual".
 * - `/manual-admin/` — the administrator / FDE guide (管理者・FDE の手引き), for an account that is
 *   an owner or admin of at least one company on this server (checked on every request; the guide
 *   is the same for every company). Any other signed-in account gets the same plain 404 as a path
 *   that names nothing, so a member cannot tell the guide is there. server.md "The administrator guide".
 *
 * Without a session every path — the bare prefix, a page, a picture, the manifest, a path that
 * names nothing — gets the same answer, so nothing tells which files exist: a browser opening a
 * page (`Accept: text/html`) is sent to the admin console's sign-in page (`/login?redirect=…`,
 * which goes back only to a same-origin path), back to that page when it is one of the site's
 * file names, else to its index; anything else is 401.
 *
 * Only files the built manifest names are answered (`lib/manual-site.ts`); every
 * other path is the same 404. The pages run no script and load nothing from
 * elsewhere: a strict CSP (own styles and pictures only), nosniff, no framing,
 * no referrer — on every answer, the refusals too. `private, no-cache` + ETag: no shared
 * cache keeps a copy for someone not signed in; a browser asks again each time and gets
 * 304 while the file is unchanged, so a new version shows at once.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { fullAccessSomewhereElse, signedInElse } from './guards'
import { manualAdminDir, manualDir } from '../lib/config'
import { readManualFile } from '../lib/manual-site'
import { isManualFilePath, manualPageFile, MANUAL_INDEX_PAGE } from '../../shared/core/manual'

export const MANUAL_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** Where each site is mounted (`app.ts`); the sign-in page's return path stays under it. */
type SitePrefix = '/manual' | '/manual-admin'

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

/** What follows `<prefix>/` in the request, or null when the path is not under it. */
function requestedFile(c: Context): string | null {
  const prefix = c.req.routePath.replace(/\*$/, '')
  return c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : null
}

/**
 * Where the sign-in page sends the browser back: the requested file when it is one of the
 * site's file names (`isManualFilePath`: a flat page, `manual.css` or `images/<name>`; no
 * `..`, `%`, `/` at the start or backslash), else the index — never anything outside `<prefix>/`.
 */
export function manualReturnPath(prefix: SitePrefix, requested: string | null): string {
  return `${prefix}/${requested !== null && isManualFilePath(requested) ? requested : manualPageFile(MANUAL_INDEX_PAGE)}`
}

/** No session: the same answer for every path, whether or not it names a file. */
function signedOut(prefix: SitePrefix) {
  return (c: Context) => {
    safeHeaders(c)
    c.header('Cache-Control', 'no-store')
    c.header('Vary', 'Accept')
    if ((c.req.header('Accept') ?? '').includes('text/html')) {
      const requested = c.req.routePath.endsWith('*') ? requestedFile(c) : null
      return c.redirect(`/login?redirect=${encodeURIComponent(manualReturnPath(prefix, requested))}`, 302)
    }
    return c.text('Unauthorized', 401)
  }
}

/** One site's routes: `guard` decides who reads it, `dir` is where its build is (read per request). */
function siteRoute(prefix: SitePrefix, guard: MiddlewareHandler, dir: () => string): Hono {
  const route = new Hono()
  // `<prefix>` → the index page, so the pages' relative links resolve inside the site. Not
  // `<prefix>/`: the admin console (which forwards it to the API behind Caddy) would send that back.
  route.get('/', guard, (c) => {
    safeHeaders(c)
    c.header('Cache-Control', 'private, no-cache')
    return c.redirect(`${prefix}/${manualPageFile(MANUAL_INDEX_PAGE)}`, 301)
  })
  route.get('/*', guard, async (c) => {
    const requested = requestedFile(c)
    if (requested === null) return notFound(c)
    const answer = await readManualFile(dir(), requested)
    if (!answer) return notFound(c)
    const etag = `"${answer.etag}"`
    safeHeaders(c)
    c.header('Cache-Control', 'private, no-cache')
    c.header('ETag', etag)
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
    c.header('Content-Type', answer.contentType)
    return c.body(answer.bytes as Uint8Array<ArrayBuffer>, 200)
  })
  return route
}

export const manualRoute = siteRoute('/manual', signedInElse(signedOut('/manual')), manualDir)

// Owner / admin of any company. A signed-in account that is neither gets exactly the 404 of a
// path that names nothing (same text and headers): the guide's existence is not told to members.
export const manualAdminRoute = siteRoute('/manual-admin', fullAccessSomewhereElse(signedOut('/manual-admin'), notFound), manualAdminDir)
