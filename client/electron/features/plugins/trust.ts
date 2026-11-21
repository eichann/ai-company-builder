/**
 * The app's plugin trust state (`.claude/rules/plugin-trust.md` "P2"; design 署名の検証 v3 §3–§5,
 * §13 P2 + v3.1 §2): one state per computer — the root chain (and a halt) is the app's, the records
 * are per server × company × generation inside it — kept in `<userData>/trust/` (`trust-store.ts`).
 *
 * - **Start**: the record and halt file read once, `startTrust` from the root this build carries
 *   (`trust-roots.ts`). Unreadable = unknown (`problem`), never empty; the unusable record is kept
 *   aside before anything is written over it. A build whose root cannot start (a packaged build
 *   without the production root cannot be made: `scripts/check-trust-root.ts`) keeps no trust at
 *   all and says so — nothing here stops the app.
 * - **Refresh** (`refresh(companyId)`, on an agent-policy answer whose `pluginTrust` marker
 *   changed): `GET /api/companies/:companyId/plugin-trust` with the member's session, parsed
 *   strictly, taken in with the app's own clock (`takeCompanyTrust`), the new state written before
 *   it is used (a failed write keeps the previous state in memory too). One at a time.
 * - **P2 enforces nothing**: `status(companyId)` answers what P4 will ask (`codeMayRunUntil`), and
 *   no package is refused because of it yet. Logs carry codes and company ids only.
 */
import {
  codeMayRunUntil, serializeTrustState, startTrust,
  type AcceptedFreshness, type AcceptedList, type TrustState,
} from '../../../../shared/core/plugin-trust'
import { parsePluginTrustDocuments, takeCompanyTrust, trustServerOf } from '../../../../shared/core/plugin-trust-distribution'
import type { TrustResult } from '../../../../shared/core/plugin-trust-documents'
import type { PluginTrustCrypto } from '../../../../shared/core/plugin-trust-sshsig'
import type { TrustFiles } from './trust-store'

export interface PluginTrustDeps {
  files: TrustFiles
  /** The root envelope this build carries (`carriedTrustRoot`). */
  bakedRoot: unknown
  /** Which root that is (P4 enforces only with `production`): required, so no caller can leave it out. */
  rootKind: 'development' | 'production'
  crypto: PluginTrustCrypto
  /** The server the app is connected to (its configured URL; `trustServerOf` makes the signed spelling). */
  serverUrl: () => string
  /** The member's session answer of the trust route for a company (`data` of the answer), or null when it could not be read. */
  fetchDocuments: (companyId: string) => Promise<unknown | null>
  now?: () => number
  log?: Pick<Console, 'warn' | 'info'>
}

export type RefreshOutcome =
  /** `settled`: false when a refusal may pass by itself (this computer's clock): ask again at the next policy answer. */
  | { ok: true; settled: boolean; notes: string[] }
  | { ok: false; reason: 'no-trust' | 'no-server' | 'unreachable' | 'unreadable' | 'not-saved' }

