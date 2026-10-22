/**
 * Server side of the chat AI's read-only company files
 * (GET /api/companies/:companyId/files/{tree,content,search}, contract in
 * shared/types/company-files.ts at the repository root).
 *
 * Runs in the main process, which holds the member's session cookies: the
 * model never sees them (the tools call this; Codex reaches the tools through
 * a loopback MCP endpoint with its own random token). Answers are cached
 * briefly per member, so the AI paging through the same file or repeating a
 * search does not hit the server every time; nothing is written to disk.
 */
import { createHash } from 'node:crypto'

export type CompanyFilesRoute = 'tree' | 'content' | 'search'

export class CompanyFilesApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export const OFFLINE_MESSAGE = 'サーバーに接続できないため、会社のファイルを参照できません（オフラインの可能性があります）。この機能はインターネットにつながっているときだけ使えます。このPCにダウンロード済みのファイルは通常どおり読めます。'
export const SIGNED_OUT_MESSAGE = 'ログインしていないため、会社のファイルを参照できません。ユーザーにアプリでログインしてもらってください。'

export interface CompanyFilesApiDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  now?: () => number
  /** How long an answer is reused (default 30 s). */
  ttlMs?: number
  /** Per request (default 20 s). */
  timeoutMs?: number
  log?: Pick<Console, 'warn'>
}

export interface CompanyFilesApi {
  get(companyId: string, route: CompanyFilesRoute, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal): Promise<unknown>
  /** Forget every cached answer (sign-out, account switch). */
  clear(): void
}

const CACHE_MAX_ENTRIES = 200
const CACHE_MAX_BYTES = 8 * 1024 * 1024

export function createCompanyFilesApi(deps: CompanyFilesApiDeps): CompanyFilesApi {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? 30_000
  const timeoutMs = deps.timeoutMs ?? 20_000
  const cache = new Map<string, { at: number; value: unknown; bytes: number }>()
  let cachedBytes = 0

  const remember = (key: string, value: unknown, bytes: number) => {
    const old = cache.get(key)
    if (old) { cachedBytes -= old.bytes; cache.delete(key) }
    if (bytes > CACHE_MAX_BYTES / 4) return
    cache.set(key, { at: now(), value, bytes })
    cachedBytes += bytes
    while (cache.size > CACHE_MAX_ENTRIES || cachedBytes > CACHE_MAX_BYTES) {
      const [oldest, entry] = cache.entries().next().value as [string, { bytes: number }]
      cache.delete(oldest)
      cachedBytes -= entry.bytes
    }
  }

  return {
    async get(companyId, route, query, signal) {
      const base = deps.baseUrl().replace(/\/+$/, '')
      if (!base) throw new CompanyFilesApiError('OFFLINE', OFFLINE_MESSAGE)
      const cookies = deps.cookies()
      if (cookies.length === 0) throw new CompanyFilesApiError('NOT_SIGNED_IN', SIGNED_OUT_MESSAGE)
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
        if (v !== undefined) params.set(k, String(v))
      }
      const url = `${base}/api/companies/${encodeURIComponent(companyId)}/files/${route}?${params.toString()}`
      // Per member: an account switch must never see the previous member's answers.
      const who = createHash('sha256').update(cookies.join('; ')).digest('hex').slice(0, 16)
      const key = `${who}\0${url}`
      const hit = cache.get(key)
      if (hit && now() - hit.at < ttl) return hit.value

      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      let res: Response
      try {
        res = await doFetch(url, { headers: { Cookie: cookies.join('; ') }, signal: combined })
      } catch (error) {
        if (signal?.aborted) throw error
        if (timeout.aborted) throw new CompanyFilesApiError('TIMEOUT', 'サーバーの応答がありませんでした。少し待ってからもう一度試してください。')
        deps.log?.warn(`[company-files] ${route}: ${error instanceof Error ? error.message : String(error)}`)
        throw new CompanyFilesApiError('OFFLINE', OFFLINE_MESSAGE)
      }
      const text = await res.text()
      let body: { data?: unknown; error?: string; code?: string } = {}
      try { body = JSON.parse(text) } catch { /* not JSON */ }
      if (res.status === 401) throw new CompanyFilesApiError('NOT_SIGNED_IN', SIGNED_OUT_MESSAGE)
      if (!res.ok) {
        if (res.status >= 500) throw new CompanyFilesApiError('SERVER_ERROR', `サーバーでエラーが起きました（HTTP ${res.status}）。少し待ってからもう一度試してください。`)
        throw new CompanyFilesApiError(body.code || `HTTP_${res.status}`, body.error || `HTTP ${res.status}`)
      }
      if (body.data === undefined) throw new CompanyFilesApiError('SERVER_ERROR', 'サーバーの応答を読めませんでした。')
      remember(key, body.data, text.length)
      return body.data
    },
    clear() {
      cache.clear()
      cachedBytes = 0
    },
  }
}
