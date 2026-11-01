/**
 * Fetching one business plugin's package for the app (plan C2, plugins.md
 * "Handing packages to the app"): `GET
 * /api/companies/:id/plugins/:pluginId/package/:version` with the member's
 * session (main only; the renderer never sees it), then checked before
 * anything is kept:
 *
 * - every path is one a package may hold (`isPluginPackagePath`): nothing can
 *   name a place outside the package's folder;
 * - the files' fingerprint v2 (`shared/core/plugin-fingerprint.ts`, the same
 *   computation as the server's shelf) equals the one the **agent policy**
 *   listed — not the one in the answer, so an answer cannot vouch for itself.
 *
 * Any mismatch → nothing is returned (logged by package name only, never a
 * file's content).
 */
import { createHash } from 'node:crypto'
import { pluginFingerprintV2 } from '../../../../shared/core/plugin-fingerprint'
import { isPluginPackagePath } from '../../../../shared/core/plugin-package-paths'
import type { DistributedPlugin } from '../../../../shared/types/plugins'
import { pluginPackageName } from '../../../shared/plugin-packages'

export interface PluginFetchDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
}

export interface PackageFile {
  path: string
  bytes: Uint8Array
}

export type PluginFetchResult = { ok: true; files: PackageFile[] } | { ok: false; reason: string }

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const MAX_FILES = 400

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

/** Check an answer's files against the entry the policy listed. Pure apart from hashing. */
export function verifyPackage(entry: DistributedPlugin, data: unknown): PluginFetchResult {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'unexpected answer' }
  const d = data as { id?: unknown; version?: unknown; files?: unknown }
  if (d.id !== entry.id || d.version !== entry.version) return { ok: false, reason: 'another package was answered' }
  if (!Array.isArray(d.files) || d.files.length === 0 || d.files.length > MAX_FILES) return { ok: false, reason: 'unexpected file list' }
  const files: PackageFile[] = []
  const seen = new Set<string>()
  for (const f of d.files as unknown[]) {
    const { path, base64 } = (f ?? {}) as { path?: unknown; base64?: unknown }
    if (typeof path !== 'string' || !isPluginPackagePath(path) || seen.has(path)) return { ok: false, reason: 'a path a package may not hold' }
    if (typeof base64 !== 'string' || base64.length % 4 !== 0 || !BASE64_RE.test(base64)) return { ok: false, reason: 'unreadable file' }
    seen.add(path)
    files.push({ path, bytes: new Uint8Array(Buffer.from(base64, 'base64')) })
  }
  if (!seen.has('plugin.yaml')) return { ok: false, reason: 'no declaration' }
  if (pluginFingerprintV2(files, sha256Hex) !== entry.fingerprint) return { ok: false, reason: 'fingerprint does not match' }
  return { ok: true, files }
}

export function createPluginFetcher(deps: PluginFetchDeps) {
  const doFetch = deps.fetch ?? fetch
  return async function fetchPackage(companyId: string, entry: DistributedPlugin): Promise<PluginFetchResult> {
    const base = deps.baseUrl()
    if (!base) return { ok: false, reason: 'not signed in' }
    const url = `${base}/api/companies/${encodeURIComponent(companyId)}/plugins/${encodeURIComponent(entry.id)}/package/${encodeURIComponent(entry.version)}`
    try {
      const res = await doFetch(url, { headers: { Cookie: deps.cookies().join('; ') }, redirect: 'error' })
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
      const data = (await res.json() as { data?: unknown })?.data
      return verifyPackage(entry, data)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'request failed' }
    }
  }
}

export type FetchPluginPackage = ReturnType<typeof createPluginFetcher>
export { pluginPackageName }
