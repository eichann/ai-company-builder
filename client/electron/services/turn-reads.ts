// 「あなたの番」 and 「AI の番」 asked once for everyone in the app that needs them at the same
// moment (plan 「問い合わせを減らす計画」 段1): the task list (`features/tasks`) and the title bar's
// watcher (`features/notifications`) both read `GET /records/my-turn`; the task list and the
// received minutes (`features/minutes/checker.ts`) both read `GET /records/ai-turn`. main.ts makes
// one of these and hands each feature only the reader it needs (`MyTurnReads` / `AiTurnReads`).
// The session stays here (Cookie header); nothing is kept once a read has settled.

import type { InFlightReads, SharedRead } from './in-flight-reads'

/** The server's answer as read (null: no server, signed out or unreachable). */
export type TurnAnswer = { status: number; json: { data?: unknown; error?: unknown; code?: unknown } | null } | null

export interface MyTurnReads {
  /** `GET /records/my-turn` of the company, shared with whoever asks it at the same time. */
  myTurn(companyId: string): Promise<SharedRead<TurnAnswer>>
}

export interface AiTurnReads {
  /** `GET /records/ai-turn` of the company, shared with whoever asks it at the same time. */
  aiTurn(companyId: string): Promise<SharedRead<TurnAnswer>>
}

export interface TurnReadsDeps {
  baseUrl: () => string
  cookies: () => string[]
  reads: InFlightReads
  fetch?: typeof fetch
  timeoutMs?: number
}

export function createTurnReads(deps: TurnReadsDeps): MyTurnReads & AiTurnReads {
  async function get(companyId: string, path: string): Promise<TurnAnswer> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await (deps.fetch ?? fetch)(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
        headers: { Cookie: cookies.join('; ') },
      })
      return { status: res.status, json: await res.json().catch(() => null) as NonNullable<TurnAnswer>['json'] }
    } catch {
      return null
    }
  }
  return {
    myTurn: companyId => deps.reads.read(companyId, 'my-turn', () => get(companyId, '/records/my-turn')),
    aiTurn: companyId => deps.reads.read(companyId, 'ai-turn', () => get(companyId, '/records/ai-turn')),
  }
}
