// Which web permissions (Chromium's: camera / microphone, notifications,
// clipboard, fullscreen, USB, …) a page in the app gets. Default deny: Electron
// grants every request when no handler is set, so a page the app did not mean
// to show (a link that opened inside the app, a dropped file, an embedded
// frame) could otherwise use the camera or the clipboard without anyone seeing
// a prompt. The shell installs this on every session (electron-adapter.ts
// `denyUnexpectedPermissions`). No Electron here, so it is tested under Node
// (tests/permission-policy.test.ts).
//
// What the app's own page needs today:
//  - `clipboard-sanitized-write`: navigator.clipboard.writeText (「パスをコピー」,
//    the voice input's 「コピー」, the backup path in the sync notice).
//  - `fullscreen`: the Fullscreen API (a preview may use it; harmless for the
//    app's own page).
// Not needed: the microphone. Voice input records in a native helper and asks
// macOS itself (voice-input.ts, systemPreferences.askForMediaAccess), never
// through getUserMedia, so `media` stays refused.

/** The permissions the app's own page may use. */
export const APP_PAGE_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen'])

export interface AppPage {
  /** The packaged page, file://…/dist/index.html (createAppPages loads it with loadFile). */
  file: string
  /** The Vite dev server (VITE_DEV_SERVER_URL) in development; its origin is the app. */
  devServerUrl?: string
}

/**
 * Whether `url` is the app's own page (any query or hash: `?window=chat` is a
 * consultation window). Anything else — another file:// page (a file dropped
 * onto the window), a web site, `blob:` / `data:` frames, the PDF viewer — is not.
 */
export function isAppPage(url: string | undefined, page: AppPage): boolean {
  if (!url) return false
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (page.devServerUrl) {
    try { return parsed.origin === new URL(page.devServerUrl).origin } catch { return false }
  }
  const app = new URL(page.file)
  return parsed.protocol === 'file:' && parsed.pathname === app.pathname
}

/** True when the permission may be granted: one the app uses, asked by the app's own page. */
export function allowPermission(permission: string, requestingUrl: string | undefined, page: AppPage): boolean {
  return APP_PAGE_PERMISSIONS.has(permission) && isAppPage(requestingUrl, page)
}
