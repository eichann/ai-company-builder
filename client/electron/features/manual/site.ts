/**
 * This computer's copy of the user manual (files-and-editor.md "The user manual"):
 * the server's built site (`/manual/`, shared/core/manual.ts), kept under the
 * app's own data folder per server, so the HTML viewer shows it from disk and
 * it still opens offline. No Electron here.
 *
 * - Only what the server's manifest names is fetched, and each file is kept
 *   only when its size and sha256 match the manifest; one that does not stops
 *   the refresh and the copy on disk stays as it was. Redirects are refused.
 * - A refresh builds a new folder beside the copy and swaps it in by rename:
 *   a refresh cut off half-way leaves the old copy whole. Refreshes run one
 *   at a time.
 * - Files whose sha256 did not change are taken from the old copy, not fetched again.
 * - The export writes exactly the copy's files (checked again) into a folder
 *   the caller already made empty, never replacing anything.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { MANUAL_MANIFEST, parseManualManifest, type ManualManifest } from '../../../../shared/core/manual'

export interface ManualSiteDeps {
  /** The server's address (config.json); its origin is used. */
  serverUrl: () => string
  /** Where copies are kept (`<userData>/manual`). */
  cacheRoot: string
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  /** How long one request may take (default 8 s; then the kept copy is shown). */
  timeoutMs?: number
}

/** The copy shown or written, or why there is none. */
export type ManualCopy =
  | { kind: 'copy'; dir: string; manifest: ManualManifest }
  /** The server answered that it has no manual (an older server): what was kept is not shown. */
  | { kind: 'missing' }
  /** The server could not be reached and nothing was kept for it. */
  | { kind: 'none' }

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

class RefreshFailed extends Error {}

