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
