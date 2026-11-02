// 見られる人 for the lists (records.md "Who can see it"), read with the member's **session**:
//   viewers:get   { records?, files? } → the phrase per record id / company path the member can see
// The server answers only what the member may read; nothing is added here.

import { VIEWERS_LIMITS } from '../../../../shared/core/viewers'
import type { ViewersAnswer } from '../../../../shared/types/viewers'
import { VIEWERS_OFFLINE_TEXT, type ViewersResult } from '../../../shared/viewers'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface ViewersDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

/** Ids that go into the server URL: no separators, dots or encoded characters. */
const ID = /^[A-Za-z0-9_-]{1,100}$/
const BAD_INPUT: ViewersResult = { success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }

const list = (v: unknown, max: number): string[] | null => {
  if (v === undefined) return []
  return Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 1000) ? v as string[] : null
}

export function createViewersApi(deps: ViewersDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  return {
    async get(companyId: unknown, query: unknown): Promise<ViewersResult> {
      if (typeof companyId !== 'string' || !ID.test(companyId) || !query || typeof query !== 'object') return BAD_INPUT
      const records = list((query as { records?: unknown }).records, VIEWERS_LIMITS.records)
      const files = list((query as { files?: unknown }).files, VIEWERS_LIMITS.files)
      if (!records || !files) return BAD_INPUT
      if (records.length === 0 && files.length === 0) return { success: true, answer: { records: {}, files: {} } }
      const base = deps.baseUrl().replace(/\/+$/, '')
      const cookies = deps.cookies()
      let r: { status: number; json: Record<string, unknown> | null } | null = null
      if (base && cookies.length > 0) {
        try {
          const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/viewers`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
            headers: { Cookie: cookies.join('; '), 'Content-Type': 'application/json' },
            body: JSON.stringify({ records, files }),
          })
          r = { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
        } catch {
          r = null
        }
      }
      if (r && r.status === 200 && r.json?.data && typeof r.json.data === 'object') return { success: true, answer: r.json.data as ViewersAnswer }
      if (!r) {
        log.warn('[viewers] get: the server could not be reached')
        return { success: false, offline: true, code: null, error: VIEWERS_OFFLINE_TEXT }
      }
      const code = typeof r.json?.code === 'string' ? r.json.code : null
      log.warn(`[viewers] get: answered ${r.status}${code ? ` ${code}` : ''}`)
      return {
        success: false, offline: r.status >= 500, code,
        error: typeof r.json?.error === 'string' && r.status < 500 ? r.json.error : `サーバーでエラーが起きました（HTTP ${r.status}）。`,
      }
    },
  }
}

export function registerViewersIpc(ipc: IpcRegistrar, deps: ViewersDeps) {
  const api = createViewersApi(deps)
  ipc.handle('viewers:get', (_event, companyId, query) => api.get(companyId, query))
}
