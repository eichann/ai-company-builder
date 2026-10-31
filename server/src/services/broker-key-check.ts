/**
 * Checking a key once when it is registered or replaced (.claude/rules/key-broker.md,
 * 「鍵を確かめる」): one free, read-only request — GET, no body — to the
 * service's fixed host, with the key in the service's own header:
 *
 * - built-in services: their `check` (Gemini `GET /v1beta/models`, OpenAI and
 *   Anthropic `GET /v1/models`, HubSpot `GET /crm/objects/2026-03/deals`) on the built-in host, and only when the key may
 *   go to that host (its destinations);
 * - generic services (K9): the definition's optional `checkPath` under its one
 *   host and base path; without one → `not-checkable`.
 *
 * The way out is the relay's (`UpstreamClient`: https, the host fixed here,
 * private addresses refused unless the company's exception names the host,
 * the connection made to the address checked). Only the status is read; the
 * answer's body is drained and dropped. Nothing about the key is logged or
 * returned — only the result word.
 */
import {
  RELAY_CHECK_REJECTED,
  brokerKeyCheckOutcome,
  builtinBrokerService,
  relayCredentialValue,
  type BrokerKeyCheckResult,
} from '../../shared/core/key-broker'
import type { UpstreamClient } from '../ports/upstream'
import type { KeyBrokerService } from './key-broker'

export interface BrokerKeyCheckDeps {
  upstream: UpstreamClient
  keyBroker: Pick<KeyBrokerService, 'relayService' | 'internalHosts'>
  /** false: keys are saved without a check (BROKER_KEY_CHECK=off). */
  enabled: boolean
  /** Until the answer's headers (default 10 s). */
  timeoutMs?: number
  log?: Pick<Console, 'warn'>
}

/** At most this much of the answer is read (and dropped) before the connection closes. */
const DRAIN_LIMIT = 64 * 1024

export function createBrokerKeyCheck(deps: BrokerKeyCheckDeps) {
  const timeoutMs = deps.timeoutMs ?? 10_000
  const log = deps.log ?? console

  return {
    /**
     * How the service answers this key, or null when checking is off. `hosts`:
     * where the key may be sent (its destinations); the check goes only to the
     * service's fixed host, and only when it is one of them.
     */
    async check(companyId: string, service: string, secret: string, hosts: readonly string[]): Promise<BrokerKeyCheckResult | null> {
      if (!deps.enabled) return null
      const builtin = builtinBrokerService(service)
      let host: string
      let path: string
      let rejected: readonly number[]
      let limited: readonly number[] = []
      const headers: Record<string, string> = { accept: 'application/json', 'accept-encoding': 'identity' }
      if (builtin) {
        host = builtin.defaultHosts[0]
        if (!hosts.includes(host)) return 'not-checkable'
        path = builtin.check.path
        rejected = builtin.check.rejected
        limited = builtin.check.limited ?? []
        Object.assign(headers, builtin.check.headers)
        headers[builtin.credential] = builtin.credential === 'authorization' ? `Bearer ${secret}` : secret
      } else {
        const relay = deps.keyBroker.relayService(companyId, service)
        if (!relay?.checkPath || !hosts.includes(relay.host)) return 'not-checkable'
        host = relay.host
        path = `${relay.basePath}${relay.checkPath}`
        rejected = RELAY_CHECK_REJECTED
        headers[relay.header] = relayCredentialValue(relay.format, secret)
      }

      const result = await deps.upstream.send({
        host,
        method: 'GET',
        path,
        headers,
        body: null,
        allowPrivateHosts: deps.keyBroker.internalHosts(companyId),
        signal: AbortSignal.timeout(timeoutMs + 5_000),
        headersTimeoutMs: timeoutMs,
      })
      if (!result.ok) {
        log.warn(`[broker] key check ${service}: ${result.reason}`)
        return 'unreachable'
      }
      const outcome = brokerKeyCheckOutcome(result.response.status, rejected, limited)
      // Read a little and drop it, so the connection closes; the body is never looked at.
      try {
        let read = 0
        for await (const chunk of result.response.body) {
          read += chunk.byteLength
          if (read >= DRAIN_LIMIT) break
        }
      } catch { /* the status is all we need */ }
      if (outcome !== 'valid') log.warn(`[broker] key check ${service}: ${outcome} (status ${result.response.status})`)
      return outcome
    },
  }
}

export type BrokerKeyCheckService = ReturnType<typeof createBrokerKeyCheck>
