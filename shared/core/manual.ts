/**
 * The user manual (取説): the built site's file names and its manifest, read by
 * the server (which serves only what the manifest names, at `/manual/`) and by
 * the desktop app (which copies exactly those files to show them in the HTML
 * viewer or to write them to a folder the member chose). One copy of the rule,
 * so neither side can be talked into a path the other would not produce.
 *
 * The built site is flat: `<page>.html` and `manual.css` at its top, pictures
 * in `images/`. Sources are `manual/pages/<page>.md` and `manual/images/<scene>.png`
 * (a page names a picture as `../images/<scene>.png`; the build makes it `images/…`).
 *
 * The administrator guide (`manual-admin/`, served at `/manual-admin/` to owners and admins:
 * server.md "The administrator guide") is built and served by the same rules and this file's.
 */

/** `manifest.json`'s `format`; another number is not read. */
export const MANUAL_MANIFEST_FORMAT = 1

/** The manifest's own name at the site's top (served, never listed in it). */
export const MANUAL_MANIFEST = 'manifest.json'

/** The page a bare `/manual/` and the app's 「使い方」 open. */
export const MANUAL_INDEX_PAGE = 'index'

/** At most this many files and bytes per file / in all: a manifest beyond them is refused whole. */
export const MANUAL_LIMITS = { files: 2000, fileBytes: 20 * 1024 * 1024, totalBytes: 300 * 1024 * 1024 } as const

const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const IMAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,99}\.(?:png|jpe?g|webp)$/
const SHA256_HEX = /^[0-9a-f]{64}$/

/** A page id: lower-case ASCII letters, digits and `-` (the source file's name without `.md`). */
export function isManualPageId(value: unknown): value is string {
  return typeof value === 'string' && PAGE_ID.test(value)
}

/** The built file of a page (`<id>.html`). */
export const manualPageFile = (pageId: string): string => `${pageId}.html`

/**
 * One of the built site's file paths (`/`-separated, relative to its top):
 * `<page>.html`, `manual.css` or `images/<name>.png|jpg|jpeg|webp`. Nothing
 * else — no other folder, no hidden name, no `..`, no SVG (it could carry a script).
 */
export function isManualFilePath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value === 'manual.css') return true
  if (value.startsWith('images/')) return IMAGE_NAME.test(value.slice('images/'.length))
  return value.endsWith('.html') && PAGE_ID.test(value.slice(0, -'.html'.length))
}

/** The Content-Type a file of the site is served (and only these). */
export function manualContentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.png')) return 'image/png'
  if (filePath.endsWith('.webp')) return 'image/webp'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'image/jpeg'
}

export interface ManualFile {
  path: string
  sha256: string
  size: number
}

export interface ManualPage {
  id: string
  title: string
}

export interface ManualManifest {
  format: typeof MANUAL_MANIFEST_FORMAT
  pages: ManualPage[]
  files: ManualFile[]
}

/**
 * A manifest as it was written by the build, or null: the right format, every
 * file path one `isManualFilePath` accepts and listed once, a sha256 and a size
 * within `MANUAL_LIMITS`, the index page among the files, and every page's file
 * listed. Anything else is refused whole (nothing partly trusted).
 */
export function parseManualManifest(value: unknown): ManualManifest | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.format !== MANUAL_MANIFEST_FORMAT || !Array.isArray(v.files) || !Array.isArray(v.pages)) return null
  if (v.files.length === 0 || v.files.length > MANUAL_LIMITS.files) return null
  const files: ManualFile[] = []
  const seen = new Set<string>()
  let total = 0
  for (const f of v.files as unknown[]) {
    if (!f || typeof f !== 'object') return null
    const { path, sha256, size } = f as Record<string, unknown>
    if (!isManualFilePath(path) || seen.has(path)) return null
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MANUAL_LIMITS.fileBytes) return null
    total += size
    if (total > MANUAL_LIMITS.totalBytes) return null
    seen.add(path)
    files.push({ path, sha256, size })
  }
  if (!seen.has(manualPageFile(MANUAL_INDEX_PAGE))) return null
  const pages: ManualPage[] = []
  for (const p of v.pages as unknown[]) {
    if (!p || typeof p !== 'object') return null
    const { id, title } = p as Record<string, unknown>
    if (!isManualPageId(id) || !seen.has(manualPageFile(id)) || typeof title !== 'string' || title.length > 200) return null
    pages.push({ id, title })
  }
  return { format: MANUAL_MANIFEST_FORMAT, pages, files }
}
