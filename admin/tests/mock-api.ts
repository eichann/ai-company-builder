import { vi } from 'vitest'

export interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

type Reply = { status?: number; body: unknown } | (() => { status?: number; body: unknown } | Promise<never>)

/**
 * Stubs fetch with a route table keyed by "METHOD /path?query". Unknown routes
 * answer 404 so a missing fixture shows up as a test failure, not a hang.
 */
export function mockApi(routes: Record<string, Reply>) {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url, headers, body })
    const route = routes[`${method} ${decodeURIComponent(url)}`]
    if (!route) return json(404, { error: `no fixture for ${method} ${url}` })
    const reply = typeof route === 'function' ? await route() : route
    return json(reply.status ?? 200, reply.body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A request that never settles, to observe loading states. */
export function pending(): Promise<never> {
  return new Promise(() => {})
}