/** The origin of the server's address, or null when it is not an http(s) address. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

async function readManifest(dir: string): Promise<ManualManifest | null> {
  try {
    return parseManualManifest(JSON.parse(await fs.readFile(path.join(dir, MANUAL_MANIFEST), 'utf8')))
  } catch {
    return null
  }
}

export function createManualSite(deps: ManualSiteDeps) {
  const fetchImpl = deps.fetch ?? fetch
  const log = deps.log ?? console
  const timeoutMs = deps.timeoutMs ?? 8_000
  let queue: Promise<unknown> = Promise.resolve()

  const folderOf = (origin: string) => path.join(deps.cacheRoot, createHash('sha256').update(origin).digest('hex').slice(0, 16))

  async function get(origin: string, file: string): Promise<Response> {
    return fetchImpl(`${origin}/manual/${file}`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  }

  async function bytesOf(res: Response, maxBytes: number): Promise<Uint8Array> {
    const length = Number(res.headers.get('content-length'))
    if (Number.isFinite(length) && length > maxBytes) throw new RefreshFailed('too large')
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new RefreshFailed('too large')
    return bytes
  }

  /** The server's manifest; null = the server has none (404); throws when it cannot be read. */
  async function serverManifest(origin: string): Promise<{ manifest: ManualManifest; bytes: Uint8Array } | null> {
    const res = await get(origin, MANUAL_MANIFEST)
    if (res.status === 404) return null
    if (!res.ok) throw new RefreshFailed(`status ${res.status}`)
    const bytes = await bytesOf(res, 4 * 1024 * 1024)
    const manifest = parseManualManifest(JSON.parse(new TextDecoder().decode(bytes)))
    if (!manifest) throw new RefreshFailed('not a manual manifest')
    return { manifest, bytes }
  }

  async function refreshInto(origin: string, site: string): Promise<ManualCopy> {
    const fresh = await serverManifest(origin)
    if (!fresh) return { kind: 'missing' }
    const old = await readManifest(site)
    const oldHashes = new Map(old?.files.map(f => [f.path, f.sha256]) ?? [])
    const staging = `${site}.new-${randomBytes(6).toString('hex')}`
    await fs.mkdir(path.join(staging, 'images'), { recursive: true })
    try {
      for (const file of fresh.manifest.files) {
        let bytes: Uint8Array | null = null
        if (oldHashes.get(file.path) === file.sha256) {
          bytes = await fs.readFile(path.join(site, ...file.path.split('/'))).catch(() => null)
          if (bytes && sha256(bytes) !== file.sha256) bytes = null
        }
        if (!bytes) {
          const res = await get(origin, file.path)
          if (!res.ok) throw new RefreshFailed(`status ${res.status}`)
          bytes = await bytesOf(res, file.size)
        }
        if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) throw new RefreshFailed('a file differs from its manifest')
        await fs.writeFile(path.join(staging, ...file.path.split('/')), bytes, { flag: 'wx' })
      }
      // The manifest last: a folder holding one is complete.
      await fs.writeFile(path.join(staging, MANUAL_MANIFEST), fresh.bytes, { flag: 'wx' })
      const retired = `${site}.old-${randomBytes(6).toString('hex')}`
      const hadOld = await fs.rename(site, retired).then(() => true, () => false)
      try {
        await fs.rename(staging, site)
      } catch (err) {
        // The old copy goes back; a stop right here is put right by `recover` on the next look.
        if (hadOld) await fs.rename(retired, site).catch(() => {})
        throw err
      }
      if (hadOld) await fs.rm(retired, { recursive: true, force: true })
      return { kind: 'copy', dir: site, manifest: fresh.manifest }
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true })
      throw err
    }
  }

  /**
   * After a refresh stopped between its two renames (the app quit, a failure): no `site`, but the
   * retired copy beside it — it is put back. Leftover staging and retired folders are removed.
   */
  async function recover(site: string): Promise<void> {
    const dir = path.dirname(site)
    const base = path.basename(site)
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const retired = names.filter(n => n.startsWith(`${base}.old-`))
    if (!(await readManifest(site))) {
      for (const name of retired) {
        if (await readManifest(path.join(dir, name))) {
          await fs.rm(site, { recursive: true, force: true })
          if (await fs.rename(path.join(dir, name), site).then(() => true, () => false)) break
        }
      }
    }
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (name.startsWith(`${base}.old-`) || name.startsWith(`${base}.new-`)) await fs.rm(path.join(dir, name), { recursive: true, force: true })
    }
  }

  async function current(): Promise<ManualCopy> {
    const origin = originOf(deps.serverUrl())
    if (!origin) return { kind: 'none' }
    const site = path.join(folderOf(origin), 'site')
    await fs.mkdir(path.dirname(site), { recursive: true })
    await recover(site)
    try {
      return await refreshInto(origin, site)
    } catch (err) {
      // Offline, or the server answered something else: what was kept for this server, if anything.
      log.warn(`[manual] Could not refresh the manual (${err instanceof RefreshFailed ? err.message : err instanceof Error ? err.name : 'error'})`)
      const kept = await readManifest(site)
      return kept ? { kind: 'copy', dir: site, manifest: kept } : { kind: 'none' }
    }
  }

  /** Writes the copy's files into `target` (see `writeTo`). */
  async function writeCopy(copy: Extract<ManualCopy, { kind: 'copy' }>, target: string): Promise<void> {
    const written: string[] = []
    try {
      await fs.mkdir(path.join(target, 'images'))
      written.push(path.join(target, 'images'))
      for (const file of copy.manifest.files) {
        const bytes = await fs.readFile(path.join(copy.dir, ...file.path.split('/')))
        if (sha256(bytes) !== file.sha256) throw new Error('the copy changed')
        const to = path.join(target, ...file.path.split('/'))
        await fs.writeFile(to, bytes, { flag: 'wx' })
        written.unshift(to)
      }
    } catch (err) {
      for (const p of written) await fs.rm(p, { recursive: false, force: true }).catch(() => fs.rmdir(p).catch(() => {}))
      throw err
    }
  }

  return {
    /** The copy to show or write: refreshed from the server when it answers. One refresh at a time. */
    current(): Promise<ManualCopy> {
      const run = queue.then(current, current)
      queue = run.catch(() => {})
      return run
    },

    /**
     * Writes the copy's files into `target` (an empty folder the caller made), each created anew
     * (never replacing) after its sha256 is checked again. Throws when one cannot be written;
     * what this call wrote is then removed again.
     */
    writeTo(copy: Extract<ManualCopy, { kind: 'copy' }>, target: string): Promise<void> {
      // In the refresh queue: a refresh never swaps the copy while it is being written out.
      const run = queue.then(() => writeCopy(copy, target))
      queue = run.catch(() => {})
      return run
    },
  }
}

export type ManualSite = ReturnType<typeof createManualSite>
