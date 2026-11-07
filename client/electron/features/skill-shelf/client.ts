/**
 * The app's calls to the Skill shelf (plugins.md "The Skill shelf"), with the member's session
 * (main only; the renderer never sees it).
 *
 * Content is checked before anything is kept, as a plugin package is (`features/plugins/fetch.ts`):
 * every path is one the shelf allows (`shelfFilePathProblem`: nothing can name a place outside the
 * Skill's folder) and the files' version equals the one the **delivery list** named — not the one
 * in the answer, so an answer cannot vouch for itself. Any mismatch → nothing is returned (logged
 * by the store with the item's name only, never a file's content).
 */
import { createHash } from 'node:crypto'
import { SHELF_LIMITS, shelfFilePathProblem, shelfPathClash, shelfTextFileName } from '../../../../shared/core/skill-shelf'
import type { ShelfFileUpload, ShelfPublishResult } from '../../../../shared/types/skill-shelf'
import { readShelfDeliveries, shelfRefusalMessage, shelfVersionOf, type ShelfDelivery } from '../../../shared/skill-shelf'

export interface ShelfClientDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
}

export interface ShelfFile {
  path: string
  bytes: Uint8Array
}

export type ShelfContentResult = { ok: true; files: ShelfFile[] } | { ok: false; reason: string }
export type ShelfListResult = { ok: true; items: ShelfDelivery[] } | { ok: false; reason: string }
export type ShelfPublishAnswer = { ok: true; result: ShelfPublishResult } | { ok: false; message: string } | { ok: false; offline: true }

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const TIMEOUT_MS = 30_000
const PUBLISH_TIMEOUT_MS = 120_000

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

/** Check an answer's files against the delivery list's entry. Pure apart from hashing. */
export function verifyShelfContent(entry: ShelfDelivery, data: unknown): ShelfContentResult {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'unexpected answer' }
  const d = data as { id?: unknown; version?: unknown; files?: unknown }
  if (d.id !== entry.id || d.version !== entry.version) return { ok: false, reason: 'another item was answered' }
  if (!Array.isArray(d.files) || d.files.length === 0 || d.files.length > SHELF_LIMITS.files) return { ok: false, reason: 'unexpected file list' }
  const files: ShelfFile[] = []
  let total = 0
  for (const f of d.files as unknown[]) {
    const { path, base64 } = (f ?? {}) as { path?: unknown; base64?: unknown }
    if (shelfFilePathProblem(path) !== null) return { ok: false, reason: 'a path the shelf does not allow' }
    if (typeof base64 !== 'string' || base64.length % 4 !== 0 || !BASE64_RE.test(base64)) return { ok: false, reason: 'unreadable file' }
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
    total += bytes.length
    if (bytes.length > SHELF_LIMITS.fileBytes || total > SHELF_LIMITS.skillBytes) return { ok: false, reason: 'too large' }
    files.push({ path: path as string, bytes })
  }
  if (shelfPathClash(files.map(f => f.path)) !== null) return { ok: false, reason: 'paths that clash' }
  if (entry.kind === 'skill') {
    if (!files.some(f => f.path === 'SKILL.md')) return { ok: false, reason: 'no SKILL.md' }
  } else if (files.length !== 1 || files[0].path !== shelfTextFileName(entry.kind, entry.name)) {
    return { ok: false, reason: 'unexpected file list' }
  }
  const version = shelfVersionOf(files.map(f => ({ path: f.path, sha256: sha256Hex(f.bytes) })), sha256Hex)
  if (version !== entry.version) return { ok: false, reason: 'version does not match' }
  return { ok: true, files }
}

export function createShelfClient(deps: ShelfClientDeps) {
  const doFetch = deps.fetch ?? fetch
  const urlOf = (companyId: string, rest: string) => `${deps.baseUrl().replace(/\/+$/, '')}/api/companies/${encodeURIComponent(companyId)}${rest}`
  const headers = () => ({ Cookie: deps.cookies().join('; ') })
  const signal = () => AbortSignal.timeout(TIMEOUT_MS)

  return {
    /** What this member's app should have now. */
    async list(companyId: string): Promise<ShelfListResult> {
      if (!deps.baseUrl()) return { ok: false, reason: 'not signed in' }
      try {
        const res = await doFetch(urlOf(companyId, '/me/skill-shelf'), { headers: headers(), redirect: 'error', signal: signal() })
        if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
        const items = readShelfDeliveries((await res.json() as { data?: unknown } | null)?.data)
        return items ? { ok: true, items } : { ok: false, reason: 'unexpected answer' }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'request failed' }
      }
    },
    /** An item's files at the listed version, checked. */
    async content(companyId: string, entry: ShelfDelivery): Promise<ShelfContentResult> {
      try {
        const res = await doFetch(urlOf(companyId, `/skill-shelf/${encodeURIComponent(entry.id)}/versions/${encodeURIComponent(entry.version)}`), { headers: headers(), redirect: 'error', signal: signal() })
        if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
        return verifyShelfContent(entry, (await res.json() as { data?: unknown } | null)?.data)
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'request failed' }
      }
    },
    /** The id of the department with this folder, or undefined (none, or the server did not answer). */
    async departmentId(companyId: string, folder: string): Promise<string | undefined> {
      try {
        const res = await doFetch(urlOf(companyId, '/departments'), { headers: headers(), redirect: 'error', signal: signal() })
        const body = res.ok ? await res.json() as { data?: unknown } | null : null
        const list = Array.isArray(body?.data) ? body.data as Array<{ id?: unknown; folder?: unknown }> : []
        const found = list.find(d => typeof d.folder === 'string' && d.folder.normalize('NFC') === folder.normalize('NFC'))
        return typeof found?.id === 'string' ? found.id : undefined
      } catch {
        return undefined
      }
    },
    /** Publish a Skill's folder. The server decides who may, and says why not. */
    async publish(companyId: string, request: { departmentId: string | null; name: string; files: ShelfFileUpload[]; expectedVersion: string | null }): Promise<ShelfPublishAnswer> {
      let res: Response
      try {
        res = await doFetch(urlOf(companyId, '/skill-shelf'), {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'skill', ...request }),
          redirect: 'error',
          signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        })
      } catch {
        return { ok: false, offline: true }
      }
      const body = await res.json().catch(() => null) as { data?: ShelfPublishResult; error?: unknown } | null
      if (!res.ok || !body?.data) return { ok: false, message: shelfRefusalMessage(res.status, body) }
      return { ok: true, result: body.data }
    },
  }
}

export type ShelfClient = ReturnType<typeof createShelfClient>
