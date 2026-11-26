/**
 * Videos the app takes in and shows (files-and-editor.md "Videos"): the file
 * tree's Finder drop, the editor's preview and main's 「ほかのアプリで開く」 read
 * this one list.
 */
export const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'mov']

export function isVideoFileName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && VIDEO_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())
}

/**
 * `acb-media://` shows a company video in the app's page. Not `local-file://`:
 * Chromium's media player seeks (asks for a byte range) only on a standard
 * scheme, and `local-file://` is not one (its URLs carry no host). The whole
 * path is one encoded segment after the fixed host `video`, so the URL parser
 * never folds a `..` or a backslash in it; `?v=<n>` is the file's version, as
 * for images (a replaced file loads again).
 */
export const MEDIA_SCHEME = 'acb-media'
const MEDIA_PREFIX = `${MEDIA_SCHEME}://video/`

export function localVideoUrl(absPath: string, version?: number): string {
  const base = `${MEDIA_PREFIX}${encodeURIComponent(absPath)}`
  return version && version > 0 ? `${base}?v=${version}` : base
}

/** The file path an `acb-media://` request names, or null (another URL, bad encoding). */
export function localVideoPathFromUrl(url: string): string | null {
  if (!url.startsWith(MEDIA_PREFIX)) return null
  let rest = url.slice(MEDIA_PREFIX.length)
  const cut = rest.search(/[?#]/)
  if (cut >= 0) rest = rest.slice(0, cut)
  if (rest.includes('/')) return null
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}
