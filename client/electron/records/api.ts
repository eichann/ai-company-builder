/**
 * The company map for the chat AI (`.claude/rules/records.md` "Who is
 * acting"), main process. Per chat turn the app asks the server — with the
 * member's session, which only main holds — for a **record token** scoped to
 * this company and member (`read`, or `act` for agents that may change state:
 * registry `recordActions`). The AI's record tools then call the server's AI
 * routes (`/api/records-ai/*`) with that token only: the server records what
 * they do as the AI's, and the AI process never sees the session. The token is
 * revoked when the turn ends (and expires on its own).
 *
 * Execution runs (S10b, records.md "Execution runs"): when the consultation
 * runs a claimed 「AI の番」 (`runOf`), its token is bound to the run — the
 * server refuses it once another PC claims the run again — and every write
 * carries an `Idempotency-Key` derived from the request itself, so the same
 * request sent again (a retry, or the next PC redoing the step) never repeats
 * the effect: the server answers what the first one made, which is read back
 * here so the AI's tools see the same answer.
 */
import { createHash } from 'crypto'
import type { BoundRun } from './runs'

export class RecordsApiError extends Error {
  /** The refusal's other fields (a plugin operation's `operation`, `current`, `fields`…); never a session or token. */
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
  }
}

export const RECORDS_OFFLINE_MESSAGE = 'サーバーに接続できないため、会社の記録を参照・変更できません（オフラインの可能性があります）。'

export interface RecordsApiDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  /** The execution run a consultation runs, if any (records/runs.ts). */
  runOf?: (companyId: string, conversationId: string) => BoundRun | null
  /**
   * Before the AI writes in a consultation: wait for the Skill uses it reported and still has
   * in flight (services/skill-use-reporter.ts), so the server copies them onto the write
   * (records.md "Which Skill"). Bounded by the reporter; never throws.
   */
  beforeWrite?: (conversationId: string) => Promise<void>
  /** Per request (default 20 s). */
  timeoutMs?: number
  log?: Pick<Console, 'warn'>
}

/** One turn's access for the AI: calls with the token, never the session. */
export interface RecordTurnAccess {
  scope: 'read' | 'act'
  /** `timeoutMs`: this request's own limit (default the API's; a Drive upload takes longer). */
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal, opts?: { timeoutMs?: number }): Promise<unknown>
  /** Revoke the token (the turn ended). */
  close(): Promise<void>
}

export interface RecordsApi {
  /**
   * A token for one turn, or null when the company map is off for the company
   * (or the member is signed out / offline: the turn simply has no record tools).
   */
  /** `requireRun`: only with a run this app holds for the consultation (a scheduled job's): none → no token at all. */
  openTurn(companyId: string, opts: { conversationId: string; agent: string; scope: 'read' | 'act'; requireRun?: boolean }): Promise<RecordTurnAccess | null>
}

/** The request as one text, keys sorted: what its idempotency key is made from. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]))
  return v
}

/** The same request within a run → the same key (`acb-` + 40 hex of sha256). */
export function operationKeyOf(method: string, path: string, body: unknown): string {
  return `acb-${createHash('sha256').update(`${method} ${path}\n${JSON.stringify(canonical(body ?? null))}`).digest('hex').slice(0, 40)}`
}

/** Where to read back what a replayed operation made, as the first answer showed it. */
function replayReadPath(path: string, ref: { kind?: unknown; id?: unknown } | null): string | null {
  if (!ref || typeof ref.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(ref.id)) return null
  const id = encodeURIComponent(ref.id)
  if (ref.kind === 'outbound') return `/outbound/${id}`
  if (ref.kind === 'record') return `/item/${id}`
  if (ref.kind === 'approval') return `/approvals/${id}`
  if (ref.kind === 'drive-put') return `/google/drive/puts/${id}`
  const plugin = /^\/plugins\/([^/]+)\//.exec(path)
  if (ref.kind === 'plugin-operation' && plugin) return `/plugins/${plugin[1]}/operations/${id}`
  return null
}

export function createRecordsApi(deps: RecordsApiDeps): RecordsApi {
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? 20_000
  const base = () => deps.baseUrl().replace(/\/+$/, '')

  async function request(url: string, init: RequestInit, signal?: AbortSignal, ownTimeoutMs?: number): Promise<{ status: number; body: { data?: unknown; error?: string; code?: string; [extra: string]: unknown } }> {
    const timeout = AbortSignal.timeout(ownTimeoutMs ?? timeoutMs)
    let res: Response
    try {
      res = await doFetch(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (error) {
      if (signal?.aborted) throw error
      deps.log?.warn(`[records] request failed: ${error instanceof Error ? error.name : 'unknown'}`)
      throw new RecordsApiError('OFFLINE', RECORDS_OFFLINE_MESSAGE)
    }
    let body: { data?: unknown; error?: string; code?: string; [extra: string]: unknown } = {}
    try { body = await res.json() as typeof body } catch { /* not JSON */ }
    return { status: res.status, body }
  }

  return {
    async openTurn(companyId, opts) {
      const root = base()
      const cookies = deps.cookies()
      if (!root || cookies.length === 0) return null
      const run = deps.runOf?.(companyId, opts.conversationId) ?? null
      // A job's run without its run (taken away just now): never an ordinary token.
      if (opts.requireRun && !run) return null
      const ask = { conversationId: opts.conversationId, agent: opts.agent, scope: opts.scope }
      let issued: { status: number; body: { data?: unknown } }
      try {
        issued = await request(`${root}/api/companies/${encodeURIComponent(companyId)}/me/record-tokens`, {
          method: 'POST',
          headers: { Cookie: cookies.join('; '), 'Content-Type': 'application/json' },
          body: JSON.stringify(run ? { ...ask, run } : ask),
        })
      } catch {
        return null
      }
      const data = issued.body.data as { token?: string; tokenId?: string; scope?: 'read' | 'act' } | undefined
      if (issued.status !== 201 || !data?.token || !data.tokenId) return null
      const token = data.token
      const conversationId = opts.conversationId
      const tokenId = data.tokenId
      let closed = false
      const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, signal?: AbortSignal, ownTimeoutMs?: number) => request(`${root}/api/records-ai${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(run && method !== 'GET' ? { 'Idempotency-Key': operationKeyOf(method, path, body) } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }, signal, ownTimeoutMs)
      return {
        scope: data.scope === 'act' ? 'act' : 'read',
        async call(method, path, body, signal, opts) {
          if (closed) throw new RecordsApiError('TURN_ENDED', 'この会話のターンは終わりました。')
          if (method !== 'GET' && deps.beforeWrite) await deps.beforeWrite(conversationId).catch(() => undefined)
          let r = await send(method, path, body, signal, opts?.timeoutMs)
          // Done before with the same request: read back what it made instead of doing it again.
          const replay = r.status === 200 && (r.body.data as { replayed?: unknown } | undefined)?.replayed === true
            ? replayReadPath(path, (r.body.data as { ref?: { kind?: unknown; id?: unknown } | null }).ref ?? null) : null
          if (replay) r = await send('GET', replay, undefined, signal)
          if (r.status >= 500) throw new RecordsApiError('SERVER_ERROR', `サーバーでエラーが起きました（HTTP ${r.status}）。`)
          if (r.status < 200 || r.status >= 300) {
            const { error, code, ...details } = r.body
            throw new RecordsApiError(code || `HTTP_${r.status}`, error || `HTTP ${r.status}`, details)
          }
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
