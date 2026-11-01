// The card's 元のスレッド (stage 3 A4, outbound-mail.md "Replies"): read with the member's
// session, which stays in main. The server reads the thread now with the member's own
// permission; nothing of it is logged here (only the status and the code).
//   threads:get   the original thread of a record (an interaction, or a record linking one)

import { RECORD_ID_RE } from '../../../../shared/core/records'
import { readThreadView, THREAD_OFFLINE_TEXT, type RecordThreadResult } from '../../../shared/threads'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface ThreadsDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  /** Per request (default 30 s: the server reads Gmail or Slack before answering). */
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/

export function createThreadsApi(deps: ThreadsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  return {
    async get(companyId: unknown, recordId: unknown): Promise<RecordThreadResult> {
      // A malformed id is no record of the member's: the panel stays hidden, nothing leaves.
      if (typeof companyId !== 'string' || !COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return { success: false, none: true }
      const base = deps.baseUrl().replace(/\/+$/, '')
      const cookies = deps.cookies()
      if (!base || cookies.length === 0) return { success: false, none: false, offline: true, error: THREAD_OFFLINE_TEXT }
      let res: Response
      try {
        res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/threads/${recordId}`, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000), headers: { Cookie: cookies.join('; ') },
        })
      } catch {
        log.warn('[threads] the server could not be reached')
        return { success: false, none: false, offline: true, error: THREAD_OFFLINE_TEXT }
      }
      const json = (await res.json().catch(() => null)) as { data?: { thread?: unknown }; error?: unknown; code?: unknown } | null
      const thread = res.ok ? readThreadView(json?.data?.thread) : null
      if (thread) return { success: true, thread }
      const code = typeof json?.code === 'string' ? json.code : null
      if (res.status === 404) return { success: false, none: true }
      log.warn(`[threads] answered ${res.status}${code ? ` ${code}` : ''}`)
      return {
        success: false, none: false, offline: res.status >= 500,
        error: typeof json?.error === 'string' && res.status < 500 ? json.error : `サーバーでエラーが起きました（HTTP ${res.status}）。`,
      }
    },
  }
}

export function registerThreadsIpc(ipc: IpcRegistrar, deps: ThreadsDeps) {
  const api = createThreadsApi(deps)
  ipc.handle('threads:get', (_event, companyId, recordId) => api.get(companyId, recordId))
}
