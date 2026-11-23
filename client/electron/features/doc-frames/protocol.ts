/**
 * `acb-doc://<token>/…` — the HTML viewer's files (`.claude/rules/doc-frame.md`).
 * No Electron here: the shell serves `serve` on the document session only
 * (`electron/doc-view.ts`).
 *
 * A **grant** is one document shown in one view: a random token standing for
 * that document's folder, held by the view (`ownerId` = the view's id). A
 * request reaches only a regular file inside that folder (or below it), and
 * only when:
 *
 * - the address is one `parseDocFrameUrl` reads (no `..`, encoded traversal,
 *   `\`, hidden names, empty segments) and the token is a grant not revoked
 *   (a view's grants go with it: `views.ts`);
 * - the file type is one `DOC_FILE_TYPES` serves;
 * - the path is not in a folder this computer did not download;
 * - no step below the folder is a link (each one `lstat`ed; the file is
 *   opened with `O_NOFOLLOW` where the system has it) and no folder below it
 *   holds a `.git` — another repository: a private folder's clone, which the
 *   document's author may not be able to read (refused for readers too);
 * - the file is a regular file of at most `DOC_MAX_FILE_BYTES`, one hard link;
 * - the opened file is the one at the path's real location, inside the
 *   folder's real path as opened (device and inode of the handle against the
 *   real path, before and after reading): a folder swapped for a link while
 *   the request runs serves nothing.
 *
 * Every refusal is the same 404 with the same body: an answer never names a
 * folder (private folder names never leak). Every file served carries the
 * document's CSP (`docFrameCsp`: no network source), `nosniff`, `no-store`,
 * `no-referrer`, `X-DNS-Prefetch-Control: off`.
 */
import fs from 'node:fs/promises'
import { constants as fsConstants, type Stats } from 'node:fs'
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
  newToken?: () => string
  log?: Pick<Console, 'warn'>
}

interface Grant {
  ownerId: number
  root: string
  /** The document's folder as opened (inside `root` by name, never `root` itself). */
  folder: string
  /** Its real path when opened: a folder swapped for a link later serves nothing. */
  realFolder: string
  /** No script runs in it (`script-src 'none'`): the user manual, which has none of its own. */
  noScripts?: boolean
}

/** A document `check` let through, before it is granted. */
export interface OpenableDocument extends Omit<Grant, 'ownerId'> {
  /** The file's name in its folder. */
  name: string
}

const REFUSALS: Readonly<Record<DocFrameRefusal, DocFrameRefused>> = Object.fromEntries(
  (Object.keys(DOC_FRAME_WORDS) as DocFrameRefusal[]).map(reason => [reason, { ok: false, reason, message: DOC_FRAME_WORDS[reason] }]),
) as Record<DocFrameRefusal, DocFrameRefused>

const NOT_FOUND_BODY = 'Not found'
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-DNS-Prefetch-Control': 'off',
}
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0

export const refuseDoc = (reason: DocFrameRefusal): DocFrameRefused => REFUSALS[reason]
const refuse = refuseDoc

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

const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino

export function createDocFrames(deps: DocFrameDeps) {
  const log = deps.log ?? console
  const newToken = deps.newToken ?? (() => randomBytes(16).toString('hex'))
  /** Token → grant. */
  const grants = new Map<string, Grant>()

  // The same answer for every refusal, whatever was asked: it names nothing.
  const notFound = () => new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; sandbox" },
  })

  /** Whether `target` still names exactly the opened file, at a real location inside the grant's folder. */
  async function stillTheFile(grant: Grant, target: string, opened: Stats): Promise<boolean> {
    const real = await fs.realpath(target)
    if (!real.startsWith(grant.realFolder + path.sep)) return false
    return sameFile(await fs.stat(real), opened)
  }

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
        // The handle, not only the path: what was opened must be the file at the real location
        // inside the folder (a folder on the way swapped for a link while opening leads elsewhere).
        if (!(await stillTheFile(grant, target, opened))) return null
        const buffer = Buffer.alloc(opened.size)
        const { bytesRead } = await handle.read(buffer, 0, opened.size, 0)
        // And again after reading: a swap back during the read is refused too.
        if (!(await stillTheFile(grant, target, opened))) return null
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
     * of a company folder (by name and real location), below a folder of it
     * (never the company folder's top level: its scripts could read every
     * served-type file of the company), not hidden, not a link, downloaded, at
     * most `DOC_MAX_FILE_BYTES`. Grants nothing by itself.
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
      const folder = path.dirname(resolved)
      if (folder === root) return refuse('top_level')
      const rel = relativeTo(root, resolved)
      // Never the repository's own folder.
      if (rel.split('/').some(segment => lookalikeKey(segment) === '.git')) return refuse('not_allowed')
      if (excludedFolderOf(deps.notDownloaded(root), rel)) return refuse('not_downloaded')
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
     * A grant for a checked document, held by view `ownerId`: the document's
     * `acb-doc://` address, for that view to load (it never leaves main). Each
     * view has its own grant — two views of one file have two tokens.
     */
    grant(doc: OpenableDocument, ownerId: number): string {
      let token = newToken()
      while (grants.has(token)) token = newToken()
      grants.set(token, { ownerId, root: doc.root, folder: doc.folder, realFolder: doc.realFolder, noScripts: doc.noScripts })
      return docFrameUrl(token, doc.name)
    },

    /** Revoke every grant of a view (it closed, was destroyed or its page crashed). */
    revoke(ownerId: number): void {
      for (const [token, grant] of grants) if (grant.ownerId === ownerId) grants.delete(token)
    },

    /** Serve one request (`protocol.handle` on the document session). */
    async serve(request: { url: string; method: string }): Promise<Response> {
      if (request.method !== 'GET') return notFound()
      const parsed = parseDocFrameUrl(request.url)
      if (!parsed) return notFound()
      const grant = grants.get(parsed.token)
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
          'Content-Security-Policy': docFrameCsp(docFramePolicy(parsed.token, { scripts: !grant.noScripts })),
        },
      })
    },
  }
}

export type DocFrames = ReturnType<typeof createDocFrames>
