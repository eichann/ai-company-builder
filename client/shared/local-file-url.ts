/**
 * `local-file://` URLs for previews of company files (images, markdown
 * images). The renderer appends `?v=<n>`, a per-path counter bumped on every
 * watcher event for the path, so a file replaced under the same name is
 * fetched again instead of served from Chromium's image cache. The protocol
 * handler in the main process drops the query before resolving the path.
 *
 * Only `%`, `?` and `#` are escaped in the path: they are the characters that
 * would otherwise be read as an escape, the query or the fragment. Everything
 * else (Japanese names, spaces, Windows drive letters) is passed as before.
 */

const PREFIX = 'local-file://'

function escapePath(p: string): string {
  return p.replace(/%/g, '%25').replace(/\?/g, '%3F').replace(/#/g, '%23')
}

/** `local-file://<path>` plus `?v=<version>` when a version is given (> 0). */
export function localFileUrl(absPath: string, version?: number): string {
  const base = `${PREFIX}${escapePath(absPath)}`
  return version && version > 0 ? `${base}?v=${version}` : base
}

/**
 * The file path a `local-file://` request names: the query and fragment are
 * dropped, then the path is percent-decoded. null when the URL is not a
 * local-file URL or cannot be decoded.
 */
export function localFilePathFromUrl(url: string): string | null {
  if (!url.startsWith(PREFIX)) return null
  let rest = url.slice(PREFIX.length)
  const cut = rest.search(/[?#]/)
  if (cut >= 0) rest = rest.slice(0, cut)
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}
