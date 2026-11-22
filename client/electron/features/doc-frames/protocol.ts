/**
 * `acb-doc://<token>/…` — the HTML viewer's files (`.claude/rules/doc-frame.md`).
 * No Electron here: the shell registers `serve` with `protocol.handle`
 * (`electron-adapter.ts` `serveDocFrames`).
 *
 * A **grant** is one opened document: a random token standing for that
 * document's folder. A request reaches only a regular file inside that folder
 * (or below it), and only when:
 *
 * - the address is one `parseDocFrameUrl` reads (no `..`, encoded traversal,
 *   `\`, hidden names, empty segments) and the token is a live grant whose
 *   window is still there (`ownerAlive`);
 * - the file type is one `DOC_FILE_TYPES` serves;
 * - the path is not in a folder this computer did not download;
 * - no step below the folder is a link (each one `lstat`ed; the file is
 *   opened with `O_NOFOLLOW` where the system has it) and no folder below it
 *   holds a `.git` — another repository: a private folder's clone, which the
 *   document's author may not be able to read (refused for readers too);
 * - the file is a regular file of at most `DOC_MAX_FILE_BYTES`, one hard link;
 * - its real location is inside the folder's real path as opened (a folder
 *   swapped for a link meanwhile serves nothing).
 *
 * Every refusal is the same 404 with the same body: an answer never names a
 * folder (private folder names never leak). Every file served carries the
 * document's CSP (`docFrameCsp`: no network source), `nosniff`, `no-store`,
 * `no-referrer`.
 */
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { excludedFolderOf } from '../../../shared/sparse-paths'
import {
  DOC_FRAME_WORDS, DOC_MAX_FILE_BYTES, docFileType, docFrameCsp, docFramePolicy, docFrameUrl, isHtmlDocumentName,
  parseDocFrameUrl, type DocFrameRefusal, type DocFrameRefused,
} from '../../../shared/doc-frame'
import { lookalikeKey } from '../../../../shared/core/paths'

export interface DocFramePaths {
  /** The path inside a company folder by name and by real location (`AllowedRoots.validate`); throws otherwise. */
  validate(inputPath: string): string
  /** The company folder the path lies in. */
  rootOf(inputPath: string): string | null
}

export interface DocFrameDeps {
  paths: DocFramePaths
  /** The folders this computer did not download (company-relative, `sync/sparse.ts`). */
  notDownloaded: (root: string) => readonly string[]
  /** Whether the window that opened a grant is still there; a grant of a gone window is revoked. */
  ownerAlive: (ownerId: number) => boolean
  newToken?: () => string
  log?: Pick<Console, 'warn'>
}

interface Grant {
  ownerId: number
  root: string
  /** The document's folder as opened (inside `root` by name). */
  folder: string
  /** Its real path when opened: a folder swapped for a link later serves nothing. */
  realFolder: string
}

/** A document `check` let through, before it is granted. */
export interface OpenableDocument extends Omit<Grant, 'ownerId'> {
  /** The file's name in its folder. */
  name: string
}

const REFUSALS: Readonly<Record<DocFrameRefusal, DocFrameRefused>> = Object.fromEntries(
  (Object.keys(DOC_FRAME_WORDS) as DocFrameRefusal[]).map(reason => [reason, { ok: false, reason, message: DOC_FRAME_WORDS[reason] }]),
) as Record<DocFrameRefusal, DocFrameRefused>

/** At most this many open documents per window; opening one more forgets the oldest. */
export const MAX_GRANTS_PER_OWNER = 32

const NOT_FOUND_BODY = 'Not found'
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0

const refuse = (reason: DocFrameRefusal): DocFrameRefused => REFUSALS[reason]

/** Company-relative, `/`-separated. */
const relativeTo = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/')

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

