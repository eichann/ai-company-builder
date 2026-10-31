/**
 * The company map for the chat AI (`.claude/rules/records.md` "Who is
 * acting"), main process. Per chat turn the app asks the server — with the
 * member's session, which only main holds — for a **record token** scoped to
 * this company and member (`read`, or `act` for agents that may change state:
 * registry `recordActions`). The AI's record tools then call the server's AI
 * routes (`/api/records-ai/*`) with that token only: the server records what
 * they do as the AI's, and the AI process never sees the session. The token is
 * revoked when the turn ends (and expires on its own).
 */

export class RecordsApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export const RECORDS_OFFLINE_MESSAGE = 'サーバーに接続できないため、会社の記録を参照・変更できません（オフラインの可能性があります）。'

export interface RecordsApiDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  /** Per request (default 20 s). */
  timeoutMs?: number
  log?: Pick<Console, 'warn'>
}

/** One turn's access for the AI: calls with the token, never the session. */
export interface RecordTurnAccess {
  scope: 'read' | 'act'
  call(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>
  /** Revoke the token (the turn ended). */
  close(): Promise<void>
}

export interface RecordsApi {
  /**
   * A token for one turn, or null when the company map is off for the company
   * (or the member is signed out / offline: the turn simply has no record tools).
   */
  openTurn(companyId: string, opts: { conversationId: string; agent: string; scope: 'read' | 'act' }): Promise<RecordTurnAccess | null>
}

export function createRecordsApi(deps: RecordsApiDeps): RecordsApi {
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? 20_000
  const base = () => deps.baseUrl().replace(/\/+$/, '')

  async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: { data?: unknown; error?: string; code?: string } }> {
    const timeout = AbortSignal.timeout(timeoutMs)
    let res: Response
    try {
      res = await doFetch(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (error) {
      if (signal?.aborted) throw error
      deps.log?.warn(`[records] request failed: ${error instanceof Error ? error.name : 'unknown'}`)
      throw new RecordsApiError('OFFLINE', RECORDS_OFFLINE_MESSAGE)
    }
    let body: { data?: unknown; error?: string; code?: string } = {}
    try { body = await res.json() as typeof body } catch { /* not JSON */ }
    return { status: res.status, body }
  }

  return {
    async openTurn(companyId, opts) {
      const root = base()
      const cookies = deps.cookies()
      if (!root || cookies.length === 0) return null
      let issued: { status: number; body: { data?: unknown } }
      try {
        issued = await request(`${root}/api/companies/${encodeURIComponent(companyId)}/me/record-tokens`, {
          method: 'POST',
          headers: { Cookie: cookies.join('; '), 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        })
      } catch {
        return null
      }
      const data = issued.body.data as { token?: string; tokenId?: string; scope?: 'read' | 'act' } | undefined
      if (issued.status !== 201 || !data?.token || !data.tokenId) return null
      const token = data.token
      const tokenId = data.tokenId
      let closed = false
      return {
        scope: data.scope === 'act' ? 'act' : 'read',
        async call(method, path, body, signal) {
          if (closed) throw new RecordsApiError('TURN_ENDED', 'この会話のターンは終わりました。')
          const r = await request(`${root}/api/records-ai${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          }, signal)
          if (r.status >= 500) throw new RecordsApiError('SERVER_ERROR', `サーバーでエラーが起きました（HTTP ${r.status}）。`)
          if (r.status < 200 || r.status >= 300) throw new RecordsApiError(r.body.code || `HTTP_${r.status}`, r.body.error || `HTTP ${r.status}`)
          return r.body.data
        },
        async close() {
          if (closed) return
          closed = true
          try {
            await request(`${root}/api/companies/${encodeURIComponent(companyId)}/me/record-tokens/${encodeURIComponent(tokenId)}`, {
              method: 'DELETE', headers: { Cookie: deps.cookies().join('; ') },
            })
          } catch { /* it expires on its own */ }
        },
      }
    },
  }
}
