/**
 * `acb-plugin://<id>/<version>/ui/…` (stage 4b, plan A5,
 * `.claude/rules/plugin-frame.md`): a business plugin's screen files, served
 * only from the verified package the app keeps
 * (`<userData>/plugins/<id>@<version>/`, `store.ts`). No Electron here: the
 * shell registers `serve` with `protocol.handle` (`electron-adapter.ts`).
 *
 * - The address must be a `ui/` file a package may hold
 *   (`parsePluginFrameUrl`): `%` escapes, `\`, `..`, another plugin or
 *   version, `plugin.yaml` / `steps/` / `types/` → 404.
 * - The package must be one a company of the signed-in account lists now and
 *   the store kept (`keptPackage`) → else 404.
 * - The first time a package is served in this run of the app, its whole
 *   folder is verified against the fingerprint it was kept with
 *   (fingerprint v2, `shared/core/plugin-fingerprint.ts`): only regular files
 *   (no links), only package paths, the same fingerprint. A folder that does
 *   not match is never served (logged by package name only).
 * - Every answer is the bytes just read, hashed and compared with the
 *   verified listing: a file changed on disk after the check → 404, and the
 *   package is checked again from scratch next time.
 *
 * Each answer carries the frame's CSP (`pluginFrameCsp`: no network at all),
 * `nosniff`, `no-store`, and `Access-Control-Allow-Origin: null` (the frame's
 * origin is opaque — sandboxed without `allow-same-origin` — and module
 * scripts are fetched in CORS mode; the CSP still refuses every `fetch`).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pluginFingerprintV2Listing } from '../../../../shared/core/plugin-fingerprint'
import { isPluginPackagePath } from '../../../../shared/core/plugin-package-paths'
import { parsePluginFrameUrl, pluginFrameCsp, pluginUiBase } from '../../../shared/plugin-bridge'
import { pluginPackageName } from '../../../shared/plugin-packages'

export interface PluginFileSource {
  /** A kept package listed for the signed-in account now (`companyId`: by that company), with the fingerprint it was kept with. */
  keptPackage(pluginId: string, version: string, companyId?: string): { folder: string; fingerprint: string } | null
}

export interface PluginFileServerDeps {
  packages: PluginFileSource
  log?: Pick<Console, 'warn'>
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

/** Same bounds as a package on the shelf (plugins.md "Package folders"), so a filled folder is not read forever. */
const MAX_FILES = 400
const MAX_TOTAL_BYTES = 12 * 1024 * 1024

const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

/** Every file of a package folder (relative `/` paths → sha256), or null when anything in it is not a plain package file. */
async function listPackage(folder: string): Promise<Map<string, string> | null> {
  const hashes = new Map<string, string>()
  let total = 0
  async function walk(dir: string, rel: string): Promise<boolean> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!(await walk(full, relPath))) return false
        continue
      }
      // A link (or anything but a regular file) is never part of a verified package.
      if (!e.isFile() || !isPluginPackagePath(relPath)) return false
      if (hashes.size >= MAX_FILES) return false
      const bytes = await fs.readFile(full)
      total += bytes.length
      if (total > MAX_TOTAL_BYTES) return false
      hashes.set(relPath, sha256Hex(bytes))
    }
    return true
  }
  try {
    return (await walk(folder, '')) ? hashes : null
  } catch {
    return null
  }
}

export function createPluginFileServer(deps: PluginFileServerDeps) {
  const log = deps.log ?? console
  /** Package name → the listing verified in this run, with the fingerprint it matched. */
  const verified = new Map<string, { fingerprint: string; hashes: Map<string, string> }>()

  async function verify(name: string, folder: string, fingerprint: string): Promise<Map<string, string> | null> {
    const known = verified.get(name)
    if (known && known.fingerprint === fingerprint) return known.hashes
    verified.delete(name)
    const hashes = await listPackage(folder)
    if (!hashes) {
      log.warn(`[plugins] ${name}: the kept folder holds something a package may not; not shown`)
      return null
    }
    let listing: string
    try {
      listing = pluginFingerprintV2Listing([...hashes].map(([p, sha256]) => ({ path: p, sha256 })))
    } catch {
      return null
    }
    if (sha256Hex(listing) !== fingerprint) {
      log.warn(`[plugins] ${name}: the kept folder does not match its fingerprint; not shown`)
      return null
    }
    verified.set(name, { fingerprint, hashes })
    return hashes
  }

  const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })

  /**
   * One file of a kept, verified package: the bytes just read, equal to the
   * verified listing, or null (not kept / not listed / not verified / changed).
   */
  async function readVerified(ref: { id: string; version: string }, filePath: string, companyId?: string): Promise<Buffer | null> {
    const kept = deps.packages.keptPackage(ref.id, ref.version, companyId)
    if (!kept) return null
    const name = pluginPackageName(ref)
    const hashes = await verify(name, kept.folder, kept.fingerprint)
    const expected = hashes?.get(filePath)
    if (!expected) return null
    const file = path.join(kept.folder, ...filePath.split('/'))
    let bytes: Buffer
    try {
      // Not a link, and still inside the package's real folder.
      const st = await fs.lstat(file)
      if (!st.isFile()) return null
      const [realFolder, realFile] = await Promise.all([fs.realpath(kept.folder), fs.realpath(file)])
      if (!realFile.startsWith(realFolder + path.sep)) return null
      bytes = await fs.readFile(file)
    } catch {
      return null
    }
    if (sha256Hex(bytes) !== expected) {
      verified.delete(name)
      log.warn(`[plugins] ${name}: a file changed after it was verified; not shown`)
      return null
    }
    return bytes
  }

  return {
    async serve(request: { url: string; method?: string }): Promise<Response> {
      if (request.method && request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
      const address = parsePluginFrameUrl(request.url)
      if (!address) return notFound()
      const bytes = await readVerified(address, address.path)
      if (!bytes) return notFound()
      const ext = address.path.slice(address.path.lastIndexOf('.') + 1).toLowerCase()
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Content-Security-Policy': pluginFrameCsp(pluginUiBase(address)),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Access-Control-Allow-Origin': 'null',
        },
      })
    },
    /**
     * A package's declaration and its file list, read through the same check
     * as every served file (screens.ts, A6): null when the package is not kept
     * for this company now or does not match its fingerprint.
     */
    async declaration(companyId: string, ref: { id: string; version: string }): Promise<{ manifest: string; files: Set<string> } | null> {
      // The whole folder again (not only plugin.yaml): a slot is shown only for a package that matches now.
      verified.delete(pluginPackageName(ref))
      const bytes = await readVerified(ref, 'plugin.yaml', companyId)
      if (!bytes) return null
      const listing = verified.get(pluginPackageName(ref))
      return listing ? { manifest: bytes.toString('utf8'), files: new Set(listing.hashes.keys()) } : null
    },
  }
}

export type PluginFileServer = ReturnType<typeof createPluginFileServer>
