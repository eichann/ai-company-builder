// shell:openExternal hands a URL to the operating system, which opens
// file:// paths, runs javascript: in a browser and launches whatever app
// registered a custom scheme. The app only ever opens web pages (a tool's
// http://localhost page, a confirmed remote image) and mail links.

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isExternalUrlAllowed(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * A link the page tried to open in a new window (`target="_blank"`, window.open)
 * or to navigate the window to: the URL to hand the member's browser, or null to
 * only refuse it. Web pages only — never `file:`, `javascript:`, `mailto:` or a
 * custom scheme (the OS would open a local file or launch another app from a
 * link in an AI answer or a markdown file).
 */
export function webLinkForBrowser(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}
