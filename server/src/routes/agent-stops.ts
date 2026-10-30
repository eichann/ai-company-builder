/**
 * The emergency stop (monitoring M2, 「AI の緊急停止」) and the push channel.
 * Mounted at /api/companies/:companyId. Shapes: shared/types/agent-stop.ts;
 * rules: services/agent-stops.ts, services/push-channel.ts;
 * .claude/rules/agent-stop.md.
 *
 *   GET    /agent-stops            stops in force, history, apps that do not follow it (owner/admin)
 *   POST   /agent-stops            { userId?, tool?, reason? } stop now (owner/admin)
 *   DELETE /agent-stops/:stopId    release one stop (owner/admin)
 *   GET    /me/events              any member: text/event-stream. Only
 *                                  `event: policy` / `data: {"kind","version"}` and
 *                                  heartbeat comments every 25 s; the app refetches
 *                                  GET /me/agent-policy when the version differs.
 *
 * The push channel is defensive by design (owner, 2026-10-31): no content in
 * an event, at most PUSH_MAX_PER_MEMBER connections per member, addressed by
 * company × member, session in the Cookie header (never the URL), nothing
 * logged about the session; a connection ends after PUSH_LIFETIME_MS and the
 * app reconnects (re-authenticated).
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import type { Member } from '../services/access'
import { AGENT_STOP_SUPPORT_HEADER, PUSH_HEARTBEAT_MS, type PushEvent } from '../../shared/types/agent-stop'
import { refusal } from './respond'

export const agentStopsRoute = new Hono()
const { access, agentStops, agentPolicy, push } = services

/** A connection lasts this long at most; the app then reconnects with its session. */
export const PUSH_LIFETIME_MS = 10 * 60_000
const timings = { heartbeatMs: PUSH_HEARTBEAT_MS, lifetimeMs: PUSH_LIFETIME_MS }

/** Tests only: shorter heartbeat / lifetime (undefined = back to the defaults). */
export function setPushTimingsForTests(value?: { heartbeatMs?: number; lifetimeMs?: number }): void {
  timings.heartbeatMs = value?.heartbeatMs ?? PUSH_HEARTBEAT_MS
  timings.lifetimeMs = value?.lifetimeMs ?? PUSH_LIFETIME_MS
}

async function authAndAuthorize(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

async function jsonBody(c: Context): Promise<unknown> {
  try { return await c.req.json() } catch { return null }
}

/** The app build, when this app says it follows the stop (X-ACB-Agent-Stop: 1). */
export function noteStopSupport(c: Context, member: Member): void {
  if (c.req.header(AGENT_STOP_SUPPORT_HEADER) !== '1') return
  const raw = c.req.header('X-ACB-Client-Version')
  const version = raw && /^[\x20-\x7e]{1,128}$/.test(raw) ? raw : null
  try { agentStops.seen(member, version) } catch (error) {
    console.warn('[agent-stop] recording the app failed:', error instanceof Error ? error.message : 'unknown')
  }
}

agentStopsRoute.get('/agent-stops', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentStops.get(member)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentStopsRoute.post('/agent-stops', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentStops.stop(member, await jsonBody(c))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

agentStopsRoute.delete('/agent-stops/:stopId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const result = agentStops.release(member, c.req.param('stopId'))
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

const frame = (event: PushEvent) => `event: ${event.kind}\ndata: ${JSON.stringify({ kind: event.kind, version: event.version })}\n\n`

agentStopsRoute.get('/me/events', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  noteStopSupport(c, member)

  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let ended = false
  const pending: string[] = []
  const write = (text: string) => {
    if (ended) return
    if (!controller) { pending.push(text); return }
    try { controller.enqueue(encoder.encode(text)) } catch { end() }
  }
  const opened = push.open(member.companyId, member.userId, { send: event => write(frame(event)) })
  if (!opened.ok) {
    console.warn(`[push] ${member.companyId}: connection refused (${opened.reason})`)
    return c.json({ error: 'Too many open connections', code: 'TOO_MANY_CONNECTIONS' }, 429)
  }

  const timers: { heartbeat?: ReturnType<typeof setInterval>; lifetime?: ReturnType<typeof setTimeout> } = {}
  const signal = c.req.raw.signal
  function end() {
    if (ended) return
    ended = true
    clearInterval(timers.heartbeat)
    clearTimeout(timers.lifetime)
    signal.removeEventListener('abort', end)
    if (opened.ok) opened.close()
    try { controller?.close() } catch { /* already closed */ }
  }
  signal.addEventListener('abort', end, { once: true })

  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      controller = ctl
      for (const text of pending.splice(0)) ctl.enqueue(encoder.encode(text))
    },
    cancel() { end() },
  })
  // The current version first: an app that missed an announcement while
  // disconnected learns it at once.
  write(frame({ kind: 'policy', version: agentPolicy.policyFor(member).version }))
  timers.heartbeat = setInterval(() => {
    // A member removed from the company stops hearing anything.
    if (!access.memberOf(member.companyId, member.userId)) { end(); return }
    write(':\n\n')
  }, timings.heartbeatMs)
  timers.lifetime = setTimeout(end, timings.lifetimeMs)
  timers.heartbeat.unref?.()
  timers.lifetime.unref?.()

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Proxies must pass every frame through at once (Caddy flushes event streams by itself;
      // X-Accel-Buffering is nginx's switch).
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
})
