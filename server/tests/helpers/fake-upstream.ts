/**
 * The relay's / connector's way out, answered by a Hono app (the fake
 * HubSpot) instead of the internet: tests pass it to createServices as
 * `upstream`. Every request is recorded (host, method, path, credential
 * header present — never its value). A request the app never answers (the
 * fake's `dropAnswerAfterWrite`) ends as a `timeout` after `timeoutMs`, as a
 * cut connection would.
 */
import type { Hono } from 'hono'
import type { UpstreamClient } from '../../src/ports/upstream'

export interface SentRequest { host: string; method: string; path: string; authorization: string | undefined }

export function fakeUpstream(app: Hono | (() => Hono), options: { timeoutMs?: number } = {}): UpstreamClient & { sent: SentRequest[] } {
  const current = typeof app === 'function' ? app : () => app
  const sent: SentRequest[] = []
  return {
    sent,
    async send(req) {
      sent.push({ host: req.host, method: req.method, path: req.path, authorization: req.headers.authorization })
      const chunks: Uint8Array[] = []
      if (req.body) for await (const c of req.body) chunks.push(c)
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'content-length'))
      const answer = Promise.resolve(current().request(`https://${req.host}${req.path}`, { method: req.method, headers, body }))
      const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), options.timeoutMs ?? 2000))
      const res = await Promise.race([answer, timeout])
      if (!res) return { ok: false, reason: 'timeout' }
      const bytes = new Uint8Array(await res.arrayBuffer())
      return {
        ok: true,
        response: {
          status: res.status,
          headers: [...res.headers.entries()],
          body: (async function* () { if (bytes.byteLength > 0) yield bytes })(),
          viaPrivateAddress: false,
        },
      }
    },
  }
}
