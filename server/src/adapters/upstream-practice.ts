/**
 * Staging only (milestone 3): requests the relay or the key check sends to a
 * redirected host (`api.hubapi.com`) connect to the practice copy instead
 * (the fake HubSpot on this machine, `lib/config.ts` `practiceUpstreamsFrom`,
 * which decides whether this applies at all — never in production). Every
 * other host goes to the real way out unchanged. The request keeps naming the
 * real host, so the relay's destination rules and redirect rewriting are the
 * same as with the real service.
 *
 * Nothing is logged here (no header, no body, no key). A request whose key
 * is not a practice key (`pat-fake-…`) is not sent at all
 * (`practice-real-secret`): a real secret never reaches the practice copy.
 */
import { request as httpRequest, type IncomingMessage } from 'http'
import { request as httpsRequest } from 'https'
import type { PracticeUpstream } from '../lib/config'
import { isPracticeSecret } from '../../shared/core/key-broker'
import type { UpstreamClient } from '../ports/upstream'

/** Headers that carry a key (the built-in services' and the usual ones). */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key']

export function practiceUpstream(real: UpstreamClient, upstreams: readonly PracticeUpstream[]): UpstreamClient {
  if (upstreams.length === 0) return real
  const byHost = new Map(upstreams.map(u => [u.host, u.target]))
  return {
    async send(req) {
      const target = byHost.get(req.host)
      if (!target) return real.send(req)
      // A real secret never goes to the practice copy (review §5.8): only practice keys pass.
      // (Registration refuses them too; this holds even for a key saved before the redirect was on.)
      if (CREDENTIAL_HEADERS.some(h => req.headers[h] !== undefined && !isPracticeSecret(req.headers[h]))) {
        return { ok: false, reason: 'practice-real-secret' }
      }
      return new Promise(resolve => {
        let settled = false
        const done = (v: Awaited<ReturnType<UpstreamClient['send']>>) => { if (!settled) { settled = true; resolve(v) } }
        const request = target.protocol === 'https:' ? httpsRequest : httpRequest
        const outgoing = request({
          host: target.hostname === '[::1]' ? '::1' : target.hostname,
          port: target.port,
          method: req.method,
          path: req.path,
          headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
          agent: false,
          signal: req.signal,
        }, (res: IncomingMessage) => {
          clearTimeout(timer)
          const headers: Array<[string, string]> = []
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]])
          done({ ok: true, response: { status: res.statusCode ?? 502, headers, body: res, viaPrivateAddress: false } })
        })
        const timer = setTimeout(() => outgoing.destroy(Object.assign(new Error('practice upstream headers timeout'), { code: 'ETIMEDOUT' })), req.headersTimeoutMs)
        outgoing.on('error', (error: Error & { code?: string }) => {
          clearTimeout(timer)
          done({ ok: false, reason: error.name === 'AbortError' ? 'aborted' : error.code === 'ETIMEDOUT' ? 'timeout' : 'connect' })
        })
        if (!req.body) { outgoing.end(); return }
        void (async () => {
          try {
            for await (const chunk of req.body!) {
              if (outgoing.destroyed) return
              if (!outgoing.write(chunk)) await new Promise(r => { outgoing.once('drain', r); outgoing.once('close', r) })
            }
            outgoing.end()
          } catch (error) {
            outgoing.destroy(error as Error)
          }
        })()
      })
    },
  }
}
