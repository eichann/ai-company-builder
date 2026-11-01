/**
 * The one check of a path sent to an outside service: the key broker's relay
 * (K4, the path a script asks for) and the plugin declarations (milestone 3,
 * the fixed paths a connector may call) apply the same rule, so a path the
 * relay would refuse can never be written into a plugin either.
 */

/**
 * The upstream path, checked: '/'-rooted, no `//`, `\`, encoded '/' / '\' /
 * NUL, control characters, spaces or `.` / `..` segments (also once
 * percent-decoded). null when refused; `decoded` is the path with each
 * segment percent-decoded.
 */
export function checkUpstreamPath(raw: string): { path: string; decoded: string } | null {
  if (!raw.startsWith('/') || raw.includes('//') || raw.includes('\\') || /%(2f|5c|00)/i.test(raw)) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(raw)) return null
  let decoded: string
  try { decoded = raw.split('/').map(decodeURIComponent).join('/') } catch { return null }
  if (decoded.split('/').some(s => s === '.' || s === '..')) return null
  return { path: raw, decoded }
}
