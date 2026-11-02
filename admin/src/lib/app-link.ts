// The invitation page's 「アプリを開く」 (管理画面の見直し 2-2): a link the desktop app handles
// (client/electron/app-link.ts parses it, the app shows the address and asks before using it).
// It carries this server's address only — never the invitation token, the session or anything
// of the member — so a copied link gives nobody more than the address it shows.

/** The URL scheme the desktop app registers (client/package.json `build.protocols`). */
export const APP_LINK_SCHEME = 'ai-company-builder'

/**
 * `ai-company-builder://open?server=<origin>` for the server at `pageUrl` (the page's own
 * address: the admin console and the API share one origin behind Caddy). Only the origin is
 * kept: a path, query or fragment of the page never reaches the app.
 */
export function appOpenLink(pageUrl: string): string {
  const origin = new URL(pageUrl).origin
  return `${APP_LINK_SCHEME}://open?server=${encodeURIComponent(origin)}`
}
