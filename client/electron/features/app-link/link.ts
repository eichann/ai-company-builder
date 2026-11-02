// The invitation page's 「アプリを開く」 link (admin/src/lib/app-link.ts builds it):
// `ai-company-builder://open?server=<origin>`. Anyone can write such a link, so this is
// the gate that decides which server address the app would even offer to the member
// (ipc.ts then shows it and asks before using it). Pure: no Electron, no fetch.

/** The scheme the app registers (client/package.json `build.protocols`). */
export const APP_LINK_SCHEME = 'ai-company-builder'

const MAX_LINK_LENGTH = 2048
// http only on this computer (a server the member runs themselves; reaching it needs code on the machine already).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The server origin a link offers, or null for anything else: another scheme or action,
 * no or several `server` values, a server address that is not https (http only for
 * loopback), carries a user name / password, or has a path, query or fragment (the page
 * sends the origin only, so anything more is not ours).
 */
export function serverFromAppLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_LINK_LENGTH) return null
  let link: URL
  try {
    link = new URL(raw)
  } catch {
    return null
  }
  if (link.protocol !== `${APP_LINK_SCHEME}:` || link.hostname !== 'open') return null
  const values = link.searchParams.getAll('server')
  if (values.length !== 1) return null
  let server: URL
  try {
    server = new URL(values[0])
  } catch {
    return null
  }
  const secure = server.protocol === 'https:' || (server.protocol === 'http:' && LOOPBACK_HOSTS.has(server.hostname))
  if (!secure) return null
  if (server.username || server.password) return null
  if (server.pathname !== '/' || server.search || server.hash) return null
  return server.origin
}

/** The first app link among a launch's arguments (Windows / Linux hand it over that way). */
export function appLinkInArgs(argv: readonly string[]): string | null {
  return argv.find(arg => typeof arg === 'string' && arg.startsWith(`${APP_LINK_SCHEME}:`)) ?? null
}
