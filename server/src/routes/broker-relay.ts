/**
 * The key broker's relay (K4), mounted at /api/broker:
 *
 *   * /api/broker/:service/<upstream path>   gemini, openai, anthropic
 *
 * The caller is a script the AI runs (or a tool started from the app) with an
 * `acb_tok_` token where the service's API key would go — `Authorization:
 * Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`. No ACB session: the
 * token is the sign-in (no token → 401). Everything else is
 * services/broker-relay.ts (.claude/rules/key-broker.md).
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { Readable } from 'stream'
import { services } from '../composition'
import type { BrokerRelay } from '../services/broker-relay'

function publicBase(c: Context): string {
  const proto = c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '')
  return (process.env.PUBLIC_URL || `${proto}://${c.req.header('host') || new URL(c.req.url).host}`).replace(/\/+$/, '')
}

/** The relay's routes over one relay service (tests hand one with a fake upstream). */
export function brokerRelayRoutes(brokerRelay: BrokerRelay): Hono {
  const route = new Hono()
  route.on(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], '/:service/*', async (c) => relayOnce(c, brokerRelay))
  return route
}

async function relayOnce(c: Context, brokerRelay: BrokerRelay): Promise<Response> {
  const service = c.req.param('service') ?? ''
  const url = new URL(c.req.url)
  const marker = `/${encodeURIComponent(service)}/`
  const at = url.pathname.indexOf(marker)
  const pathAndQuery = `${at < 0 ? '/' : url.pathname.slice(at + marker.length - 1)}${url.search}`
  const headers: Array<[string, string]> = []
  c.req.raw.headers.forEach((value, name) => { headers.push([name.toLowerCase(), value]) })
  const raw = c.req.raw.body as unknown as AsyncIterable<Uint8Array> | null

  const answer = await brokerRelay.relay({
    service,
    method: c.req.method,
    pathAndQuery,
    headers,
    body: raw,
    signal: c.req.raw.signal,
    publicBase: publicBase(c),
  })
  const body = answer.body === null
    ? null
    : answer.body instanceof Uint8Array
      ? answer.body
      : (Readable.toWeb(Readable.from(answer.body)) as unknown as ReadableStream<Uint8Array>)
  return new Response(body as BodyInit | null, { status: answer.status, headers: answer.headers })
}

export const brokerRelayRoute = brokerRelayRoutes(services.brokerRelay)
