/**
 * Which file a `local-file://` request may read. The query (`?v=<n>`, the
 * renderer's cache-buster) and fragment are dropped; the path must lie inside
 * one of the allowed roots (company folders the member opened), exactly as
 * before the query was introduced.
 */
import path from 'node:path'
import { localFilePathFromUrl } from '../shared/local-file-url'

export type LocalFileTarget =
  | { ok: true; path: string }
  | { ok: false; status: 400 | 403 }

export function localFileTarget(url: string, allowedRoots: Iterable<string>): LocalFileTarget {
  const filePath = localFilePathFromUrl(url)
  if (filePath === null || filePath === '') return { ok: false, status: 400 }
  const resolved = path.resolve(filePath)
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return { ok: true, path: resolved }
  }
  return { ok: false, status: 403 }
}
