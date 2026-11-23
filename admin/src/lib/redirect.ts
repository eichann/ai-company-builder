/**
 * The static sites the API serves (not this console): the user manual (`/manual/…`, server.md
 * "The user manual") and the administrator guide (`/manual-admin/…`, server.md "The administrator
 * guide"). The sign-in page sends a reader back to them as a whole page.
 */
export type ManualSite = 'manual' | 'manual-admin'

/** Which site a (normalised: `safeRedirect`) path is a page of, or null for anything else. */
export function manualSiteOf(path: string): ManualSite | null {
  if (path.startsWith('/manual/')) return 'manual'
  if (path.startsWith('/manual-admin/')) return 'manual-admin'
  return null
}

/** A page of the user manual or of the administrator guide. */
export function isManualPath(path: string): boolean {
  return manualSiteOf(path) !== null
}

/** The administrator guide's first page (opened in a new tab from the console's menu). */
export const ADMIN_GUIDE_PATH = '/manual-admin/index.html'

const FALLBACK = '/dashboard'
// A fixed stand-in for this console's own origin: only whether the parsed result stays on it counts.
const BASE = new URL('https://admin.invalid')
// C0 controls, DEL, C1 controls, the Unicode line / paragraph separators, and backslashes. URL
// parsing strips tabs and newlines and reads `\` as `/`, so `/<TAB>/evil.example` or
// `/\evil.example` would become `//evil.example`: another site after sign-in.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/

function acceptable(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !UNSAFE.test(path)
}

/**
 * Only same-origin paths, so ?redirect= cannot send people to another site. Returns the path as
 * the URL parser normalises it (dot segments resolved), so a caller's check — `manualSiteOf` —
 * judges the path the browser will actually open. The same checks hold once percent-decoded, so an
 * encoded tab, newline, backslash or slash (`/%09/x`, `/%2F/x`) is refused too.
 */
export function safeRedirect(value: string | null): string {
  if (!value || !acceptable(value)) return FALLBACK
  let url: URL
  try {
    url = new URL(value, BASE)
  } catch {
    return FALLBACK
  }
  if (url.origin !== BASE.origin) return FALLBACK
  const path = `${url.pathname}${url.search}${url.hash}`
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return FALLBACK
  }
  if (!acceptable(path) || !acceptable(decoded)) return FALLBACK
  return path
}