export function createPluginTrust(deps: PluginTrustDeps) {
  const log = deps.log ?? console
  const now = deps.now ?? (() => Date.now())
  let state: TrustState | null | undefined // undefined: not started; null: this build has no usable root
  const handles = new Map<string, { list: AcceptedList | null; freshness: AcceptedFreshness | null }>()
  let chain: Promise<unknown> = Promise.resolve()

  const key = (server: string, companyId: string) => JSON.stringify([server, companyId])

  function loaded(): TrustState | null {
    if (state !== undefined) return state
    const stored = deps.files.read()
    try {
      state = startTrust(deps.bakedRoot, stored, deps.crypto)
    } catch (e) {
      log.warn(`[plugin-trust] this build carries no usable root: plugin trust is off (${e instanceof Error ? e.message : 'unknown'})`)
      state = null
      return state
    }
    if (state.halted) log.warn(`[plugin-trust] halted: ${state.halted.reason}`)
    if (state.problem) {
      log.warn(`[plugin-trust] ${state.problem}`)
      if (stored.record !== null && stored.record !== undefined) deps.files.keepUnusable()
    }
    return state
  }

  async function refreshNow(companyId: string): Promise<RefreshOutcome> {
    const current = loaded()
    if (!current) return { ok: false, reason: 'no-trust' }
    const server = trustServerOf(deps.serverUrl())
    if (!server) return { ok: false, reason: 'no-server' }
    const data = await deps.fetchDocuments(companyId)
    if (data === null) return { ok: false, reason: 'unreachable' }
    const documents = parsePluginTrustDocuments(data)
    if (!documents) {
      log.warn(`[plugin-trust] company=${companyId}: the server's trust answer has an unexpected shape; nothing changed`)
      return { ok: false, reason: 'unreadable' }
    }
    // The state may have moved while the answer was on its way (another company's refresh).
    const base = state as TrustState
    const taken = takeCompanyTrust(base, documents, { server, companyId, now: now() }, deps.crypto)
    try {
      deps.files.write(serializeTrustState(taken.state))
    } catch (e) {
      log.warn(`[plugin-trust] the trust record could not be saved; kept the previous state (${e instanceof Error ? e.message : 'unknown'})`)
      return { ok: false, reason: 'not-saved' }
    }
    if (taken.state.halted && !base.halted) log.warn(`[plugin-trust] halted: ${taken.state.halted.reason}`)
    state = taken.state
    const k = key(server, companyId)
    const before = handles.get(k)
    // A refused document keeps the handle accepted before: `codeMayRunUntil` asks the record whether
    // it is still current (a newer list, a rotated key or a freshness bound to another list refuses).
    handles.set(k, { list: taken.list ?? before?.list ?? null, freshness: taken.freshness ?? before?.freshness ?? null })
    for (const n of taken.notes) log.info(`[plugin-trust] company=${companyId}: ${n}`)
    return { ok: true, settled: !taken.retry, notes: taken.notes }
  }

  return {
    /** Take in what the server hands for this company now. Refreshes run one at a time. */
    refresh(companyId: string): Promise<RefreshOutcome> {
      const run = chain.then(() => refreshNow(companyId))
      chain = run.catch(() => undefined)
      return run
    },
    /** Until when this company's plugin code may run (P4 will ask; P2 only answers). */
    status(companyId: string): TrustResult<{ until: number }> | { ok: false; code: 'no-trust' | 'no-server' } {
      const current = loaded()
      if (!current) return { ok: false, code: 'no-trust' }
      const server = trustServerOf(deps.serverUrl())
      if (!server) return { ok: false, code: 'no-server' }
      const h = handles.get(key(server, companyId))
      return codeMayRunUntil(current, h?.list ?? null, h?.freshness ?? null, { server, companyId, now: now() })
    },
    /**
     * The start's or the last root update's note, the halt, whether the records were lost once and
     * not cleared since (`unknown`, stored with the record), and which root this build carries —
     * enforcement (P4) must refuse to act on trust unless it is `production`.
     */
    health(): { available: boolean; halted: boolean; problem: string | null; unknown: string | null; root: 'development' | 'production' } {
      const current = loaded()
      return {
        available: current !== null, halted: Boolean(current?.halted), problem: current?.problem ?? null,
        unknown: current?.unknown ?? null, root: deps.rootKind,
      }
    },
  }
}

export type PluginTrust = ReturnType<typeof createPluginTrust>

/** The trust route's answer for a company with the member's session (main only). */
export function createTrustFetcher(deps: { baseUrl: () => string; cookies: () => string[]; fetch?: typeof fetch }) {
  const doFetch = deps.fetch ?? fetch
  return async (companyId: string): Promise<unknown | null> => {
    const base = deps.baseUrl()
    if (!base) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/plugin-trust`, {
        headers: { Cookie: deps.cookies().join('; ') }, redirect: 'error',
      })
      if (!res.ok) return null
      return (await res.json() as { data?: unknown })?.data ?? null
    } catch {
      return null
    }
  }
}
