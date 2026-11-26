/**
 * Which file a `local-file://` request may read. The query (`?v=<n>`, the
 * renderer's cache-buster) and fragment are dropped; the path must lie inside
 * one of the allowed roots (company folders the member opened), exactly as
 * before the query was introduced.
 */
import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { localFilePathFromUrl } from '../shared/local-file-url'
import { isVideoFileName, localVideoPathFromUrl } from '../shared/video-files'

export type LocalFileTarget =
  | { ok: true; path: string }
  | { ok: false; status: 400 | 403 }

export function localFileTarget(url: string, allowedRoots: Iterable<string>): LocalFileTarget {
  return insideRoots(localFilePathFromUrl(url), allowedRoots)
}

function insideRoots(filePath: string | null, allowedRoots: Iterable<string>): LocalFileTarget {
  if (filePath === null || filePath === '') return { ok: false, status: 400 }
  const resolved = path.resolve(filePath)
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return { ok: true, path: resolved }
  }
  return { ok: false, status: 403 }
}

/**
 * The part of a file a `Range` header asks for (`acb-media://`: a video's
 * player asks for pieces, so a 100 MB file is never read whole and an index at
 * its end is reached at once). One range only, in bytes: `start-end`, `start-` or the
 * last `-n`. `full` for no header or a form we do not serve (several ranges,
 * other units): the whole file, as before. `unsatisfiable` when it starts at
 * or after the end (HTTP 416).
 */
export type ByteRange =
  | { kind: 'full' }
  | { kind: 'part'; start: number; end: number }
  | { kind: 'unsatisfiable' }

export function byteRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: 'full' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'full' }
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'part', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(m[1])
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' }
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (end < start) return { kind: 'full' }
  return { kind: 'part', start, end }
}

/**
 * Which video an `acb-media://` request may read (files-and-editor.md
 * "Videos"): a `.mp4` / `.mov` inside an allowed root by name; the caller
 * then checks its real location (`AllowedRoots.validate`), like local-file://.
 * Any other file is 403: the scheme serves videos only.
 */
export function localVideoTarget(url: string, allowedRoots: Iterable<string>): LocalFileTarget {
  const filePath = localVideoPathFromUrl(url)
  if (filePath && !isVideoFileName(path.basename(filePath))) return { ok: false, status: 403 }
  return insideRoots(filePath, allowedRoots)
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0
const VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime' }

/**
 * A checked video file, streamed from disk: the whole file (200), only the
 * bytes a `Range` header asks for (206), or 416. Never cached. 404 when it is
 * gone, is a link (opened with `O_NOFOLLOW` where the system has it) or is not
 * a regular file. Opened once and read from that handle, so a link swapped in
 * after the checks leads nowhere.
 */
export async function videoFileResponse(filePath: string, rangeHeader: string | null): Promise<Response> {
  let handle: FileHandle
  let size: number
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return new Response('Not found', { status: 404 })
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch {
    await handle.close()
    return new Response('Not found', { status: 404 })
  }
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': VIDEO_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
  }
  const range = byteRange(rangeHeader, size)
  if (range.kind === 'unsatisfiable' || size === 0) {
    await handle.close()
    if (size === 0) return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': '0' } })
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  }
  const { start, end } = range.kind === 'part' ? range : { start: 0, end: size - 1 }
  const body = Readable.toWeb(handle.createReadStream({ start, end, autoClose: true })) as ReadableStream<Uint8Array>
  headers['Content-Length'] = String(end - start + 1)
  if (range.kind === 'part') headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(body, { status: range.kind === 'part' ? 206 : 200, headers })
}
