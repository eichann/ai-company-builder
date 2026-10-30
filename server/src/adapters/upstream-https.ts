/**
 * The relay's HTTPS client (ports/upstream.ts): resolve the host once, refuse
 * private / internal addresses unless the company named the host as an
 * exception, then connect to that very address with TLS verified against the
 * host name — so a second DNS answer (rebinding) can never change where the
 * key goes. No redirects are followed; nothing is logged here.
 */
import { request } from 'https'
import { lookup as dnsLookup } from 'dns/promises'
import type { IncomingMessage } from 'http'
import { isIP } from 'net'
import { isPrivateAddress } from '../lib/net-ranges'
import type { UpstreamClient, UpstreamFailure } from '../ports/upstream'

export interface HttpsUpstreamOptions {
  /** DNS resolution (default: the system resolver, every address). */
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>
  /** Tests: the fake upstream's port and certificate authority. */
  port?: number
  ca?: string | Buffer
}

function failureOf(error: unknown): UpstreamFailure {
  const e = error as { code?: string; name?: string }
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return 'aborted'
  const code = e?.code ?? ''
  if (code === 'ETIMEDOUT' || code === 'ACB_HEADERS_TIMEOUT') return 'timeout'
  if (/CERT|SSL|TLS|SELF_SIGNED|ERR_TLS|HOSTNAME|ALTNAME/i.test(code)) return 'tls'
  return 'connect'
}

export function httpsUpstream(options: HttpsUpstreamOptions = {}): UpstreamClient {
  const lookup = options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true }))
  return {
    async send(req) {
      let addresses: Array<{ address: string; family: number }>
      try {
        addresses = isIP(req.host) ? [{ address: req.host, family: isIP(req.host) }] : await lookup(req.host)
      } catch {
        return { ok: false, reason: 'dns' }
      }
      if (addresses.length === 0) return { ok: false, reason: 'dns' }
      // Every answer is judged, not only the one used: a name with any internal address is refused.
      const internal = addresses.some(a => isPrivateAddress(a.address))
      if (internal && !req.allowPrivateHosts.includes(req.host)) return { ok: false, reason: 'private-address' }
      const target = addresses[0]

      return new Promise(resolve => {
        let settled = false
        const done = (v: Awaited<ReturnType<UpstreamClient['send']>>) => { if (!settled) { settled = true; resolve(v) } }
        const outgoing = request({
          host: target.address,
          family: target.family,
          port: options.port ?? 443,
          servername: isIP(req.host) ? undefined : req.host,
          method: req.method,
          path: req.path,
          headers: { ...req.headers, host: req.host },
          agent: false,
          ...(options.ca ? { ca: options.ca } : {}),
          signal: req.signal,
        }, (res: IncomingMessage) => {
          clearTimeout(timer)
          const headers: Array<[string, string]> = []
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]])
          done({ ok: true, response: { status: res.statusCode ?? 502, headers, body: res, viaPrivateAddress: internal } })
        })
        const timer = setTimeout(() => {
          outgoing.destroy(Object.assign(new Error('upstream headers timeout'), { code: 'ACB_HEADERS_TIMEOUT' }))
        }, req.headersTimeoutMs)
        outgoing.on('error', error => { clearTimeout(timer); done({ ok: false, reason: failureOf(error) }) })
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