export function createDocFrames(deps: DocFrameDeps) {
  const log = deps.log ?? console
  const newToken = deps.newToken ?? (() => randomBytes(16).toString('hex'))
  /** Token → grant, in the order opened (a Map keeps insertion order: the oldest first). */
  const grants = new Map<string, Grant>()

  const liveGrant = (token: string): Grant | null => {
    const grant = grants.get(token)
    if (!grant) return null
    if (!deps.ownerAlive(grant.ownerId)) {
      grants.delete(token)
      return null
    }
    return grant
  }

  // The same answer for every refusal, whatever was asked: it names nothing.
  const notFound = () => new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; sandbox" },
  })

  /** The bytes of `segments` under the grant's folder, or null for every refusal. */
  async function readInside(grant: Grant, segments: readonly string[]): Promise<Buffer | null> {
    // Segments are plain names (`parseDocFrameUrl`): the target is below the folder by name.
    const target = path.join(grant.folder, ...segments)
    if (excludedFolderOf(deps.notDownloaded(grant.root), relativeTo(grant.root, target))) return null
    try {
      let dir = grant.folder
      for (const name of segments.slice(0, -1)) {
        dir = path.join(dir, name)
        // lstat: a link is not a directory.
        if (!(await fs.lstat(dir)).isDirectory()) return null
        // Another repository (a private folder's clone, a nested repository): never entered.
        if (await exists(path.join(dir, '.git'))) return null
      }
      // A link as the file itself fails to open (where the system has O_NOFOLLOW); a named pipe
      // opens without waiting for a writer (O_NONBLOCK) and is then refused as not a file.
      const handle = await fs.open(target, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.nlink > 1 || opened.size > DOC_MAX_FILE_BYTES) return null
        // Last, the real location: a folder on the way swapped for a link meanwhile leads elsewhere.
        const real = await fs.realpath(target)
        if (!real.startsWith(grant.realFolder + path.sep)) return null
        const buffer = Buffer.alloc(opened.size)
        const { bytesRead } = await handle.read(buffer, 0, opened.size, 0)
        return buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  return {
    /**
     * Whether `filePath` may be shown as a document: one `.html` / `.htm` file
     * of a company folder (by name and real location), not hidden, not a link,
     * downloaded, at most `DOC_MAX_FILE_BYTES`. Grants nothing by itself.
     */
    async check(filePath: unknown): Promise<{ ok: true; doc: OpenableDocument } | DocFrameRefused> {
      if (typeof filePath !== 'string' || filePath === '') return refuse('not_found')
      let resolved: string
      try {
        resolved = deps.paths.validate(filePath)
      } catch {
        return refuse('not_allowed')
      }
      const name = path.basename(resolved)
      if (!isHtmlDocumentName(name)) return refuse('not_html')
      if (name.startsWith('.')) return refuse('not_allowed')
      const root = deps.paths.rootOf(resolved)
      if (!root || resolved === root) return refuse('not_allowed')
      const rel = relativeTo(root, resolved)
      // Never the repository's own folder.
      if (rel.split('/').some(segment => lookalikeKey(segment) === '.git')) return refuse('not_allowed')
      if (excludedFolderOf(deps.notDownloaded(root), rel)) return refuse('not_downloaded')
      const folder = path.dirname(resolved)
      try {
        // No link anywhere from the company folder down: the grant's folder is where it is by name.
        let dir = root
        for (const segment of rel.split('/').slice(0, -1)) {
          dir = path.join(dir, segment)
          // lstat: a link is not a directory, nor a file below.
          if (!(await fs.lstat(dir)).isDirectory()) return refuse('not_allowed')
        }
        const st = await fs.lstat(resolved)
        if (!st.isFile()) return refuse('not_allowed')
        if (st.size > DOC_MAX_FILE_BYTES) return refuse('too_large')
        return { ok: true, doc: { root, folder, realFolder: await fs.realpath(folder), name } }
      } catch {
        return refuse('not_found')
      }
    },

    /**
     * A grant for a checked document, held by window `ownerId`: the document's
     * `acb-doc://` address (the renderer gets only this). Each call is a new
     * grant — two views of one file have two tokens, each closed on its own.
     */
    grant(doc: OpenableDocument, ownerId: number): string {
      const own = [...grants].filter(([, g]) => g.ownerId === ownerId)
      for (const [token] of own.slice(0, Math.max(0, own.length - MAX_GRANTS_PER_OWNER + 1))) grants.delete(token)
      let token = newToken()
      while (grants.has(token)) token = newToken()
      grants.set(token, { ownerId, root: doc.root, folder: doc.folder, realFolder: doc.realFolder })
      return docFrameUrl(token, doc.name)
    },

    /** Revoke the grant of `url` (the view closed). Only its own window may; anything else is ignored. */
    close(url: unknown, ownerId: number): void {
      if (typeof url !== 'string') return
      const parsed = parseDocFrameUrl(url)
      const grant = parsed ? grants.get(parsed.token) : undefined
      if (parsed && grant && grant.ownerId === ownerId) grants.delete(parsed.token)
    },

    /** Revoke every grant of a window (it closed or reloaded). */
    closeAllOf(ownerId: number): void {
      for (const [token, grant] of grants) if (grant.ownerId === ownerId) grants.delete(token)
    },

    /** Serve one request (`protocol.handle`). */
    async serve(request: { url: string; method: string }): Promise<Response> {
      if (request.method !== 'GET') return notFound()
      const parsed = parseDocFrameUrl(request.url)
      if (!parsed) return notFound()
      const grant = liveGrant(parsed.token)
      if (!grant) return notFound()
      const type = docFileType(parsed.segments[parsed.segments.length - 1])
      if (!type) return notFound()
      const bytes = await readInside(grant, parsed.segments)
      // Revoked while the file was read (the view closed meanwhile): nothing is answered.
      if (!bytes || grants.get(parsed.token) !== grant) {
        if (!bytes) log.warn('[doc-frame] refused a request')
        return notFound()
      }
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          ...BASE_HEADERS,
          'Content-Type': type,
          'Content-Security-Policy': docFrameCsp(docFramePolicy(parsed.token)),
        },
      })
    },
  }
}

export type DocFrames = ReturnType<typeof createDocFrames>
